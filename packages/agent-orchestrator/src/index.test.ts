import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { VisualComputerRuntime, type Screenshot } from "@adpilot/computer-use";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { PiAgentRuntime } from "@adpilot/runtime";
import { SkillRegistry } from "@adpilot/skills";
import { AccountOperator, SpecialistCoordinator, specialistSchemas, type SpecialistAgent } from "@adpilot/specialist-agents";
import { AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotAgent } from "./index.js";

describe("AdPilotAgent integration", () => {
  it("uses Pi as the main loop, dispatches an isolated specialist, and persists task state", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-main-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("dispatch_specialist", { role: "performance_analyst", input: { metrics: { spend: 100, conversions: 10, days: 7 }, target: 10, objective: "CPA" } }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("dispatch_specialist", { role: "account_operator", input: { visualTask: {
        instruction: "Read the visible campaign table", target: "campaign table", expectedResult: "campaign table is visible",
        riskLevel: "observe", permission: "OBSERVE",
        surface: { app: "Browser", domain: "ads.google.com", allowedApps: ["Browser"], allowedDomains: ["ads.google.com"] }
      } } }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("prepare_approval", {
        operation: {
          account: "acct-1", campaign: "campaign-1", operation: "set_daily_budget",
          currentValue: 100, proposedValue: 110, changePercentage: 10,
          reason: "Mature performance supports a staged increase", evidence: [`screenshot:${"a".repeat(64)}`],
          expectedImpact: "Increase qualified volume", observationWindow: "7 days",
          rollbackCondition: "CPA rises more than 20%", riskLevel: "mutate"
        },
        executionPlan: {
          instruction: "Set the daily budget to 110", target: "Save budget", expectedResult: "Daily budget shows 110",
          surface: { app: "Browser", domain: "ads.google.com", allowedApps: ["Browser"], allowedDomains: ["ads.google.com"] },
          experiment: {
            hypothesis: "A staged budget increase will add volume without breaching CPA", variable: "daily_budget",
            baseline: { dailyBudget: 100, cpa: 10 }, expected: "More conversions at stable CPA",
            successCriteria: "CPA remains at or below 12", failureCriteria: "CPA rises above 12",
            maturityWindowDays: 7, rollbackCondition: "CPA rises more than 20%", reviewAt: "2026-01-08T00:00:00.000Z"
          }
        }
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(JSON.stringify({
        summary: "CPA is on target after deterministic review.",
        investigationTree: [{ question: "Is performance on target?", specialist: "performance_analyst", status: "complete", conclusion: "CPA equals target" }],
        nextStep: "Review again in seven days", proposedApprovalIds: [], reviewAt: "2026-01-08T00:00:00.000Z"
      }))
    ]);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const approvals = new ApprovalService(workspace, "0123456789abcdef0123456789abcdef");
    const screenshot: Screenshot = { base64: "screen", width: 100, height: 100, scaleFactor: 1, capturedAt: "2026-01-01T00:00:00.000Z", sha256: "a".repeat(64) };
    const computer = new VisualComputerRuntime(
      { capture: async () => screenshot, execute: async () => undefined },
      { ground: async () => ({ action: "done", target: "campaign table", reason: "table is visible", confidence: 1, expected_result: "campaign table is visible", risk_level: "observe" }) },
      { verify: async () => ({ matched: true, confidence: 1, reason: "visible" }) }
    );
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), approvals, new ExperimentStore(workspace), computer);
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const specialist: SpecialistAgent = {
      role: "performance_analyst", inputSchema: specialistSchemas.PerformanceInput, outputSchema: specialistSchemas.PerformanceOutput,
      execute: async () => ({ calculated: { cpi: null, cpa: 10, roas: null }, findings: [], maturity: "mature", confidence: 1 })
    };
    const agent = new AdPilotAgent(runtime, new SpecialistCoordinator([specialist, new AccountOperator(tools)]), workspace, tools);
    const result = await agent.runTask("client-a", "Why is CPA high?", { targetCpa: 10 });
    expect(result.task.phase).toBe("awaiting_approval");
    expect(result.specialistResults.performance_analyst).toBeDefined();
    expect(result.specialistResults.account_operator).toMatchObject({ status: "done" });
    expect((result.specialistResults.account_operator as { evidence: string[] }).evidence).toContain(`screenshot:${"a".repeat(64)}`);
    expect(result.result.proposedApprovalIds).toHaveLength(1);
    await expect(approvals.list("client-a")).resolves.toMatchObject([{ status: "pending_risk_review", executionPlan: { target: "Save budget" } }]);
    expect((await workspace.readTask("client-a", result.task.id)).nextStep).toBe("Review again in seven days");
  });
});
