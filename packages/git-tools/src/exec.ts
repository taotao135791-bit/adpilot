/**
 * Injection-safe executor for the system `git` binary.
 *
 * - Arguments are passed as an argv array to node:child_process spawn; no
 *   shell is ever involved, so metacharacters in branch names, paths or
 *   commit messages cannot escape into a command line.
 * - Every invocation is bounded by a 30s timeout (kills the child).
 * - The child environment is a small allowlist (PATH, HOME, TMPDIR, locale)
 *   plus GIT_TERMINAL_PROMPT=0 so git can never block on a credential prompt;
 *   host process secrets are not inherited.
 */
import { spawn, spawnSync } from "node:child_process";
import { GitToolError } from "./error.js";

export const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 500;

export interface GitExecOptions {
  cwd: string;
  input?: string | undefined;
  timeoutMs?: number | undefined;
  /** Exit codes (besides 0) that resolve instead of throwing. */
  allowExitCodes?: number[] | undefined;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    EDITOR: "true"
  };
  for (const name of ["HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function spawnFailure(error: NodeJS.ErrnoException): GitToolError {
  if (error.code === "ENOENT") {
    return new GitToolError("GIT_UNAVAILABLE", "the system git executable was not found on PATH");
  }
  return new GitToolError("GIT_UNAVAILABLE", `failed to spawn git: ${error.message}`, { cause: error });
}

function commandFailure(args: string[], stdout: string, stderr: string, exitCode: number): GitToolError {
  const detail = (stderr.trim() || stdout.trim() || `exit code ${exitCode}`).slice(0, MAX_ERROR_DETAIL_CHARS);
  return new GitToolError("GIT_COMMAND_FAILED", `git ${args.join(" ")} failed: ${detail}`);
}

export async function runGit(args: string[], options: GitExecOptions): Promise<GitExecResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const allowed = new Set<number>([0, ...(options.allowExitCodes ?? [])]);
  return new Promise<GitExecResult>((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: gitEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(spawnFailure(error as NodeJS.ErrnoException));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        rejectPromise(new GitToolError("GIT_TIMEOUT", `git ${args[0] ?? ""} timed out after ${timeoutMs}ms`));
        return;
      }
      const exitCode = code ?? 1;
      if (!allowed.has(exitCode)) {
        rejectPromise(commandFailure(args, stdout, stderr, exitCode));
        return;
      }
      resolvePromise({ stdout, stderr, exitCode });
    });
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

/** Synchronous variant, used only by the GitRepository constructor probe. */
export function runGitSync(args: string[], options: GitExecOptions): GitExecResult {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const allowed = new Set<number>([0, ...(options.allowExitCodes ?? [])]);
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    env: gitEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true
  });
  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    if (error.code === "ETIMEDOUT") {
      throw new GitToolError("GIT_TIMEOUT", `git ${args[0] ?? ""} timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw spawnFailure(error);
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? 1;
  if (!allowed.has(exitCode)) throw commandFailure(args, stdout, stderr, exitCode);
  return { stdout, stderr, exitCode };
}
