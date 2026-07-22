import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Platform, RiskLevel, stableJson, systemClock, type Clock } from "@adpilot/shared";
import { WorkspaceStore } from "@adpilot/workspace";
import { ChangeGuardrailInput, evaluateChangeGuardrail } from "@adpilot/advertising-core";

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

const ExecutionValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const Sha256Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);

const GuardrailDecision = z.object({
  allowed: z.boolean(),
  changePercent: z.number().finite(),
  cappedValue: z.number().finite(),
  reasons: z.array(z.string()),
  requiresFreshReview: z.boolean()
}).strict();

export const ApprovalGuardrailRequest = z.object({
  input: ChangeGuardrailInput,
  evidenceFactIds: z.array(z.string().min(1)).min(1),
  singleVariable: z.boolean()
}).strict();
export type ApprovalGuardrailRequest = z.infer<typeof ApprovalGuardrailRequest>;

export const ApprovalGuardrail = z.object({
  input: ChangeGuardrailInput,
  decision: GuardrailDecision,
  evidenceFactIds: z.array(z.string().min(1)).min(1),
  singleVariable: z.boolean(),
  operationFingerprint: Sha256Fingerprint,
  evaluatedAt: z.string().datetime()
}).strict();
export type ApprovalGuardrail = z.infer<typeof ApprovalGuardrail>;

export const VisualAllowedRegion = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  coordinateSpace: z.enum(["screenshot_pixels", "screen_points"])
}).strict();
export type VisualAllowedRegion = z.infer<typeof VisualAllowedRegion>;

const visualExecutionPlanShape = {
  schemaVersion: z.literal(1),
  planId: z.string().uuid(),
  taskId: z.string().uuid(),
  clientId: z.string().min(1),
  platform: Platform,
  browserProfile: z.string().min(1),
  applicationId: z.string().min(1),
  applicationName: z.string().min(1),
  windowId: z.string().min(1),
  domain: z.string().min(1).nullable(),
  allowedApplications: z.array(z.string().min(1)).min(1),
  allowedDomains: z.array(z.string().min(1)),
  accountName: z.string().min(1),
  accountId: z.string().min(1),
  campaignName: z.string().min(1),
  campaignId: z.string().min(1),
  pageType: z.string().min(1),
  operation: z.string().min(1),
  currentValue: ExecutionValue,
  proposedValue: ExecutionValue,
  instruction: z.string().min(1),
  target: z.string().min(1),
  expectedResult: z.string().min(1),
  allowedRegion: VisualAllowedRegion,
  riskLevel: RiskLevel,
  surfaceFingerprint: Sha256Fingerprint,
  accountFingerprint: Sha256Fingerprint,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
} as const;

/**
 * Stable contract for the complete visual work approved by the user.
 *
 * This schema is deliberately strict: accepting and silently stripping a new
 * execution field would leave that field outside the approval fingerprint.
 */
export const VisualExecutionPlan = z.object(visualExecutionPlanShape).strict().superRefine(validatePlanLifetime);
export type VisualExecutionPlan = z.infer<typeof VisualExecutionPlan>;

export const ApprovalExperiment = z.object({
  hypothesis: z.string().min(1),
  variable: z.string().min(1),
  baseline: z.record(z.number()),
  expected: z.string().min(1),
  successCriteria: z.string().min(1),
  failureCriteria: z.string().min(1),
  maturityWindowDays: z.number().int().positive(),
  rollbackCondition: z.string().min(1),
  reviewAt: z.string().datetime()
}).strict();

/** A visual execution contract plus the experiment created after success. */
export const ApprovalExecutionPlan = z.object({
  ...visualExecutionPlanShape,
  experiment: ApprovalExperiment
}).strict().superRefine(validatePlanLifetime);
export type ApprovalExecutionPlan = z.infer<typeof ApprovalExecutionPlan>;

/** Remove non-execution metadata before generating or checking the fingerprint. */
export function extractVisualExecutionPlan(planInput: ApprovalExecutionPlan): VisualExecutionPlan {
  const { experiment: _experiment, ...visualPlan } = ApprovalExecutionPlan.parse(planInput);
  return VisualExecutionPlan.parse(visualPlan);
}

