import { createHash } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { AuditLog, redactSecrets } from "@adpilot/audit";
import type { RuntimeExtension, RuntimeResult, RuntimeRunContext } from "./index.js";

const MAX_STRING = 512;
const MAX_ARRAY = 20;
const MAX_DEPTH = 6;

/**
 * Chains the runtime's factual event stream into the tamper-evident audit log:
 * every tool call and result (secret-redacted and size-capped), the final
 * model routing decision (provider/id/tier), and failed runs. This complements
 * traces/*.jsonl, which remains the verbose debugging stream; the audit chain
 * is the compliance record, so payloads are hashed and truncated instead of
 * stored verbatim (screenshot base64 never enters the chain).
 */
export class AuditRuntimeExtension implements RuntimeExtension {
  readonly name = "audit";

  constructor(private readonly audit: AuditLog) {}

  async onEvent(event: AgentEvent, context: RuntimeRunContext): Promise<void> {
    if (event.type === "tool_execution_start") {
      await this.audit.append({
        clientId: context.clientId,
        taskId: context.taskId,
        sessionId: context.sessionId,
        actor: context.actor,
        action: "tool_call",
        status: "attempted",
        details: { tool: event.toolName, args: sanitizeForAudit(event.args) }
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      await this.audit.append({
        clientId: context.clientId,
        taskId: context.taskId,
        sessionId: context.sessionId,
        actor: context.actor,
        action: "tool_result",
        status: event.isError ? "failed" : "succeeded",
        details: { tool: event.toolName, isError: event.isError, result: sanitizeForAudit(event.result) }
      });
    }
  }

  async afterRun(result: RuntimeResult, context: RuntimeRunContext): Promise<void> {
    await this.audit.append({
      clientId: context.clientId,
      taskId: context.taskId,
      sessionId: context.sessionId,
      actor: context.actor,
      action: "model_route",
      status: "succeeded",
      details: {
        provider: result.model.provider,
        id: result.model.id,
        tier: result.model.tier,
        recovered: result.recovered,
        compacted: result.compacted ?? false
      }
    });
  }

  async onError(error: Error, context: RuntimeRunContext): Promise<void> {
    await this.audit.append({
      clientId: context.clientId,
      taskId: context.taskId,
      sessionId: context.sessionId,
      actor: context.actor,
      action: "agent_run",
      status: "failed",
      details: { error: error.message.slice(0, MAX_STRING) }
    });
  }
}

/** Secret-redacted, depth/breadth-capped copy safe for the append-only chain. */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  const redacted = redactSecrets(value);
  return cap(redacted, depth);
}

function cap(value: unknown, depth: number): unknown {
  if (typeof value === "string" && value.length > MAX_STRING) {
    const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
    return `[omitted ${value.length} chars sha256:${digest}]`;
  }
  if (depth >= MAX_DEPTH) return "[omitted: depth limit]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => cap(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[omitted ${value.length - MAX_ARRAY} further items]`);
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cap(item, depth + 1)]));
  }
  return value;
}
