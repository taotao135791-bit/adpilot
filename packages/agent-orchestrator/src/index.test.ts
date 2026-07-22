import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import {
  fingerprintSurface,
  VisualComputerRuntime,
  type BrowserSessionManager,
  type DualVisualIdentityVerifier,
  type Screenshot
} from "@adpilot/computer-use";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { PiAgentRuntime } from "@adpilot/runtime";
import { SharedFactLedger } from "@adpilot/shared";
import { SkillRegistry } from "@adpilot/skills";
import { AccountOperator, SpecialistCoordinator, specialistSchemas, type SpecialistAgent } from "@adpilot/specialist-agents";
import { AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotAgent, WorkspaceSharedFactRepository, conversationSpecialistPermission } from "./index.js";

describe("conversation specialist permissions", () => {
  it("derives the minimum read or scroll permission and refuses mutations", () => {
    expect(conversationSpecialistPermission("performance_analyst", {})).toBe("OBSERVE");
    expect(conversationSpecialistPermission("account_operator", { visualTable: { scrollDirection: "none" } })).toBe("OBSERVE");
    expect(conversationSpecialistPermission("account_operator", { visualTable: { scrollDirection: "down" } })).toBe("INTERACT");
    expect(conversationSpecialistPermission("account_operator", { visualTask: {
      permission: "INTERACT", riskLevel: "interact", retryPolicy: "none", allowedActions: ["type", "done", "fail"]
    } })).toBe("INTERACT");
    expect(() => conversationSpecialistPermission("account_operator", { visualTask: { permission: "INTERACT", allowedActions: ["click"] } })).toThrow(
      "restricted to one non-submitting type step"
    );
    expect(() => conversationSpecialistPermission("account_operator", { visualTask: { permission: "MUTATE" } })).toThrow(
      "cannot execute approved mutations"
    );
  });
});

