/**
 * Persistent interactive terminal sessions for the Universal Workspace.
 *
 * node-pty is deliberately not a dependency: sessions run `/bin/zsh -i` over
 * plain stdio pipes (no TTY), which is enough for streaming output, stdin
 * writes and signal-driven interruption. Project-bound sessions are launched
 * under macOS Seatbelt, with a readonly `chpwd` guard that immediately returns
 * an interactive shell to its canonical project root if a command tries to
 * leave it. Every child is spawned `detached`, so interrupt/kill address the
 * whole process group (`kill(-pid, …)`) instead of the shell alone.
 *
 * One-shot `exec` calls reuse the session's shell binary, cwd and
 * environment, and report the post-command working directory back through a
 * dedicated fd, so cwd changes (`cd build`) persist across exec calls only
 * while they remain inside the immutable session root. Commands the shared
 * bash classifier verdicts `write` require `{ approved: true }`; `deny` is
 * absolute and can never be overridden by approval. Every shell receives a
 * distinct 0700 HOME/TMPDIR and cannot delegate work to another GUI app.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { classifyBashCommand, type BashClassification } from "@adpilot/shared";
import {
  buildSeatbeltProfile,
  createPrivateSandboxDirectory,
  createProtectedPathMatcher,
  removePrivateSandboxDirectory,
  resolveSandboxExec
} from "@adpilot/tools";
import { broadProjectRootReason } from "./project-root-policy.js";

export type TerminalErrorCode =
  | "TERMINAL_NOT_FOUND"
  | "TERMINAL_EXITED"
  | "TERMINAL_LIMIT"
  | "TERMINAL_CWD_INVALID"
  | "TERMINAL_CWD_ESCAPE"
  | "TERMINAL_INPUT_INVALID"
  | "TERMINAL_SPAWN_FAILED"
  | "TERMINAL_SANDBOX_UNAVAILABLE"
  | "COMMAND_APPROVAL_REQUIRED"
  | "COMMAND_DENIED";

export class TerminalError extends Error {
  readonly code: TerminalErrorCode;
  readonly classification?: BashClassification;

  constructor(message: string, code: TerminalErrorCode, options?: { classification?: BashClassification; cause?: unknown }) {
    super(message);
    this.name = "TerminalError";
    this.code = code;
    if (options?.classification !== undefined) this.classification = options.classification;
    if (options && "cause" in options) this.cause = options.cause;
  }
}

export interface TerminalCreateInput {
  readonly cwd: string;
  /**
   * REST-created terminals always carry this immutable ownership boundary.
   * Agent-internal placeholder sessions may omit it because their registry
   * already owns a stricter workspace/product-session map.
   */
  readonly scope?: TerminalSessionScope;
  /** Extra environment entries layered over the whitelist; values are stringified. */
  readonly env?: Readonly<Record<string, string | number | boolean>>;
  readonly title?: string;
}

export interface TerminalSessionScope {
  readonly clientId: string;
  readonly projectId: string;
  /** Canonical project root selected for this terminal. */
  readonly root: string;
}

export interface TerminalSessionInfo {
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  readonly createdAt: string;
  readonly running: boolean;
  readonly exitCode: number | null;
}

export interface TerminalOutputChunk {
  readonly seq: number;
  readonly ts: number;
  readonly stream: "stdout" | "stderr";
  readonly data: string;
}

export interface TerminalOutput {
  readonly chunks: TerminalOutputChunk[];
  readonly running: boolean;
}

export interface TerminalExecOptions {
  readonly timeoutMs?: number;
  readonly approved?: boolean;
  readonly scope?: TerminalSessionScope;
}

export interface TerminalExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

const SHELL = "/bin/zsh";
const MAX_SESSIONS = 8;
const MAX_CHUNKS = 2_000;
const MAX_PENDING_INPUT_BYTES = 64_000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const MAX_EXEC_TIMEOUT_MS = 600_000;
const SIGKILL_GRACE_MS = 2_000;
const ENV_WHITELIST = ["PATH", "HOME", "LANG", "TERM", "SHELL"] as const;

