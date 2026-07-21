import { describe, expect, it } from "vitest";
import { SpecialistCoordinator, specialistSchemas, type SpecialistAgent } from "./index.js";

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
});

