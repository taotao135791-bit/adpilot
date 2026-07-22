import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import {
  fingerprintSurface,
  ImageChangeVerifier,
  VisualComputerRuntime,
  type DualVisualIdentityVerifier,
  type BrowserSessionManager,
  type GroundingModel,
  type NativeOperator,
  type Screenshot,
  type VisualAction,
  type VisualMicroTask
} from "@adpilot/computer-use";
import { ExperimentStore } from "@adpilot/experiments";
import { SharedFactLedger } from "@adpilot/shared";
import { AdPilotTools, visualTaskFromExecutionPlan } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";

type DashboardState = {
  dateMenu: boolean;
  dateRange: "Last 30 days" | "Last 7 days";
  dialog: boolean;
  draftBudget: string;
  savedBudget: number;
  toast: boolean;
};

const nativeSurface = {
  platform: "darwin" as const,
  app: "Local Ad Console",
  bundleId: "dev.adpilot.mock-console",
  browserProfile: "local-test-profile",
  pid: 42,
  title: "Android Growth — Visual test",
  windowId: "mock-window-1",
  bounds: { x: 0, y: 0, width: 1280, height: 800 },
  screenId: "screen-1",
  screenBounds: { x: 0, y: 0, width: 1280, height: 800 },
  scaleFactor: 1
};
const surface = {
  app: nativeSurface.app,
  applicationId: nativeSurface.bundleId,
  processId: nativeSurface.pid,
  windowId: nativeSurface.windowId,
  domain: "127.0.0.1",
  browserProfile: "local-test-profile",
  allowedApps: [nativeSurface.bundleId, nativeSurface.app],
  allowedDomains: ["127.0.0.1"]
};

