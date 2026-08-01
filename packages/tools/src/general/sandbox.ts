/**
 * sandbox-exec (seatbelt) confinement for the vendored bash tool (AdPilot-specific).
 *
 * The classifier (in @adpilot/shared) is the first enforcement layer; this is
 * the OS-level floor that holds even when a command was misclassified:
 *
 * - (deny network*): no outbound or inbound sockets. Direct advertising-API
 *   calls, exfiltration POSTs and remote code pulls are impossible regardless
 *   of what the classifier let through, and the local-only privacy mode's "no
 *   bytes leave this machine" semantics hold for bash automatically.
 * - production callers bind file writes to the workspace root and one
 *   invocation-private 0700 HOME/TMPDIR.
 * - reads of the protected paths (the .adpilot private subtree except the
 *   public skills/prompts directories, browser profile stores, credential
 *   stores, .env files, the audit chain) are denied outright.
 * - process-exec of screencapture/osascript is denied as extra hardening of
 *   the screenshot privacy pipeline (threat b).
 *
 * Fail-closed by contract: when sandbox-exec is unavailable the bash tool
 * refuses to execute instead of silently degrading to an unsandboxed shell.
 */
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ProtectedPathMatcher } from "./protected-paths.js";

export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** Explicit, actionable error when the sandbox is unavailable (fail-closed). */
export const SANDBOX_UNAVAILABLE_MESSAGE =
  "bash is disabled: macOS sandbox-exec is unavailable, and AdPilot never runs model-initiated shell commands without the seatbelt sandbox (fail-closed)";

export interface SandboxAvailability {
  readonly available: boolean;
  readonly path: string | null;
  readonly reason: string | null;
}

/**
 * Resolves the sandbox executable. Returns unavailable on non-macOS platforms
 * or when the binary is missing — the caller must refuse execution.
 */
export function resolveSandboxExec(candidatePath: string = SANDBOX_EXEC_PATH): SandboxAvailability {
  if (process.platform !== "darwin") {
    return { available: false, path: null, reason: `platform ${process.platform} has no sandbox-exec` };
  }
  if (!existsSync(candidatePath)) {
    return { available: false, path: null, reason: `${candidatePath} does not exist` };
  }
  return { available: true, path: candidatePath, reason: null };
}

