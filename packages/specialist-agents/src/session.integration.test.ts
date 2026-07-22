import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeRequest, RuntimeResult } from "@adpilot/runtime";
import { PiAgentRuntime } from "@adpilot/runtime";
import { WorkspaceStore } from "@adpilot/workspace";
import { ModelRouter } from "@adpilot/model-router";
import { SkillRegistry } from "@adpilot/skills";
import { AdPilotTools } from "@adpilot/tools";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import type { SharedFact } from "@adpilot/shared";
import {
  InMemorySpecialistSessionRepository,
  PerformanceAnalyst,
  SpecialistCoordinator,
  type SpecialistRuntime
} from "./index.js";

describe("task-scoped specialist session integration", () => {
  it("resumes a specialist after coordinator reconstruction through the repository interface", async () => {
    const calls: RuntimeRequest[] = [];
    const runtime: SpecialistRuntime = {
      run: async (request): Promise<RuntimeResult> => {
        calls.push(request);
        const text = JSON.stringify({ calculated: { cpi: null, cpa: 5, roas: null }, findings: [], maturity: "mature", confidence: 0.9 });
        return {
          text,
          model: { provider: "test", id: "fast", tier: "fast" },
          messages: [...(request.priorMessages ?? []), fauxAssistantMessage(text)],
          events: [],
          recovered: false
        };
      }
    };
    const repository = new InMemorySpecialistSessionRepository();
    const taskId = crypto.randomUUID();
    const dispatch = (coordinator: SpecialistCoordinator) => coordinator.dispatch("performance_analyst", {
      context: { clientId: "client-a", taskId, actor: "root_agent", permission: "OBSERVE" },
      input: {
        metrics: { spend: 50, conversions: 10, days: 7 }, target: 5, objective: "CPA",
        factIds: { "metrics.spend": "spend", "metrics.conversions": "conversions", "metrics.days": "days", target: "target" }
      },
      sharedFacts: specialistFacts(taskId)
    });

    await dispatch(new SpecialistCoordinator([new PerformanceAnalyst(runtime, repository)]));
    await dispatch(new SpecialistCoordinator([new PerformanceAnalyst(runtime, repository)]));

    expect(calls).toHaveLength(2);
    expect(calls[1]?.context.sessionId).toBe(calls[0]?.context.sessionId);
    expect(calls[1]?.priorMessages).toHaveLength(1);
    expect(calls[1]?.priorMessages?.[0]).toMatchObject({ role: "assistant" });
  });

  it("restores the same task specialist from the persisted Pi session after runtime reconstruction", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-specialist-restart-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 5 } });
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const makeRuntime = () => {
      const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
      return new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    };
    const taskId = crypto.randomUUID();
    const request = {
      context: { clientId: "client-a", taskId, actor: "root_agent", permission: "OBSERVE" as const },
      input: { metrics: {
        spend: 50, conversions: 10, impressions: 0, clicks: 0, installs: 0, revenue: 0, days: 7,
        conversionDelayDays: 0, dailyConversions: [], currencyConsistency: 1, missingValueRate: 0, reconciliationDifference: 0
      }, target: 5, objective: "CPA", factIds: {
        "metrics.spend": "spend", "metrics.conversions": "conversions", "metrics.impressions": "impressions",
        "metrics.clicks": "clicks", "metrics.installs": "installs", "metrics.revenue": "revenue",
        "metrics.days": "days", "metrics.conversionDelayDays": "conversionDelayDays",
        "metrics.currencyConsistency": "currencyConsistency", "metrics.missingValueRate": "missingValueRate",
        "metrics.reconciliationDifference": "reconciliationDifference", target: "target"
      } },
      sharedFacts: specialistFacts(taskId, true)
    };
    faux.setResponses([fauxAssistantMessage('{"calculated":{"cpi":null,"cpa":5,"roas":null},"findings":[],"maturity":"mature","confidence":0.9}')]);
    await new PerformanceAnalyst(makeRuntime()).execute(request);

    let sawPrevious = false;
    faux.setResponses([(context) => {
      const transcript = JSON.stringify(context.messages);
      sawPrevious = transcript.includes("cpa") && transcript.includes("0.9");
      return fauxAssistantMessage('{"calculated":{"cpi":null,"cpa":4.5,"roas":null},"findings":[],"maturity":"mature","confidence":0.95}');
    }]);
    await expect(new PerformanceAnalyst(makeRuntime()).execute(request)).resolves.toMatchObject({ calculated: { cpa: 4.5 } });
    expect(sawPrevious).toBe(true);
  });
});

function specialistFacts(taskId: string, all = false): SharedFact[] {
  const values: Array<[string, number, string]> = [
    ["spend", 50, "spend"], ["conversions", 10, "conversions"], ["days", 7, "days"], ["target_cpa", 5, "target"]
  ];
  if (all) values.push(
    ["impressions", 0, "impressions"], ["clicks", 0, "clicks"], ["installs", 0, "installs"],
    ["revenue", 0, "revenue"], ["conversion_delay_days", 0, "conversionDelayDays"],
    ["currency_consistency", 1, "currencyConsistency"], ["missing_value_rate", 0, "missingValueRate"],
    ["reconciliation_difference", 0, "reconciliationDifference"]
  );
  return values.map(([predicate, value, factId]) => ({
    factId, clientId: "client-a", taskId, subject: "campaign-a", predicate, value, unit: "",
    sourceType: "visual_table", sourceScreenshotId: `screen-${factId}`, sourceBoundingBox: [1, 2, 3, 4],
    evidenceIds: [`screenshot:screen-${factId}`], confidence: 0.95, status: "verified",
    createdBy: "visual_table_reader", verifiedBy: ["visual_verifier"], createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:01.000Z", verifiedAt: "2026-07-22T00:00:01.000Z",
    expiresAt: "2027-07-22T00:00:00.000Z", statusReason: null, supersededByFactId: null, derivedFromFactId: null
  }));
}