function screenshot(state: DashboardState): Screenshot {
  const content = JSON.stringify(state);
  return {
    base64: Buffer.from(content).toString("base64"), width: 1280, height: 800, scaleFactor: 1,
    capturedAt: new Date().toISOString(), sha256: createHash("sha256").update(content).digest("hex"),
    surface: nativeSurface,
    surfaceFingerprint: fingerprintSurface(nativeSurface)
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
    const runtime = new VisualComputerRuntime(operator, grounding, { verify: async () => ({ matched: true, confidence: 1, reason: "visible in local fixture" }) });

    await expect(runtime.runMicroTask(task("date selector", "date menu is open", "interact", "INTERACT"))).resolves.toMatchObject({ status: "done" });
    await expect(runtime.runMicroTask(task("Last 7 days", "date range is Last 7 days", "interact", "INTERACT"))).resolves.toMatchObject({ status: "done" });
    await expect(runtime.runMicroTask(task("Read campaign table", "campaign metrics are available", "observe", "OBSERVE"))).resolves.toMatchObject({ status: "done" });
    await expect(runtime.runMicroTask(task("Edit daily budget", "budget dialog is open", "interact", "INTERACT"))).resolves.toMatchObject({ status: "done" });
    await expect(runtime.runMicroTask(task("Budget input", "draft budget is 120", "mutate", "MUTATE"))).resolves.toMatchObject({ status: "failed", blockerCode: "POLICY_BLOCKED" });

    expect(operator.state).toMatchObject({ dateRange: "Last 7 days", draftBudget: "100", savedBudget: 100, dialog: true });

    await expect(runtime.runMicroTask(task("Save budget", "budget is saved as 120", "mutate", "OBSERVE"))).resolves.toMatchObject({ status: "failed" });
    expect(operator.state.savedBudget).toBe(100);

    const workspace = new WorkspaceStore(await mkdtemp(join(tmpdir(), "adpilot-visual-")));
    await workspace.initializeClient({
      profile: { id: "visual-client", name: "Visual test" }, kpi: { primary: "CPA", target: 18 },
      accounts: { accounts: [{ platform: "other", accountRef: "local-account", browserProfile: "local-test-profile", allowedDomains: ["127.0.0.1"] }] }
    });
    const approvals = new ApprovalService(workspace, "0123456789abcdef0123456789abcdef");
    const visualIdentity = {
      confirm: async () => ({
        fingerprintHash: "d".repeat(64),
        fingerprint: { confidence: 0.99, screenshotHash: screenshot(operator.state).sha256, criticalRegionHashes: {} },
        targetRegion: { x: 900, y: 560, width: 220, height: 120 },
        reviewers: [{ id: "mock-gui", confidence: 0.99, reason: "fixture" }, { id: "mock-deep", confidence: 0.99, reason: "fixture" }]
      })
    } as unknown as DualVisualIdentityVerifier;
    const browserSessions = {
      get: async () => ({
        browserProfile: "local-test-profile",
        nativeProfileFingerprint: "local-test-profile",
        platform: "other",
        processId: nativeSurface.pid,
        windowId: nativeSurface.windowId,
        browserApplicationId: nativeSurface.bundleId,
        browserApp: nativeSurface.app
      }),
      assertActive: async () => ({
        browserProfile: "local-test-profile",
        nativeProfileFingerprint: "local-test-profile",
        platform: "other",
        processId: nativeSurface.pid,
        windowId: nativeSurface.windowId,
        browserApplicationId: nativeSurface.bundleId,
        browserApp: nativeSurface.app
      })
    } as unknown as BrowserSessionManager;
    const taskId = crypto.randomUUID();
    const operation = {
      platform: "other" as const, account: "local-account", campaign: "Android Growth", operation: "set_daily_budget",
      currentValue: 100, proposedValue: 120, changePercentage: 20,
      reason: "Mature campaign within the staged budget cap", evidence: ["local-console:before"],
      expectedImpact: "Increase conversion volume", observationWindow: "7 days",
      rollbackCondition: "CPA rises more than 20%", riskLevel: "mutate" as const
    };
    operator.state.draftBudget = "120"; // Simulates a draft entered manually by the user, outside AdPilot.
    const createdAt = new Date().toISOString();
    const executionPlan = {
      schemaVersion: 1 as const,
      planId: crypto.randomUUID(),
      taskId,
      clientId: "visual-client",
      platform: "other" as const,
      browserProfile: "local-test-profile",
      applicationId: nativeSurface.bundleId,
      applicationName: nativeSurface.app,
      windowId: nativeSurface.windowId,
      domain: "127.0.0.1",
      allowedApplications: [nativeSurface.bundleId, nativeSurface.app],
      allowedDomains: ["127.0.0.1"],
      accountName: "Visual test",
      accountId: "local-account",
      campaignName: "Android Growth",
      campaignId: "Android Growth",
      pageType: "campaign_budget_editor",
      operation: "set_daily_budget",
      currentValue: 100,
      proposedValue: 120,
      instruction: "Save the drafted daily budget",
      target: "Save budget",
      expectedResult: "budget is saved as 120",
      allowedRegion: { x: 900, y: 560, width: 220, height: 120, coordinateSpace: "screenshot_pixels" as const },
      riskLevel: "mutate" as const,
      surfaceFingerprint: fingerprintSurface(nativeSurface),
      accountFingerprint: "d".repeat(64),
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString(),
      experiment: {
        hypothesis: "A 20% budget increase adds volume without breaking CPA", variable: "daily_budget",
        baseline: { dailyBudget: 100, cpa: 15.24 }, expected: "More conversions at stable CPA",
        successCriteria: "CPA stays below 18", failureCriteria: "CPA exceeds 18",
        maturityWindowDays: 7, rollbackCondition: "CPA rises more than 20%", reviewAt: "2026-08-01T00:00:00.000Z"
      }
    };
    const sharedFacts = new SharedFactLedger();
    const evidenceExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const sourceScreenshotId = screenshot(operator.state).sha256;
    const addGuardrailFact = async (predicate: string, value: string | boolean) => {
      const observed = await sharedFacts.observe({
        clientId: "visual-client",
        taskId,
        subject: operation.campaign,
        predicate,
        value,
        unit: typeof value === "boolean" ? "boolean" : "status",
        sourceType: "visual_table",
        sourceScreenshotId,
        sourceBoundingBox: [900, 560, 220, 40],
        evidenceIds: [`screenshot:${sourceScreenshotId}`],
        confidence: 0.98,
        createdBy: "mock_visual_table_reader",
        expiresAt: evidenceExpiresAt
      });
      return sharedFacts.verify("visual-client", observed.factId, {
        verifier: "mock_independent_visual_verifier",
        confidence: 0.97
      });
    };
    const measurementFact = await addGuardrailFact("measurement_status", "reliable");
    const maturityFact = await addGuardrailFact("campaign_mature", true);
    const learningFact = await addGuardrailFact("learning_phase", false);
    const tools = new AdPilotTools(
      workspace,
      new AuditLog(workspace),
      approvals,
      new ExperimentStore(workspace),
      runtime,
      visualIdentity,
      browserSessions,
      undefined,
      sharedFacts
    );
    const approval = await approvals.create("visual-client", taskId, operation, executionPlan, {
      input: {
        kind: "budget",
        currentValue: 100,
        proposedValue: 120,
        maxChangePercent: 20,
        activeExperimentVariables: [],
        measurementStatus: "reliable",
        mature: true,
        learning: false
      },
      evidenceFactIds: [measurementFact.factId, maturityFact.factId, learningFact.factId],
      singleVariable: true
    });
    await approvals.recordRiskReview("visual-client", approval.id, true, "Within policy and single-variable guardrail");
    const { token } = await approvals.approveByUser("visual-client", approval.id, "test-owner");
    await expect(tools.commitApprovedVisualAction(
      { clientId: "visual-client", taskId, actor: "account_operator", permission: "MUTATE" },
      approval.id, token, operation, visualTaskFromExecutionPlan(executionPlan, "USD")
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
    await expect(runtime.runMicroTask(task("popup", "popup closed", "interact", "INTERACT"))).resolves.toMatchObject({
      status: "failed",
      blocker: "action coordinates are outside the screenshot",
      blockerCode: "POLICY_BLOCKED"
    });
    expect(attempts).toBe(1);
  });
});