function canonical(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** SBPL string escaping for double-quoted path literals. */
function sbpl(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface SeatbeltProfileOptions {
  workspaceRoot: string;
  protect: ProtectedPathMatcher;
  /** Defaults to the process home directory; injectable for tests. */
  homeDir?: string;
  /**
   * A per-invocation 0700 directory used as HOME and TMPDIR. When present,
   * the profile does not grant data access to the process-wide temp trees.
   */
  isolatedTempDir?: string;
  /** Terminal shells must not hand work to LaunchServices or another GUI app. */
  denyGuiLaunch?: boolean;
}

/**
 * Generates the seatbelt profile for one workspace. SBPL evaluates rules in
 * order and the LAST matching rule wins, so the layout is: broad allows
 * first, then protected denies, then the public re-allows inside .adpilot.
 */
export function buildSeatbeltProfile(options: SeatbeltProfileOptions): string {
  const workspace = canonical(options.workspaceRoot);
  const isolatedTemp = options.isolatedTempDir ? canonical(options.isolatedTempDir) : null;
  const sharedTempReads = isolatedTemp
    ? [`  (subpath "${sbpl(isolatedTemp)}")`]
    : [
        `  (subpath "${sbpl("/tmp")}")`,
        `  (subpath "${sbpl("/private/tmp")}")`,
        `  (subpath "${sbpl(canonical(tmpdir()))}")`,
        `  (subpath "${sbpl("/var/folders")}")`,
        `  (subpath "${sbpl("/private/var/folders")}")`
      ];
  const sharedTempWrites = [...sharedTempReads];
  const protectedPrefixes = options.protect.deniedPrefixes();
  const deniedExecutables = [
    "/usr/sbin/screencapture",
    "/usr/bin/osascript",
    ...(options.denyGuiLaunch
      ? ["/usr/bin/open", "/usr/bin/shortcuts", "/usr/bin/automator"]
      : [])
  ];

  const lines: string[] = [
    ";; AdPilot bash seatbelt profile — generated, do not edit.",
    ";; Layer 2 of the bash enforcement pair (classifier first, sandbox always).",
    "(version 1)",
    "(deny default)",
    "",
    ";; process execution of CLI tools",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow process-info*)",
    "",
    ";; runtime services POSIX tools need",
    "(allow mach-lookup)",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    "(allow file-ioctl)",
    "(allow pseudo-tty)",
    "",
    ";; reads: system resources, the workspace, and temp directories.",
    ";; (literal \"/\") is required: dyld's CacheFinder opens the root",
    ";; directory itself at process startup and subpath rules never match",
    ";; the root — without it the sandboxed process aborts inside dyld.",
    "(allow file-read*",
    `  (literal "/")`,
    `  (subpath "${sbpl("/System")}")`,
    `  (subpath "${sbpl("/usr")}")`,
    `  (subpath "${sbpl("/bin")}")`,
    `  (subpath "${sbpl("/sbin")}")`,
    `  (subpath "${sbpl("/etc")}")`,
    `  (subpath "${sbpl("/private/etc")}")`,
    `  (subpath "${sbpl("/dev")}")`,
    `  (subpath "${sbpl("/Library")}")`,
    `  (subpath "${sbpl("/Applications")}")`,
    `  (subpath "${sbpl("/opt")}")`,
    `  (subpath "${sbpl(workspace)}")`,
    ...sharedTempReads,
    ")",
    "",
    ";; writes: only the workspace, temp directories, and devices",
    "(allow file-write*",
    `  (subpath "${sbpl(workspace)}")`,
    ...sharedTempWrites,
    `  (subpath "${sbpl("/dev")}")`,
    ")",
    "",
    ";; protected paths: denied for read AND write after the broad allows.",
    ";; .adpilot first, then the re-allow of its public subtrees below.",
    `(deny file-read* file-write* (subpath "${sbpl(resolve(workspace, ".adpilot"))}"))`,
    ...protectedPrefixes
      .filter((prefix) => prefix !== resolve(workspace, ".adpilot") && !prefix.startsWith(`${resolve(workspace, ".adpilot")}/`))
      .map((prefix) => `(deny file-read* file-write* (subpath "${sbpl(prefix)}"))`),
    `(deny file-read* file-write* (regex #"/\\.env[^/]*$") (regex #"/audit\\.jsonl$"))`,
    `(allow file-read* (subpath "${sbpl(resolve(workspace, ".adpilot", "skills"))}") (subpath "${sbpl(resolve(workspace, ".adpilot", "prompts"))}"))`,
    "",
    ";; screenshot capture and UI scripting stay inside the privacy pipeline",
    `(deny process-exec ${deniedExecutables.map((path) => `(literal "${sbpl(path)}")`).join(" ")})`,
    "",
    ";; no sockets at all: egress, ingress and binds are impossible",
    "(deny network*)",
    ""
  ];
  return lines.join("\n");
}

const PRIVATE_SANDBOX_PREFIX = "adpilot-private-";

/** Creates a canonical, process-private HOME/TMPDIR for one sandboxed shell. */
export async function createPrivateSandboxDirectory(): Promise<string> {
  const root = canonical(tmpdir());
  const directory = await mkdtemp(join(root, PRIVATE_SANDBOX_PREFIX));
  await chmod(directory, 0o700);
  return canonical(directory);
}

/** Removes only directories created by createPrivateSandboxDirectory. */
export async function removePrivateSandboxDirectory(path: string): Promise<void> {
  const canonicalTempRoot = canonical(tmpdir());
  const resolved = resolve(path);
  if (dirname(resolved) !== canonicalTempRoot || !basename(resolved).startsWith(PRIVATE_SANDBOX_PREFIX)) {
    throw new Error("refusing to remove a non-AdPilot sandbox directory");
  }
  await rm(resolved, { recursive: true, force: true });
}

/**
 * Environment handed to sandboxed commands: an allowlist that excludes every
 * API key, token and secret of the host process, so `echo $OPENAI_API_KEY`
 * style channels return nothing.
 */
export function sandboxedEnv(
  base: NodeJS.ProcessEnv = process.env,
  isolatedHome?: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
    SHELL: "/bin/bash",
    TERM: "dumb"
  };
  for (const name of ["HOME", "LANG", "TMPDIR", "USER", "LOGNAME", "__CF_USER_TEXT_ENCODING", "LC_ALL", "LC_CTYPE"]) {
    if (base[name]) env[name] = base[name];
  }
  if (isolatedHome) {
    env.HOME = isolatedHome;
    env.TMPDIR = isolatedHome;
  }
  return env;
}
