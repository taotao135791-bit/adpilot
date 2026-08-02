import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { RuntimeRequest, RuntimeResult } from "@adpilot/runtime";
import type { SharedFact } from "@adpilot/shared";
import type { AdPilotTools } from "@adpilot/tools";
import {
  AccountOperator,
  InMemorySpecialistSessionRepository,
  MediaBuyer,
  MeasurementReviewer,
  PerformanceAnalyst,
  ReportingAnalyst,
  SpecialistCoordinator,
  selectSharedFactsForSpecialist,
  specialistSchemas,
  specialistSessionKey,
  type SpecialistAgent,
  type SpecialistRuntime
} from "./index.js";

describe("specialist agents", () => {
  it("keeps roles isolated and validates structured input/output", async () => {
    const seen: unknown[] = [];
    const agent: SpecialistAgent = {
      role: "performance_analyst",
      inputSchema: specialistSchemas.PerformanceInput,
      outputSchema: specialistSchemas.PerformanceOutput,
      execute: async (request) => { seen.push(request.sharedFacts); return { calculated: { cpi: 1, cpa: 2, roas: 3 }, findings: [], maturity: "mature", confidence: 1 }; }
    };
    const coordinator = new SpecialistCoordinator([agent]);
    const taskId = crypto.randomUUID();
    const result = await coordinator.dispatch("performance_analyst", {
      context: { clientId: "client-a", taskId, actor: "main", permission: "OBSERVE" },
      input: {
        metrics: { spend: 10, days: 7 }, target: 2, objective: "CPA",
        factIds: { "metrics.spend": "spend", "metrics.days": "days", target: "target" }
      },
      sharedFacts: [visualFact(taskId, "spend", 10, "spend"), visualFact(taskId, "days", 7, "days"), visualFact(taskId, "target_cpa", 2, "target")]
    }) as { confidence: number };
    expect(result.confidence).toBe(1);
    expect(seen).toEqual([[expect.objectContaining({ factId: "spend" }), expect.objectContaining({ factId: "days" }), expect.objectContaining({ factId: "target" })]]);
    await expect(coordinator.dispatch("media_buyer", { context: { clientId: "x", taskId: crypto.randomUUID(), actor: "x", permission: "OBSERVE" }, input: {}, sharedFacts: [] })).rejects.toThrow("unavailable");
  });

  it("uses a stable task-and-role session and isolates another task", async () => {
    const calls: RuntimeRequest[] = [];
    const runtime: SpecialistRuntime = {
      run: async (request): Promise<RuntimeResult> => {
        calls.push(request);
        const text = JSON.stringify({ calculated: { cpi: 1, cpa: 2, roas: 3 }, findings: [], maturity: "mature", confidence: 1 });
        return {
          text,
          model: { provider: "test", id: "fast", tier: "fast" },
          messages: [...(request.priorMessages ?? []), fauxAssistantMessage(text)],
          events: [],
          recovered: false
        };
      }
    };
    const sessions = new InMemorySpecialistSessionRepository();
    const coordinator = new SpecialistCoordinator([new PerformanceAnalyst(runtime, sessions)]);
    const taskA = crypto.randomUUID();
    const taskB = crypto.randomUUID();
    const request = (taskId: string) => ({
      context: { clientId: "client-a", taskId, actor: "main", permission: "OBSERVE" as const },
      input: {
        metrics: { spend: 10, days: 7 }, target: 2, objective: "CPA",
        factIds: { "metrics.spend": "spend", "metrics.days": "days", target: "target" }
      },
      sharedFacts: [
        visualFact(taskId, "spend", 10, "spend"),
        visualFact(taskId, "days", 7, "days"),
        visualFact(taskId, "target_cpa", 2, "target")
      ]
    });

    await coordinator.dispatch("performance_analyst", request(taskA));
    await coordinator.dispatch("performance_analyst", request(taskA));
    await coordinator.dispatch("performance_analyst", request(taskB));

    expect(calls[0]?.context.sessionId).toBe(specialistSessionKey(taskA, "performance_analyst"));
    expect(calls[1]?.context.sessionId).toBe(calls[0]?.context.sessionId);
    expect(calls[1]?.priorMessages).toHaveLength(1);
    expect(calls[2]?.context.sessionId).toBe(specialistSessionKey(taskB, "performance_analyst"));
    expect(calls[2]?.context.sessionId).not.toBe(calls[0]?.context.sessionId);
    expect(calls[2]?.priorMessages).toBeUndefined();
  });

  it("forwards only verified, unexpired facts from the same client and task", () => {
    const taskId = crypto.randomUUID();
    const otherTaskId = crypto.randomUUID();
    const base = {
      clientId: "client-a",
      taskId,
      subject: "campaign-a",
      predicate: "daily_budget",
      unit: "USD",
      sourceType: "visual_table" as const,
      sourceScreenshotId: "screen-1",
      sourceBoundingBox: [1, 2, 3, 4] as [number, number, number, number],
      evidenceIds: ["screenshot:screen-1"],
      confidence: 0.9,
      createdBy: "visual_table_reader",
      verifiedBy: ["visual_verifier"],
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:01.000Z",
      verifiedAt: "2026-07-22T00:00:01.000Z",
      expiresAt: null,
      statusReason: null,
      supersededByFactId: null,
      derivedFromFactId: null,
      value: 1
    } satisfies Omit<SharedFact, "factId" | "status">;
    const facts: SharedFact[] = [
      { ...base, factId: "verified", status: "verified" },
      { ...base, factId: "observation", status: "observed", verifiedBy: [], verifiedAt: null },
      { ...base, factId: "stale", status: "stale", verifiedAt: null, statusReason: "surface changed" },
      { ...base, factId: "expired", status: "verified", expiresAt: "2026-01-01T00:00:00.000Z" },
      { ...base, factId: "other-task", status: "verified", taskId: otherTaskId },
      { ...base, factId: "other-client", status: "verified", clientId: "client-b" },
      { ...base, factId: "migration", status: "verified", sourceType: "migration", sourceScreenshotId: null, sourceBoundingBox: null }
    ];
    const selected = selectSharedFactsForSpecialist(facts, {
      clientId: "client-a",
      taskId,
      role: "performance_analyst",
      now: new Date("2026-07-22T00:00:00.000Z")
    });
    expect(selected.map((fact) => fact.factId)).toEqual(["verified"]);
  });

  it("rejects legacy ordinary-object dispatch from the production selector", () => {
    expect(() => selectSharedFactsForSpecialist({ targetCpa: 10 } as never, {
      clientId: "client-a",
      taskId: crypto.randomUUID(),
      role: "media_buyer"
    })).toThrow();
  });

  it("routes natural-language account investigation table work through the production table tool", async () => {
    const readVisualTable = vi.fn(async () => ({
      status: "done" as const,
      cells: [],
      facts: [],
      screenshots: [],
      checks: { pagesRead: 0, duplicateRowsRemoved: 0, totalsChecked: 0, totalsConsistent: true, anomalies: [] },
      verification: null
    }));
    const operator = new AccountOperator({ readVisualTable } as unknown as AdPilotTools);
    const taskId = crypto.randomUUID();
    await expect(operator.execute({
      context: { clientId: "client-a", taskId, actor: "adpilot_agent", permission: "OBSERVE" },
      input: {
        visualTable: {
          platform: "google_ads",
          targetColumns: [{ key: "campaign", label: "Campaign", valueType: "text", unit: "", critical: true }],
          targetRows: [],
          scrollDirection: "none",
          historicalOverlapRows: [],
          pageScale: 1,
          factTtlMs: 15 * 60_000,
          maxPages: 30,
          sensitiveRegions: []
        }
      },
      sharedFacts: []
    })).resolves.toMatchObject({ status: "done" });
    expect(readVisualTable).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client-a", taskId }), expect.objectContaining({
      platform: "google_ads",
      targetColumns: [expect.objectContaining({ key: "campaign", valueType: "text" })]
    }), undefined);
  });

  it("rejects a conversational click disguised as an interaction before Computer Use", async () => {
    const executeVisualTask = vi.fn();
    const operator = new AccountOperator({ executeVisualTask } as unknown as AdPilotTools);
    await expect(operator.execute({
      context: { clientId: "client-a", taskId: crypto.randomUUID(), actor: "adpilot_agent", permission: "INTERACT" },
      input: {
        visualTask: {
          instruction: "Click Save", target: "Save budget", expectedResult: "saved", riskLevel: "interact", permission: "INTERACT",
          allowedActions: ["click"], retryPolicy: "none",
          surface: { app: "Browser", allowedApps: ["Browser"], allowedDomains: [] }
        }
      },
      sharedFacts: []
    })).rejects.toThrow("type-only preparation step");
    expect(executeVisualTask).not.toHaveBeenCalled();
  });

  it("prevents a media buyer from receiving stale facts", () => {
    const taskId = crypto.randomUUID();
    const selected = selectSharedFactsForSpecialist([{
      factId: "stale-budget", clientId: "client-a", taskId, subject: "campaign-a", predicate: "daily_budget",
      value: 100, unit: "USD", sourceType: "visual_table", sourceScreenshotId: "screen-1",
      sourceBoundingBox: [1, 2, 3, 4], evidenceIds: ["screenshot:screen-1"], confidence: 0.95,
      status: "stale", createdBy: "visual_table_reader", verifiedBy: ["visual_verifier"],
      createdAt: "2026-07-22T00:00:00.000Z", updatedAt: "2026-07-22T00:10:00.000Z",
      verifiedAt: "2026-07-22T00:00:01.000Z", expiresAt: null, statusReason: "surface changed",
      supersededByFactId: null, derivedFromFactId: null
    }], { clientId: "client-a", taskId, role: "media_buyer", now: new Date("2026-07-22T00:11:00.000Z") });
    expect(selected).toEqual([]);
  });

  it("rejects model-authored specialist numbers that do not exactly match bound visual facts", async () => {
    const runtime: SpecialistRuntime = { run: vi.fn() };
    const taskId = crypto.randomUUID();
    const analyst = new PerformanceAnalyst(runtime);
    const input = {
      metrics: { spend: 101, days: 7 },
      target: 10,
      objective: "CPA",
      factIds: { "metrics.spend": "spend", "metrics.days": "days", target: "target" }
    };
    const sharedFacts = [
      visualFact(taskId, "spend", 100, "spend"),
      visualFact(taskId, "days", 7, "days"),
      visualFact(taskId, "target_cpa", 10, "target")
    ];

    await expect(analyst.execute({
      context: { clientId: "client-a", taskId, actor: "root_agent", permission: "OBSERVE" },
      input,
      sharedFacts
    })).rejects.toThrow("unverified numerical specialist input: metrics.spend");
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("rejects same-valued facts with the wrong predicate or without screenshot bounding-box proof", async () => {
    const runtime: SpecialistRuntime = { run: vi.fn() };
    const taskId = crypto.randomUUID();
    const analyst = new PerformanceAnalyst(runtime);
    const input = {
      metrics: { spend: 100, days: 7 }, target: 10, objective: "CPA",
      factIds: { "metrics.spend": "wrong", "metrics.days": "days", target: "target" }
    };
    const wrongPredicate = visualFact(taskId, "impressions", 100, "wrong");
    const noBox = {
      ...visualFact(taskId, "spend", 100, "no-box"),
      sourceType: "workspace" as const,
      sourceScreenshotId: null,
      sourceBoundingBox: null,
      evidenceIds: []
    };

    await expect(analyst.execute({
      context: { clientId: "client-a", taskId, actor: "root_agent", permission: "OBSERVE" },
      input,
      sharedFacts: [wrongPredicate, visualFact(taskId, "days", 7, "days"), visualFact(taskId, "target_cpa", 10, "target")]
    })).rejects.toThrow("unverified numerical specialist input: metrics.spend");
    await expect(analyst.execute({
      context: { clientId: "client-a", taskId, actor: "root_agent", permission: "OBSERVE" },
      input: { ...input, factIds: { ...input.factIds, "metrics.spend": "no-box" } },
      sharedFacts: [noBox, visualFact(taskId, "days", 7, "days"), visualFact(taskId, "target_cpa", 10, "target")]
    })).rejects.toThrow("unverified numerical specialist input: metrics.spend");
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("requires explicit fact ids instead of value-only matching across Campaigns", async () => {
    const runtime: SpecialistRuntime = { run: vi.fn() };
    const taskId = crypto.randomUUID();
    const duplicateSpend = { ...visualFact(taskId, "spend", 100, "spend-b"), subject: "campaign-b" };
    await expect(new PerformanceAnalyst(runtime).execute({
      context: { clientId: "client-a", taskId, actor: "root_agent", permission: "OBSERVE" },
      input: { metrics: { spend: 100, days: 7 }, target: 10, objective: "CPA", factIds: {} },
      sharedFacts: [
        visualFact(taskId, "spend", 100, "spend-a"), duplicateSpend,
        visualFact(taskId, "days", 7, "days"), visualFact(taskId, "target_cpa", 10, "target")
      ]
    })).rejects.toThrow("unverified numerical specialist input: metrics.spend");
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("enforces fact binding for media buyer and measurement reviewer without affecting other roles", async () => {
    const runtime: SpecialistRuntime = { run: vi.fn() };
    const taskId = crypto.randomUUID();
    const context = { clientId: "client-a", taskId, actor: "root_agent", permission: "OBSERVE" as const };
    await expect(new MediaBuyer(runtime).execute({
      context,
      input: {
        change: {
          kind: "budget", currentValue: 100, proposedValue: 110, maxChangePercent: 20,
          activeExperimentVariables: [], measurementStatus: "reliable", mature: true, learning: false
        },
        objective: "CPA", businessBoundary: "No more than 20%", factIds: {}
      },
      sharedFacts: []
    })).rejects.toThrow("unverified numerical specialist input: change.currentValue");

    await expect(new MeasurementReviewer(runtime).execute({
      context,
      input: {
        metrics: { spend: 100, days: 7 }, platformConversions: 10, sourceConversions: 10,
        duplicatedEvents: 0, eventIdsPresent: true, factIds: {}
      },
      sharedFacts: []
    })).rejects.toThrow("unverified numerical specialist input: metrics.spend");
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("dispatches the reporting analyst with reporting skills, report routing, and verified fact binding", async () => {
    const calls: RuntimeRequest[] = [];
    const runtime: SpecialistRuntime = {
      run: async (request): Promise<RuntimeResult> => {
        calls.push(request);
        const text = JSON.stringify({ reportType: "daily", markdown: "# Daily Ads Report\n\n## Observed Facts\n\n- ok", reliability: "reliable", findings: [], confidence: 0.9 });
        return {
          text,
          model: { provider: "test", id: "fast", tier: "fast" },
          messages: [...(request.priorMessages ?? []), fauxAssistantMessage(text)],
          events: [],
          recovered: false
        };
      }
    };
    const coordinator = new SpecialistCoordinator([new ReportingAnalyst(runtime)]);
    const taskId = crypto.randomUUID();
    const result = await coordinator.dispatch("reporting_analyst", {
      context: { clientId: "client-a", taskId, actor: "main", permission: "OBSERVE" },
      input: {
        reportType: "daily",
        metrics: { spend: 100, conversions: 10, days: 7 },
        target: 10,
        objective: "CPA",
        periodStart: "2026-07-15",
        periodEnd: "2026-07-21",
        timezone: "UTC",
        currency: "USD",
        audience: "client",
        factIds: { "metrics.spend": "spend", "metrics.conversions": "conversions", "metrics.days": "days", target: "target" }
      },
      sharedFacts: [
        visualFact(taskId, "spend", 100, "spend"),
        visualFact(taskId, "conversions", 10, "conversions"),
        visualFact(taskId, "days", 7, "days"),
        visualFact(taskId, "target_cpa", 10, "target")
      ]
    }) as { reportType: string; markdown: string };
    expect(result.reportType).toBe("daily");
    expect(result.markdown).toContain("# Daily Ads Report");
    expect(calls[0]?.allowedSkills).toEqual(["daily-report", "weekly-report", "account-audit", "generate-client-report"]);
    expect(calls[0]?.signals).toEqual({ task: "report" });
  });

  it("rejects reporting analyst numbers that are not bound to verified visual facts", async () => {
    const runtime: SpecialistRuntime = { run: vi.fn() };
    const taskId = crypto.randomUUID();
    await expect(new ReportingAnalyst(runtime).execute({
      context: { clientId: "client-a", taskId, actor: "root_agent", permission: "OBSERVE" },
      input: {
        reportType: "weekly",
        metrics: { spend: 100, days: 7 },
        priorMetrics: { spend: 80, days: 7 },
        objective: "CPA",
        periodStart: "2026-07-08",
        periodEnd: "2026-07-14",
        timezone: "UTC",
        currency: "USD",
        audience: "client",
        factIds: { "metrics.spend": "spend", "metrics.days": "days", "priorMetrics.days": "prior-days" }
      },
      sharedFacts: [
        visualFact(taskId, "spend", 100, "spend"),
        visualFact(taskId, "days", 7, "days"),
        visualFact(taskId, "days", 7, "prior-days")
      ]
    })).rejects.toThrow("unverified numerical specialist input: priorMetrics.spend");
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("lets the media buyer assess campaign launches", () => {
    const runtime: SpecialistRuntime = { run: vi.fn() };
    expect(new MediaBuyer(runtime).allowedSkills).toContain("assess-campaign-launch");
  });
});

function visualFact(taskId: string, predicate: string, value: number, factId: string): SharedFact {
  return {
    factId,
    clientId: "client-a",
    taskId,
    subject: "campaign-a",
    predicate,
    value,
    unit: "",
    sourceType: "visual_table",
    sourceScreenshotId: `screen-${factId}`,
    sourceBoundingBox: [1, 2, 3, 4],
    evidenceIds: [`screenshot:screen-${factId}`],
    confidence: 0.95,
    status: "verified",
    createdBy: "visual_table_reader",
    verifiedBy: ["visual_verifier"],
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:01.000Z",
    verifiedAt: "2026-07-22T00:00:01.000Z",
    expiresAt: "2027-07-22T00:00:00.000Z",
    statusReason: null,
    supersededByFactId: null,
    derivedFromFactId: null
  };
}
