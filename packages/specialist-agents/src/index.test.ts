import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { RuntimeRequest, RuntimeResult } from "@adpilot/runtime";
import type { SharedFact } from "@adpilot/shared";
import {
  InMemorySpecialistSessionRepository,
  PerformanceAnalyst,
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
    const result = await coordinator.dispatch("performance_analyst", {
      context: { clientId: "client-a", taskId: crypto.randomUUID(), actor: "main", permission: "OBSERVE" },
      input: { metrics: { spend: 10, days: 7 }, target: 2, objective: "CPA" }, sharedFacts: []
    }) as { confidence: number };
    expect(result.confidence).toBe(1);
    expect(seen).toEqual([[]]);
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
      input: { metrics: { spend: 10, days: 7 }, target: 2, objective: "CPA" },
      sharedFacts: []
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
});
