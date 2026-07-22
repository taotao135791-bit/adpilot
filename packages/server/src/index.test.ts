import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import type { ApprovalExecutionPlan, ApprovalOperation } from "@adpilot/approvals";
import { BrowserSessionLostError, type BrowserSession, type ScreenshotModelCallAudit } from "@adpilot/computer-use";
import { visualTaskFromExecutionPlan, type VisualApprovalPlanDraft } from "@adpilot/tools";
import { createServer } from "./index.js";

function operation(): ApprovalOperation {
  return {
    platform: "google_ads", account: "acct", campaign: "campaign", operation: "set_daily_budget",
    currentValue: 100, proposedValue: 110, changePercentage: 10,
    reason: "Mature efficient campaign", evidence: ["screen:before"], expectedImpact: "More volume",
    observationWindow: "7 days", rollbackCondition: "CPA rises 20%", riskLevel: "mutate"
  };
}

function executionPlan(clientId: string, taskId: string, approvedOperation = operation()): ApprovalExecutionPlan {
  const now = Date.now();
  return {
    schemaVersion: 1,
    planId: crypto.randomUUID(),
    taskId,
    clientId,
    platform: approvedOperation.platform,
    browserProfile: "client-a-google",
    applicationId: "com.google.Chrome",
    applicationName: "Google Chrome",
    windowId: "window-77",
    domain: "ads.google.com",
    allowedApplications: ["com.google.Chrome", "Google Chrome"],
    allowedDomains: ["ads.google.com"],
    accountName: "Example account",
    accountId: approvedOperation.account,
    campaignName: "Campaign A",
    campaignId: approvedOperation.campaign,
    pageType: "campaign_budget_editor",
    operation: approvedOperation.operation,
    currentValue: approvedOperation.currentValue,
    proposedValue: approvedOperation.proposedValue,
    instruction: "Set the daily budget to 110 without changing other fields",
    target: "Daily budget input and Save button",
    expectedResult: "Daily budget visibly reads 110 after saving",
    allowedRegion: { x: 600, y: 240, width: 320, height: 260, coordinateSpace: "screenshot_pixels" },
    riskLevel: approvedOperation.riskLevel,
    surfaceFingerprint: "f".repeat(64),
    accountFingerprint: "a".repeat(64),
    createdAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    experiment: {
      hypothesis: "Budget adds volume", variable: "daily_budget", baseline: { budget: 100 }, expected: "More volume",
      successCriteria: "CPA holds", failureCriteria: "CPA rises", maturityWindowDays: 7,
      rollbackCondition: "CPA rises 20%", reviewAt: new Date(now + 7 * 24 * 60 * 60_000).toISOString()
    }
  };
}

function executionDraft(approvedOperation = operation()): VisualApprovalPlanDraft {
  return {
    schemaVersion: 1,
    platform: approvedOperation.platform,
    browserProfile: "client-a-google",
    domain: "ads.google.com",
    allowedDomains: ["ads.google.com"],
    accountName: "Example account",
    accountId: approvedOperation.account,
    campaignName: "Campaign A",
    campaignId: approvedOperation.campaign,
    pageType: "campaign_budget_editor",
    operation: approvedOperation.operation,
    currentValue: approvedOperation.currentValue,
    proposedValue: approvedOperation.proposedValue,
    instruction: "Set the daily budget to 110 without changing other fields",
    target: "Daily budget input and Save button",
    expectedResult: "Daily budget visibly reads 110 after saving",
    allowedRegion: { x: 600, y: 240, width: 320, height: 260, coordinateSpace: "screenshot_pixels" },
    riskLevel: approvedOperation.riskLevel,
    experiment: executionPlan("client-a", crypto.randomUUID(), approvedOperation).experiment
  };
}

