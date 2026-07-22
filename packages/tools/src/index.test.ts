import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp } from "jimp";
import { describe, expect, it, vi } from "vitest";
import { ApprovalService } from "@adpilot/approvals";
import { AuditLog } from "@adpilot/audit";
import {
  DualVisualIdentityVerifier,
  type BrowserSession,
  type BrowserSessionManager,
  type Screenshot,
  type VisualComputerRuntime,
  type VisualIdentityObservation
} from "@adpilot/computer-use";
import { ExperimentStore } from "@adpilot/experiments";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotTools, visualTaskFromExecutionPlan, type VisualApprovalPlanDraft } from "./index.js";

const taskId = "9af9bf5e-3114-43c6-8963-748cfc63a731";
const operation = {
  platform: "google_ads" as const,
  account: "123-456-7890",
  campaign: "campaign-42",
  operation: "set_daily_budget",
  currentValue: 100,
  proposedValue: 110,
  changePercentage: 10,
  reason: "controlled increase",
  evidence: ["screenshot:before"],
  expectedImpact: "more qualified volume",
  observationWindow: "7 days",
  rollbackCondition: "CPA rises 20%",
  riskLevel: "mutate" as const
};

const draft: VisualApprovalPlanDraft = {
  platform: "google_ads",
  domain: "ads.google.com",
  accountName: "Example Ads",
  accountId: "123-456-7890",
  campaignName: "Brand Search",
  campaignId: "campaign-42",
  pageType: "campaign_budget_editor",
  operation: "set_daily_budget",
  currentValue: 100,
  proposedValue: 110,
  instruction: "Click the visible Save budget button",
  target: "Save budget button",
  expectedResult: "Daily budget visibly reads 110 USD",
  allowedRegion: { x: 70, y: 50, width: 40, height: 30, coordinateSpace: "screenshot_pixels" },
  riskLevel: "mutate",
  experiment: {
    hypothesis: "budget adds volume",
    variable: "daily_budget",
    baseline: { budget: 100 },
    expected: "more conversions",
    successCriteria: "CPA remains below target",
    failureCriteria: "CPA rises 20%",
    maturityWindowDays: 7,
    rollbackCondition: "CPA rises 20%",
    reviewAt: new Date(Date.now() + 7 * 86_400_000).toISOString()
  }
};

const session: BrowserSession = {
  sessionId: "a".repeat(32),
  clientId: "client-a",
  browserProfile: "Default@managed-profile",
  profileDirectory: "/tmp/adpilot-profile",
  nativeProfileFingerprint: "Default@managed-profile",
  processId: 42,
  windowId: "window-7",
  windowBounds: { x: 0, y: 0, width: 120, height: 100 },
  platform: "google_ads",
  runtimePlatform: "darwin",
  browserApplicationId: "com.google.Chrome",
  browserApp: "Google Chrome",
  sessionStatus: "connected",
  startedAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  lastValidatedAt: "2026-07-22T00:00:00.000Z"
};

