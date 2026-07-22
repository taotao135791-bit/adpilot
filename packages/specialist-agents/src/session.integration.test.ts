import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { RuntimeRequest, RuntimeResult } from "@adpilot/runtime";
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
      input: { metrics: { spend: 50, conversions: 10, days: 7 }, target: 5, objective: "CPA" },
      sharedFacts: {}
    });

    await dispatch(new SpecialistCoordinator([new PerformanceAnalyst(runtime, repository)]));
    await dispatch(new SpecialistCoordinator([new PerformanceAnalyst(runtime, repository)]));

    expect(calls).toHaveLength(2);
    expect(calls[1]?.context.sessionId).toBe(calls[0]?.context.sessionId);
    expect(calls[1]?.priorMessages).toHaveLength(1);
    expect(calls[1]?.priorMessages?.[0]).toMatchObject({ role: "assistant" });
  });
});
