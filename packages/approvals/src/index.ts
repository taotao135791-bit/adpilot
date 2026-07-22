import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Platform, RiskLevel, stableJson, systemClock, type Clock } from "@adpilot/shared";
import { WorkspaceStore } from "@adpilot/workspace";

export const ApprovalOperation = z.object({
  platform: Platform.default("google_ads"),
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

export const ApprovalExecutionPlan = z.object({
  instruction: z.string().min(1),
  target: z.string().min(1),
  expectedResult: z.string().min(1),
  surface: z.object({
    app: z.string().min(1),
    domain: z.string().min(1).optional(),
    browserProfile: z.string().min(1),
    allowedApps: z.array(z.string().min(1)).min(1),
    allowedDomains: z.array(z.string().min(1)).default([]),
    surfaceFingerprint: z.string().length(64).optional()
  }),
  experiment: z.object({
    hypothesis: z.string().min(1),
    variable: z.string().min(1),
    baseline: z.record(z.number()),
    expected: z.string().min(1),
    successCriteria: z.string().min(1),
    failureCriteria: z.string().min(1),
    maturityWindowDays: z.number().int().positive(),
    rollbackCondition: z.string().min(1),
    reviewAt: z.string().datetime()
  })
});
export type ApprovalExecutionPlan = z.infer<typeof ApprovalExecutionPlan>;

export const ApprovalTokenBinding = z.object({
  approvalId: z.string().uuid(),
  clientId: z.string().min(1),
  platform: Platform,
  accountId: z.string().min(1),
  campaignId: z.string().min(1),
  operation: z.string().min(1),
  currentValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  proposedValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  riskLevel: RiskLevel,
  surfaceFingerprint: z.string().length(64),
  expiresAt: z.string().datetime(),
  maxAttempts: z.literal(1)
});
export type ApprovalTokenBinding = z.infer<typeof ApprovalTokenBinding>;

export const Approval = z.object({
  id: z.string().uuid(),
  clientId: z.string().min(1),
  taskId: z.string().uuid(),
  operation: ApprovalOperation,
  executionPlan: ApprovalExecutionPlan.nullable().default(null),
  fingerprint: z.string().min(1),
  status: z.enum(["pending_risk_review", "rejected", "pending_user", "approved", "executing", "executed", "failed", "expired", "cancelled"]),
  riskReview: z.object({ reviewer: z.literal("risk_reviewer"), approved: z.boolean(), reason: z.string().min(1), at: z.string().datetime() }).nullable(),
  userApproval: z.object({ approvedBy: z.string().min(1), at: z.string().datetime() }).nullable(),
  tokenNonceHash: z.string().nullable(),
  tokenExpiresAt: z.string().datetime().nullable(),
  tokenBinding: ApprovalTokenBinding.nullable().default(null),
  tokenAttempts: z.number().int().nonnegative().default(0),
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

  async create(clientId: string, taskId: string, operationInput: ApprovalOperation, planInput?: ApprovalExecutionPlan): Promise<Approval> {
    const operation = ApprovalOperation.parse(operationInput);
    validateNumericChange(operation);
    const executionPlan = planInput ? ApprovalExecutionPlan.parse(planInput) : null;
    const now = this.clock.now().toISOString();
    const approval = Approval.parse({
      id: crypto.randomUUID(), clientId, taskId, operation, executionPlan,
      fingerprint: this.fingerprint(operation), status: "pending_risk_review",
      riskReview: null, userApproval: null, tokenNonceHash: null, tokenExpiresAt: null,
      tokenBinding: null, tokenAttempts: 0,
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
    const surfaceFingerprint = current.executionPlan?.surface.surfaceFingerprint;
    if (!surfaceFingerprint) throw new ApprovalError("a verified surface fingerprint is required before user approval");
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + 5 * 60_000);
    const nonce = crypto.randomUUID();
    const binding = ApprovalTokenBinding.parse({
      approvalId: current.id, clientId: current.clientId, platform: current.operation.platform,
      accountId: current.operation.account, campaignId: current.operation.campaign,
      operation: current.operation.operation, currentValue: current.operation.currentValue,
      proposedValue: current.operation.proposedValue, riskLevel: current.operation.riskLevel,
      surfaceFingerprint, expiresAt: expiresAt.toISOString(), maxAttempts: 1
    });
    const encodedBinding = Buffer.from(stableJson(binding)).toString("base64url");
    const signature = this.sign(`${encodedBinding}.${nonce}`);
    const token = `${encodedBinding}.${nonce}.${signature}`;
    const approval = await this.update(current, {
      status: "approved",
      userApproval: { approvedBy, at: now.toISOString() },
      tokenNonceHash: this.sign(nonce),
      tokenExpiresAt: expiresAt.toISOString(),
      tokenBinding: binding,
      tokenAttempts: 0,
      updatedAt: now.toISOString()
    });
    return { approval, token };
  }

  async consume(clientId: string, id: string, token: string, exactOperation: ApprovalOperation, liveSurfaceFingerprint: string): Promise<Approval> {
    const current = await this.get(clientId, id);
    if (current.status !== "approved") throw new ApprovalError("approval token is not usable");
    if (!current.tokenBinding || current.tokenAttempts >= current.tokenBinding.maxAttempts) {
      await this.invalidate(current, "failed");
      throw new ApprovalError("approval token attempt limit reached");
    }
    if (this.fingerprint(ApprovalOperation.parse(exactOperation)) !== current.fingerprint) {
      await this.invalidate(current, "failed");
      throw new ApprovalError("operation no longer matches approval");
    }
    if (liveSurfaceFingerprint !== current.tokenBinding.surfaceFingerprint) {
      await this.invalidate(current, "cancelled");
      throw new ApprovalError("surface changed after approval");
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      await this.invalidate(current, "failed");
      throw new ApprovalError("invalid approval token");
    }
    const [encodedBinding, nonce, signature] = parts as [string, string, string];
    let tokenBinding: ApprovalTokenBinding;
    try { tokenBinding = ApprovalTokenBinding.parse(JSON.parse(Buffer.from(encodedBinding, "base64url").toString("utf8"))); }
    catch {
      await this.invalidate(current, "failed");
      throw new ApprovalError("invalid approval token binding");
    }
    const expected = this.sign(`${encodedBinding}.${nonce}`);
    if (tokenBinding.approvalId !== id || stableJson(tokenBinding) !== stableJson(current.tokenBinding) || !safeEqual(signature, expected) || !safeEqual(this.sign(nonce), current.tokenNonceHash ?? "")) {
      await this.invalidate(current, "failed");
      throw new ApprovalError("invalid approval token signature or binding");
    }
    const now = this.clock.now();
    if (!current.tokenExpiresAt || now >= new Date(current.tokenExpiresAt) || now >= new Date(tokenBinding.expiresAt)) {
      await this.update(current, { status: "expired", updatedAt: now.toISOString(), tokenNonceHash: null, tokenAttempts: current.tokenAttempts + 1 });
      throw new ApprovalError("approval token expired");
    }
    return this.update(current, { status: "executing", updatedAt: now.toISOString(), tokenNonceHash: null, tokenAttempts: current.tokenAttempts + 1 });
  }

  async cancel(clientId: string, id: string): Promise<Approval> {
    const current = await this.get(clientId, id);
    if (!['pending_risk_review', 'pending_user', 'approved'].includes(current.status)) throw new ApprovalError("approval can no longer be cancelled");
    return this.invalidate(current, "cancelled");
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
      platform: operation.platform,
      account: operation.account,
      campaign: operation.campaign,
      operation: operation.operation,
      currentValue: operation.currentValue,
      proposedValue: operation.proposedValue,
      riskLevel: operation.riskLevel
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

  private invalidate(current: Approval, status: "failed" | "cancelled"): Promise<Approval> {
    return this.update(current, { status, tokenNonceHash: null, tokenAttempts: current.tokenAttempts + (current.status === "approved" ? 1 : 0), updatedAt: this.clock.now().toISOString() });
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateNumericChange(operation: ApprovalOperation): void {
  if (typeof operation.currentValue !== "number" || typeof operation.proposedValue !== "number") return;
  const calculated = ((operation.proposedValue - operation.currentValue) / operation.currentValue) * 100;
  if (!Number.isFinite(calculated)) throw new ApprovalError("numeric approval values must produce a finite change");
  if (operation.changePercentage === null || Math.abs(calculated - operation.changePercentage) > 0.01) {
    throw new ApprovalError("change percentage does not match current and proposed values");
  }
  if (Math.abs(calculated) > 20.0001) throw new ApprovalError("change exceeds the 20% deterministic safety cap");
}