const observed: VisualIdentityObservation = {
  platform: "google_ads",
  pageType: "campaign_budget_editor",
  accountName: "Example Ads",
  accountId: "123-456-7890",
  campaignName: "Brand Search",
  campaignId: "campaign-42",
  currency: "USD",
  currentValue: 100,
  operation: "set_daily_budget",
  proposedValue: 110,
  target: "Save budget button",
  accountNameComplete: true,
  accountIdVisible: true,
  campaignNameComplete: true,
  campaignIdVisible: true,
  currentValueVisible: true,
  proposedValueVisible: true,
  targetVisible: true,
  unobscured: true,
  confidence: 0.96,
  regions: {
    account: { x: 2, y: 2, width: 35, height: 12 },
    campaign: { x: 2, y: 20, width: 40, height: 12 },
    currentValue: { x: 46, y: 20, width: 22, height: 12 },
    target: { x: 72, y: 54, width: 34, height: 22 }
  },
  reason: "all execution facts are fully visible"
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-tools-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10, currency: "USD" } });
  const png = await new Jimp({ width: 120, height: 100, color: 0xf4f3efff }).getBuffer("image/png");
  const screenshot: Screenshot = {
    base64: png.toString("base64"),
    width: 120,
    height: 100,
    scaleFactor: 1,
    capturedAt: new Date().toISOString(),
    sha256: createHash("sha256").update(png).digest("hex"),
    surface: {
      platform: "darwin",
      app: "Google Chrome",
      bundleId: "com.google.Chrome",
      browserProfile: "Default@managed-profile",
      pid: 42,
      title: "Campaign budget - Google Ads",
      windowId: "window-7",
      bounds: { x: 0, y: 0, width: 120, height: 100 },
      screenId: "screen-1",
      screenBounds: { x: 0, y: 0, width: 120, height: 100 },
      scaleFactor: 1
    },
    surfaceFingerprint: "f".repeat(64)
  };
  let currentObservation = observed;
  const identity = new DualVisualIdentityVerifier(
    { id: "gui-verification", review: async () => structuredClone(currentObservation) },
    { id: "deep-vision-reviewer", review: async () => structuredClone(currentObservation) }
  );
  const runMicroTask = vi.fn(async (task, initial: Screenshot | undefined) => ({
    status: "done" as const,
    attempts: 1,
    action: {
      action: "click" as const,
      x: 90,
      y: 65,
      target: task.target,
      reason: "visible",
      confidence: 0.98,
      expected_result: task.expectedResult,
      risk_level: "mutate" as const
    },
    before: initial ?? screenshot,
    after: { ...(initial ?? screenshot), capturedAt: new Date().toISOString() }
  }));
  const computer = {
    captureForTask: vi.fn(async () => screenshot),
    runMicroTask
  } as unknown as VisualComputerRuntime;
  const browserSessions = {
    get: vi.fn(async () => session),
    assertActive: vi.fn(async () => session)
  } as unknown as BrowserSessionManager;
  const approvals = new ApprovalService(workspace, "0123456789abcdef0123456789abcdef");
  const tools = new AdPilotTools(workspace, new AuditLog(workspace), approvals, new ExperimentStore(workspace), computer, identity, browserSessions);
  return { tools, approvals, runMicroTask, setObservation: (value: VisualIdentityObservation) => { currentObservation = value; } };
}

async function approved() {
  const fixture = await setup();
  const context = { clientId: "client-a", taskId, actor: "account_operator", permission: "MUTATE" as const };
  const created = await fixture.tools.createApproval({ ...context, permission: "OBSERVE" }, operation, draft);
  await fixture.approvals.recordRiskReview("client-a", created.id, true, "within policy");
  const { approval, token } = await fixture.approvals.approveByUser("client-a", created.id, "owner");
  return { ...fixture, context, approval, token, task: visualTaskFromExecutionPlan(approval.executionPlan!, "USD") };
}

describe("production visual approval tools", () => {
  it("binds a draft to native and dual-visual evidence, then executes the exact plan once", async () => {
    const fixture = await approved();
    expect(fixture.approval.executionPlan).toMatchObject({
      applicationId: "com.google.Chrome",
      windowId: "window-7",
      browserProfile: "Default@managed-profile",
      accountFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      surfaceFingerprint: "f".repeat(64)
    });
    await expect(fixture.tools.commitApprovedVisualAction(fixture.context, fixture.approval.id, fixture.token, operation, fixture.task))
      .resolves.toMatchObject({ status: "done" });
    expect(fixture.runMicroTask).toHaveBeenCalledTimes(1);
    await expect(fixture.approvals.get("client-a", fixture.approval.id)).resolves.toMatchObject({ status: "executed" });
  });

  it("burns the token before native input when the actual instruction changes", async () => {
    const fixture = await approved();
    await expect(fixture.tools.commitApprovedVisualAction(
      fixture.context,
      fixture.approval.id,
      fixture.token,
      operation,
      { ...fixture.task, instruction: "Click a different control" }
    )).rejects.toThrow("no longer matches approval");
    expect(fixture.runMicroTask).not.toHaveBeenCalled();
    await expect(fixture.approvals.get("client-a", fixture.approval.id)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("cancels before token consumption or input when the visible current value changes", async () => {
    const fixture = await approved();
    fixture.setObservation({ ...observed, currentValue: 120 });
    await expect(fixture.tools.commitApprovedVisualAction(fixture.context, fixture.approval.id, fixture.token, operation, fixture.task))
      .rejects.toMatchObject({ code: "CURRENT_VALUE_CHANGED" });
    expect(fixture.runMicroTask).not.toHaveBeenCalled();
    await expect(fixture.approvals.get("client-a", fixture.approval.id)).resolves.toMatchObject({ status: "cancelled" });
  });
});