function browserSession(status: BrowserSession["sessionStatus"] = "connected"): BrowserSession {
  const at = "2026-07-22T08:00:00.000Z";
  return {
    sessionId: "b".repeat(32), clientId: "client-a", browserProfile: "client-a-google",
    profileDirectory: "/private/workspace/browser-profiles/redacted", nativeProfileFingerprint: "Default@1234567890abcdef",
    processId: 501, windowId: "window-77", windowBounds: { x: 20, y: 40, width: 1280, height: 800 },
    platform: "google_ads", runtimePlatform: process.platform === "darwin" || process.platform === "win32" || process.platform === "linux" ? process.platform : "linux",
    browserApplicationId: "com.google.Chrome", browserApp: "Google Chrome", sessionStatus: status,
    startedAt: at, updatedAt: at, lastValidatedAt: at
  };
}

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

  it("restores the same Pi conversation after a full server restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-session-restart-"));
    const faux = fauxProvider({ provider: "test", models: [{ id: "code", input: ["text"] }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('{"mode":"answer","reply":"I will remember reference ALPHA-42.","goal":null}')]);
    const options = { workspaceRoot: root, env: { ADPILOT_FAST_PROVIDER: "test", ADPILOT_FAST_MODEL: "code", ADPILOT_STRONG_PROVIDER: "test", ADPILOT_STRONG_MODEL: "code" }, models };
    const firstSystem = await createAdPilotSystem(options);
    const firstServer = await createServer(firstSystem, { uiRoot: join(root, "missing-ui") });
    const first = await firstServer.inject({ method: "POST", url: "/api/messages", payload: { conversationId: "launch-review", message: "Remember reference ALPHA-42", locale: "en" } });
    expect(first.statusCode).toBe(201);
    await firstServer.close();

    faux.setResponses([(context) => {
      const transcript = JSON.stringify(context.messages);
      expect(transcript).toContain("ALPHA-42");
      expect(context.messages.filter((message) => message.role === "user").length).toBeGreaterThanOrEqual(2);
      return fauxAssistantMessage('{"mode":"answer","reply":"The saved reference is ALPHA-42.","goal":null}');
    }]);
    const restoredSystem = await createAdPilotSystem(options);
    const restoredServer = await createServer(restoredSystem, { uiRoot: join(root, "missing-ui") });
    const second = await restoredServer.inject({ method: "POST", url: "/api/messages", payload: { conversationId: "launch-review", message: "What reference did I give you?", locale: "en" } });
    expect(second.statusCode).toBe(201);
    expect(second.json().message.content).toBe("The saved reference is ALPHA-42.");
    const state = await restoredServer.inject({ method: "GET", url: "/api/state?conversationId=launch-review" });
    expect(state.json()).toMatchObject({ selectedConversationId: "launch-review" });
    expect(state.json().messages).toHaveLength(4);
    await restoredServer.close();
  });

  it("restores pending approvals and active experiments after application restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-product-restart-"));
    const first = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    await first.workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const taskId = crypto.randomUUID();
    const approval = await first.approvals.create("client-a", taskId, {
      platform: "google_ads", account: "acct-1", campaign: "campaign-1", operation: "set_daily_budget",
      currentValue: 100, proposedValue: 110, changePercentage: 10, reason: "controlled increase",
      evidence: ["workspace:baseline"], expectedImpact: "more volume", observationWindow: "7 days",
      rollbackCondition: "CPA exceeds 12", riskLevel: "mutate"
    });
    const experiment = await first.experiments.create({
      clientId: "client-a", taskId, approvalId: approval.id, hypothesis: "budget adds volume", variable: "daily_budget",
      baseline: { budget: 100, cpa: 10 }, expected: "more conversions", successCriteria: "CPA remains below 12",
      failureCriteria: "CPA exceeds 12", maturityWindowDays: 7, rollbackCondition: "CPA exceeds 12",
      reviewAt: "2026-08-01T00:00:00.000Z"
    });
    await first.experiments.start("client-a", experiment.id);

    const restored = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    await expect(restored.approvals.list("client-a")).resolves.toMatchObject([{ id: approval.id, status: "pending_risk_review" }]);
    await expect(restored.experiments.list("client-a")).resolves.toMatchObject([{ id: experiment.id, status: "active" }]);
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
    const approvedOperation = operation();
    const approvedPlan = executionPlan("client-a", taskId, approvedOperation);
    const fabricated = await system.approvals.create("client-a", taskId, { ...approvedOperation, evidence: [`screenshot:${"a".repeat(64)}`] }, approvedPlan);
    const fabricatedReview = await server.inject({ method: "POST", url: `/api/approvals/${fabricated.id}/risk-review`, payload: { clientId: "client-a" } });
    expect(fabricatedReview.statusCode).toBe(200);
    expect(fabricatedReview.json().approved).toBe(false);
    await expect(system.approvals.get("client-a", fabricated.id)).resolves.toMatchObject({ status: "rejected" });

    const approval = await system.approvals.create("client-a", taskId, approvedOperation, approvedPlan);
    await system.approvals.recordRiskReview("client-a", approval.id, true, "Within policy");
    const response = await server.inject({ method: "POST", url: `/api/approvals/${approval.id}/approve`, payload: { clientId: "client-a", approvedBy: "owner" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().tokenStored).toBe(true);
    expect(JSON.stringify(response.json())).not.toContain("signature");
    expect(system.approvalTokens.has(approval.id)).toBe(true);
    await server.close();
  });

  it("accepts both visual approval drafts and fully bound execution plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-approval-api-"));
    const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    await system.workspace.initializeClient({ profile: { id: "client-a", name: "Example" }, kpi: { primary: "CPA", target: 10 } });
    const create = vi.spyOn(system.tools, "createApproval").mockImplementation(async () => ({ id: crypto.randomUUID(), status: "pending_risk_review" }) as never);
    const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
    const approvedOperation = operation();
    const firstTask = crypto.randomUUID();
    const draft = executionDraft(approvedOperation);
    const draftResponse = await server.inject({
      method: "POST", url: "/api/approvals",
      payload: { clientId: "client-a", taskId: firstTask, operation: approvedOperation, executionPlan: draft }
    });
    expect(draftResponse.statusCode).toBe(201);
    expect(create).toHaveBeenNthCalledWith(1, { clientId: "client-a", taskId: firstTask, actor: "adpilot_agent", permission: "OBSERVE" }, approvedOperation, draft);

    const secondTask = crypto.randomUUID();
    const complete = executionPlan("client-a", secondTask, approvedOperation);
    const completeResponse = await server.inject({
      method: "POST", url: "/api/approvals",
      payload: { clientId: "client-a", taskId: secondTask, operation: approvedOperation, executionPlan: complete }
    });
    expect(completeResponse.statusCode).toBe(201);
    expect(create).toHaveBeenNthCalledWith(2, { clientId: "client-a", taskId: secondTask, actor: "adpilot_agent", permission: "OBSERVE" }, approvedOperation, complete);

    const missingPlan = await server.inject({
      method: "POST", url: "/api/approvals",
      payload: { clientId: "client-a", taskId: crypto.randomUUID(), operation: approvedOperation }
    });
    expect(missingPlan.statusCode).toBe(400);
    expect(missingPlan.json().error).toContain("complete visual approval plan");
    expect(create).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("commits only the canonical task projected from the approved execution plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-approval-commit-"));
    const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    await system.workspace.initializeClient({ profile: { id: "client-a", name: "Example" }, kpi: { primary: "CPA", target: 10, currency: "USD" } });
    const taskId = crypto.randomUUID();
    const approvedOperation = operation();
    const approvedPlan = executionPlan("client-a", taskId, approvedOperation);
    const approval = await system.approvals.create("client-a", taskId, approvedOperation, approvedPlan);
    await system.approvals.recordRiskReview("client-a", approval.id, true, "Within policy");
    const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
    const approved = await server.inject({ method: "POST", url: `/api/approvals/${approval.id}/approve`, payload: { clientId: "client-a", approvedBy: "owner" } });
    expect(approved.statusCode).toBe(200);
    const commit = vi.spyOn(system.tools, "commitApprovedVisualAction").mockResolvedValue({
      status: "failed", attempts: 1, blocker: "verification stopped", blockerCode: "VERIFICATION_FAILED"
    });
    const response = await server.inject({ method: "POST", url: `/api/approvals/${approval.id}/commit`, payload: { clientId: "client-a" } });
    expect(response.statusCode).toBe(200);
    const canonicalTask = visualTaskFromExecutionPlan(approvedPlan, "USD", "MUTATE");
    expect(commit).toHaveBeenCalledWith(
      { clientId: "client-a", taskId, actor: "account_operator", permission: "MUTATE" },
      approval.id,
      expect.any(String),
      approvedOperation,
      canonicalTask
    );
    expect(canonicalTask).toMatchObject({
      clientId: "client-a", taskId, planId: approvedPlan.planId, accountFingerprint: approvedPlan.accountFingerprint,
      allowedRegion: approvedPlan.allowedRegion,
      surface: { applicationId: approvedPlan.applicationId, windowId: approvedPlan.windowId, browserProfile: approvedPlan.browserProfile }
    });
    expect(system.approvalTokens.has(approval.id)).toBe(false);
    await server.close();
  });

  it("exposes managed browser start, live status, explicit resume, close, and product status", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-browser-api-"));
    const system = await createAdPilotSystem({ workspaceRoot: root, env: { ADPILOT_PRIVACY_MODE: "local-only" } });
    await system.workspace.initializeClient({
      profile: { id: "client-a", name: "Example" }, kpi: { primary: "CPA", target: 10 },
      accounts: { accounts: [{ platform: "google_ads", accountRef: "acct", browserProfile: "client-a-google", allowedDomains: ["ads.google.com"] }] }
    });
    let sessions: BrowserSession[] = [];
    vi.spyOn(system.browserSessions, "recover").mockImplementation(async () => sessions);
    vi.spyOn(system.browserSessions, "list").mockImplementation(async () => sessions);
    const start = vi.spyOn(system.browserSessions, "start").mockImplementation(async () => {
      sessions = [browserSession("connected")];
      return sessions[0]!;
    });
    const resume = vi.spyOn(system.browserSessions, "resume").mockImplementation(async () => {
      sessions = [browserSession("connected")];
      return sessions[0]!;
    });
    const close = vi.spyOn(system.browserSessions, "close").mockImplementation(async () => {
      sessions = [browserSession("closed")];
      return sessions[0]!;
    });
    const server = await createServer(system, { uiRoot: join(root, "missing-ui") });

    const started = await server.inject({
      method: "POST", url: "/api/browser-session/start",
      payload: { clientId: "client-a", browserProfile: "client-a-google", platform: "google_ads" }
    });
    expect(started.statusCode).toBe(201);
    expect(start).toHaveBeenCalledWith({ clientId: "client-a", browserProfile: "client-a-google", platform: "google_ads" });
    expect(started.json()).toMatchObject({ session: { processId: 501, windowId: "window-77", sessionStatus: "connected" }, computerUse: { browserStatus: "connected", permission: "OBSERVE", privacyMode: "local-only" } });
    expect(JSON.stringify(started.json())).not.toContain("profileDirectory");
    expect(JSON.stringify(started.json())).not.toContain("nativeProfileFingerprint");

    const status = await server.inject({ method: "GET", url: "/api/browser-session?clientId=client-a&browserProfile=client-a-google" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      session: { browserProfile: "client-a-google" },
      profiles: [{ browserProfile: "client-a-google", platform: "google_ads", accountRef: "acct" }],
      browserStatus: "connected", currentBrowser: { browserProfile: "client-a-google" }, sessions: [{ sessionStatus: "connected" }]
    });

    const state = await server.inject({ method: "GET", url: "/api/state?clientId=client-a" });
    expect(state.json()).toMatchObject({
      models: { browserSession: "connected" },
      computerUse: { browserStatus: "connected", permission: "OBSERVE", privacyMode: "local-only" },
      browserSessions: [{ clientId: "client-a", sessionStatus: "connected" }]
    });
    const settings = await server.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json()).toMatchObject({ runtimeModels: { browserSession: "connected" }, computerUse: { permission: "OBSERVE", privacyMode: "local-only" } });

    sessions = [{ ...browserSession("lost"), lostAt: "2026-07-22T08:10:00.000Z", lostReason: "foreground changed" }];
    const resumed = await server.inject({ method: "POST", url: "/api/browser-session/resume", payload: { clientId: "client-a", browserProfile: "client-a-google" } });
    expect(resumed.statusCode).toBe(200);
    expect(resume).toHaveBeenCalledWith("client-a", "client-a-google");
    expect(resumed.json().session.sessionStatus).toBe("connected");

    const closed = await server.inject({ method: "POST", url: "/api/browser-session/close", payload: { clientId: "client-a", browserProfile: "client-a-google" } });
    expect(closed.statusCode).toBe(200);
    expect(close).toHaveBeenCalledWith("client-a", "client-a-google");
    expect(closed.json()).toMatchObject({ session: { sessionStatus: "closed" }, computerUse: { browserStatus: "closed" } });

    resume.mockRejectedValueOnce(new BrowserSessionLostError("original managed window is unavailable", browserSession("lost")));
    const rejectedResume = await server.inject({ method: "POST", url: "/api/browser-session/resume", payload: { clientId: "client-a", browserProfile: "client-a-google" } });
    expect(rejectedResume.statusCode).toBe(409);
    expect(rejectedResume.json()).toEqual({ error: "original managed window is unavailable", code: "BROWSER_SESSION_LOST" });
    await server.close();
  });

  it("returns bounded screenshot disclosure audits without image bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-privacy-audit-api-"));
    const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    await system.workspace.initializeClient({ profile: { id: "client-a", name: "Example" }, kpi: { primary: "CPA", target: 10 } });
    const audit: ScreenshotModelCallAudit = {
      auditId: crypto.randomUUID(), clientId: "client-a", taskId: "task-a", purpose: "grounding",
      modelProvider: "remote-vendor", modelId: "gui-model", screenshotId: crypto.randomUUID(), screenshotSha256: "a".repeat(64),
      sentRoi: { x: 20, y: 30, width: 500, height: 300 },
      masks: [{ category: "email", region: { x: 30, y: 40, width: 80, height: 20 }, reason: "private email" }],
      transmittedWidth: 500, transmittedHeight: 300, leftLocal: true, fullScreenshotLocalOnly: true,
      privacyMode: "minimized", dataRetentionPolicy: "provider-zero-retention", outcome: "prepared",
      createdAt: "2026-07-22T08:30:00.000Z"
    };
    await system.screenshotAudits.append(audit);
    const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
    const response = await server.inject({ method: "GET", url: "/api/privacy/screenshot-audits?clientId=client-a&limit=1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ total: 1, audits: [audit] });
    expect(JSON.stringify(response.json())).not.toContain("base64");
    expect(JSON.stringify(response.json())).not.toContain("localPath");
    await server.close();
  });
});