interface TerminalSession {
  readonly id: string;
  /** Immutable confinement root. */
  readonly root: string;
  /** Private 0700 HOME/TMPDIR granted to this session and no other terminal. */
  readonly tempRoot: string;
  /** Tracked cwd; it may move only to a descendant of `root`. */
  cwd: string;
  readonly scope?: TerminalSessionScope;
  readonly title: string;
  readonly createdAt: string;
  readonly env: Record<string, string>;
  readonly proc: ChildProcess;
  readonly stdin: Writable;
  readonly chunks: TerminalOutputChunk[];
  /** Withheld shell input that ends in a continuation or incomplete quote. */
  pendingInput: string;
  seq: number;
  running: boolean;
  exitCode: number | null;
  readonly exitWaiters: Array<() => void>;
  tempCleanup?: Promise<void>;
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>();

  async create(input: TerminalCreateInput): Promise<TerminalSessionInfo> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new TerminalError(
        `terminal session limit reached (${MAX_SESSIONS}); kill an existing session first`,
        "TERMINAL_LIMIT"
      );
    }
    const cwd = await normalizeCwd(input.cwd);
    const scope = input.scope === undefined
      ? undefined
      : await normalizeScope(input.scope, cwd);
    const root = scope?.root ?? cwd;
    await assertSafeTerminalRoot(root);
    const tempRoot = await createPrivateSandboxDirectory();
    const env = buildEnv(input.env, tempRoot);
    let spawnTarget: ReturnType<typeof sandboxedShell>;
    try {
      spawnTarget = sandboxedShell(root, tempRoot, ["-i", "-f"]);
    } catch (error) {
      await removePrivateSandboxDirectory(tempRoot);
      throw error;
    }
    // -i: interactive (reads commands from stdin); -f: skip rc files so the
    // caller's ~/.zshrc cannot inject aliases, prompts or hangs into a
    // service-owned shell.
    let proc: ChildProcess;
    try {
      proc = spawn(spawnTarget.file, spawnTarget.args, {
        cwd,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      await removePrivateSandboxDirectory(tempRoot);
      throw new TerminalError(`failed to spawn ${SHELL}`, "TERMINAL_SPAWN_FAILED", { cause: error });
    }
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      await removePrivateSandboxDirectory(tempRoot);
      throw new TerminalError("failed to pipe the shell stdio", "TERMINAL_SPAWN_FAILED");
    }
    const session: TerminalSession = {
      id: randomUUID(),
      root,
      tempRoot,
      cwd,
      ...(scope !== undefined ? { scope } : {}),
      title: input.title ?? basename(cwd),
      createdAt: new Date().toISOString(),
      env,
      proc,
      stdin: proc.stdin,
      chunks: [],
      pendingInput: "",
      seq: 0,
      running: true,
      exitCode: null,
      exitWaiters: []
    };
    // zsh invokes chpwd after every directory change. Marking this function
    // readonly prevents later input from replacing the guard in the parent
    // shell. Child processes remain inside the same Seatbelt profile.
    session.stdin.write(cwdGuard(root));
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    proc.stdout.on("data", (data: Buffer) => this.pushChunk(session, "stdout", stdoutDecoder.write(data)));
    proc.stderr.on("data", (data: Buffer) => this.pushChunk(session, "stderr", stderrDecoder.write(data)));
    // An EPIPE on stdin after the shell died is already reported via the exit state.
    proc.stdin.on("error", () => undefined);
    proc.on("error", () => this.markExited(session, null));
    proc.on("exit", (code) => {
      this.pushChunk(session, "stdout", stdoutDecoder.end());
      this.pushChunk(session, "stderr", stderrDecoder.end());
      this.markExited(session, code);
    });
    this.sessions.set(session.id, session);
    return this.info(session);
  }

  list(scope?: TerminalSessionScope): TerminalSessionInfo[] {
    return [...this.sessions.values()]
      .filter((session) => scope === undefined || scopeMatches(session.scope, scope))
      .map((session) => this.info(session));
  }

  output(id: string, sinceSeq?: number, scope?: TerminalSessionScope): TerminalOutput {
    const session = this.require(id, scope);
    const chunks = sinceSeq === undefined
      ? [...session.chunks]
      : session.chunks.filter((chunk) => chunk.seq > sinceSeq);
    return { chunks, running: session.running };
  }

  write(
    id: string,
    data: string,
    scope?: TerminalSessionScope,
    approved = false
  ): BashClassification | undefined {
    const session = this.require(id, scope);
    this.assertRunning(session);
    session.pendingInput += data;
    if (Buffer.byteLength(session.pendingInput, "utf8") > MAX_PENDING_INPUT_BYTES) {
      session.pendingInput = "";
      throw new TerminalError(
        `terminal input exceeds ${MAX_PENDING_INPUT_BYTES} bytes before forming a complete command`,
        "TERMINAL_INPUT_INVALID"
      );
    }
    // A REST write is an arbitrary byte chunk, not a shell command boundary.
    // Hold it until a newline terminates the complete command. Otherwise two
    // requests (`r` then `m -rf …\n`) would be harmless in isolation but join
    // into a denied command in zsh's own input buffer.
    if (!session.pendingInput.endsWith("\n")) return undefined;
    const normalized = session.pendingInput.replace(/\\\r?\n/g, "");
    const classification = classifyBashCommand(normalized, { workspaceRoot: session.root });
    if (/\\(?:\r?\n)$/.test(session.pendingInput) || !classification.parseable) return undefined;
    const completeInput = session.pendingInput;
    session.pendingInput = "";
    if (classification.verdict === "deny") {
      throw deniedCommand(classification);
    }
    if (classification.verdict === "write" && !approved) {
      throw new TerminalError(
        `command requires explicit approval (${classification.verdict}: ${classification.reason})`,
        "COMMAND_APPROVAL_REQUIRED",
        { classification }
      );
    }
    session.stdin.write(completeInput);
    return classification;
  }

  interrupt(id: string, scope?: TerminalSessionScope): void {
    const session = this.require(id, scope);
    this.assertRunning(session);
    signalGroup(session.proc, "SIGINT");
  }

  async kill(id: string, scope?: TerminalSessionScope): Promise<void> {
    const session = this.require(id, scope);
    this.sessions.delete(id);
    await this.terminate(session);
    await this.cleanupTemp(session);
  }

  async exec(
    target: string | { cwd: string },
    command: string,
    options: TerminalExecOptions = {}
  ): Promise<TerminalExecResult> {
    let cwd: string;
    let env: Record<string, string>;
    let session: TerminalSession | undefined;
    if (typeof target === "string") {
      session = this.require(target, options.scope);
      this.assertRunning(session);
      cwd = await normalizeCwd(session.cwd);
      if (!isWithinRoot(cwd, session.root)) {
        session.cwd = session.root;
        throw new TerminalError(
          `terminal cwd escaped its project root: ${cwd}`,
          "TERMINAL_CWD_ESCAPE"
        );
      }
      env = session.env;
    } else {
      cwd = await normalizeCwd(target.cwd);
      await assertSafeTerminalRoot(cwd);
      const classification = classifyBashCommand(command, { workspaceRoot: cwd });
      if (classification.verdict === "deny") throw deniedCommand(classification);
      if (classification.verdict === "write" && options.approved !== true) {
        throw new TerminalError(
          `command requires explicit approval (${classification.verdict}: ${classification.reason}); retry with approved: true`,
          "COMMAND_APPROVAL_REQUIRED",
          { classification }
        );
      }
      const tempRoot = await createPrivateSandboxDirectory();
      try {
        env = buildEnv(undefined, tempRoot);
        const result = await this.runOnce(cwd, cwd, env, command, options.timeoutMs, tempRoot);
        return terminalExecResult(result);
      } finally {
        await removePrivateSandboxDirectory(tempRoot);
      }
    }
    const root = session?.root ?? cwd;
    const classification = classifyBashCommand(command, { workspaceRoot: root });
    if (classification.verdict === "deny") {
      throw deniedCommand(classification);
    }
    if (classification.verdict === "write" && options.approved !== true) {
      throw new TerminalError(
        `command requires explicit approval (${classification.verdict}: ${classification.reason}); retry with approved: true`,
        "COMMAND_APPROVAL_REQUIRED",
        { classification }
      );
    }
    const result = await this.runOnce(cwd, root, env, command, options.timeoutMs, session!.tempRoot);
    if (session && result.finalCwd !== undefined) {
      const finalCwd = await normalizeCwd(result.finalCwd);
      if (!isWithinRoot(finalCwd, session.root)) {
        throw new TerminalError(
          `command attempted to move terminal cwd outside its project root: ${finalCwd}`,
          "TERMINAL_CWD_ESCAPE"
        );
      }
      session.cwd = finalCwd;
    }
    return terminalExecResult(result);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(async (id) => {
      try {
        await this.kill(id);
      } catch {
        // A session that vanished between listing and killing is already gone.
      }
    }));
  }

  private runOnce(
    cwd: string,
    root: string,
    env: Record<string, string>,
    command: string,
    timeoutMs: number | undefined,
    tempRoot: string
  ): Promise<TerminalExecResult & { finalCwd?: string }> {
    const timeout = Math.min(Math.max(1, timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS), MAX_EXEC_TIMEOUT_MS);
    // fd 3 carries the post-command PWD back without polluting stdout; the
    // trailing `exit` preserves the command's own exit code.
    const wrapped = `${command}\n__adpilot_exit_code=$?\nprintf '%s' "$PWD" >&3\nexit "$__adpilot_exit_code"`;
    const startedAt = Date.now();
    const spawnTarget = sandboxedShell(root, tempRoot, ["-f", "-c", wrapped]);
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(spawnTarget.file, spawnTarget.args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "pipe"]
      });
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const metaDecoder = new StringDecoder("utf8");
      const metaStream = child.stdio[3] as Readable | null | undefined;
      let stdout = "";
      let stderr = "";
      let meta = "";
      let timedOut = false;
      let settled = false;
      child.stdout?.on("data", (data: Buffer) => { stdout += stdoutDecoder.write(data); });
      child.stderr?.on("data", (data: Buffer) => { stderr += stderrDecoder.write(data); });
      metaStream?.on("data", (data: Buffer) => { meta += metaDecoder.write(data); });
      const killTimer = setTimeout(() => {
        timedOut = true;
        signalGroup(child, "SIGTERM");
        setTimeout(() => {
          if (!settled) signalGroup(child, "SIGKILL");
        }, SIGKILL_GRACE_MS).unref();
      }, timeout);
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        rejectPromise(new TerminalError(`failed to spawn ${SHELL}: ${error.message}`, "TERMINAL_SPAWN_FAILED", { cause: error }));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        meta += metaDecoder.end();
        const finalCwd = !timedOut && meta.trim().length > 0 ? meta.trim() : undefined;
        resolvePromise({
          exitCode: code,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
          ...(finalCwd !== undefined ? { finalCwd } : {})
        });
      });
    });
  }

  private async terminate(session: TerminalSession): Promise<void> {
    if (!session.running) return;
    const exited = new Promise<void>((resolve) => session.exitWaiters.push(resolve));
    signalGroup(session.proc, "SIGTERM");
    await Promise.race([exited, delay(SIGKILL_GRACE_MS)]);
    if (!session.running) return;
    signalGroup(session.proc, "SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }

  private require(id: string, scope?: TerminalSessionScope): TerminalSession {
    const session = this.sessions.get(id);
    if (!session || (scope !== undefined && !scopeMatches(session.scope, scope))) {
      // Ownership mismatches deliberately collapse to not-found so a caller
      // cannot use terminal ids to enumerate another client/project/root.
      throw new TerminalError(`terminal session not found: ${id}`, "TERMINAL_NOT_FOUND");
    }
    return session;
  }

  private assertRunning(session: TerminalSession): void {
    if (!session.running) {
      throw new TerminalError(
        `terminal session ${session.id} already exited (code ${session.exitCode ?? "signal"})`,
        "TERMINAL_EXITED"
      );
    }
  }

  private info(session: TerminalSession): TerminalSessionInfo {
    return {
      id: session.id,
      cwd: session.cwd,
      title: session.title,
      createdAt: session.createdAt,
      running: session.running,
      exitCode: session.exitCode
    };
  }

  private markExited(session: TerminalSession, exitCode: number | null): void {
    if (!session.running) return;
    session.running = false;
    session.exitCode = exitCode;
    const waiters = session.exitWaiters.splice(0);
    for (const resolve of waiters) resolve();
    void this.cleanupTemp(session).catch(() => undefined);
  }

  private cleanupTemp(session: TerminalSession): Promise<void> {
    session.tempCleanup ??= removePrivateSandboxDirectory(session.tempRoot);
    return session.tempCleanup;
  }

  private pushChunk(session: TerminalSession, stream: "stdout" | "stderr", data: string): void {
    if (!data) return;
    session.seq += 1;
    session.chunks.push({ seq: session.seq, ts: Date.now(), stream, data });
    if (session.chunks.length > MAX_CHUNKS) {
      session.chunks.splice(0, session.chunks.length - MAX_CHUNKS);
    }
  }
}

async function normalizeCwd(cwd: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(cwd);
  } catch (error) {
    throw new TerminalError(`terminal cwd does not exist: ${cwd}`, "TERMINAL_CWD_INVALID", { cause: error });
  }
  const metadata = await stat(canonical).catch(() => null);
  if (!metadata?.isDirectory()) {
    throw new TerminalError(`terminal cwd is not a directory: ${cwd}`, "TERMINAL_CWD_INVALID");
  }
  return canonical;
}