/** SHA-256 over every accepted execution field in canonical key order. */
export function executionPlanFingerprint(planInput: VisualExecutionPlan): string {
  const plan = VisualExecutionPlan.parse(planInput);
  return createHash("sha256").update(stableJson(plan)).digest("hex");
}

export const ApprovalTokenBinding = z.object({
  schemaVersion: z.literal(2),
  approvalId: z.string().uuid(),
  clientId: z.string().min(1),
  taskId: z.string().uuid(),
  planId: z.string().uuid(),
  platform: Platform,
  browserProfile: z.string().min(1),
  applicationId: z.string().min(1),
  windowId: z.string().min(1),
  accountName: z.string().min(1),
  accountId: z.string().min(1),
  campaignName: z.string().min(1),
  campaignId: z.string().min(1),
  pageType: z.string().min(1),
  operation: z.string().min(1),
  currentValue: ExecutionValue,
  proposedValue: ExecutionValue,
  riskLevel: RiskLevel,
  surfaceFingerprint: Sha256Fingerprint,
  accountFingerprint: Sha256Fingerprint,
  executionPlanFingerprint: Sha256Fingerprint,
  guardrailFingerprint: Sha256Fingerprint.optional(),
  expiresAt: z.string().datetime(),
  maxAttempts: z.literal(1)
}).strict();
export type ApprovalTokenBinding = z.infer<typeof ApprovalTokenBinding>;

