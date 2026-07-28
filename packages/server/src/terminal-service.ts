/**
 * Persistent interactive terminal sessions for the Universal Workspace.
 *
 * node-pty is deliberately not a dependency: sessions run `/bin/zsh -i` over
 * plain stdio pipes (no TTY), which is enough for streaming output, stdin
 * writes and signal-driven interruption. Every child is spawned `detached`,
 * so interrupt/kill address the whole process group (`kill(-pid, …)`) instead
 * of the shell alone.
 *
 * One-shot `exec` calls reuse the session's shell binary, cwd and
 * environment, and report the post-command working directory back through a
 * dedicated fd, so cwd changes (`cd build`) persist across exec calls on the
 * same session. Commands the shared bash classifier does not verdict `read`
 * require an explicit `{ approved: true }`; the refusal carries the
 * classification so the caller can surface exactly why.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { classifyBashCommand, type BashClassification } from "@adpilot/shared";

export type TerminalErrorCode =
  | "TERMINAL_NOT_FOUND"
  | "TERMINAL_EXITED"
  | "TERMINAL_LIMIT"
  | "TERMINAL_CWD_INVALID"
  | "TERMINAL_SPAWN_FAILED"
  | "COMMAND_APPROVAL_REQUIRED";

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
  /** Extra environment entries layered over the whitelist; values are stringified. */
  readonly env?: Readonly<Record<string, string | number | boolean>>;
  readonly title?: string;
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
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const MAX_EXEC_TIMEOUT_MS = 600_000;
const SIGKILL_GRACE_MS = 2_000;
const ENV_WHITELIST = ["PATH", "HOME", "LANG", "TERM", "SHELL"] as const;

interface TerminalSession {
  readonly id: string;
  /** Tracked cwd; updated from the post-exec PWD so exec calls stay continuous. */
  cwd: string;
  readonly title: string;
  readonly createdAt: string;
  readonly env: Record<string, string>;
  readonly proc: ChildProcess;
  readonly stdin: Writable;
  readonly chunks: TerminalOutputChunk[];
  seq: number;
  running: boolean;
  exitCode: number | null;
  readonly exitWaiters: Array<() => void>;
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
    const env = buildEnv(input.env);
    // -i: interactive (reads commands from stdin); -f: skip rc files so the
    // caller's ~/.zshrc cannot inject aliases, prompts or hangs into a
    // service-owned shell.
    const proc = spawn(SHELL, ["-i", "-f"], {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new TerminalError("failed to pipe the shell stdio", "TERMINAL_SPAWN_FAILED");
    }
    const session: TerminalSession = {
      id: randomUUID(),
      cwd,
      title: input.title ?? basename(cwd),
      createdAt: new Date().toISOString(),
      env,
      proc,
      stdin: proc.stdin,
      chunks: [],
      seq: 0,
      running: true,
      exitCode: null,
      exitWaiters: []
    };
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

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((session) => this.info(session));
  }

  output(id: string, sinceSeq?: number): TerminalOutput {
    const session = this.require(id);
    const chunks = sinceSeq === undefined
      ? [...session.chunks]
      : session.chunks.filter((chunk) => chunk.seq > sinceSeq);
    return { chunks, running: session.running };
  }

  write(id: string, data: string): void {
    const session = this.require(id);
    this.assertRunning(session);
    session.stdin.write(data);
  }

  interrupt(id: string): void {
    const session = this.require(id);
    this.assertRunning(session);
    signalGroup(session.proc, "SIGINT");
  }

  async kill(id: string): Promise<void> {
    const session = this.require(id);
    this.sessions.delete(id);
    await this.terminate(session);
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
      session = this.require(target);
      this.assertRunning(session);
      cwd = session.cwd;
      env = session.env;
    } else {
      cwd = await normalizeCwd(target.cwd);
      env = buildEnv();
    }
    const classification = classifyBashCommand(command, { workspaceRoot: cwd });
    if (classification.verdict !== "read" && options.approved !== true) {
      throw new TerminalError(
        `command requires explicit approval (${classification.verdict}: ${classification.reason}); retry with approved: true`,
        "COMMAND_APPROVAL_REQUIRED",
        { classification }
      );
    }
    const result = await this.runOnce(cwd, env, command, options.timeoutMs);
    if (session && result.finalCwd !== undefined) session.cwd = result.finalCwd;
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut
    };
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
    env: Record<string, string>,
    command: string,
    timeoutMs?: number
  ): Promise<TerminalExecResult & { finalCwd?: string }> {
    const timeout = Math.min(Math.max(1, timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS), MAX_EXEC_TIMEOUT_MS);
    // fd 3 carries the post-command PWD back without polluting stdout; the
    // trailing `exit` preserves the command's own exit code.
    const wrapped = `${command}\n__adpilot_exit_code=$?\nprintf '%s' "$PWD" >&3\nexit "$__adpilot_exit_code"`;
    const startedAt = Date.now();
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(SHELL, ["-f", "-c", wrapped], {
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

  private require(id: string): TerminalSession {
    const session = this.sessions.get(id);
    if (!session) throw new TerminalError(`terminal session not found: ${id}`, "TERMINAL_NOT_FOUND");
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

function buildEnv(extra?: Readonly<Record<string, string | number | boolean>>): Record<string, string> {
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
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin";
  return env;
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
