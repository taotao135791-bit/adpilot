import type { AgentExecutionContext } from "./context.js";

/**
 * Unified result contract for every registry tool call (0.3.1 Integration
 * Release). Success and failure share one shape so the agent, the desktop,
 * and the server can consume outcomes uniformly.
 *
 * `error.recoverable = true` means the agent may read the error, adjust, and
 * keep working (missing entity, invalid params, unavailable engine);
 * `false` means a hard stop that needs the user (permission denial).
 */
export interface AgentToolError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface AgentToolResult<T = unknown> {
  success: boolean;
  toolCallId: string;
  tool: string;
  workspaceId: string;
  projectId?: string;
  goalId?: string;
  taskId?: string;
  sessionId: string;
  data?: T;
  error?: AgentToolError;
  evidenceIds: string[];
  artifactIds: string[];
  auditEventId?: string;
  /** Optional image payload handed to the model alongside the text result
     (pi ImageContent: base64 data + mime type). Only tools that genuinely
     captured pixels (computer.observe) set this. */
  image?: { data: string; mimeType: string };
  startedAt: string;
  completedAt: string;
}

export const PERMISSION_DENIED = "PERMISSION_DENIED";
export const INVALID_PARAMS = "INVALID_PARAMS";
export const EXECUTION_FAILED = "EXECUTION_FAILED";

/**
 * Recoverability mapping from an error code. Domain packages throw coded
 * errors (KernelError, GitToolError, AdsIntelligenceError, TerminalError,
 * AutomationsError, WorkflowError); NOT_FOUND / INVALID codes are recoverable
 * so the agent can correct and retry, while permission denials are not —
 * retrying cannot change the caller's permission grant.
 */
export function recoverableForCode(code: string): boolean {
  if (code === PERMISSION_DENIED || code.endsWith("_DENIED")) return false;
  if (code === "COMMAND_APPROVAL_REQUIRED") return false;
  if (code.endsWith("_ABORTED")) return false;
  return true;
}

/** Extract the stable code from a thrown domain error, if it carries one. */
export function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return EXECUTION_FAILED;
}

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the success draft a tool group's `execute` returns. The lifecycle is
 * authoritative for the envelope (toolCallId, startedAt, completedAt,
 * auditEventId) and overwrites these placeholders before the result leaves
 * the registry — no placeholder can reach a caller.
 */
export function succeed<T>(
  tool: string,
  ctx: AgentExecutionContext,
  data: T,
  extras: { evidenceIds?: readonly string[]; artifactIds?: readonly string[] } = {}
): AgentToolResult<T> {
  return {
    success: true,
    toolCallId: "",
    tool,
    workspaceId: ctx.workspaceId,
    ...(ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
    ...(ctx.goalId !== undefined ? { goalId: ctx.goalId } : {}),
    ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
    sessionId: ctx.sessionId,
    data,
    evidenceIds: [...(extras.evidenceIds ?? [])],
    artifactIds: [...(extras.artifactIds ?? [])],
    startedAt: "",
    completedAt: ""
  };
}
