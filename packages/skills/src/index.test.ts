import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotTools } from "@adpilot/tools";
import { SkillRegistry } from "./index.js";

describe("SkillRegistry", () => {
  it("exposes the eight single-responsibility skills with contracts", () => {
    const registry = new SkillRegistry();
    expect(registry.list()).toHaveLength(8);
    for (const skill of registry.list()) {
      expect(skill.prerequisites.length).toBeGreaterThan(0);
      expect(skill.failureConditions.length).toBeGreaterThan(0);
      expect(skill.forbidden.length).toBeGreaterThan(0);
    }
  });

  it("executes skill through a deterministic tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-skill-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const result = await new SkillRegistry().execute("evaluate-budget-change", { clientId: "client-a", taskId: crypto.randomUUID(), actor: "media_buyer", permission: "OBSERVE" }, {
      kind: "budget", currentValue: 100, proposedValue: 150, maxChangePercent: 20,
      activeExperimentVariables: [], measurementStatus: "reliable", mature: true, learning: false
    }, tools) as { cappedValue: number };
    expect(result.cappedValue).toBe(120);
  });
});