const ApprovalV2 = z.object({
  schemaVersion: z.literal(2),
  id: z.string().uuid(),
  clientId: z.string().min(1),
  taskId: z.string().uuid(),
  operation: ApprovalOperation,
  guardrail: ApprovalGuardrail.nullable().default(null),
  guardrailFingerprint: Sha256Fingerprint.nullable().default(null),
  executionPlan: ApprovalExecutionPlan.nullable().default(null),
  executionPlanFingerprint: Sha256Fingerprint.nullable().default(null),
  legacyExecutionPlan: z.unknown().optional(),
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

/**
 * Old persisted approvals remain readable for audit/recovery, but their
 * incomplete plans and tokens are converted to terminal, non-executable data.
 */
export const Approval = z.preprocess((input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (record.schemaVersion === 2) return record;
  const previousStatus = record.status;
  return {
    ...record,
    schemaVersion: 2,
    executionPlan: null,
    executionPlanFingerprint: null,
    guardrail: null,
    guardrailFingerprint: null,
    ...(record.executionPlan == null ? {} : { legacyExecutionPlan: record.executionPlan }),
    tokenBinding: null,
    tokenNonceHash: null,
    status: previousStatus === "approved" ? "cancelled" : previousStatus === "executing" ? "failed" : previousStatus
  };
}, ApprovalV2);
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

  async create(
    clientId: string,
    taskId: string,
    operationInput: ApprovalOperation,
    planInput?: ApprovalExecutionPlan,
    guardrailInput?: ApprovalGuardrailRequest
  ): Promise<Approval> {
    const operation = ApprovalOperation.parse(operationInput);
    validateNumericChange(operation);
    const executionPlan = planInput ? ApprovalExecutionPlan.parse(planInput) : null;
    const nowDate = this.clock.now();
    if (executionPlan) {
      const visualPlan = extractVisualExecutionPlan(executionPlan);
      validateExecutionPlanContext(visualPlan, operation, clientId, taskId);
      if (nowDate >= new Date(visualPlan.expiresAt)) throw new ApprovalError("visual execution plan is already expired");
      if (new Date(visualPlan.createdAt).getTime() > nowDate.getTime() + 30_000) {
        throw new ApprovalError("visual execution plan creation time is in the future");
      }
    }
    const planFingerprint = executionPlan ? executionPlanFingerprint(extractVisualExecutionPlan(executionPlan)) : null;
    const now = nowDate.toISOString();
    const guardrail = guardrailInput ? buildApprovalGuardrail(operation, guardrailInput, now) : null;
    if (operation.riskLevel === "mutate" || operation.riskLevel === "destructive") {
      if (!guardrail) throw new ApprovalError("a deterministic guardrail attestation is required for mutations");
      assertGuardrailAllowsOperation(operation, guardrail);
    }
    const boundGuardrailFingerprint = guardrail ? approvalGuardrailFingerprint(guardrail) : null;
    const approval = Approval.parse({
      schemaVersion: 2, id: crypto.randomUUID(), clientId, taskId, operation, executionPlan,
      executionPlanFingerprint: planFingerprint,
      guardrail,
      guardrailFingerprint: boundGuardrailFingerprint,
      fingerprint: this.operationFingerprint(operation), status: "pending_risk_review",
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
    if (approved) assertStoredGuardrail(current);
    const at = this.clock.now().toISOString();
    return this.update(current, {
      status: approved ? "pending_user" : "rejected",
      riskReview: { reviewer: "risk_reviewer", approved, reason, at }, updatedAt: at
    });
  }

  async approveByUser(clientId: string, id: string, approvedBy: string): Promise<{ approval: Approval; token: string }> {
    const current = await this.get(clientId, id);
    if (current.status !== "pending_user" || !current.riskReview?.approved) throw new ApprovalError("risk review must approve before user approval");
    if (!current.executionPlan || !current.executionPlanFingerprint) {
      throw new ApprovalError("a complete visual execution plan is required before user approval");
    }
    assertStoredGuardrail(current);
    const visualPlan = extractVisualExecutionPlan(current.executionPlan);
    validateExecutionPlanContext(visualPlan, current.operation, current.clientId, current.taskId);
    const recalculatedFingerprint = executionPlanFingerprint(visualPlan);
    if (!safeEqual(recalculatedFingerprint, current.executionPlanFingerprint)) {
      await this.invalidate(current, "failed");
      throw new ApprovalError("stored visual execution plan fingerprint is invalid");
    }
    const now = this.clock.now();
    const planExpiresAt = new Date(visualPlan.expiresAt);
    if (now >= planExpiresAt) {
      await this.update(current, { status: "expired", updatedAt: now.toISOString() });
      throw new ApprovalError("visual execution plan expired before approval");
    }
    const expiresAt = new Date(Math.min(now.getTime() + 5 * 60_000, planExpiresAt.getTime()));
    const nonce = crypto.randomUUID();
    const binding = ApprovalTokenBinding.parse({
      schemaVersion: 2,
      approvalId: current.id,
      clientId: current.clientId,
      taskId: current.taskId,
      planId: visualPlan.planId,
      platform: visualPlan.platform,
      browserProfile: visualPlan.browserProfile,
      applicationId: visualPlan.applicationId,
      windowId: visualPlan.windowId,
      accountName: visualPlan.accountName,
      accountId: visualPlan.accountId,
      campaignName: visualPlan.campaignName,
      campaignId: visualPlan.campaignId,
      pageType: visualPlan.pageType,
      operation: visualPlan.operation,
      currentValue: visualPlan.currentValue,
      proposedValue: visualPlan.proposedValue,
      riskLevel: visualPlan.riskLevel,
      surfaceFingerprint: visualPlan.surfaceFingerprint,
      accountFingerprint: visualPlan.accountFingerprint,
      executionPlanFingerprint: recalculatedFingerprint,
      guardrailFingerprint: current.guardrailFingerprint!,
      expiresAt: expiresAt.toISOString(),
      maxAttempts: 1
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

  /**
   * Check the complete actual plan without consuming a valid token. A mismatch
   * still destroys an approved token so callers cannot probe and then retry.
   */
  async verifyExecutionPlan(clientId: string, id: string, actualPlan: VisualExecutionPlan): Promise<{
    approval: Approval;
    approvedFingerprint: string;
    actualFingerprint: string;
  }> {
    const current = await this.get(clientId, id);
    if (current.status !== "approved") throw new ApprovalError("approval token is not usable");
    const parsed = await this.assertExactExecutionPlan(current, actualPlan);
    return {
      approval: current,
      approvedFingerprint: current.executionPlanFingerprint!,
      actualFingerprint: executionPlanFingerprint(parsed)
    };
  }

  async consume(
    clientId: string,
    id: string,
    token: string,
    exactOperation: ApprovalOperation,
    actualPlan: VisualExecutionPlan | string
  ): Promise<Approval> {
    const current = await this.get(clientId, id);
    if (current.status !== "approved") throw new ApprovalError("approval token is not usable");
    if (!current.tokenBinding || current.tokenAttempts >= current.tokenBinding.maxAttempts) {
      await this.invalidate(current, "failed");
      throw new ApprovalError("approval token attempt limit reached");
    }
    if (this.operationFingerprint(ApprovalOperation.parse(exactOperation)) !== current.fingerprint) {
      await this.invalidate(current, "failed");
      throw new ApprovalError("operation no longer matches approval");
    }
    try { assertStoredGuardrail(current); }
    catch (error) {
      await this.invalidate(current, "failed");
      throw error;
    }
    if (typeof actualPlan === "string") {
      await this.invalidate(current, "cancelled");
      throw new ApprovalError("a complete actual visual execution plan is required; a surface fingerprint alone is insufficient");
    }
    await this.assertExactExecutionPlan(current, actualPlan);
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
    if (tokenBinding.approvalId !== id || stableJson(tokenBinding) !== stableJson(current.tokenBinding)
      || !tokenBinding.guardrailFingerprint || !current.guardrailFingerprint
      || !safeEqual(tokenBinding.guardrailFingerprint, current.guardrailFingerprint)
      || !safeEqual(signature, expected) || !safeEqual(this.sign(nonce), current.tokenNonceHash ?? "")) {
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

  /** Tokens live only in process memory; restart makes interrupted states terminal and non-replayable. */
  async recoverInterrupted(clientId: string): Promise<Approval[]> {
    const approvals = await this.list(clientId);
    const recovered: Approval[] = [];
    for (const approval of approvals) {
      if (approval.status === "approved") recovered.push(await this.invalidate(approval, "cancelled"));
      else if (approval.status === "executing") recovered.push(await this.invalidate(approval, "failed"));
    }
    return recovered;
  }

  private operationFingerprint(operation: ApprovalOperation): string {
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

  private async assertExactExecutionPlan(current: Approval, actualPlanInput: VisualExecutionPlan): Promise<VisualExecutionPlan> {
    if (!current.executionPlan || !current.executionPlanFingerprint || !current.tokenBinding) {
      await this.invalidate(current, "failed");
      throw new ApprovalError("approval has no executable visual plan binding");
    }
    let actualPlan: VisualExecutionPlan;
    try {
      actualPlan = VisualExecutionPlan.parse(actualPlanInput);
      validateExecutionPlanContext(actualPlan, current.operation, current.clientId, current.taskId);
    } catch (error) {
      await this.invalidate(current, "cancelled");
      throw new ApprovalError(`actual visual execution plan is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const approvedPlan = extractVisualExecutionPlan(current.executionPlan);
    const approvedFingerprint = executionPlanFingerprint(approvedPlan);
    const actualFingerprint = executionPlanFingerprint(actualPlan);
    const bindingFingerprint = current.tokenBinding.executionPlanFingerprint;
    if (
      !safeEqual(approvedFingerprint, current.executionPlanFingerprint)
      || !safeEqual(bindingFingerprint, current.executionPlanFingerprint)
      || !safeEqual(actualFingerprint, current.executionPlanFingerprint)
    ) {
      await this.invalidate(current, "cancelled");
      throw new ApprovalError("visual execution plan no longer matches approval; prepare and approve a new plan");
    }
    return actualPlan;
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

function validatePlanLifetime(
  plan: { createdAt: string; expiresAt: string },
  context: z.RefinementCtx
): void {
  if (new Date(plan.expiresAt).getTime() <= new Date(plan.createdAt).getTime()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "visual execution plan must expire after it is created"
    });
  }
}

function validateExecutionPlanContext(
  plan: VisualExecutionPlan,
  operation: ApprovalOperation,
  clientId: string,
  taskId: string
): void {
  const mismatches: string[] = [];
  if (plan.clientId !== clientId) mismatches.push("clientId");
  if (plan.taskId !== taskId) mismatches.push("taskId");
  if (plan.platform !== operation.platform) mismatches.push("platform");
  if (plan.accountId !== operation.account) mismatches.push("accountId");
  if (plan.campaignId !== operation.campaign) mismatches.push("campaignId");
  if (plan.operation !== operation.operation) mismatches.push("operation");
  if (stableJson(plan.currentValue) !== stableJson(operation.currentValue)) mismatches.push("currentValue");
  if (stableJson(plan.proposedValue) !== stableJson(operation.proposedValue)) mismatches.push("proposedValue");
  if (plan.riskLevel !== operation.riskLevel) mismatches.push("riskLevel");
  if (!plan.allowedApplications.includes(plan.applicationId) && !plan.allowedApplications.includes(plan.applicationName)) {
    mismatches.push("allowedApplications");
  }
  if (plan.domain) {
    const domain = plan.domain.toLowerCase();
    const allowed = plan.allowedDomains.some((candidate) => {
      const normalized = candidate.toLowerCase();
      return domain === normalized || domain.endsWith(`.${normalized}`);
    });
    if (!allowed) mismatches.push("allowedDomains");
  }
  if (mismatches.length > 0) {
    throw new ApprovalError(`visual execution plan differs from approval context: ${mismatches.join(", ")}`);
  }
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

export function approvalOperationFingerprint(operationInput: ApprovalOperation): string {
  const operation = ApprovalOperation.parse(operationInput);
  return createHash("sha256").update(stableJson({
    platform: operation.platform,
    account: operation.account,
    campaign: operation.campaign,
    operation: operation.operation,
    currentValue: operation.currentValue,
    proposedValue: operation.proposedValue,
    riskLevel: operation.riskLevel
  })).digest("hex");
}

export function approvalGuardrailFingerprint(input: ApprovalGuardrail): string {
  return createHash("sha256").update(stableJson(ApprovalGuardrail.parse(input))).digest("hex");
}

function buildApprovalGuardrail(
  operation: ApprovalOperation,
  input: ApprovalGuardrailRequest,
  evaluatedAt: string
): ApprovalGuardrail {
  const request = ApprovalGuardrailRequest.parse(input);
  const kind = guardrailKindForOperation(operation.operation);
  if (typeof operation.currentValue !== "number" || typeof operation.proposedValue !== "number") {
    throw new ApprovalError("deterministic guardrails currently require numeric current and proposed values");
  }
  if (request.input.kind !== kind || request.input.currentValue !== operation.currentValue || request.input.proposedValue !== operation.proposedValue) {
    throw new ApprovalError("guardrail input does not match the approval operation");
  }
  return ApprovalGuardrail.parse({
    input: request.input,
    decision: evaluateChangeGuardrail(request.input),
    evidenceFactIds: [...new Set(request.evidenceFactIds)].sort(),
    singleVariable: request.singleVariable,
    operationFingerprint: approvalOperationFingerprint(operation),
    evaluatedAt
  });
}

function assertStoredGuardrail(approval: Approval): void {
  if (!approval.guardrail || !approval.guardrailFingerprint) {
    throw new ApprovalError("approval has no deterministic guardrail binding");
  }
  if (!safeEqual(approvalGuardrailFingerprint(approval.guardrail), approval.guardrailFingerprint)) {
    throw new ApprovalError("stored deterministic guardrail fingerprint is invalid");
  }
  assertGuardrailAllowsOperation(approval.operation, approval.guardrail);
}

function assertGuardrailAllowsOperation(operation: ApprovalOperation, guardrail: ApprovalGuardrail): void {
  if (guardrail.operationFingerprint !== approvalOperationFingerprint(operation)) {
    throw new ApprovalError("deterministic guardrail is bound to a different operation");
  }
  const recomputed = GuardrailDecision.parse(evaluateChangeGuardrail(guardrail.input));
  if (stableJson(recomputed) !== stableJson(guardrail.decision)) {
    throw new ApprovalError("deterministic guardrail decision no longer validates");
  }
  if (!guardrail.singleVariable) throw new ApprovalError("single-variable guardrail rejected the operation");
  if (!recomputed.allowed) throw new ApprovalError(`deterministic guardrail rejected the operation: ${recomputed.reasons.join("; ")}`);
  if (recomputed.requiresFreshReview) throw new ApprovalError("deterministic guardrail requires a capped value and fresh review");
}

function guardrailKindForOperation(operation: string): z.infer<typeof ChangeGuardrailInput>["kind"] {
  const normalized = operation.toLowerCase().replaceAll("-", "_");
  if (normalized.includes("target_roas") || normalized.includes("troas")) return "target_roas";
  if (normalized.includes("target_cpa") || normalized.includes("tcpa")) return "target_cpa";
  if (normalized.includes("budget")) return "budget";
  if (normalized.includes("bid")) return "bid";
  throw new ApprovalError(`unsupported guarded operation: ${operation}`);
}
