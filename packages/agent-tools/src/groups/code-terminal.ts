import { z } from "zod";
import { classifyBashCommand } from "@adpilot/shared";
import { executeSandboxedBash } from "@adpilot/tools";
import type { AgentExecutionContext } from "../context.js";
import type { AgentToolDeps } from "../deps.js";
import type { AgentToolDefinition } from "../registry.js";
import { assertWithinRoots } from "../paths.js";
import { succeed } from "../result.js";
import { toolError } from "../errors.js";

const CreateParams = z.object({
  cwd: z.string().min(1),
  title: z.string().min(1).optional()
});

const ExecuteParams = z.object({
  terminalId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional()
});

const SessionParams = z.object({ terminalId: z.string().min(1) });

type OwnedTerminal = {
  workspaceId: string;
  sessionId: string;
  root: string;
  lastExitCode: number | null;
  chunks: Array<{
    seq: number;
    ts: number;
    stream: "stdout" | "stderr";
    data: string;
  }>;
};

async function requireOwnedTerminal(
  terminals: ReadonlyMap<string, OwnedTerminal>,
  terminalId: string,
  ctx: AgentExecutionContext,
  deps: AgentToolDeps
): Promise<{ owned: OwnedTerminal; cwd: string; running: boolean; exitCode: number | null }> {
  const owned = terminals.get(terminalId);
  if (
    !owned
    || owned.workspaceId !== ctx.workspaceId
    || owned.sessionId !== ctx.sessionId
  ) {
    throw toolError(
      "TERMINAL_NOT_FOUND",
      "terminal session is unavailable or belongs to a different workspace/session"
    );
  }
  const session = deps.terminal.list().find((candidate) => candidate.id === terminalId);
  if (!session) throw toolError("TERMINAL_NOT_FOUND", `terminal session not found: ${terminalId}`);
  // A user may also interact with the same terminal through the desktop. If
  // that moved its cwd, re-check it at every tool call instead of trusting the
  // creation-time root.
  const cwd = await assertWithinRoots(session.cwd, [owned.root]);
  return { owned, cwd, running: session.running, exitCode: session.exitCode };
}

async function checkpointRepositoryMutation(
  cwd: string,
  command: string,
  ctx: AgentExecutionContext,
  deps: AgentToolDeps
): Promise<string | undefined> {
  for (const candidate of ctx.rootPaths) {
    let repositoryRoot: string;
    try {
      repositoryRoot = await assertWithinRoots(candidate, ctx.rootPaths);
      await assertWithinRoots(cwd, [repositoryRoot]);
      // repository() deliberately rejects subdirectories, so use the
      // explicit project root after proving cwd belongs to it.
      deps.git.repository(repositoryRoot);
    } catch {
      continue;
    }
    const checkpoint = await deps.git.checkpoints(repositoryRoot).create({
      repoRoot: repositoryRoot,
      label: `before-terminal: ${command.replace(/\s+/g, " ").slice(0, 64)}`,
      ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {})
    });
    return checkpoint.id;
  }
  return undefined;
}

/**
 * Terminal tools (capability pack "code"): persistent shell sessions and
 * command execution through the real TerminalService. Both the working
 * directory of a session and any one-shot cwd must live inside the execution
 * context's rootPaths. Command policy follows the shared bash classifier:
 * read-level commands run directly, write-level commands require the normal
 * write grant and stay inside the root-only Seatbelt profile, while
 * deny-level commands never run. The registry lifecycle checks the write
 * grant before this implementation is entered.
 */
