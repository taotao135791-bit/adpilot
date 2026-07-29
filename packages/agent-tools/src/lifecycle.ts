import { randomUUID } from "node:crypto";
import type { AgentExecutionContext, AgentExecutionPermissions } from "./context.js";
import type { AgentToolDeps } from "./deps.js";
import { updateKernelTask } from "./kernel-internal.js";
import { redactParams } from "./redact.js";
import type { AgentToolDefinition } from "./registry.js";
import {
  INVALID_PARAMS,
  PERMISSION_DENIED,
  errorCodeOf,
  errorMessageOf,
  recoverableForCode,
  type AgentToolResult
} from "./result.js";

/**
 * Unified per-call lifecycle (toPiTools runs this for every tool call):
 *
 *   inject toolCallId + startedAt
 *   → permission re-check (second gate, independent of registry filtering)
 *   → zod-parse the parameters (INVALID_PARAMS is recoverable)
 *   → execute against the real subsystem
 *   → audit (action `agent_tool:<name>`, redacted parameter summary)
 *   → task write-back (terminal/git/artifact write successes attach an
 *     evidence summary to the kernel task's evidenceIds)
 *   → assemble the AgentToolResult
 *
 * A throwing execute never escapes: it becomes an error result whose
 * recoverability follows the error code (NOT_FOUND/INVALID recoverable,
 * PERMISSION_DENIED not).
 */
export async function runAgentToolCall(
  definition: AgentToolDefinition,
  rawParams: unknown,
  ctx: AgentExecutionContext,
  deps: AgentToolDeps
): Promise<AgentToolResult> {
  const toolCallId = randomUUID();
  const startedAt = deps.now().toISOString();

  let result: AgentToolResult;
  if (!permissionGranted(definition.permission, ctx.permissions)) {
    result = fail(
      definition,
      ctx,
      toolCallId,
      startedAt,
      PERMISSION_DENIED,
      `tool ${definition.name} requires "${definition.permission}" permission, which this execution context does not grant; ask the user to grant it instead of retrying`,
      false,
      deps
    );
  } else {
    const parsed = definition.parameters.safeParse(rawParams ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ");
      result = fail(definition, ctx, toolCallId, startedAt, INVALID_PARAMS, `invalid parameters: ${issues}`, true, deps);
    } else {
      try {
        const draft = await definition.execute(parsed.data, ctx, deps);
        result = {
          ...draft,
          success: true,
          toolCallId,
          startedAt,
          completedAt: deps.now().toISOString()
        };
      } catch (error) {
        const code = errorCodeOf(error);
        result = fail(definition, ctx, toolCallId, startedAt, code, errorMessageOf(error), recoverableForCode(code), deps);
      }
    }
  }

  try {
    result.auditEventId = await deps.audit(ctx.workspaceId, `agent_tool:${definition.name}`, {
      tool: definition.name,
      capabilityPack: definition.capabilityPack,
      permission: definition.permission,
      toolCallId,
      success: result.success,
      ...(ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
      ...(ctx.goalId !== undefined ? { goalId: ctx.goalId } : {}),
      ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
      sessionId: ctx.sessionId,
      params: redactParams(rawParams ?? {}),
      ...(result.error ? { error: result.error } : {})
    });
  } catch {
    // Auditing must never break a tool call; auditEventId stays undefined.
  }

  if (
    result.success
    && ctx.taskId !== undefined
    && (definition.permission === "write" || definition.permission === "destructive")
    && WRITEBACK_PACKS.has(definition.capabilityPack)
  ) {
    const summaryId = `agent-tool:${definition.name}:${toolCallId}`;
    try {
      await updateKernelTask(deps.kernel, ctx.taskId, deps.now(), (task) => ({
        evidenceIds: [...new Set([...task.evidenceIds, summaryId, ...result.evidenceIds])]
      }));
      result.evidenceIds = [summaryId, ...result.evidenceIds];
    } catch {
      // The orchestrator's conversation tasks do not live in the kernel task
      // store; evidence attachment is best-effort for kernel-backed tasks.
    }
  }

  return result;
}

/** Packs whose successful writes attach an evidence summary to the running task. */
const WRITEBACK_PACKS = new Set(["code", "git", "artifact"]);

/** Second permission gate, independent of the registry's visibility filter. */
export function permissionGranted(permission: AgentToolDefinition["permission"], permissions: AgentExecutionPermissions): boolean {
  switch (permission) {
    case "read":
      return permissions.read;
    case "write":
      return permissions.write;
    case "destructive":
      return permissions.destructive;
    case "computer-use":
      return permissions.computerUse;
  }
}

function fail(
  definition: AgentToolDefinition,
  ctx: AgentExecutionContext,
  toolCallId: string,
  startedAt: string,
  code: string,
  message: string,
  recoverable: boolean,
  deps: AgentToolDeps
): AgentToolResult {
  return {
    success: false,
    toolCallId,
    tool: definition.name,
    workspaceId: ctx.workspaceId,
    ...(ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
    ...(ctx.goalId !== undefined ? { goalId: ctx.goalId } : {}),
    ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
    sessionId: ctx.sessionId,
    error: { code, message, recoverable },
    evidenceIds: [],
    artifactIds: [],
    startedAt,
    completedAt: deps.now().toISOString()
  };
}
