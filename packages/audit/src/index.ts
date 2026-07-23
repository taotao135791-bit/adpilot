import { createHash } from "node:crypto";
import { z } from "zod";
import { WorkspaceStore } from "@adpilot/workspace";
import { stableJson } from "@adpilot/shared";

const SECRET_KEY = /(password|passwd|cookie|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|otp|verification[_-]?code|credential)/i;

export const AuditEvent = z.object({
  id: z.string().uuid(),
  clientId: z.string().min(1),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  actor: z.string().min(1),
  action: z.string().min(1),
  status: z.enum(["attempted", "succeeded", "failed", "denied", "cancelled"]),
  at: z.string().datetime(),
  details: z.record(z.unknown()).default({}),
  previousHash: z.string().nullable(),
  hash: z.string().min(1)
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(item)
    ]));
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\b\d{6}\b/g, "[REDACTED_CODE]");
  }
  return value;
}

export class AuditLog {
  /**
   * Internal serialization chain. append() reads the current tail hash before
   * writing, so concurrent appends would otherwise read the same previousHash
   * and fork the hash chain. Every call is queued behind the previous one; a
   * rejected append rejects its own caller without poisoning the queue.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly workspace: WorkspaceStore) {}

  append(input: Omit<AuditEvent, "id" | "at" | "previousHash" | "hash">): Promise<AuditEvent> {
    const appended = this.queue.then(() => this.appendSerialized(input));
    this.queue = appended.catch(() => undefined);
    return appended;
  }

  private async appendSerialized(input: Omit<AuditEvent, "id" | "at" | "previousHash" | "hash">): Promise<AuditEvent> {
    const existing = await this.list(input.clientId);
    const previousHash = existing.at(-1)?.hash ?? null;
    const base = {
      ...input,
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      details: redactSecrets(input.details) as Record<string, unknown>,
      previousHash
    };
    const hash = createHash("sha256").update(stableJson(base)).digest("hex");
    const event = AuditEvent.parse({ ...base, hash });
    await this.workspace.appendJsonl(input.clientId, "audit.jsonl", event);
    return event;
  }

  list(clientId: string): Promise<AuditEvent[]> {
    return this.workspace.readJsonl(clientId, "audit.jsonl", AuditEvent);
  }

  async verify(clientId: string): Promise<boolean> {
    const events = await this.list(clientId);
    let previousHash: string | null = null;
    for (const event of events) {
      if (event.previousHash !== previousHash) return false;
      const { hash, ...base } = event;
      if (createHash("sha256").update(stableJson(base)).digest("hex") !== hash) return false;
      previousHash = hash;
    }
    return true;
  }
}
