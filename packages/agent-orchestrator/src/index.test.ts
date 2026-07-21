import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { PiAgentRuntime } from "@adpilot/runtime";
import { SkillRegistry } from "@adpilot/skills";
import { SpecialistCoordinator, specialistSchemas, type SpecialistAgent } from "@adpilot/specialist-agents";
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
      fauxAssistantMessage(JSON.stringify({
        summary: "CPA is on target after deterministic review.",
        investigationTree: [{ question: "Is performance on target?", specialist: "performance_analyst", status: "complete", conclusion: "CPA equals target" }],
        nextStep: "Review again in seven days", proposedApprovalIds: [], reviewAt: "2026-01-08T00:00:00.000Z"
      }))
    ]);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const specialist: SpecialistAgent = {
      role: "performance_analyst", inputSchema: specialistSchemas.PerformanceInput, outputSchema: specialistSchemas.PerformanceOutput,
      execute: async () => ({ calculated: { cpi: null, cpa: 10, roas: null }, findings: [], maturity: "mature", confidence: 1 })
    };
    const agent = new AdPilotAgent(runtime, new SpecialistCoordinator([specialist]), workspace);
    const result = await agent.runTask("client-a", "Why is CPA high?", { targetCpa: 10 });
    expect(result.task.phase).toBe("completed");
    expect(result.specialistResults.performance_analyst).toBeDefined();
    expect((await workspace.readTask("client-a", result.task.id)).nextStep).toBe("Review again in seven days");
  });
});

