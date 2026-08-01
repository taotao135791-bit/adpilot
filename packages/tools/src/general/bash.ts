/**
 * Vendored from pi (https://github.com/earendil-works/pi),
 * packages/coding-agent/src/core/tools/bash.ts @ 0.80.10.
 * MIT License — see licenses/pi-MIT.txt.
 *
 * AdPilot adaptations (the pi-tui renderer, streaming previews and prompt
 * snippets were dropped; the execution core was rebuilt around the AdPilot
 * enforcement pair):
 *
 * 1. Every command is classified by the deterministic shell-syntax-aware
 *    classifier in @adpilot/shared BEFORE execution: whitelisted read
 *    commands flow, write-level commands reach here only with an executed
 *    approval reference (enforced by the tool gate), and deny-level commands
 *    (network egress, screen capture, credential/profile stores, sudo, kill,
 *    launchctl, rm -rf, ...) are refused here absolutely — no approval can
 *    authorize them, because they are exactly the threat-model channels that
 *    would bypass the visual-only red line and the screenshot privacy
 *    pipeline. The classification decision is written to the audit chain.
 * 2. Execution happens exclusively through macOS sandbox-exec with a
 *    generated seatbelt profile (no network, writes confined to the
 *    workspace and one per-call private temp home, protected paths unreadable). When
 *    sandbox-exec is unavailable the tool FAILS CLOSED with an explicit
 *    error instead of silently degrading to an unsandboxed shell — this is
 *    the behavioral equivalent of upstream's spawnHook seam.
 * 3. The child environment is an allowlist: provider API keys, tokens and
 *    secrets of the host process are stripped so they cannot be echoed into
 *    the model context.
 * 4. Timeouts kill the whole process group; output is truncated with the
 *    shared tail-truncation semantics.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { classifyBashCommand, type BashClassification } from "@adpilot/shared";
import { createProtectedPathMatcher } from "./protected-paths.js";
import {
  buildSeatbeltProfile,
  createPrivateSandboxDirectory,
  removePrivateSandboxDirectory,
  resolveSandboxExec,
  sandboxedEnv,
  SANDBOX_UNAVAILABLE_MESSAGE
} from "./sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.js";

const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_TIMEOUT_SECONDS = 120;

const bashParameters = Type.Object({
  command: Type.String({ description: "Bash command to execute in the workspace root" }),
  timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS})` }))
});

const bashInput = z.object({
  command: z.string().min(1),
  timeout: z.number().finite().positive().max(MAX_TIMEOUT_SECONDS).optional()
});

/** Unified hard-denial prefix for bash commands (no approval can authorize these). */
export const BASH_DENY_MESSAGE = "bash command is denied by AdPilot policy";

export interface BashToolAuditEntry {
  readonly classification: BashClassification;
  readonly commandPreview: string;
  readonly sandboxPath: string | null;
  readonly executed: boolean;
}

export interface BashToolOptions {
  /** Workspace root: the bash cwd and the confinement boundary. */
  workspaceRoot: string;
  /**
   * Receives the full classification record for every invocation (allowed and
   * denied). AdPilotTools binds this to the tamper-evident audit chain with
   * the run's ToolContext.
   */
  onClassified?: (entry: BashToolAuditEntry) => Promise<void> | void;
  /** Injectable for tests. Defaults to platform detection of /usr/bin/sandbox-exec. */
  sandboxExecPath?: string | null;
  /** Injectable for tests (defaults to node:child_process spawn). */
  spawnImpl?: typeof spawn;
}

export interface SandboxedBashResult {
  readonly exitCode: number | null;
  readonly output: string;
  readonly classification: BashClassification;
  readonly truncated: boolean;
  readonly durationMs: number;
}

