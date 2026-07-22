import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "@adpilot/workspace";
import { ApprovalService, type ApprovalOperation } from "./index.js";

const operation: ApprovalOperation = {
  platform: "google_ads", account: "acct-1", campaign: "campaign-1", operation: "set_daily_budget",
  currentValue: 100, proposedValue: 110, changePercentage: 10,
  reason: "Mature efficient campaign", evidence: ["screenshot:before"],
  expectedImpact: "Increase qualified volume", observationWindow: "7 days",
  rollbackCondition: "CPA exceeds target by 20%", riskLevel: "mutate"
};
const plan = {
  instruction: "Save the daily budget", target: "Save", expectedResult: "Budget is 110",
  surface: { app: "Browser", domain: "ads.google.com", browserProfile: "client-a", allowedApps: ["Browser"], allowedDomains: ["ads.google.com"], surfaceFingerprint: "f".repeat(64) },
  experiment: {
    hypothesis: "Budget adds volume", variable: "daily_budget", baseline: { budget: 100 }, expected: "More volume",
    successCriteria: "CPA holds", failureCriteria: "CPA rises", maturityWindowDays: 7,
    rollbackCondition: "CPA rises 20%", reviewAt: "2026-01-08T00:00:00.000Z"
  }
};

async function fixture(now = new Date("2026-01-01T00:00:00Z")) {
  const root = await mkdtemp(join(tmpdir(), "adpilot-approval-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
  const clock = { now: () => now };
  return { service: new ApprovalService(workspace, "0123456789abcdef0123456789abcdef", clock), clock };
}

describe("ApprovalService", () => {
  it("requires risk and user approval, then consumes a bound token once", async () => {
    const { service } = await fixture();
    const created = await service.create("client-a", crypto.randomUUID(), operation, plan);
    await expect(service.approveByUser("client-a", created.id, "owner")).rejects.toThrow();
    await service.recordRiskReview("client-a", created.id, true, "Within policy");
    const { token } = await service.approveByUser("client-a", created.id, "owner");
    expect((await service.consume("client-a", created.id, token, operation, "f".repeat(64))).status).toBe("executing");
    await expect(service.consume("client-a", created.id, token, operation, "f".repeat(64))).rejects.toThrow();
  });

  it("rejects changed values and expired tokens", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const root = await mkdtemp(join(tmpdir(), "adpilot-approval-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const service = new ApprovalService(workspace, "0123456789abcdef0123456789abcdef", { now: () => now });
    const created = await service.create("client-a", crypto.randomUUID(), operation, plan);
    await service.recordRiskReview("client-a", created.id, true, "Safe");
    const { token } = await service.approveByUser("client-a", created.id, "owner");
    await expect(service.consume("client-a", created.id, token, { ...operation, proposedValue: 120 }, "f".repeat(64))).rejects.toThrow("no longer matches");
    const retry = await service.create("client-a", crypto.randomUUID(), operation, plan);
    await service.recordRiskReview("client-a", retry.id, true, "Safe");
    const { token: expiringToken } = await service.approveByUser("client-a", retry.id, "owner");
    now = new Date("2026-01-01T00:06:00Z");
    await expect(service.consume("client-a", retry.id, expiringToken, operation, "f".repeat(64))).rejects.toThrow("expired");
  });

  it("burns a token when the live surface changes and supports explicit cancellation", async () => {
    const { service } = await fixture();
    const created = await service.create("client-a", crypto.randomUUID(), operation, plan);
    await service.recordRiskReview("client-a", created.id, true, "Safe");
    const { token } = await service.approveByUser("client-a", created.id, "owner");
    await expect(service.consume("client-a", created.id, token, operation, "e".repeat(64))).rejects.toThrow("surface changed");
    await expect(service.get("client-a", created.id)).resolves.toMatchObject({ status: "cancelled", tokenNonceHash: null, tokenAttempts: 1 });

    const cancellable = await service.create("client-a", crypto.randomUUID(), operation, plan);
    await service.recordRiskReview("client-a", cancellable.id, true, "Safe");
    await service.approveByUser("client-a", cancellable.id, "owner");
    await expect(service.cancel("client-a", cancellable.id)).resolves.toMatchObject({ status: "cancelled", tokenNonceHash: null });
  });

  it("rejects inconsistent or over-cap numeric proposals before review", async () => {
    const { service } = await fixture();
    await expect(service.create("client-a", crypto.randomUUID(), { ...operation, proposedValue: 130, changePercentage: 10 })).rejects.toThrow("does not match");
    await expect(service.create("client-a", crypto.randomUUID(), { ...operation, proposedValue: 130, changePercentage: 30 })).rejects.toThrow("20%");
  });
});
