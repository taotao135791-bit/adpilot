import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "./index.js";

describe("product server", () => {
  it("creates a usable personal workspace on first launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-first-launch-"));
    const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
    const state = await server.inject({ method: "GET", url: "/api/state" });
    expect(state.json()).toMatchObject({ selectedClientId: "personal", clients: [{ id: "personal", name: "AdPilot" }], messages: [] });

    await system.workspace.appendJsonl("personal", "conversation.jsonl", {
      id: crypto.randomUUID(), clientId: "personal", role: "system", status: "error",
      content: '[{"code":"invalid_type","expected":"answer | investigate"}]', at: new Date().toISOString()
    });
    const migratedState = await server.inject({ method: "GET", url: "/api/state" });
    expect(migratedState.json().messages[0].content).toBe("上一次模型响应使用了不兼容的格式，AdPilot 已安全停止。请重新发送消息。");
    expect(migratedState.json().messages[0].content).not.toContain("invalid_type");
    await server.close();
  });

  it("accepts natural-language chat and persists both sides of the conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-conversation-"));
    const faux = fauxProvider({ provider: "test", models: [{ id: "code", input: ["text", "image"] }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('{"action":"answer","message":"Tell me the account symptom and I will investigate the evidence.","console":"ready"}')]);
    const system = await createAdPilotSystem({ workspaceRoot: root, env: { ADPILOT_FAST_PROVIDER: "test", ADPILOT_FAST_MODEL: "code", ADPILOT_STRONG_PROVIDER: "test", ADPILOT_STRONG_MODEL: "code" }, models });
    const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
    const response = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "What can you do?", locale: "en" } });
    expect(response.statusCode).toBe(201);
    expect(response.json().message).toMatchObject({ role: "assistant", content: "Tell me the account symptom and I will investigate the evidence." });
    const state = await server.inject({ method: "GET", url: "/api/state" });
    expect(state.json().messages).toMatchObject([{ role: "user", content: "What can you do?" }, { role: "assistant" }]);
    expect(state.json().models).toMatchObject({ chatConfigured: true, guiConfigured: true, gui: "test/code" });

    faux.setResponses([fauxAssistantMessage('{"action":"answer"}')]);
    const failed = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "Hello again", locale: "en" } });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toContain("stopped safely");
    expect(failed.json().error).not.toContain("invalid_type");
    const failedState = await server.inject({ method: "GET", url: "/api/state" });
    expect(failedState.json().messages.at(-1)).toMatchObject({ role: "system", status: "error" });
    expect(failedState.json().messages.at(-1).content).not.toContain("expected");
    await server.close();
  });

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
      platform: "google_ads" as const, account: "acct", campaign: "campaign", operation: "set_daily_budget",
      currentValue: 100, proposedValue: 110, changePercentage: 10,
      reason: "Mature efficient campaign", evidence: ["screen:before"], expectedImpact: "More volume",
      observationWindow: "7 days", rollbackCondition: "CPA rises 20%", riskLevel: "mutate" as const
    };
    const executionPlan = {
      instruction: "Save the budget", target: "Save", expectedResult: "Budget saved",
      surface: { app: "Browser", domain: "ads.google.com", browserProfile: "client-a", allowedApps: ["Browser"], allowedDomains: ["ads.google.com"], surfaceFingerprint: "f".repeat(64) },
      experiment: {
        hypothesis: "Budget adds volume", variable: "daily_budget", baseline: { budget: 100 }, expected: "More volume",
        successCriteria: "CPA holds", failureCriteria: "CPA rises", maturityWindowDays: 7,
        rollbackCondition: "CPA rises 20%", reviewAt: "2026-01-08T00:00:00.000Z"
      }
    };
    const fabricated = await system.approvals.create("client-a", taskId, { ...operation, evidence: [`screenshot:${"a".repeat(64)}`] }, executionPlan);
    const fabricatedReview = await server.inject({ method: "POST", url: `/api/approvals/${fabricated.id}/risk-review`, payload: { clientId: "client-a" } });
    expect(fabricatedReview.statusCode).toBe(200);
    expect(fabricatedReview.json().approved).toBe(false);
    await expect(system.approvals.get("client-a", fabricated.id)).resolves.toMatchObject({ status: "rejected" });

    const approval = await system.approvals.create("client-a", taskId, operation, executionPlan);
    await system.approvals.recordRiskReview("client-a", approval.id, true, "Within policy");
    const response = await server.inject({ method: "POST", url: `/api/approvals/${approval.id}/approve`, payload: { clientId: "client-a", approvedBy: "owner" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().tokenStored).toBe(true);
    expect(JSON.stringify(response.json())).not.toContain("signature");
    expect(system.approvalTokens.has(approval.id)).toBe(true);
    await server.close();
  });
});
