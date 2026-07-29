import { z } from "zod";
import { classifyBashCommand } from "@adpilot/shared";
import type { AgentToolDefinition } from "../registry.js";
import { assertWithinRoots } from "../paths.js";
import { succeed } from "../result.js";
import { toolError } from "../errors.js";

const CreateParams = z.object({
  cwd: z.string().min(1),
  title: z.string().min(1).optional(),
  env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
});

const ExecuteParams = z.object({
  terminalId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional()
});

const SessionParams = z.object({ terminalId: z.string().min(1) });

/**
 * Terminal tools (capability pack "code"): persistent shell sessions and
 * command execution through the real TerminalService. Both the working
 * directory of a session and any one-shot cwd must live inside the execution
 * context's rootPaths. Command policy follows the shared bash classifier:
 * read-level commands run directly, write-level commands require the
 * destructive grant (a refusal is PERMISSION_DENIED, recoverable=false, so
 * the agent asks the user instead of retrying), deny-level commands never run.
 */
export function createCodeTerminalTools(): AgentToolDefinition[] {
  return [
    {
      name: "terminal.create",
      description: "Open a persistent terminal session rooted at a directory inside the project's rootPaths. Use for multi-step shell work; cwd persists across terminal.execute calls on the session.",
      capabilityPack: "code",
      permission: "write",
      parameters: CreateParams,
      execute: async (raw, ctx, deps) => {
        const params = CreateParams.parse(raw);
        const cwd = await assertWithinRoots(params.cwd, ctx.rootPaths);
        const session = await deps.terminal.create({
          cwd,
          ...(params.title !== undefined ? { title: params.title } : {}),
          ...(params.env !== undefined ? { env: params.env } : {})
        });
        return succeed("terminal.create", ctx, { session }, { evidenceIds: [`terminal:${session.id}`] });
      }
    },
    {
      name: "terminal.execute",
      description: "Run a shell command in an existing terminal session (terminalId) or as a one-shot (cwd). Read-level commands run directly; write-level commands need the destructive permission; deny-level commands are refused. Returns exit code, stdout, stderr.",
      capabilityPack: "code",
      permission: "write",
      parameters: ExecuteParams,
      execute: async (raw, ctx, deps) => {
        const params = ExecuteParams.parse(raw);
        if (params.terminalId === undefined && params.cwd === undefined) {
          throw toolError("INVALID", "pass terminalId (session command) or cwd (one-shot command)");
        }
        const classification = classifyBashCommand(params.command, {
          ...(params.cwd !== undefined ? { workspaceRoot: params.cwd } : {})
        });
        if (classification.verdict === "deny") {
          throw toolError(
            "PERMISSION_DENIED",
            `command is deny-classified and never runs (${classification.reason}); do not try to work around this`
          );
        }
        if (classification.verdict !== "read" && !ctx.permissions.destructive) {
          throw toolError(
            "PERMISSION_DENIED",
            `command is ${classification.verdict}-classified (${classification.reason}) and this context lacks the destructive permission; ask the user to run it or to grant the permission`
          );
        }
        const target = params.terminalId !== undefined
          ? params.terminalId
          : { cwd: await assertWithinRoots(params.cwd!, ctx.rootPaths) };
        const result = await deps.terminal.exec(target, params.command, {
          ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
          approved: classification.verdict !== "read"
        });
        return succeed("terminal.execute", ctx, {
          classification: { verdict: classification.verdict, reason: classification.reason },
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timedOut: result.timedOut
        });
      }
    },
    {
      name: "terminal.get_output",
      description: "Read a terminal session's buffered stdout/stderr chunks, optionally only after a sequence number. Use to poll a long-running command's progress.",
      capabilityPack: "code",
      permission: "read",
      parameters: SessionParams.extend({ sinceSeq: z.number().int().nonnegative().optional() }),
      execute: async (raw, ctx, deps) => {
        const params = SessionParams.extend({ sinceSeq: z.number().int().nonnegative().optional() }).parse(raw);
        const output = deps.terminal.output(params.terminalId, params.sinceSeq);
        return succeed("terminal.get_output", ctx, output);
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
        const session = deps.terminal.list().find((candidate) => candidate.id === params.terminalId);
        if (!session) throw toolError("TERMINAL_NOT_FOUND", `terminal session not found: ${params.terminalId}`);
        return succeed("terminal.get_exit_status", ctx, {
          terminalId: session.id,
          running: session.running,
          exitCode: session.exitCode
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
        await deps.terminal.kill(params.terminalId);
        return succeed("terminal.close", ctx, { terminalId: params.terminalId, closed: true });
      }
    }
  ];
}
