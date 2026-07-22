import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotTools, type ToolContext } from "@adpilot/tools";
import { SkillRegistry, formatSkillContract, skillInputFields } from "./index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-skill-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
  const audit = new AuditLog(workspace);
  const tools = new AdPilotTools(workspace, audit, new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
  const context: ToolContext = { clientId: "client-a", taskId: crypto.randomUUID(), actor: "media_buyer", permission: "OBSERVE" };
  return { workspace, audit, tools, context };
}

const healthyMetrics = {
  spend: 500,
  impressions: 50_000,
  clicks: 1_000,
  installs: 100,
  conversions: 50,
  revenue: 1_000,
  days: 7,
  conversionDelayDays: 1,
  dailyConversions: [6, 7, 8, 7, 6, 8, 8],
  currencyConsistency: 1,
  missingValueRate: 0,
  reconciliationDifference: 0
};

describe("SkillRegistry", () => {
  it("exposes the eleven single-responsibility skills with contracts", () => {
    const registry = new SkillRegistry();
    expect(registry.list()).toHaveLength(11);
    expect(new Set(registry.list().map((skill) => skill.name)).size).toBe(11);
    for (const skill of registry.list()) {
      expect(skill.prerequisites.length).toBeGreaterThan(0);
      expect(skill.failureConditions.length).toBeGreaterThan(0);
      expect(skill.forbidden.length).toBeGreaterThan(0);
    }
  });

  it("executes skill through a deterministic tool", async () => {
    const { tools, context } = await fixture();
    const result = await new SkillRegistry().execute("evaluate-budget-change", context, {
      kind: "budget", currentValue: 100, proposedValue: 150, maxChangePercent: 20,
      activeExperimentVariables: [], measurementStatus: "reliable", mature: true, learning: false
    }, tools) as { cappedValue: number };
    expect(result.cappedValue).toBe(120);
  });

  it("describes every skill input contract with field paths, types, and requiredness", () => {
    const registry = new SkillRegistry();
    const fatigue = skillInputFields(registry.get("detect-creative-fatigue"));
    expect(fatigue).toContainEqual({ path: "currentCtr", type: "number >= 0", required: true });
    expect(fatigue).toContainEqual({ path: "daysRunning", type: "integer > 0", required: true });

    const daily = skillInputFields(registry.get("daily-report"));
    expect(daily).toContainEqual({ path: "metrics.spend", type: "number >= 0", required: true });
    expect(daily).toContainEqual(expect.objectContaining({ path: "metrics.impressions", required: false }));
    expect(daily).toContainEqual(expect.objectContaining({ path: "reportDate", type: "string (ISO date)", required: true }));
    expect(daily).toContainEqual(expect.objectContaining({ path: "target", required: false }));
    expect(daily).toContainEqual(expect.objectContaining({ path: "audience", required: false }));

    const weekly = skillInputFields(registry.get("weekly-report"));
    expect(weekly).toContainEqual(expect.objectContaining({ path: "priorMetrics.spend", required: false }));

    const experiment = skillInputFields(registry.get("create-single-variable-experiment"));
    expect(experiment).toContainEqual({ path: "baseline", type: "Record<string, number>", required: true });
    expect(experiment).toContainEqual({ path: "approvalId", type: "string (uuid)", required: true });
    expect(experiment).toContainEqual({ path: "reviewAt", type: "string (ISO datetime)", required: true });

    const contract = formatSkillContract(registry.get("evaluate-budget-change"));
    expect(contract).toContain("evaluate-budget-change: Evaluate a proposed budget change");
    expect(contract).toContain("currentValue: number > 0 (required)");
    expect(contract).toContain('measurementStatus: "reliable" | "warning" | "blocked" (required)');
    expect(contract).toContain("maxChangePercent: number >= 0, <= 100 (optional)");
    expect(contract).toContain("Forbidden: Exceeding the staged cap");
  });

  it("appends a succeeded audit event with input and output fingerprints", async () => {
    const { audit, tools, context } = await fixture();
    const result = await new SkillRegistry().execute("detect-creative-fatigue", context, {
      currentCtr: 0.01, priorCtr: 0.02, frequency: 4, daysRunning: 10, spendShare: 0.5
    }, tools) as { fatigued: boolean };
    expect(result.fatigued).toBe(true);
    const events = (await audit.list("client-a")).filter((event) => event.action === "execute_skill");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "succeeded", actor: "media_buyer" });
    expect(events[0]?.details).toMatchObject({ skill: "detect-creative-fatigue" });
    expect(events[0]?.details.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(events[0]?.details.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("audits denied input-contract violations and failed executions", async () => {
    const { audit, tools, context } = await fixture();
    const registry = new SkillRegistry();
    await expect(registry.execute("detect-creative-fatigue", context, { currentCtr: -1 }, tools)).rejects.toThrow();
    await expect(registry.execute("create-single-variable-experiment", context, {
      hypothesis: "budget adds volume", variable: "daily_budget", baseline: { budget: 100 },
      expected: "more conversions", successCriteria: "CPA holds", failureCriteria: "CPA rises 20%",
      maturityWindowDays: 7, rollbackCondition: "CPA rises 20%",
      reviewAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), approvalId: crypto.randomUUID()
    }, tools)).rejects.toThrow("executed approval");
    const events = (await audit.list("client-a")).filter((event) => event.action === "execute_skill");
    expect(events.map((event) => [event.status, event.details.skill])).toEqual([
      ["denied", "detect-creative-fatigue"],
      ["failed", "create-single-variable-experiment"]
    ]);
    expect(events[0]?.details.reason).toContain("input contract rejected");
    expect(events[1]?.details.reason).toContain("executed approval");
    expect(events[1]?.details.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await audit.verify("client-a")).toBe(true);
  });
});

describe("reporting skills", () => {
  it("daily-report separates observed facts, deterministic calculations, and inferences", async () => {
    const { tools, context } = await fixture();
    const result = await new SkillRegistry().execute("daily-report", context, {
      metrics: healthyMetrics, reportDate: "2026-07-22", timezone: "Asia/Shanghai",
      currency: "USD", objective: "CPA", target: 10, audience: "client"
    }, tools) as { markdown: string; reliability: string; mature: boolean };
    expect(result.reliability).toBe("reliable");
    expect(result.mature).toBe(true);
    expect(result.markdown).toContain("# Daily Ads Report");
    expect(result.markdown).toContain("**Date:** 2026-07-22");
    const observed = result.markdown.split("## Observed Facts")[1]?.split("## Calculated")[0] ?? "";
    expect(observed).toContain("Spend: 500 USD over 7 day(s)");
    expect(observed).toContain("Conversions: 50; revenue: 1000 USD");
    const calculated = result.markdown.split("## Calculated")[1]?.split("## Inferences")[0] ?? "";
    expect(calculated).toContain("CPA: 10 USD");
    expect(calculated).toContain("Measurement reliability: reliable");
    const inferences = result.markdown.split("## Inferences")[1] ?? "";
    expect(inferences).toContain("within 20% of the CPA target");
  });

  it("daily-report rejects invalid metrics through the input contract", async () => {
    const { tools, context } = await fixture();
    await expect(new SkillRegistry().execute("daily-report", context, {
      metrics: { ...healthyMetrics, spend: -1 }, reportDate: "2026-07-22",
      timezone: "UTC", currency: "USD", objective: "CPA"
    }, tools)).rejects.toThrow();
  });

  it("weekly-report reports deterministic deltas only from supplied prior metrics", async () => {
    const { tools, context } = await fixture();
    const registry = new SkillRegistry();
    const result = await registry.execute("weekly-report", context, {
      metrics: healthyMetrics,
      priorMetrics: { ...healthyMetrics, spend: 400, conversions: 40, revenue: 800 },
      periodStart: "2026-07-14", periodEnd: "2026-07-20", timezone: "UTC",
      currency: "USD", objective: "CPA", target: 10
    }, tools) as { markdown: string; reliability: string };
    expect(result.markdown).toContain("# Weekly Ads Report");
    expect(result.markdown).toContain("**Period:** 2026-07-14 → 2026-07-20");
    const changed = result.markdown.split("## What Changed")[1]?.split("## Inferences")[0] ?? "";
    expect(changed).toContain("Spend: 500 USD vs 400 USD (+25%)");
    expect(changed).toContain("Conversions: 50 vs 40 (+25%)");

    const noPrior = await registry.execute("weekly-report", context, {
      metrics: healthyMetrics, periodStart: "2026-07-14", periodEnd: "2026-07-20",
      timezone: "UTC", currency: "USD", objective: "CPA"
    }, tools) as { markdown: string };
    expect(noPrior.markdown).toContain("week-over-week comparison is unavailable");
  });

  it("weekly-report surfaces blocked measurement instead of drawing conclusions", async () => {
    const { tools, context } = await fixture();
    const result = await new SkillRegistry().execute("weekly-report", context, {
      metrics: { spend: 500, days: 3, conversions: 1, dailyConversions: [1, 0, 0], currencyConsistency: 0.9 },
      periodStart: "2026-07-14", periodEnd: "2026-07-20", timezone: "UTC", currency: "USD", objective: "CPA", target: 10
    }, tools) as { markdown: string; reliability: string; mature: boolean };
    expect(result.reliability).toBe("blocked");
    expect(result.mature).toBe(false);
    expect(result.markdown).toContain("Measurement is blocked");
    expect(result.markdown).toContain("Fix conversion tracking before any optimization change.");
  });

  it("account-audit grades deterministic health checks through calculateHealthScore", async () => {
    const { tools, context } = await fixture();
    const registry = new SkillRegistry();
    const healthy = await registry.execute("account-audit", context, {
      metrics: healthyMetrics, objective: "CPA", currency: "USD", target: 10
    }, tools) as { markdown: string; score: number; grade: string; checks: Array<{ category: string; severity: string; result: string }> };
    expect(healthy.grade).toBe("A");
    expect(healthy.score).toBe(100);
    expect(healthy.checks).toContainEqual({ category: "measurement", severity: "critical", result: "pass" });
    expect(healthy.markdown).toContain("| measurement_reliability | measurement | critical | pass |");
    expect(healthy.markdown).toContain("**A — 100 / 100**");

    const broken = await registry.execute("account-audit", context, {
      metrics: { spend: 500, days: 3, conversions: 1, dailyConversions: [1, 0, 0], currencyConsistency: 0.9 },
      objective: "CPA", currency: "USD", target: 10
    }, tools) as { markdown: string; score: number; grade: string; checks: Array<{ category: string; severity: string; result: string }> };
    expect(broken.checks[0]).toEqual({ category: "measurement", severity: "critical", result: "fail" });
    expect(broken.checks).toContainEqual({ category: "efficiency", severity: "medium", result: "fail" });
    expect(broken.grade).toBe("D");
    expect(broken.score).toBe(23.86);
    expect(broken.score).toBeLessThan(healthy.score);
  });
});