async function normalizeScope(scope: TerminalSessionScope, cwd: string): Promise<TerminalSessionScope> {
  const root = await normalizeCwd(scope.root);
  if (cwd !== root) {
    throw new TerminalError(
      `terminal cwd must equal its canonical project root: ${root}`,
      "TERMINAL_CWD_INVALID"
    );
  }
  return { clientId: scope.clientId, projectId: scope.projectId, root };
}

async function assertSafeTerminalRoot(root: string): Promise<void> {
  const reason = await broadProjectRootReason(root);
  if (reason) {
    throw new TerminalError(
      `terminal cwd is too broad for confinement (${reason})`,
      "TERMINAL_CWD_INVALID"
    );
  }
}

function scopeMatches(
  actual: TerminalSessionScope | undefined,
  expected: TerminalSessionScope
): boolean {
  return actual !== undefined
    && actual.clientId === expected.clientId
    && actual.projectId === expected.projectId
    && actual.root === expected.root;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function deniedCommand(classification: BashClassification): TerminalError {
  return new TerminalError(
    `command is denied by terminal policy (${classification.reason}); approval cannot override this refusal`,
    "COMMAND_DENIED",
    { classification }
  );
}

function sandboxedShell(
  root: string,
  tempRoot: string,
  shellArgs: readonly string[]
): { file: string; args: string[] } {
  const sandbox = resolveSandboxExec();
  if (!sandbox.available || !sandbox.path) {
    throw new TerminalError(
      `terminal sandbox is unavailable (${sandbox.reason ?? "unknown reason"})`,
      "TERMINAL_SANDBOX_UNAVAILABLE"
    );
  }
  const protect = createProtectedPathMatcher({ workspaceRoot: root });
  const profile = buildSeatbeltProfile({
    workspaceRoot: root,
    protect,
    isolatedTempDir: tempRoot,
    denyGuiLaunch: true
  });
  return { file: sandbox.path, args: ["-p", profile, SHELL, ...shellArgs] };
}

function cwdGuard(root: string): string {
  const literal = shellSingleQuote(root);
  return [
    `typeset -gr ADPILOT_PROJECT_ROOT=${literal}`,
    "function chpwd() {",
    '  case "$PWD" in',
    '    "$ADPILOT_PROJECT_ROOT"|"$ADPILOT_PROJECT_ROOT"/*) ;;',
    '    *) print -u2 "AdPilot: blocked terminal cwd escape"; builtin cd -q -- "$ADPILOT_PROJECT_ROOT" ;;',
    "  esac",
    "}",
    "functions -r chpwd",
    ""
  ].join("\n");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildEnv(
  extra: Readonly<Record<string, string | number | boolean>> | undefined,
  tempRoot: string
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_WHITELIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (key.length === 0 || key.includes("=") || key.includes("\0")) continue;
    env[key] = String(value);
  }
  // Pipes are no TTY: line editing and history are useless, and history
  // writes must never touch the caller's real ~/.zsh_history.
  env.TERM = "xterm-256color";
  env.SHELL = SHELL;
  env.HISTFILE = "/dev/null";
  env.HOME = tempRoot;
  env.TMPDIR = tempRoot;
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin";
  return env;
}

function terminalExecResult(result: TerminalExecResult & { finalCwd?: string }): TerminalExecResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timedOut: result.timedOut
  };
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: the process (group) already exited; the exit event settles state.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
