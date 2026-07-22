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
      input: { metrics: { spend: 10, days: 7 }, target: 2, objective: "CPA" }, sharedFacts: { target: 2 }
    }) as { confidence: number };
    expect(result.confidence).toBe(1);
    expect(seen).toEqual([{ target: 2 }]);
    await expect(coordinator.dispatch("media_buyer", { context: { clientId: "x", taskId: crypto.randomUUID(), actor: "x", permission: "OBSERVE" }, input: {}, sharedFacts: {} })).rejects.toThrow("unavailable");
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
      sharedFacts: {}
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

  it("forwards only verified or explicitly required observed facts from the same task", () => {
    const taskId = crypto.randomUUID();
    const otherTaskId = crypto.randomUUID();
    const base = {
      source: "test",
      evidence: ["fixture:evidence"],
      confidence: 0.9,
      created_by: "root_agent",
      verified_by: ["measurement_reviewer"],
      task_id: taskId,
      expires_at: null,
      value: 1
    } satisfies Omit<SharedFact, "fact_id" | "status">;
    const facts: SharedFact[] = [
      { ...base, fact_id: "verified", status: "verified" },
      { ...base, fact_id: "required-observation", status: "observed", verified_by: [] },
      { ...base, fact_id: "unselected-observation", status: "observed", verified_by: [] },
      { ...base, fact_id: "disputed", status: "disputed" },
      { ...base, fact_id: "expired", status: "verified", expires_at: "2026-01-01T00:00:00.000Z" },
      { ...base, fact_id: "other-task", status: "verified", task_id: otherTaskId }
    ];
    const selected = selectSharedFactsForSpecialist(facts, {
      taskId,
      role: "performance_analyst",
      requiredObservedFactIds: ["required-observation"],
      now: new Date("2026-07-22T00:00:00.000Z")
    });
    expect(selected.map((fact) => fact.fact_id)).toEqual(["verified", "required-observation"]);
  });

  it("adapts legacy fact records but removes transcript-like payloads", () => {
    const selected = selectSharedFactsForSpecialist({ targetCpa: 10, recentMemory: [{ summary: "private history" }], messages: ["full conversation"] }, {
      taskId: crypto.randomUUID(),
      role: "media_buyer"
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ fact_id: "legacy.targetCpa", status: "observed", value: 10 });
  });
});
