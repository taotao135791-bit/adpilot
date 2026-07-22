import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "@adpilot/workspace";
import {
  Approval,
  ApprovalExecutionPlan,
  ApprovalService,
  VisualExecutionPlan as VisualExecutionPlanSchema,
  executionPlanFingerprint,
  extractVisualExecutionPlan,
  type ApprovalGuardrailRequest,
  type ApprovalOperation,
  type VisualExecutionPlan
} from "./index.js";

const operation: ApprovalOperation = {
  platform: "google_ads", account: "acct-1", campaign: "campaign-1", operation: "set_daily_budget",
  currentValue: 100, proposedValue: 110, changePercentage: 10,
  reason: "Mature efficient campaign", evidence: ["screenshot:before"],
  expectedImpact: "Increase qualified volume", observationWindow: "7 days",
  rollbackCondition: "CPA exceeds target by 20%", riskLevel: "mutate"
};

function guardrailFor(
  guardedOperation: ApprovalOperation = operation,
  overrides: Partial<ApprovalGuardrailRequest["input"]> = {}
): ApprovalGuardrailRequest {
  if (typeof guardedOperation.currentValue !== "number" || typeof guardedOperation.proposedValue !== "number") {
    throw new Error("test guardrail requires numeric operation values");
  }
  return {
    input: {
      kind: "budget",
      currentValue: guardedOperation.currentValue,
      proposedValue: guardedOperation.proposedValue,
      maxChangePercent: 20,
      activeExperimentVariables: [],
      measurementStatus: "reliable",
      mature: true,
      learning: false,
      ...overrides
    },
    evidenceFactIds: ["fact-measurement", "fact-maturity", "fact-learning"],
    singleVariable: true
  };
}

function plan(taskId: string, overrides: Partial<ApprovalExecutionPlan> = {}): ApprovalExecutionPlan {
  return ApprovalExecutionPlan.parse({
    schemaVersion: 1,
    planId: crypto.randomUUID(),
    taskId,
    clientId: "client-a",
    platform: "google_ads",
    browserProfile: "client-a-profile",
    applicationId: "com.google.Chrome",
    applicationName: "Google Chrome",
    windowId: "window-42",
    domain: "ads.google.com",
    allowedApplications: ["com.google.Chrome", "Google Chrome"],
    allowedDomains: ["ads.google.com"],
    accountName: "Acme Ads",
    accountId: "acct-1",
    campaignName: "Android Growth",
    campaignId: "campaign-1",
    pageType: "campaign_budget_editor",
    operation: "set_daily_budget",
    currentValue: 100,
    proposedValue: 110,
    instruction: "Save the daily budget",
    target: "Save",
    expectedResult: "Budget is 110",
    allowedRegion: { x: 100, y: 80, width: 900, height: 650, coordinateSpace: "screenshot_pixels" },
    riskLevel: "mutate",
    surfaceFingerprint: "f".repeat(64),
    accountFingerprint: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    experiment: {
      hypothesis: "Budget adds volume", variable: "daily_budget", baseline: { budget: 100 }, expected: "More volume",
      successCriteria: "CPA holds", failureCriteria: "CPA rises", maturityWindowDays: 7,
      rollbackCondition: "CPA rises 20%", reviewAt: "2026-01-08T00:00:00.000Z"
    },
    ...overrides
  });
}

