import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "./index.js";

describe("product server", () => {
  it("serves workspace state and keeps one-time approval tokens off the HTTP response", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-server-"));
    const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    await system.workspace.initializeClient({ profile: { id: "client-a", name: "Example" }, kpi: { primary: "CPA", target: 10 } });
    const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
    const state = await server.inject({ method: "GET", url: "/api/state?clientId=client-a" });
    expect(state.statusCode).toBe(200);
    expect(state.json().clients[0].name).toBe("Example");
    const about = await server.inject({ method: "GET", url: "/api/about" });
    expect(about.statusCode).toBe(200);
    expect(about.json()).toMatchObject({ name: "AdPilot", runtime: { name: "Pi" }, computerUse: { name: "UI-TARS" } });

    const taskId = crypto.randomUUID();
    const operation = {
      account: "acct", campaign: "campaign", operation: "set_daily_budget",
      currentValue: 100, proposedValue: 110, changePercentage: 10,
      reason: "Mature efficient campaign", evidence: ["screen:before"], expectedImpact: "More volume",
      observationWindow: "7 days", rollbackCondition: "CPA rises 20%", riskLevel: "mutate" as const
    };
    const approval = await system.approvals.create("client-a", taskId, operation);
    await system.approvals.recordRiskReview("client-a", approval.id, true, "Within policy");
    const response = await server.inject({ method: "POST", url: `/api/approvals/${approval.id}/approve`, payload: { clientId: "client-a", approvedBy: "owner" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().tokenStored).toBe(true);
    expect(JSON.stringify(response.json())).not.toContain("signature");
    expect(system.approvalTokens.has(approval.id)).toBe(true);
    await server.close();
  });
});
