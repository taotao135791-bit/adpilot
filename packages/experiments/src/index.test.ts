import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "@adpilot/workspace";
import { ExperimentStore } from "./index.js";

describe("ExperimentStore", () => {
  it("tracks lifecycle and prevents variable stacking", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-experiment-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const store = new ExperimentStore(workspace);
    const base = {
      clientId: "client-a", taskId: crypto.randomUUID(), approvalId: crypto.randomUUID(),
      hypothesis: "More budget can unlock efficient volume", variable: "daily_budget",
      baseline: { budget: 100, cpa: 8 }, expected: "More conversions at CPA <= 10",
      successCriteria: "CPA <= 10 after 20 conversions", failureCriteria: "CPA > 12",
      maturityWindowDays: 7, rollbackCondition: "CPA > 12", reviewAt: "2026-01-08T00:00:00.000Z"
    };
    const first = await store.create(base);
    await store.start("client-a", first.id);
    await expect(store.create({ ...base, approvalId: crypto.randomUUID(), variable: "target_cpa" })).rejects.toThrow("single-variable");
    await expect(store.create({ ...base, approvalId: crypto.randomUUID() })).rejects.toThrow("unfinished experiment");
    expect((await store.conclude("client-a", first.id, "won", "CPA held")).status).toBe("won");
  });
});