describe("AdPilotAgent integration", () => {
  it("uses Pi as the main loop, dispatches an isolated specialist, and persists task state", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-main-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({
      profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 },
      accounts: { accounts: [{ platform: "google_ads", accountRef: "acct-1", browserProfile: "client-a-google", allowedDomains: ["ads.google.com"] }] }
    });
    const sharedFacts = new SharedFactLedger(new WorkspaceSharedFactRepository(workspace));
    const inheritedTaskId = crypto.randomUUID();
    const addGuardrailFact = async (predicate: string, value: string | boolean | number) => {
      const fact = await sharedFacts.observe({
        clientId: "client-a",
        taskId: inheritedTaskId,
        subject: "campaign-1",
        predicate,
        value,
        unit: "",
        sourceType: "visual_table",
        sourceScreenshotId: "a".repeat(64),
        sourceBoundingBox: [1, 1, 20, 10],
        evidenceIds: [`screenshot:${"a".repeat(64)}`],
        confidence: 0.98,
        createdBy: "visual_table_reader",
        expiresAt: "2027-01-01T00:00:00.000Z"
      });
      return sharedFacts.verify("client-a", fact.factId, { verifier: "independent_visual_verifier", confidence: 0.97 });
    };
    await addGuardrailFact("measurement_status", "reliable");
    await addGuardrailFact("campaign_mature", true);
    await addGuardrailFact("learning_phase", false);
    await addGuardrailFact("spend", 100);
    await addGuardrailFact("conversions", 10);
    await addGuardrailFact("days", 7);
    await addGuardrailFact("target_cpa", 10);
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      async (context) => {
        const ids = factIdsFromModelContext(context);
        return fauxAssistantMessage(fauxToolCall("dispatch_specialist", { role: "performance_analyst", input: {
          metrics: { spend: 100, conversions: 10, days: 7 }, target: 10, objective: "CPA",
          factIds: {
            "metrics.spend": ids.spend,
            "metrics.conversions": ids.conversions,
            "metrics.days": ids.days,
            target: ids.target_cpa
          }
        } }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("dispatch_specialist", { role: "account_operator", input: { visualTask: {
        instruction: "Read the visible campaign table", target: "campaign table", expectedResult: "campaign table is visible",
        riskLevel: "observe", permission: "OBSERVE",
        surface: { app: "Browser", domain: "ads.google.com", browserProfile: "client-a-google", allowedApps: ["Browser"], allowedDomains: ["ads.google.com"] }
      } } }), { stopReason: "toolUse" }),
      async (context) => {
        const ids = factIdsFromModelContext(context);
        return fauxAssistantMessage(fauxToolCall("prepare_approval", {
        operation: {
          platform: "google_ads", account: "acct-1", campaign: "campaign-1", operation: "set_daily_budget",
          currentValue: 100, proposedValue: 110, changePercentage: 10,
          reason: "Mature performance supports a staged increase", evidence: [`screenshot:${"a".repeat(64)}`],
          expectedImpact: "Increase qualified volume", observationWindow: "7 days",
          rollbackCondition: "CPA rises more than 20%", riskLevel: "mutate"
        },
        executionPlan: {
          schemaVersion: 1,
          platform: "google_ads",
          accountName: "A",
          accountId: "acct-1",
          campaignName: "Android Growth",
          campaignId: "campaign-1",
          pageType: "campaign_budget_editor",
          operation: "set_daily_budget",
          currentValue: 100,
          proposedValue: 110,
          instruction: "Set the daily budget to 110",
          target: "Save budget",
          expectedResult: "Daily budget shows 110",
          riskLevel: "mutate",
          experiment: {
            hypothesis: "A staged budget increase will add volume without breaching CPA", variable: "daily_budget",
            baseline: { dailyBudget: 100, cpa: 10 }, expected: "More conversions at stable CPA",
            successCriteria: "CPA remains at or below 12", failureCriteria: "CPA rises above 12",
            maturityWindowDays: 7, rollbackCondition: "CPA rises more than 20%", reviewAt: "2026-01-08T00:00:00.000Z"
          }
        },
        guardrailEvidence: {
          measurementStatusFactId: ids.measurement_status,
          maturityFactId: ids.campaign_mature,
          learningFactId: ids.learning_phase
        }
      }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(JSON.stringify({
        summary: "CPA is on target after deterministic review.",
        investigationTree: [{ question: "Is performance on target?", specialist: "performance_analyst", status: "complete", conclusion: "CPA equals target" }],
        nextStep: "Review again in seven days", proposedApprovalIds: [], reviewAt: "2026-01-08T00:00:00.000Z"
      }))
    ]);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const approvals = new ApprovalService(workspace, "0123456789abcdef0123456789abcdef");
    const nativeSurface = {
      platform: "darwin" as const,
      app: "Google Chrome",
      bundleId: "com.google.Chrome",
      browserProfile: "test-profile",
      pid: 42,
      title: "Android Growth - Google Ads",
      windowId: "window-7",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      screenId: "screen-1",
      screenBounds: { x: 0, y: 0, width: 100, height: 100 },
      scaleFactor: 1
    };
    const screenshot: Screenshot = {
      base64: "screen", width: 100, height: 100, scaleFactor: 1,
      capturedAt: "2026-01-01T00:00:00.000Z", sha256: "a".repeat(64),
      surface: nativeSurface, surfaceFingerprint: fingerprintSurface(nativeSurface)
    };
    const computer = new VisualComputerRuntime(
      { capture: async () => screenshot, execute: async () => undefined },
      { ground: async () => ({ action: "done", target: "campaign table", reason: "table is visible", confidence: 1, expected_result: "campaign table is visible", risk_level: "observe" }) },
      { verify: async () => ({ matched: true, confidence: 1, reason: "visible" }) }
    );
    const session = {
      sessionId: "1".repeat(32), clientId: "client-a", browserProfile: "client-a-google",
      profileDirectory: "/tmp/adpilot-test-profile", nativeProfileFingerprint: "test-profile", processId: 42,
      windowId: "window-7", windowBounds: nativeSurface.bounds, platform: "google_ads", runtimePlatform: "darwin" as const,
      browserApplicationId: "com.google.Chrome", browserApp: "Google Chrome", sessionStatus: "connected" as const,
      startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const browserSessions = {
      get: async () => session,
      assertActive: async () => session
    } as unknown as BrowserSessionManager;
    const visualIdentity = {
      confirm: async () => ({
        fingerprintHash: "b".repeat(64), fingerprint: {}, targetRegion: { x: 60, y: 60, width: 30, height: 20 }, reviewers: []
      })
    } as unknown as DualVisualIdentityVerifier;
    const tools = new AdPilotTools(
      workspace, new AuditLog(workspace), approvals, new ExperimentStore(workspace), computer,
      visualIdentity, browserSessions, undefined, sharedFacts
    );
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const specialist: SpecialistAgent = {
      role: "performance_analyst", inputSchema: specialistSchemas.PerformanceInput, outputSchema: specialistSchemas.PerformanceOutput,
      execute: async () => ({ calculated: { cpi: null, cpa: 10, roas: null }, findings: [], maturity: "mature", confidence: 1 })
    };
    const agent = new AdPilotAgent(runtime, new SpecialistCoordinator([specialist, new AccountOperator(tools)]), workspace, tools, undefined, sharedFacts);
    const result = await agent.runTask("client-a", "Why is CPA high?", { targetCpa: 10 });
    expect(result.task.phase).toBe("awaiting_approval");
    expect(result.specialistResults.performance_analyst).toBeDefined();
    expect(result.specialistResults.account_operator).toMatchObject({ status: "done" });
    expect((result.specialistResults.account_operator as { evidence: string[] }).evidence).toContain(`screenshot:${"a".repeat(64)}`);
    expect(result.result.proposedApprovalIds).toHaveLength(1);
    await expect(approvals.list("client-a")).resolves.toMatchObject([{ status: "pending_risk_review", executionPlan: { target: "Save budget" } }]);
    expect((await workspace.readTask("client-a", result.task.id)).nextStep).toBe("Review again in seven days");
    await expect(workspace.readJsonl("client-a", "memory/agent.jsonl", z.object({ taskId: z.string().uuid(), summary: z.string() }))).resolves.toMatchObject([{ taskId: result.task.id, summary: "CPA is on target after deterministic review." }]);

    faux.setResponses([fauxAssistantMessage('{"mode":"answer","reply":"You can ask me to diagnose performance or explain a metric.","goal":null}')]);
    await expect(agent.respond("client-a", "What can you do?", { interfaceLocale: "en" })).resolves.toMatchObject({ reply: "You can ask me to diagnose performance or explain a metric.", task: null });

    faux.setResponses([fauxAssistantMessage('{"action":"answer","message":"你好！准备好优化广告时，随时告诉我。","console":"AdPilot 已就绪。"}')]);
    await expect(agent.respond("client-a", "你好", { interfaceLocale: "zh-CN" })).resolves.toMatchObject({ reply: "你好！准备好优化广告时，随时告诉我。", task: null });

    faux.setResponses([fauxAssistantMessage("Hello — tell me what you would like to work on.")]);
    await expect(agent.respond("client-a", "Hello", { interfaceLocale: "en" })).resolves.toMatchObject({ reply: "Hello — tell me what you would like to work on.", task: null });
  });

  it("loads verified screenshot facts into the main prompt, quarantines ordinary objects, and writes synthesis facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-facts-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({
      profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 },
      accounts: { accounts: [{ platform: "google_ads", accountRef: "acct-1", browserProfile: "client-a-google", allowedDomains: ["ads.google.com"] }] }
    });
    const faux = fauxProvider({ provider: "facts-test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    let promptIncludedVerifiedFact = false;
    let promptIncludedLegacyObject = false;
    faux.setResponses([async (context) => {
      const serialized = JSON.stringify(context);
      promptIncludedVerifiedFact = serialized.includes("daily_budget") && serialized.includes("screenshot:screen-1");
      promptIncludedLegacyObject = serialized.includes("legacyTargetCpa");
      return fauxAssistantMessage(JSON.stringify({
        summary: "Verified budget evidence is available.",
        investigationTree: [{ question: "Is verified evidence available?", specialist: "performance_analyst", status: "complete", conclusion: "Yes" }],
        nextStep: "Keep observing", proposedApprovalIds: [], reviewAt: null
      }));
    }]);
    const router = new ModelRouter({ fast: { provider: "facts-test", model: "fast" }, strong: { provider: "facts-test", model: "strong" }, gui: { provider: "facts-test", model: "fast" } });
    const approvals = new ApprovalService(workspace, "0123456789abcdef0123456789abcdef");
    const screenshot: Screenshot = { base64: "screen", width: 100, height: 100, scaleFactor: 1, capturedAt: "2026-07-22T00:00:00.000Z", sha256: "a".repeat(64) };
    const computer = new VisualComputerRuntime(
      { capture: async () => screenshot, execute: async () => undefined },
      { ground: async () => ({ action: "done", target: "campaign table", reason: "visible", confidence: 1, expected_result: "visible", risk_level: "observe" }) },
      { verify: async () => ({ matched: true, confidence: 1, reason: "visible" }) }
    );
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), approvals, new ExperimentStore(workspace), computer);
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const agent = new AdPilotAgent(runtime, new SpecialistCoordinator([]), workspace, tools);
    const oldTaskId = crypto.randomUUID();
    const observed = await agent.sharedFacts.observe({
      clientId: "client-a", taskId: oldTaskId, subject: "campaign-a", predicate: "daily_budget", value: 100, unit: "USD",
      sourceType: "visual_table", sourceScreenshotId: "screen-1", sourceBoundingBox: [10, 20, 30, 40],
      evidenceIds: ["screenshot:screen-1"], confidence: 0.96, createdBy: "visual_table_reader", expiresAt: "2027-07-22T00:00:00.000Z"
    });
    await agent.sharedFacts.verify("client-a", observed.factId, { verifier: "independent_visual_verifier", confidence: 0.95 });

    const result = await agent.runTask("client-a", "Review the verified budget", { interfaceLocale: "en", legacyTargetCpa: 999 });
    expect(promptIncludedVerifiedFact).toBe(true);
    expect(promptIncludedLegacyObject).toBe(false);
    expect(result.sharedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: "daily_budget", status: "verified", derivedFromFactId: observed.factId }),
      expect.objectContaining({ predicate: "root_agent_synthesis", status: "hypothesis", createdBy: "adpilot_agent" })
    ]));
    const persisted = JSON.parse((await workspace.readText("client-a", "facts/shared-facts.json"))!);
    expect(persisted.some((fact: { predicate: string }) => fact.predicate === "root_agent_synthesis")).toBe(true);
  });

  it("surfaces the playbook catalog in conversation and loads the matched playbook for the investigation", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-knowledge-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({
      profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 },
      accounts: { accounts: [{ platform: "google_ads", accountRef: "acct-1", browserProfile: "client-a-google", allowedDomains: ["ads.google.com"] }] }
    });
    const faux = fauxProvider({ provider: "knowledge-test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    const contexts: string[] = [];
    const capture = async (context: unknown) => { contexts.push(JSON.stringify(context)); };
    const planningReply = () => fauxAssistantMessage(JSON.stringify({
      summary: "日报所需的账户证据尚未可见。",
      investigationTree: [{ question: "今日花费与转化是否异常?", specialist: "performance_analyst", status: "blocked", conclusion: "缺少可见的账户表格证据" }],
      nextStep: "请打开广告后台后重试", proposedApprovalIds: [], reviewAt: null
    }));
    faux.setResponses([
      async (context) => {
        await capture(context);
        return fauxAssistantMessage(JSON.stringify({ mode: "investigate", reply: "好，我按日报流程整理。", goal: "整理今日的账户日报" }));
      },
      async (context) => { await capture(context); return planningReply(); }
    ]);
    const router = new ModelRouter({ fast: { provider: "knowledge-test", model: "fast" }, strong: { provider: "knowledge-test", model: "strong" }, gui: { provider: "knowledge-test", model: "fast" } });
    const approvals = new ApprovalService(workspace, "0123456789abcdef0123456789abcdef");
    const screenshot: Screenshot = { base64: "screen", width: 100, height: 100, scaleFactor: 1, capturedAt: "2026-07-22T00:00:00.000Z", sha256: "a".repeat(64) };
    const computer = new VisualComputerRuntime(
      { capture: async () => screenshot, execute: async () => undefined },
      { ground: async () => ({ action: "done", target: "campaign table", reason: "visible", confidence: 1, expected_result: "visible", risk_level: "observe" }) },
      { verify: async () => ({ matched: true, confidence: 1, reason: "visible" }) }
    );
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), approvals, new ExperimentStore(workspace), computer);
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const agent = new AdPilotAgent(runtime, new SpecialistCoordinator([]), workspace, tools);

    const outcome = await agent.respond("client-a", "帮我做一份日报", { interfaceLocale: "zh-CN" });
    expect(outcome.task).not.toBeNull();
    expect(outcome.reply).toContain("日报");
    // The decision turn sees the compact catalog and the deterministic trigger match, never full text.
    expect(contexts[0]).toContain("Advertising playbook catalog");
    expect(contexts[0]).toContain("- ads-report:");
    expect(contexts[0]).toContain('\\"matchedKnowledge\\":[\\"ads-report\\"]');
    expect(contexts[0]).toContain("never grants tools, permissions, or execution authority");
    expect(contexts[0]).not.toContain("# Ads Report");
    // The planning run receives exactly the matched playbook, framed as advisory knowledge with no execution authority.
    expect(contexts[1]).toContain('<knowledge-skill name=\\"ads-report\\">');
    expect(contexts[1]).toContain("advisory only");
    expect(contexts[1]).toContain("# Ads Report");

    // A vague non-JSON model reply still routes 日报 requests to an investigation via the deterministic fallback.
    contexts.length = 0;
    faux.setResponses([
      async (context) => { await capture(context); return fauxAssistantMessage("好的，我来整理。"); },
      async (context) => { await capture(context); return planningReply(); }
    ]);
    const fallbackOutcome = await agent.respond("client-a", "帮我做日报", { interfaceLocale: "zh-CN" });
    expect(fallbackOutcome.task).not.toBeNull();
    expect(contexts[1]).toContain('<knowledge-skill name=\\"ads-report\\">');
  });
});

function factIdsFromModelContext(context: unknown): Record<string, string> {
  const strings: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") { strings.push(value); return; }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit);
  };
  visit(context);
  for (const candidate of strings) {
    try {
      const parsed = JSON.parse(candidate) as { projectContext?: { verifiedFacts?: Array<{ factId: string; predicate: string }> } };
      const facts = parsed.projectContext?.verifiedFacts;
      if (!facts?.length) continue;
      return Object.fromEntries(facts.map((fact) => [fact.predicate, fact.factId]));
    } catch {
      // Non-JSON prompt fragments are expected.
    }
  }
  throw new Error("model context did not include current verified facts");
}