export function createCodeTerminalTools(): AgentToolDefinition[] {
  const terminals = new Map<string, OwnedTerminal>();

  return [
    {
      name: "terminal.create",
      description: "Create a session-bound coding terminal rooted at a directory inside the project's rootPaths. Every terminal.execute remains pinned to this root and runs in the same fail-closed macOS Seatbelt sandbox as bash; terminal ids cannot cross product sessions.",
      capabilityPack: "code",
      permission: "write",
      parameters: CreateParams,
      execute: async (raw, ctx, deps) => {
        const params = CreateParams.parse(raw);
        const cwd = await assertWithinRoots(params.cwd, ctx.rootPaths);
        const session = await deps.terminal.create({
          cwd,
          ...(params.title !== undefined ? { title: params.title } : {})
        });
        terminals.set(session.id, {
          workspaceId: ctx.workspaceId,
          sessionId: ctx.sessionId,
          root: cwd,
          lastExitCode: null,
          chunks: []
        });
        return succeed("terminal.create", ctx, { session }, { evidenceIds: [`terminal:${session.id}`] });
      }
    },
    {
      name: "terminal.execute",
      description: "Run one shell command in a session-bound terminalId or a one-shot cwd. Exactly one target is required. Commands are deterministically classified, run with a scrubbed environment under macOS Seatbelt, cannot write outside the bound project root or use network access, and return capped output plus exit status.",
      capabilityPack: "code",
      permission: "write",
      parameters: ExecuteParams,
      execute: async (raw, ctx, deps, signal) => {
        const params = ExecuteParams.parse(raw);
        if ((params.terminalId === undefined) === (params.cwd === undefined)) {
          throw toolError("INVALID", "pass exactly one of terminalId (session command) or cwd (one-shot command)");
        }
        const sessionTarget = params.terminalId !== undefined
          ? await requireOwnedTerminal(terminals, params.terminalId, ctx, deps)
          : undefined;
        const cwd = sessionTarget?.cwd
          ?? await assertWithinRoots(params.cwd!, ctx.rootPaths);
        const classification = classifyBashCommand(params.command, {
          workspaceRoot: cwd
        });
        if (classification.verdict === "deny") {
          throw toolError(
            "PERMISSION_DENIED",
            `command is deny-classified and never runs (${classification.reason}); do not try to work around this`
          );
        }
        const checkpointId = classification.verdict === "read"
          ? undefined
          : await checkpointRepositoryMutation(cwd, params.command, ctx, deps);
        const result = await executeSandboxedBash(
          { workspaceRoot: cwd },
          {
            command: params.command,
            ...(params.timeoutMs !== undefined ? { timeout: params.timeoutMs / 1_000 } : {})
          },
          signal
        );
        if (sessionTarget) {
          sessionTarget.owned.lastExitCode = result.exitCode;
          sessionTarget.owned.chunks.push({
            seq: (sessionTarget.owned.chunks.at(-1)?.seq ?? 0) + 1,
            ts: Date.now(),
            stream: result.exitCode === 0 ? "stdout" : "stderr",
            data: result.output
          });
          if (sessionTarget.owned.chunks.length > 200) {
            sessionTarget.owned.chunks.splice(0, sessionTarget.owned.chunks.length - 200);
          }
        }
        return succeed("terminal.execute", ctx, {
          classification: {
            verdict: result.classification.verdict,
            reason: result.classification.reason
          },
          exitCode: result.exitCode,
          stdout: result.exitCode === 0 ? result.output : "",
          stderr: result.exitCode === 0 ? "" : result.output,
          durationMs: result.durationMs,
          timedOut: false,
          truncated: result.truncated,
          sandboxed: true,
          ...(checkpointId ? { checkpointId } : {})
        }, checkpointId ? { evidenceIds: [`git-checkpoint:${checkpointId}`] } : {});
      }
    },
    {
      name: "terminal.get_output",
      description: "Read capped results from prior terminal.execute calls in this exact product session, optionally only after a sequence number.",
      capabilityPack: "code",
      permission: "read",
      parameters: SessionParams.extend({ sinceSeq: z.number().int().nonnegative().optional() }),
      execute: async (raw, ctx, deps) => {
        const params = SessionParams.extend({ sinceSeq: z.number().int().nonnegative().optional() }).parse(raw);
        const { owned, running } = await requireOwnedTerminal(terminals, params.terminalId, ctx, deps);
        const chunks = params.sinceSeq === undefined
          ? [...owned.chunks]
          : owned.chunks.filter((chunk) => chunk.seq > params.sinceSeq!);
        return succeed("terminal.get_output", ctx, { chunks, running });
      }
    },
    {
      name: "terminal.get_exit_status",
      description: "Check whether a terminal session is still running and its exit code once it exited.",
      capabilityPack: "code",
      permission: "read",
      parameters: SessionParams,
      execute: async (raw, ctx, deps) => {
        const params = SessionParams.parse(raw);
        const session = await requireOwnedTerminal(terminals, params.terminalId, ctx, deps);
        return succeed("terminal.get_exit_status", ctx, {
          terminalId: params.terminalId,
          running: session.running,
          exitCode: session.owned.lastExitCode ?? session.exitCode
        });
      }
    },
    {
      name: "terminal.interrupt",
      description: "Send SIGINT to a terminal session's process group. Use to stop a running command without killing the session.",
      capabilityPack: "code",
      permission: "write",
      parameters: SessionParams,
      execute: async (raw, ctx, deps) => {
        const params = SessionParams.parse(raw);
        await requireOwnedTerminal(terminals, params.terminalId, ctx, deps);
        deps.terminal.interrupt(params.terminalId);
        return succeed("terminal.interrupt", ctx, { terminalId: params.terminalId, interrupted: true });
      }
    },
    {
      name: "terminal.close",
      description: "Terminate a terminal session and free its slot (SIGTERM, then SIGKILL after a grace period). Use when the shell work is done.",
      capabilityPack: "code",
      permission: "write",
      parameters: SessionParams,
      execute: async (raw, ctx, deps) => {
        const params = SessionParams.parse(raw);
        await requireOwnedTerminal(terminals, params.terminalId, ctx, deps);
        await deps.terminal.kill(params.terminalId);
        terminals.delete(params.terminalId);
        return succeed("terminal.close", ctx, { terminalId: params.terminalId, closed: true });
      }
    }
  ];
}
