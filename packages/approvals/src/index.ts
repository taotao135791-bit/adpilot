import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { RiskLevel, stableJson, systemClock, type Clock } from "@adpilot/shared";
import { WorkspaceStore } from "@adpilot/workspace";

export const ApprovalOperation = z.object({
  account: z.string().min(1),
  campaign: z.string().min(1),
  operation: z.string().min(1),
  currentValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  proposedValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  changePercentage: z.number().nullable(),
  reason: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
  expectedImpact: z.string().min(1),
  observationWindow: z.string().min(1),
  rollbackCondition: z.string().min(1),
  riskLevel: RiskLevel
});
export type ApprovalOperation = z.infer<typeof ApprovalOperation>;

export const Approval = z.object({
  id: z.string().uuid(),
  clientId: z.string().min(1),
  taskId: z.string().uuid(),
  operation: ApprovalOperation,
  fingerprint: z.string().min(1),
  status: z.enum(["pending_risk_review", "rejected", "pending_user", "approved", "executing", "executed", "failed", "expired", "cancelled"]),
  riskReview: z.object({ reviewer: z.literal("risk_reviewer"), approved: z.boolean(), reason: z.string().min(1), at: z.string().datetime() }).nullable(),
  userApproval: z.object({ approvedBy: z.string().min(1), at: z.string().datetime() }).nullable(),
  tokenNonceHash: z.string().nullable(),
  tokenExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type Approval = z.infer<typeof Approval>;

export class ApprovalError extends Error {}

export class ApprovalService {
  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly secret: string,
    private readonly clock: Clock = systemClock
  ) {
    if (secret.length < 32) throw new Error("approval secret must be at least 32 characters");
  }

  async create(clientId: string, taskId: string, operationInput: ApprovalOperation): Promise<Approval> {
    const operation = ApprovalOperation.parse(operationInput);
    const now = this.clock.now().toISOString();
    const approval = Approval.parse({
      id: crypto.randomUUID(), clientId, taskId, operation,
      fingerprint: this.fingerprint(operation), status: "pending_risk_review",
      riskReview: null, userApproval: null, tokenNonceHash: null, tokenExpiresAt: null,
      createdAt: now, updatedAt: now
    });
    await this.persist(approval);
    await this.workspace.appendJsonl(clientId, "approvals/index.jsonl", { id: approval.id });
    return approval;
  }

  async recordRiskReview(clientId: string, id: string, approved: boolean, reason: string): Promise<Approval> {
    const current = await this.get(clientId, id);
    if (current.status !== "pending_risk_review") throw new ApprovalError("approval is not awaiting risk review");
    const at = this.clock.now().toISOString();
    return this.update(current, {
      status: approved ? "pending_user" : "rejected",
      riskReview: { reviewer: "risk_reviewer", approved, reason, at }, updatedAt: at
    });
  }

  async approveByUser(clientId: string, id: string, approvedBy: string): Promise<{ approval: Approval; token: string }> {
    const current = await this.get(clientId, id);
    if (current.status !== "pending_user" || !current.riskReview?.approved) throw new ApprovalError("risk review must approve before user approval");
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + 5 * 60_000);
    const nonce = crypto.randomUUID();
    const payload = `${current.id}.${Math.floor(expiresAt.getTime() / 1000)}.${nonce}`;
    const signature = this.sign(`${payload}.${current.fingerprint}`);
    const token = `${payload}.${signature}`;
    const approval = await this.update(current, {
      status: "approved",
      userApproval: { approvedBy, at: now.toISOString() },
      tokenNonceHash: this.sign(nonce),
      tokenExpiresAt: expiresAt.toISOString(),
      updatedAt: now.toISOString()
    });
    return { approval, token };
  }

  async consume(clientId: string, id: string, token: string, exactOperation: ApprovalOperation): Promise<Approval> {
    const current = await this.get(clientId, id);
    if (current.status !== "approved") throw new ApprovalError("approval token is not usable");
    if (this.fingerprint(ApprovalOperation.parse(exactOperation)) !== current.fingerprint) throw new ApprovalError("operation no longer matches approval");
    const parts = token.split(".");
    if (parts.length !== 4) throw new ApprovalError("invalid approval token");
    const [tokenId, expiry, nonce, signature] = parts as [string, string, string, string];
    if (tokenId !== id || !/^\d+$/.test(expiry)) throw new ApprovalError("approval token binding mismatch");
    const expected = this.sign(`${tokenId}.${expiry}.${nonce}.${current.fingerprint}`);
    if (!safeEqual(signature, expected) || !safeEqual(this.sign(nonce), current.tokenNonceHash ?? "")) throw new ApprovalError("invalid approval token signature");
    const now = this.clock.now();
    if (now.getTime() >= Number(expiry) * 1000 || !current.tokenExpiresAt || now >= new Date(current.tokenExpiresAt)) {
      await this.update(current, { status: "expired", updatedAt: now.toISOString(), tokenNonceHash: null });
      throw new ApprovalError("approval token expired");
    }
    return this.update(current, { status: "executing", updatedAt: now.toISOString(), tokenNonceHash: null });
  }

  async finish(clientId: string, id: string, succeeded: boolean): Promise<Approval> {
    const current = await this.get(clientId, id);
    if (current.status !== "executing") throw new ApprovalError("approval is not executing");
    return this.update(current, { status: succeeded ? "executed" : "failed", updatedAt: this.clock.now().toISOString() });
  }

  async get(clientId: string, id: string): Promise<Approval> {
    return this.workspace.readJson(clientId, `approvals/${id}.json`, Approval);
  }

  async list(clientId: string): Promise<Approval[]> {
    const index = await this.workspace.readJsonl(clientId, "approvals/index.jsonl", z.object({ id: z.string().uuid() }));
    const unique = [...new Set(index.map(({ id }) => id))];
    return Promise.all(unique.map((id) => this.get(clientId, id)));
  }

  private fingerprint(operation: ApprovalOperation): string {
    return this.sign(stableJson({
      account: operation.account,
      campaign: operation.campaign,
      operation: operation.operation,
      currentValue: operation.currentValue,
      proposedValue: operation.proposedValue
    }));
  }

  private sign(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }

  private async persist(approval: Approval): Promise<void> {
    await this.workspace.writeJson(approval.clientId, `approvals/${approval.id}.json`, approval);
  }

  private async update(current: Approval, patch: Partial<Approval>): Promise<Approval> {
    const next = Approval.parse({ ...current, ...patch });
    await this.persist(next);
    return next;
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