function resolveTimeoutSeconds(timeout: number | undefined): number {
  if (timeout === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS) {
    throw new Error(`Invalid timeout: must be between 0 and ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeout;
}

/**
 * Structured execution primitive shared by the ordinary `bash` tool and the
 * Universal Workspace terminal adapter. Keeping the sandbox here prevents a
 * second shell surface from silently drifting away from the classifier,
 * environment scrubber, output cap, and Seatbelt confinement contract.
 */
export async function executeSandboxedBash(
  options: BashToolOptions,
  raw: unknown,
  signal?: AbortSignal
): Promise<SandboxedBashResult> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const protect = createProtectedPathMatcher({ workspaceRoot: options.workspaceRoot });
  const sandboxPath = options.sandboxExecPath === null ? null : (options.sandboxExecPath ?? "/usr/bin/sandbox-exec");
  const execSandboxed = (command: string, timeoutSeconds: number, profile: string, isolatedHome: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: Buffer }> => {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawnImpl(sandboxPath!, ["-p", profile, "/bin/bash", "-c", command], {
        cwd: options.workspaceRoot,
        detached: true,
        env: sandboxedEnv(process.env, isolatedHome),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      } as SpawnOptions);
      const chunks: Buffer[] = [];
      let timedOut = false;
      const killTree = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      };
      const timeoutHandle = setTimeout(() => { timedOut = true; killTree(); }, timeoutSeconds * 1000);
      const onAbort = () => killTree();
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout?.on("data", (data: Buffer) => chunks.push(data));
      child.stderr?.on("data", (data: Buffer) => chunks.push(data));
      child.on("error", (error) => {
        clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          rejectPromise(new Error("Operation aborted"));
        } else if (timedOut) {
          rejectPromise(new Error(`Command timed out after ${timeoutSeconds} seconds`));
        } else {
          resolvePromise({ exitCode: code, output: Buffer.concat(chunks) });
        }
      });
    });
  };
  const { command, timeout } = bashInput.parse(raw);
  if (signal?.aborted) throw new Error("Operation aborted");

  // Layer 1: deterministic classification. The tool re-runs it with the
  // workspace root so absolute redirect targets are confinement-checked.
  const classification = classifyBashCommand(command, { workspaceRoot: options.workspaceRoot });

  // Layer 2 availability: fail closed when the sandbox is missing.
  const sandbox = options.sandboxExecPath === null
    ? { available: false, path: null, reason: "sandbox disabled by configuration" } as const
    : resolveSandboxExec(sandboxPath ?? "/usr/bin/sandbox-exec");
  if (!sandbox.available && classification.verdict !== "deny") {
    await options.onClassified?.({ classification, commandPreview: command.slice(0, 200), sandboxPath: null, executed: false });
    throw new Error(`${SANDBOX_UNAVAILABLE_MESSAGE} (${sandbox.reason ?? "unknown reason"})`);
  }

  if (classification.verdict === "deny") {
    await options.onClassified?.({ classification, commandPreview: command.slice(0, 200), sandboxPath: sandbox.path, executed: false });
    const denied = classification.commands.filter((item) => item.verdict === "deny");
    const detail = denied.map((item) => `${item.command} [${item.rule}]`).join("; ") || classification.reason;
    throw new Error(`${BASH_DENY_MESSAGE}: ${classification.reason}. Denied segment(s): ${detail}. This refusal is absolute: no approval can authorize these commands.`);
  }

  const timeoutSeconds = resolveTimeoutSeconds(timeout);
  const isolatedHome = await createPrivateSandboxDirectory();
  try {
    const profile = buildSeatbeltProfile({
      workspaceRoot: options.workspaceRoot,
      protect,
      isolatedTempDir: isolatedHome,
      denyGuiLaunch: true
    });
    await options.onClassified?.({ classification, commandPreview: command.slice(0, 200), sandboxPath: sandbox.path, executed: true });
    const startedAt = Date.now();
    const { exitCode, output } = await execSandboxed(command, timeoutSeconds, profile, isolatedHome, signal);

    const text = output.toString("utf-8");
    const truncation = truncateTail(text);
    let outputText = truncation.content.trim().length > 0 ? truncation.content : "(no output)";
    if (truncation.truncated) {
      const startLine = truncation.totalLines - truncation.outputLines + 1;
      outputText += `\n\n[Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}${truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : ""}]`;
    }
    return {
      exitCode,
      output: outputText,
      classification,
      truncated: truncation.truncated,
      durationMs: Date.now() - startedAt
    };
  } finally {
    await removePrivateSandboxDirectory(isolatedHome);
  }
}

export function createBashTool(options: BashToolOptions): AgentTool {
  return {
    name: "bash",
    label: "Run a sandboxed bash command",
    description: `Execute a bash command in the workspace root under a macOS seatbelt sandbox: no network access, file writes confined to the workspace and one per-call private temp home, and protected paths (credentials, approval secrets, audit chain, browser profiles) unreadable. Read-only commands (ls, cat, grep, git status/diff/log, ...) run freely; writes require an executed approval reference; dangerous commands (GUI app launch, curl/wget/ssh, screencapture, sudo, kill, launchctl, rm -rf, browser profile access) are always refused. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    parameters: bashParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, raw, signal) => {
      const result = await executeSandboxedBash(options, raw, signal);
      if (result.exitCode !== 0 && result.exitCode !== null) {
        throw new Error(`${result.output}\n\nCommand exited with code ${result.exitCode}`);
      }
      return {
        content: [{ type: "text" as const, text: result.output }],
        details: {
          exitCode: result.exitCode,
          classification: {
            verdict: result.classification.verdict,
            parseable: result.classification.parseable
          },
          truncated: result.truncated
        }
      };
    }
  };
}
