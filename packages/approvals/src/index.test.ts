import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "@adpilot/workspace";
import { ApprovalService, type ApprovalOperation } from "./index.js";

const operation: ApprovalOperation = {
  account: "acct-1", campaign: "campaign-1", operation: "set_daily_budget",
  currentValue: 100, proposedValue: 110, changePercentage: 10,
  reason: "Mature efficient campaign", evidence: ["screenshot:before"],
  expectedImpact: "Increase qualified volume", observationWindow: "7 days",
  rollbackCondition: "CPA exceeds target by 20%", riskLevel: "mutate"
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
    const created = await service.create("client-a", crypto.randomUUID(), operation);
    await expect(service.approveByUser("client-a", created.id, "owner")).rejects.toThrow();
    await service.recordRiskReview("client-a", created.id, true, "Within policy");
    const { token } = await service.approveByUser("client-a", created.id, "owner");
    expect((await service.consume("client-a", created.id, token, operation)).status).toBe("executing");
    await expect(service.consume("client-a", created.id, token, operation)).rejects.toThrow();
  });

  it("rejects changed values and expired tokens", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const root = await mkdtemp(join(tmpdir(), "adpilot-approval-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const service = new ApprovalService(workspace, "0123456789abcdef0123456789abcdef", { now: () => now });
    const created = await service.create("client-a", crypto.randomUUID(), operation);
    await service.recordRiskReview("client-a", created.id, true, "Safe");
    const { token } = await service.approveByUser("client-a", created.id, "owner");
    await expect(service.consume("client-a", created.id, token, { ...operation, proposedValue: 120 })).rejects.toThrow("no longer matches");
    now = new Date("2026-01-01T00:06:00Z");
    await expect(service.consume("client-a", created.id, token, operation)).rejects.toThrow("expired");
  });
});

