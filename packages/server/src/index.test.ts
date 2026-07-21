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
    await system.credentials.modify("openai-codex", async () => ({ type: "oauth", access: "oauth-access-secret", refresh: "oauth-refresh-secret", expires: Date.now() + 60_000 }));
    await system.workspace.initializeClient({ profile: { id: "client-a", name: "Example" }, kpi: { primary: "CPA", target: 10 } });
    let signalRestart: (() => void) | undefined;
    const restarted = new Promise<void>((resolve) => { signalRestart = resolve; });
    const server = await createServer(system, { uiRoot: join(root, "missing-ui"), onRestartRequested: () => signalRestart?.() });
    const state = await server.inject({ method: "GET", url: "/api/state?clientId=client-a" });
    expect(state.statusCode).toBe(200);
    expect(state.json().clients[0].name).toBe("Example");
    const about = await server.inject({ method: "GET", url: "/api/about" });
    expect(about.statusCode).toBe(200);
    expect(about.json()).toMatchObject({ name: "AdPilot", runtime: { name: "Pi" }, computerUse: { name: "UI-TARS" } });
    const settings = await server.inject({ method: "GET", url: "/api/settings" });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().catalog.providers.length).toBeGreaterThanOrEqual(30);
    expect(settings.json().restartAvailable).toBe(true);
    expect(settings.json().providerCredentials["openai-codex"]).toBe("oauth");
    expect(JSON.stringify(settings.json())).not.toContain("oauth-access-secret");
    const savedSettings = await server.inject({
      method: "PUT", url: "/api/settings",
      payload: { locale: "zh-CN", appearance: "dark", models: { fast: { provider: "openai", model: "gpt-5-mini" }, strong: { provider: "openai", model: "gpt-5.2" } }, env: { OPENAI_API_KEY: "private-value" } }
    });
    expect(savedSettings.json()).toEqual({ saved: true, restartRequired: true });
    const updatedSettings = await server.inject({ method: "GET", url: "/api/settings" });
    expect(updatedSettings.json().configured.OPENAI_API_KEY).toBe(true);
    expect(JSON.stringify(updatedSettings.json())).not.toContain("private-value");
    const restart = await server.inject({ method: "POST", url: "/api/settings/restart" });
    expect(restart.json()).toEqual({ restarting: true });
    await restarted;

    const taskId = crypto.randomUUID();
    const operation = {
      account: "acct", campaign: "campaign", operation: "set_daily_budget",
      currentValue: 100, proposedValue: 110, changePercentage: 10,
      reason: "Mature efficient campaign", evidence: ["screen:before"], expectedImpact: "More volume",
      observationWindow: "7 days", rollbackCondition: "CPA rises 20%", riskLevel: "mutate" as const
    };
    const fabricated = await system.approvals.create("client-a", taskId, { ...operation, evidence: [`screenshot:${"a".repeat(64)}`] }, {
      instruction: "Save the budget", target: "Save", expectedResult: "Budget saved",
      surface: { app: "Browser", domain: "ads.google.com", browserProfile: "client-a", allowedApps: ["Browser"], allowedDomains: ["ads.google.com"] },
      experiment: {
        hypothesis: "Budget adds volume", variable: "daily_budget", baseline: { budget: 100 }, expected: "More volume",
        successCriteria: "CPA holds", failureCriteria: "CPA rises", maturityWindowDays: 7,
        rollbackCondition: "CPA rises 20%", reviewAt: "2026-01-08T00:00:00.000Z"
      }
    });
    const fabricatedReview = await server.inject({ method: "POST", url: `/api/approvals/${fabricated.id}/risk-review`, payload: { clientId: "client-a" } });
    expect(fabricatedReview.statusCode).toBe(200);
    expect(fabricatedReview.json().approved).toBe(false);
    await expect(system.approvals.get("client-a", fabricated.id)).resolves.toMatchObject({ status: "rejected" });

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
