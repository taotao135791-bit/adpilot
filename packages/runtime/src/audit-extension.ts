import { createHash } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { AuditLog } from "@adpilot/audit";
import type { RuntimeExtension, RuntimeResult, RuntimeRunContext } from "./index.js";

const MAX_ARRAY = 20;
const MAX_DEPTH = 6;

interface AuditStringProjection {
  length: number;
  sha256: string;
}

/**
 * Chains the runtime's factual event stream into the tamper-evident audit log:
 * every tool call and result (structurally projected and size-capped), the final
 * model routing decision (provider/id/tier), and failed runs. This complements
 * traces/*.jsonl, which remains the verbose debugging stream; the audit chain
 * is the compliance record, so every string in an untrusted tool payload is
 * represented only by its length and SHA-256 digest. Screenshot base64,
 * commands, output, queries, and other content therefore never enter the chain.
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
        details: projectToolEventForAudit(event.toolName, "args", event.args)
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
        details: {
          ...projectToolEventForAudit(event.toolName, "result", event.result),
          isError: event.isError
        }
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
      details: { error: projectString(error.message) }
    });
  }
}

/**
 * Keeps the trusted tool identifier useful to operators while projecting the
 * entire untrusted call/result payload through the same fail-closed policy.
 */
function projectToolEventForAudit(toolName: string, field: "args" | "result", value: unknown): Record<string, unknown> {
  return { tool: toolName, [field]: sanitizeForAudit(value) };
}

/**
 * Depth/breadth-capped structural copy safe for the append-only chain.
 *
 * Object keys, arrays, numbers, booleans, and null retain their shape so an
 * event remains auditable. String values are never copied, even when they are
 * short or do not resemble a secret: only length and a full SHA-256 digest are
 * retained. This default-deny rule covers future tools and payload fields
 * without relying on a list of sensitive key names.
 */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  return projectStructure(value, depth);
}

function projectStructure(value: unknown, depth: number): unknown {
  if (typeof value === "string") return projectString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return { omittedAtDepthLimit: true };
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => projectStructure(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push({ omittedItems: value.length - MAX_ARRAY });
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, projectStructure(item, depth + 1)])
    );
  }
  return { unsupportedValue: true };
}

function projectString(value: string): AuditStringProjection {
  return {
    length: value.length,
    sha256: createHash("sha256").update(value).digest("hex")
  };
}
