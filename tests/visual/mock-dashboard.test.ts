import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import {
  ImageChangeVerifier,
  VisualComputerRuntime,
  type GroundingModel,
  type NativeOperator,
  type Screenshot,
  type VisualAction,
  type VisualMicroTask
} from "@adpilot/computer-use";
import { ExperimentStore } from "@adpilot/experiments";
import { AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";

type DashboardState = {
  dateMenu: boolean;
  dateRange: "Last 30 days" | "Last 7 days";
  dialog: boolean;
  draftBudget: string;
  savedBudget: number;
  toast: boolean;
};

const surface = { app: "Local Ad Console", domain: "127.0.0.1", browserProfile: "local-test-profile", allowedApps: ["Local Ad Console"], allowedDomains: ["127.0.0.1"], surfaceFingerprint: "f".repeat(64) };

function screenshot(state: DashboardState): Screenshot {
  const content = JSON.stringify(state);
  return {
    base64: Buffer.from(content).toString("base64"), width: 1280, height: 800, scaleFactor: 1,
    capturedAt: new Date().toISOString(), sha256: createHash("sha256").update(content).digest("hex"),
    surfaceFingerprint: surface.surfaceFingerprint
  };
}

class MockDashboardOperator implements NativeOperator {
  state: DashboardState = { dateMenu: false, dateRange: "Last 30 days", dialog: false, draftBudget: "100", savedBudget: 100, toast: false };

  async capture(): Promise<Screenshot> { return screenshot(this.state); }

  async execute(action: VisualAction): Promise<void> {
    if (action.action === "click" && action.target === "date selector") this.state.dateMenu = true;
    else if (action.action === "click" && action.target === "Last 7 days") { this.state.dateRange = "Last 7 days"; this.state.dateMenu = false; }
    else if (action.action === "click" && action.target === "Edit daily budget") this.state.dialog = true;
    else if (action.action === "type" && this.state.dialog) this.state.draftBudget = action.text;
    else if (action.action === "click" && action.target === "Save budget" && this.state.dialog) {
      this.state.savedBudget = Number(this.state.draftBudget); this.state.dialog = false; this.state.toast = true;
    }
  }
}

const grounding: GroundingModel = {
  async ground(task): Promise<VisualAction> {
    const base = { target: task.target, reason: "target is visible in the local console", confidence: 0.99, expected_result: task.expectedResult, risk_level: task.riskLevel };
    if (task.target === "Read campaign table") return { action: "done", ...base, risk_level: "observe" };
    if (task.target === "Budget input") return { action: "type", text: "120", ...base };
    const coordinates: Record<string, [number, number]> = {
      "date selector": [1120, 28], "Last 7 days": [1110, 82], "Edit daily budget": [1160, 210], "Save budget": [1000, 610]
    };
    const [x, y] = coordinates[task.target] ?? [0, 0];
    return { action: "click", x, y, ...base };
  }
};

function task(target: string, expectedResult: string, riskLevel: VisualMicroTask["riskLevel"], permission: VisualMicroTask["permission"]): VisualMicroTask {
  return { instruction: `Operate ${target}`, target, expectedResult, riskLevel, permission, surface };
}

describe("local mock advertising console", () => {
  it("covers inspect, draft, stop-before-submit, and approved commit", async () => {
    const html = await readFile(fileURLToPath(new URL("../../apps/mock-ad-dashboard/index.html", import.meta.url)), "utf8");
    expect(html).toContain('id="date-selector"');
    expect(html).toContain('aria-label="Campaign performance"');
    expect(html).toContain('id="save-budget"');

    const operator = new MockDashboardOperator();
    const runtime = new VisualComputerRuntime(operator, grounding, new ImageChangeVerifier());

    await expect(runtime.runMicroTask(task("date selector", "date menu is open", "interact", "INTERACT"))).resolves.toMatchObject({ status: "done" });
    await expect(runtime.runMicroTask(task("Last 7 days", "date range is Last 7 days", "interact", "INTERACT"))).resolves.toMatchObject({ status: "done" });
    await expect(runtime.runMicroTask(task("Read campaign table", "campaign metrics are available", "observe", "OBSERVE"))).resolves.toMatchObject({ status: "done" });
    await expect(runtime.runMicroTask(task("Edit daily budget", "budget dialog is open", "interact", "INTERACT"))).resolves.toMatchObject({ status: "done" });
    await expect(runtime.runMicroTask(task("Budget input", "draft budget is 120", "mutate", "MUTATE"))).resolves.toMatchObject({ status: "done" });

    expect(operator.state).toMatchObject({ dateRange: "Last 7 days", draftBudget: "120", savedBudget: 100, dialog: true });

    await expect(runtime.runMicroTask(task("Save budget", "budget is saved as 120", "mutate", "OBSERVE"))).resolves.toMatchObject({ status: "failed" });
    expect(operator.state.savedBudget).toBe(100);

    const workspace = new WorkspaceStore(await mkdtemp(join(tmpdir(), "adpilot-visual-")));
    await workspace.initializeClient({
      profile: { id: "visual-client", name: "Visual test" }, kpi: { primary: "CPA", target: 18 },
      accounts: { accounts: [{ platform: "local", accountRef: "mock-account", browserProfile: "local-test-profile", allowedDomains: ["127.0.0.1"] }] }
    });
    const approvals = new ApprovalService(workspace, "0123456789abcdef0123456789abcdef");
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), approvals, new ExperimentStore(workspace), runtime);
    const taskId = crypto.randomUUID();
    const operation = {
      platform: "google_ads" as const, account: "local-account", campaign: "Android Growth", operation: "set_daily_budget",
      currentValue: 100, proposedValue: 120, changePercentage: 20,
      reason: "Mature campaign within the staged budget cap", evidence: ["local-console:before"],
      expectedImpact: "Increase conversion volume", observationWindow: "7 days",
      rollbackCondition: "CPA rises more than 20%", riskLevel: "mutate" as const
    };
    const approval = await approvals.create("visual-client", taskId, operation, {
      instruction: "Save the drafted daily budget", target: "Save budget", expectedResult: "budget is saved as 120", surface,
      experiment: {
        hypothesis: "A 20% budget increase adds volume without breaking CPA", variable: "daily_budget",
        baseline: { dailyBudget: 100, cpa: 15.24 }, expected: "More conversions at stable CPA",
        successCriteria: "CPA stays below 18", failureCriteria: "CPA exceeds 18",
        maturityWindowDays: 7, rollbackCondition: "CPA rises more than 20%", reviewAt: "2026-08-01T00:00:00.000Z"
      }
    });
    await approvals.recordRiskReview("visual-client", approval.id, true, "Within policy and single-variable guardrail");
    const { token } = await approvals.approveByUser("visual-client", approval.id, "test-owner");
    await expect(tools.commitApprovedVisualAction(
      { clientId: "visual-client", taskId, actor: "account_operator", permission: "MUTATE" },
      approval.id, token, operation, task("Save budget", "budget is saved as 120", "mutate", "MUTATE")
    )).resolves.toMatchObject({ status: "done" });
    expect(operator.state).toMatchObject({ savedBudget: 120, dialog: false, toast: true });
    await expect(approvals.get("visual-client", approval.id)).resolves.toMatchObject({ status: "executed" });
    await expect(new ExperimentStore(workspace).list("visual-client")).resolves.toMatchObject([{ status: "active", variable: "daily_budget" }]);
  });

  it("fails closed for invalid grounding and unexpected popups", async () => {
    const operator = new MockDashboardOperator();
    let attempts = 0;
    const runtime = new VisualComputerRuntime(operator, {
      ground: async () => {
        attempts += 1;
        if (attempts === 1) return { action: "click", x: 5000, y: 2, target: "popup", reason: "bad coordinate", confidence: 0.1, expected_result: "popup closed", risk_level: "interact" };
        return { action: "fail", target: "popup", reason: "unexpected popup requires user takeover", confidence: 1, expected_result: "popup closed", risk_level: "observe" };
      }
    }, new ImageChangeVerifier());
    await expect(runtime.runMicroTask(task("popup", "popup closed", "interact", "INTERACT"))).resolves.toMatchObject({ status: "failed", blocker: "unexpected popup requires user takeover" });
    expect(attempts).toBe(2);
  });
});