async function fixture(now = new Date("2026-01-01T00:00:00Z")) {
  const root = await mkdtemp(join(tmpdir(), "adpilot-approval-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
  await workspace.initializeClient({ profile: { id: "client-b", name: "B" }, kpi: { primary: "CPA", target: 12 } });
  const clock = { now: () => now };
  return { workspace, service: new ApprovalService(workspace, "0123456789abcdef0123456789abcdef", clock), clock };
}

async function approved(service: ApprovalService, taskId: string, executionPlan = plan(taskId)) {
  const created = await service.create("client-a", taskId, operation, executionPlan, guardrailFor());
  await service.recordRiskReview("client-a", created.id, true, "Within policy");
  const { token, approval } = await service.approveByUser("client-a", created.id, "owner");
  return { created, approval, token, executionPlan, actualPlan: extractVisualExecutionPlan(executionPlan) };
}

describe("VisualExecutionPlan", () => {
  it("fingerprints every accepted execution field in canonical order", () => {
    const taskId = crypto.randomUUID();
    const original = extractVisualExecutionPlan(plan(taskId));
    const reordered = VisualExecutionPlanFrom({ ...original, allowedDomains: [...original.allowedDomains] });
    expect(executionPlanFingerprint(reordered)).toBe(executionPlanFingerprint(original));

    const changed = VisualExecutionPlanFrom({ ...original, instruction: "Click a different control" });
    expect(executionPlanFingerprint(changed)).not.toBe(executionPlanFingerprint(original));
    expect(() => VisualExecutionPlanFrom({ ...original, unboundExecutionField: "unsafe" } as VisualExecutionPlan)).toThrow("Unrecognized key");
  });

  it("requires a bounded lifetime", () => {
    const taskId = crypto.randomUUID();
    expect(() => plan(taskId, { expiresAt: "2025-12-31T23:59:59.000Z" })).toThrow("expire after");
  });
});

describe("ApprovalService", () => {
  it("requires risk and user approval, then consumes the complete bound plan once", async () => {
    const { service } = await fixture();
    const taskId = crypto.randomUUID();
    const executionPlan = plan(taskId);
    const created = await service.create("client-a", taskId, operation, executionPlan, guardrailFor());
    await expect(service.approveByUser("client-a", created.id, "owner")).rejects.toThrow();
    await service.recordRiskReview("client-a", created.id, true, "Within policy");
    const { approval, token } = await service.approveByUser("client-a", created.id, "owner");
    expect(approval.executionPlanFingerprint).toBe(executionPlanFingerprint(extractVisualExecutionPlan(executionPlan)));
    expect(approval.tokenBinding).toMatchObject({
      schemaVersion: 2,
      taskId,
      planId: executionPlan.planId,
      browserProfile: executionPlan.browserProfile,
      applicationId: executionPlan.applicationId,
      windowId: executionPlan.windowId,
      accountId: executionPlan.accountId,
      campaignId: executionPlan.campaignId,
      accountFingerprint: executionPlan.accountFingerprint,
      executionPlanFingerprint: approval.executionPlanFingerprint,
      guardrailFingerprint: approval.guardrailFingerprint,
      maxAttempts: 1
    });
    await expect(service.verifyExecutionPlan("client-a", created.id, extractVisualExecutionPlan(executionPlan))).resolves.toMatchObject({
      approvedFingerprint: approval.executionPlanFingerprint,
      actualFingerprint: approval.executionPlanFingerprint
    });
    expect((await service.consume("client-a", created.id, token, operation, extractVisualExecutionPlan(executionPlan))).status).toBe("executing");
    await expect(service.consume("client-a", created.id, token, operation, extractVisualExecutionPlan(executionPlan))).rejects.toThrow("not usable");
  });

  it.each([
    ["instruction", (value: VisualExecutionPlan) => ({ ...value, instruction: "Press a hidden save button" })],
    ["target", (value: VisualExecutionPlan) => ({ ...value, target: "Delete campaign" })],
    ["expected result", (value: VisualExecutionPlan) => ({ ...value, expectedResult: "Campaign deleted" })],
    ["proposed value", (value: VisualExecutionPlan) => ({ ...value, proposedValue: 115 })],
    ["campaign", (value: VisualExecutionPlan) => ({ ...value, campaignName: "Brand", campaignId: "campaign-2" })],
    ["page", (value: VisualExecutionPlan) => ({ ...value, pageType: "account_settings" })],
    ["window", (value: VisualExecutionPlan) => ({ ...value, windowId: "window-99" })],
    ["browser profile", (value: VisualExecutionPlan) => ({ ...value, browserProfile: "other-profile" })],
    ["application", (value: VisualExecutionPlan) => ({ ...value, applicationId: "com.apple.Safari", applicationName: "Safari", allowedApplications: ["com.apple.Safari"] })],
    ["allowed region", (value: VisualExecutionPlan) => ({ ...value, allowedRegion: { ...value.allowedRegion, x: value.allowedRegion.x + 1 } })],
    ["surface", (value: VisualExecutionPlan) => ({ ...value, surfaceFingerprint: "e".repeat(64) })],
    ["account identity", (value: VisualExecutionPlan) => ({ ...value, accountName: "Other Ads", accountId: "acct-2", accountFingerprint: "b".repeat(64) })]
  ])("burns the token when %s changes after approval", async (_label, mutate) => {
    const { service } = await fixture();
    const taskId = crypto.randomUUID();
    const issued = await approved(service, taskId);
    const changed = VisualExecutionPlanFrom(mutate(issued.actualPlan));
    await expect(service.consume("client-a", issued.created.id, issued.token, operation, changed)).rejects.toThrow(/visual execution plan|actual visual execution plan/);
    await expect(service.get("client-a", issued.created.id)).resolves.toMatchObject({ status: "cancelled", tokenNonceHash: null, tokenAttempts: 1 });
    await expect(service.consume("client-a", issued.created.id, issued.token, operation, issued.actualPlan)).rejects.toThrow("not usable");
  });

  it("rejects changed operation values, token binding tampering, and cross-client replay", async () => {
    const first = await fixture();
    const taskId = crypto.randomUUID();
    const changedOperation = await approved(first.service, taskId);
    await expect(first.service.consume(
      "client-a", changedOperation.created.id, changedOperation.token,
      { ...operation, proposedValue: 120 }, changedOperation.actualPlan
    )).rejects.toThrow("operation no longer matches");
    await expect(first.service.get("client-a", changedOperation.created.id)).resolves.toMatchObject({ status: "failed", tokenAttempts: 1 });

    const second = await fixture();
    const tampered = await approved(second.service, crypto.randomUUID());
    const [encoded, nonce, signature] = tampered.token.split(".") as [string, string, string];
    const binding = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    binding.executionPlanFingerprint = "0".repeat(64);
    const alteredToken = `${Buffer.from(JSON.stringify(binding)).toString("base64url")}.${nonce}.${signature}`;
    await expect(second.service.consume("client-a", tampered.created.id, alteredToken, operation, tampered.actualPlan)).rejects.toThrow("invalid approval token");
    await expect(second.service.get("client-a", tampered.created.id)).resolves.toMatchObject({ status: "failed", tokenAttempts: 1 });

    const third = await fixture();
    const crossClient = await approved(third.service, crypto.randomUUID());
    await expect(third.service.consume("client-b", crossClient.created.id, crossClient.token, operation, crossClient.actualPlan)).rejects.toThrow();
    await expect(third.service.get("client-a", crossClient.created.id)).resolves.toMatchObject({ status: "approved", tokenAttempts: 0 });
  });

  it("invalidates a token after execution failure, expiry, cancellation, and restart", async () => {
    const failure = await fixture();
    const failed = await approved(failure.service, crypto.randomUUID());
    await failure.service.consume("client-a", failed.created.id, failed.token, operation, failed.actualPlan);
    await failure.service.finish("client-a", failed.created.id, false);
    await expect(failure.service.consume("client-a", failed.created.id, failed.token, operation, failed.actualPlan)).rejects.toThrow("not usable");

    let now = new Date("2026-01-01T00:00:00Z");
    const expiry = await fixture(now);
    const expiring = await approved(expiry.service, crypto.randomUUID());
    now = new Date("2026-01-01T00:06:00Z");
    Object.assign(expiry.clock, { now: () => now });
    await expect(expiry.service.consume("client-a", expiring.created.id, expiring.token, operation, expiring.actualPlan)).rejects.toThrow("expired");

    const cancellation = await fixture();
    const cancelled = await approved(cancellation.service, crypto.randomUUID());
    await cancellation.service.cancel("client-a", cancelled.created.id);
    await expect(cancellation.service.consume("client-a", cancelled.created.id, cancelled.token, operation, cancelled.actualPlan)).rejects.toThrow("not usable");

    const restart = await fixture();
    const interrupted = await approved(restart.service, crypto.randomUUID());
    const restarted = new ApprovalService(restart.workspace, "0123456789abcdef0123456789abcdef");
    await restarted.recoverInterrupted("client-a");
    await expect(restarted.consume("client-a", interrupted.created.id, interrupted.token, operation, interrupted.actualPlan)).rejects.toThrow("not usable");
  });

  it("migrates old partial approvals to non-executable terminal records", async () => {
    const { service, workspace } = await fixture();
    const taskId = crypto.randomUUID();
    const created = await service.create("client-a", taskId, operation, undefined, guardrailFor());
    const legacy = { ...created } as Record<string, unknown>;
    delete legacy.schemaVersion;
    delete legacy.executionPlanFingerprint;
    legacy.status = "approved";
    legacy.executionPlan = {
      instruction: "Save", target: "Save", expectedResult: "Saved",
      surface: { app: "Browser", browserProfile: "client-a", allowedApps: ["Browser"], allowedDomains: [], surfaceFingerprint: "f".repeat(64) },
      experiment: { hypothesis: "x", variable: "budget", baseline: { budget: 100 }, expected: "x", successCriteria: "x", failureCriteria: "x", maturityWindowDays: 7, rollbackCondition: "x", reviewAt: "2026-01-08T00:00:00.000Z" }
    };
    legacy.tokenBinding = {
      approvalId: created.id, clientId: "client-a", platform: "google_ads", accountId: "acct-1", campaignId: "campaign-1",
      operation: "set_daily_budget", currentValue: 100, proposedValue: 110, riskLevel: "mutate",
      surfaceFingerprint: "f".repeat(64), expiresAt: "2026-01-01T00:05:00.000Z", maxAttempts: 1
    };
    legacy.tokenNonceHash = "legacy";
    await workspace.writeJson("client-a", `approvals/${created.id}.json`, legacy);
    await expect(service.get("client-a", created.id)).resolves.toMatchObject({
      schemaVersion: 2,
      status: "cancelled",
      executionPlan: null,
      executionPlanFingerprint: null,
      tokenBinding: null,
      tokenNonceHash: null
    });
    await expect(service.consume("client-a", created.id, "legacy", operation, "f".repeat(64))).rejects.toThrow("not usable");
  });

  it("rejects missing plans, inconsistent context, and unsafe numeric proposals", async () => {
    const { service } = await fixture();
    const taskId = crypto.randomUUID();
    await expect(service.create("client-a", taskId, operation)).rejects.toThrow("deterministic guardrail");
    const missing = await service.create("client-a", taskId, operation, undefined, guardrailFor());
    await service.recordRiskReview("client-a", missing.id, true, "Safe");
    await expect(service.approveByUser("client-a", missing.id, "owner")).rejects.toThrow("complete visual execution plan");
    await expect(service.create("client-a", taskId, operation, plan(taskId, { campaignId: "campaign-2" }))).rejects.toThrow("campaignId");
    await expect(service.create("client-a", crypto.randomUUID(), { ...operation, proposedValue: 130, changePercentage: 10 })).rejects.toThrow("does not match");
    await expect(service.create("client-a", crypto.randomUUID(), { ...operation, proposedValue: 130, changePercentage: 30 })).rejects.toThrow("20%");
  });

  it("recomputes deterministic guardrails and rejects unsafe or tampered attestations", async () => {
    const { service, workspace } = await fixture();
    const taskId = crypto.randomUUID();
    await expect(service.create(
      "client-a",
      taskId,
      operation,
      plan(taskId),
      guardrailFor(operation, { measurementStatus: "blocked" })
    )).rejects.toThrow("measurement reliability");
    await expect(service.create(
      "client-a",
      taskId,
      operation,
      plan(taskId),
      { ...guardrailFor(), singleVariable: false }
    )).rejects.toThrow("single-variable");

    const created = await service.create("client-a", taskId, operation, plan(taskId), guardrailFor());
    const stored = await workspace.readJson("client-a", `approvals/${created.id}.json`, Approval);
    if (!stored.guardrail) throw new Error("approval guardrail fixture was not persisted");
    const guardrail = structuredClone(stored.guardrail);
    guardrail.input.learning = true;
    await workspace.writeJson("client-a", `approvals/${created.id}.json`, { ...stored, guardrail });
    await expect(service.recordRiskReview("client-a", created.id, true, "safe")).rejects.toThrow("fingerprint");
  });
});

function VisualExecutionPlanFrom(input: VisualExecutionPlan): VisualExecutionPlan {
  return VisualExecutionPlanSchema.parse(input);
}
