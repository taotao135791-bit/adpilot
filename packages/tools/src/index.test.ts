import { createHash } from "node:crypto";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp } from "jimp";
import { describe, expect, it, vi } from "vitest";
import { ApprovalExecutionPlan, ApprovalService, extractVisualExecutionPlan, type ApprovalGuardrailRequest } from "@adpilot/approvals";
import { AuditLog } from "@adpilot/audit";
import {
  DualVisualIdentityVerifier,
  FileScreenshotArtifactStore,
  FileScreenshotModelCallAuditStore,
  ScreenshotPrivacyPipeline,
  type BrowserSession,
  type BrowserSessionManager,
  type Screenshot,
  type VisualComputerRuntime,
  type VisualIdentityObservation,
  type VisualStepResult
} from "@adpilot/computer-use";
import { ExperimentStore } from "@adpilot/experiments";
import { SharedFactLedger } from "@adpilot/shared";
import {
  VisualTableReader,
  type VisualTableModelRequest,
  type VisualTableVerifierRequest
} from "@adpilot/visual-table-reader";
import { WorkspaceStore } from "@adpilot/workspace";
import {
  AdPilotTools,
  visualTaskFromExecutionPlan,
  type ApprovalGuardrailEvidence,
  type VisualApprovalPlanDraft
} from "./index.js";

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
  browserProfile: "google-primary",
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
  const runMicroTask = vi.fn(async (task, initial: Screenshot | undefined): Promise<VisualStepResult> => ({
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
    after: { ...(initial ?? screenshot), capturedAt: new Date().toISOString() },
    executed: true,
    verified: true
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
  const sharedFacts = new SharedFactLedger();
  const guardrailEvidence = await createGuardrailEvidence(sharedFacts);
  const tools = new AdPilotTools(
    workspace,
    new AuditLog(workspace),
    approvals,
    new ExperimentStore(workspace),
    computer,
    identity,
    browserSessions,
    undefined,
    sharedFacts
  );
  return {
    tools,
    approvals,
    sharedFacts,
    guardrailEvidence,
    runMicroTask,
    screenshot,
    workspace,
    setObservation: (value: VisualIdentityObservation) => { currentObservation = value; }
  };
}

async function approved() {
  const fixture = await setup();
  const context = { clientId: "client-a", taskId, actor: "account_operator", permission: "MUTATE" as const };
  const created = await fixture.tools.createApproval(
    { ...context, permission: "OBSERVE" },
    operation,
    draft,
    fixture.guardrailEvidence
  );
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
      browserProfile: "google-primary",
      accountFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      surfaceFingerprint: "f".repeat(64)
    });
    expect(fixture.approval.executionPlan?.allowedRegion).toEqual({ x: 72, y: 54, width: 34, height: 22, coordinateSpace: "screenshot_pixels" });
    await expect(fixture.tools.commitApprovedVisualAction(fixture.context, fixture.approval.id, fixture.token, operation, fixture.task))
      .resolves.toMatchObject({ status: "done" });
    expect(fixture.runMicroTask).toHaveBeenCalledTimes(1);
    await expect(fixture.approvals.get("client-a", fixture.approval.id)).resolves.toMatchObject({ status: "executed" });
  });

  it("fails the approval when a runtime reports done without native execution provenance", async () => {
    const fixture = await approved();
    fixture.runMicroTask.mockResolvedValueOnce({
      status: "done",
      attempts: 1,
      action: {
        action: "done",
        target: fixture.task.target,
        reason: "model-only completion claim",
        confidence: 1,
        expected_result: fixture.task.expectedResult,
        risk_level: "observe"
      },
      before: fixture.screenshot,
      after: fixture.screenshot,
      executed: false,
      verified: false
    });
    await expect(fixture.tools.commitApprovedVisualAction(
      fixture.context,
      fixture.approval.id,
      fixture.token,
      operation,
      fixture.task
    )).resolves.toMatchObject({
      status: "failed",
      blockerCode: "VERIFICATION_FAILED"
    });
    await expect(fixture.approvals.get("client-a", fixture.approval.id)).resolves.toMatchObject({ status: "failed" });
    await expect(new ExperimentStore(fixture.workspace).list("client-a")).resolves.toEqual([]);
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

  it("rejects a caller-supplied region that is broader than the dual-reviewed target", async () => {
    const fixture = await setup();
    await expect(fixture.tools.createApproval(
      { clientId: "client-a", taskId, actor: "adpilot_agent", permission: "OBSERVE" },
      operation,
      { ...draft, allowedRegion: { x: 0, y: 0, width: 120, height: 100, coordinateSpace: "screenshot_pixels" } },
      fixture.guardrailEvidence
    )).rejects.toThrow("not tightly bound");
  });

  it("requires exact, verified visual facts for deterministic mutation guardrails", async () => {
    const fixture = await setup();
    await expect(fixture.tools.createApproval(
      { clientId: "client-a", taskId, actor: "adpilot_agent", permission: "OBSERVE" },
      operation,
      draft
    )).rejects.toThrow();
    await expect(fixture.tools.createApproval(
      { clientId: "client-a", taskId, actor: "adpilot_agent", permission: "OBSERVE" },
      operation,
      draft,
      { ...fixture.guardrailEvidence, learningFactId: fixture.guardrailEvidence.maturityFactId }
    )).rejects.toThrow("learning_phase");
    const otherCampaign = await createGuardrailEvidence(fixture.sharedFacts, "campaign-other");
    await expect(fixture.tools.createApproval(
      { clientId: "client-a", taskId, actor: "adpilot_agent", permission: "OBSERVE" },
      operation,
      draft,
      otherCampaign
    )).rejects.toThrow("different campaign");
  });

  it("cancels before consuming the token when the dual-reviewed target control moves", async () => {
    const fixture = await approved();
    fixture.setObservation({ ...observed, regions: { ...observed.regions, target: { x: 8, y: 62, width: 34, height: 22 } } });
    await expect(fixture.tools.commitApprovedVisualAction(fixture.context, fixture.approval.id, fixture.token, operation, fixture.task))
      .rejects.toThrow("target moved outside");
    expect(fixture.runMicroTask).not.toHaveBeenCalled();
    await expect(fixture.approvals.get("client-a", fixture.approval.id)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("cancels the approval before input when a bound guardrail fact becomes stale", async () => {
    const fixture = await approved();
    await fixture.sharedFacts.markStale(
      "client-a",
      fixture.guardrailEvidence.measurementStatusFactId,
      "source page changed"
    );
    await expect(fixture.tools.commitApprovedVisualAction(
      fixture.context,
      fixture.approval.id,
      fixture.token,
      operation,
      fixture.task
    )).rejects.toThrow(/not verified|stale/);
    expect(fixture.runMicroTask).not.toHaveBeenCalled();
    await expect(fixture.approvals.get("client-a", fixture.approval.id)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("derives guardrail facts deterministically from ordinary verified campaign metrics and statuses", async () => {
    const fixture = await setup();
    const raw = await createMetricGuardrailEvidence(fixture.sharedFacts);
    const created = await fixture.tools.createApproval(
      { clientId: "client-a", taskId, actor: "adpilot_agent", permission: "OBSERVE" },
      operation,
      draft,
      raw
    );
    expect(created.guardrail).toMatchObject({
      input: { measurementStatus: "reliable", mature: true, learning: false },
      decision: { allowed: true, requiresFreshReview: false },
      singleVariable: true
    });
    const facts = await fixture.sharedFacts.list("client-a", { taskId, includeTerminal: true });
    const bound = facts.filter((fact) => created.guardrail?.evidenceFactIds.includes(fact.factId));
    expect(bound.map((fact) => fact.predicate).sort()).toEqual(["campaign_mature", "learning_phase", "measurement_status"]);
    expect(bound.every((fact) => fact.status === "verified" && fact.createdBy === "deterministic_guardrail_derivation")).toBe(true);
  });

  it("cancels a derived approval when one of its raw screenshot facts is superseded or stale", async () => {
    const fixture = await setup();
    const raw = await createMetricGuardrailEvidence(fixture.sharedFacts);
    const created = await fixture.tools.createApproval(
      { clientId: "client-a", taskId, actor: "adpilot_agent", permission: "OBSERVE" },
      operation,
      draft,
      raw
    );
    await fixture.sharedFacts.markStale("client-a", raw.conversionsFactId, "a newer Campaign view replaced the source");
    await expect(fixture.tools.validateApprovalGuardrail("client-a", created.id, true))
      .rejects.toThrow(/source fact .*not current|stale/);
    await expect(fixture.approvals.get("client-a", created.id)).resolves.toMatchObject({ status: "cancelled" });
  });
});

async function createGuardrailEvidence(ledger: SharedFactLedger, subject = "campaign-42"): Promise<ApprovalGuardrailEvidence> {
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const add = async (predicate: string, value: string | boolean) => {
    const observedFact = await ledger.observe({
      clientId: "client-a",
      taskId,
      subject,
      predicate,
      value,
      unit: "",
      sourceType: "visual_table",
      sourceScreenshotId: `screen-${predicate}`,
      sourceBoundingBox: [1, 1, 20, 10],
      evidenceIds: [`screenshot:screen-${predicate}`],
      confidence: 0.98,
      createdBy: "visual_table_reader",
      expiresAt
    });
    return ledger.verify("client-a", observedFact.factId, { verifier: "independent_visual_verifier", confidence: 0.97 });
  };
  const measurement = await add("measurement_status", "reliable");
  const maturity = await add("campaign_mature", "mature");
  const learning = await add("learning_phase", "not learning");
  return {
    measurementStatusFactId: measurement.factId,
    maturityFactId: maturity.factId,
    learningFactId: learning.factId
  };
}

async function createMetricGuardrailEvidence(ledger: SharedFactLedger) {
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const add = async (predicate: string, value: string | number) => {
    const observedFact = await ledger.observe({
      clientId: "client-a",
      taskId,
      subject: "campaign-42",
      predicate,
      value,
      unit: "",
      sourceType: "visual_table",
      sourceScreenshotId: `metric-${predicate}`,
      sourceBoundingBox: [2, 2, 22, 12],
      evidenceIds: [`screenshot:metric-${predicate}`],
      confidence: 0.97,
      createdBy: "visual_table_reader",
      expiresAt
    });
    return ledger.verify("client-a", observedFact.factId, { verifier: "independent_visual_verifier", confidence: 0.96 });
  };
  const conversions = await add("conversions", 40);
  const days = await add("observation_days", 14);
  const learning = await add("bid_strategy_status", "eligible");
  const measurement = await add("conversion_tracking_status", "recording conversions");
  return {
    conversionsFactId: conversions.factId,
    observationDaysFactId: days.factId,
    learningStatusFactId: learning.factId,
    measurementStatusFactId: measurement.factId,
    dailyConversionFactIds: []
  };
}

describe("production visual table tool", () => {
  it("captures a managed window, sends audited ROIs, scrolls once, and persists only verified facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-table-tool-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({
      profile: { id: "client-a", name: "A" },
      kpi: { primary: "CPA", target: 10, currency: "USD" },
      accounts: {
        accounts: [{
          platform: "google_ads",
          accountRef: "123-456-7890",
          browserProfile: session.browserProfile,
          allowedDomains: ["ads.google.com"]
        }]
      }
    });
    const capturedAt = Date.now();
    const first = await tableScreenshot(0xf4f3efff, new Date(capturedAt).toISOString());
    const second = await tableScreenshot(0xe9e7e1ff, new Date(capturedAt + 1_000).toISOString());
    const readerRequests: VisualTableModelRequest[] = [];
    const verifierRequests: VisualTableVerifierRequest[] = [];
    const pages = [tablePage([tableRow("campaign-a", "Campaign A", "$100")], true), tablePage([
      tableRow("campaign-a", "Campaign A", "$100"),
      tableRow("campaign-b", "Campaign B", "$200", 32)
    ], false)];
    const ledger = new SharedFactLedger();
    const tableReader = new VisualTableReader({
      model: {
        identity: "remote-code/code-vision",
        readPage: async (request) => {
          readerRequests.push(request);
          return pages[Math.min(readerRequests.length - 1, pages.length - 1)]!;
        }
      },
      verifier: {
        identity: "remote-code/code-vision",
        verify: async (request) => {
          verifierRequests.push(request);
          return {
            reviews: request.cells.map((cell) => ({
              rowKey: cell.rowKey,
              columnKey: cell.columnKey,
              matched: true,
              confidence: 0.99,
              normalizedValue: cell.normalizedValue,
              reason: "matched in independent verifier call"
            })),
            confidence: 0.99,
            reason: "all visible values matched"
          };
        }
      },
      factSink: ledger
    });
    const runMicroTask = vi.fn(async (
      task: Parameters<VisualComputerRuntime["runMicroTask"]>[0],
      initial?: Screenshot,
      _constraints?: Parameters<VisualComputerRuntime["runMicroTask"]>[2]
    ) => ({
      status: "done" as const,
      attempts: 1,
      action: {
        action: "scroll" as const,
        direction: "down" as const,
        x: 50,
        y: 50,
        target: task.target,
        reason: "table has more rows",
        confidence: 0.99,
        expected_result: task.expectedResult,
        risk_level: "interact" as const
      },
      before: initial ?? first,
      after: second,
      executed: true,
      verified: true
    }));
    const computer = {
      captureForTask: vi.fn(async () => first),
      runMicroTask
    } as unknown as VisualComputerRuntime;
    const browserSessions = {
      get: vi.fn(async () => session),
      assertActive: vi.fn(async () => session)
    } as unknown as BrowserSessionManager;
    const screenshotAudits = new FileScreenshotModelCallAuditStore(root);
    const privacy = new ScreenshotPrivacyPipeline(new FileScreenshotArtifactStore(root), screenshotAudits);
    const tools = new AdPilotTools(
      workspace,
      new AuditLog(workspace),
      new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"),
      new ExperimentStore(workspace),
      computer,
      undefined,
      browserSessions,
      {
        reader: tableReader,
        screenshotPrivacy: privacy,
        readerModel: { provider: "remote-code", modelId: "code-vision", location: "remote", retentionPolicy: "provider zero retention" },
        verifierModel: { provider: "remote-code", modelId: "code-vision", location: "remote", retentionPolicy: "provider zero retention" },
        privacyMode: "minimized"
      }
    );

    await expect(tools.readVisualTable(
      { clientId: "client-a", taskId, actor: "account_operator", permission: "OBSERVE" },
      {
        platform: "google_ads",
        browserProfile: session.browserProfile,
        targetColumns: [{ key: "name", label: "Campaign", valueType: "text" }],
        scrollDirection: "down"
      }
    )).rejects.toThrow("requires explicit INTERACT permission");
    expect(runMicroTask).not.toHaveBeenCalled();

    const result = await tools.readVisualTable(
      { clientId: "client-a", taskId, actor: "account_operator", permission: "INTERACT" },
      {
        platform: "google_ads",
        browserProfile: session.browserProfile,
        tableRoi: { x: 10, y: 20, width: 80, height: 60, coordinateSpace: "screenshot_pixels" },
        targetColumns: [
          { key: "name", label: "Campaign", valueType: "text" },
          { key: "budget", label: "Budget", valueType: "currency", unit: "USD" }
        ],
        scrollDirection: "down",
        maxPages: 3
      }
    );

    expect(result).toMatchObject({ status: "done", checks: { pagesRead: 2, duplicateRowsRemoved: 2 } });
    expect(result.facts).toHaveLength(4);
    expect(result.facts.every((fact) => fact.status === "verified")).toBe(true);
    await expect(ledger.usable("client-a", { taskId })).resolves.toHaveLength(4);
    expect(runMicroTask).toHaveBeenCalledTimes(1);
    expect(runMicroTask.mock.calls[0]?.[1]).toBeUndefined();
    expect(runMicroTask.mock.calls[0]?.[2]).toEqual({ allowedActions: ["scroll", "done", "fail"] });
    expect(runMicroTask.mock.calls[0]?.[0]).toMatchObject({
      clientId: "client-a",
      taskId,
      platform: "google_ads",
      permission: "INTERACT",
      riskLevel: "interact",
      allowedActions: ["scroll", "done", "fail"],
      allowedScrollDirections: ["down"],
      retryPolicy: "none",
      surface: {
        applicationId: "com.google.Chrome",
        processId: 42,
        windowId: "window-7",
        browserProfile: session.browserProfile
      }
    });
    expect(readerRequests).toHaveLength(2);
    expect(verifierRequests).toHaveLength(1);
    expect(verifierRequests[0]?.screenshots).toHaveLength(2);
    for (const request of readerRequests) {
      expect({ width: request.roiWidth, height: request.roiHeight }).toEqual({ width: 80, height: 60 });
    }
    for (const screenshot of verifierRequests[0]!.screenshots) {
      expect({ width: screenshot.width, height: screenshot.height }).toEqual({ width: 80, height: 60 });
    }

    const audits = await screenshotAudits.list("client-a");
    expect(audits).toHaveLength(4);
    expect(audits.map((audit) => audit.callRole)).toEqual(["table_reader", "table_reader", "table_verifier", "table_verifier"]);
    for (const audit of audits) {
      expect(audit).toMatchObject({
        purpose: "table_read",
        modelProvider: "remote-code",
        modelId: "code-vision",
        sentRoi: { x: 10, y: 20, width: 80, height: 60 },
        transmittedWidth: 80,
        transmittedHeight: 60,
        leftLocal: true,
        fullScreenshotLocalOnly: true,
        outcome: "prepared"
      });
    }
    const clientKey = createHash("sha256").update("client-a").digest("hex").slice(0, 24);
    const artifactDirectory = join(root, "screenshots", clientKey);
    const pngs = (await readdir(artifactDirectory)).filter((name) => name.endsWith(".png"));
    expect(pngs).toHaveLength(4);
    for (const name of pngs) expect((await stat(join(artifactDirectory, name))).mode & 0o777).toBe(0o600);

    const defaultRoiResult = await tools.readVisualTable(
      { clientId: "client-a", taskId, actor: "account_operator", permission: "OBSERVE" },
      {
        platform: "google_ads",
        browserProfile: session.browserProfile,
        targetColumns: [
          { key: "name", label: "Campaign", valueType: "text" },
          { key: "budget", label: "Budget", valueType: "currency", unit: "USD" }
        ]
      }
    );
    expect(defaultRoiResult.status).toBe("done");
    expect(readerRequests.at(-1)).toMatchObject({ roiWidth: 120, roiHeight: 88 });
    const defaultAudits = (await screenshotAudits.list("client-a")).slice(-2);
    expect(defaultAudits.map((audit) => audit.callRole)).toEqual(["table_reader", "table_verifier"]);
    expect(defaultAudits.map((audit) => audit.sentRoi)).toEqual([
      { x: 0, y: 12, width: 120, height: 88 },
      { x: 0, y: 12, width: 120, height: 88 }
    ]);
    expect(defaultAudits.every((audit) => audit.transmittedHeight === 88 && audit.fullScreenshotLocalOnly)).toBe(true);
    await expect(tools.readVisualTable(
      { clientId: "client-a", taskId, actor: "account_operator", permission: "OBSERVE" },
      {
        platform: "google_ads",
        browserProfile: session.browserProfile,
        tableRoi: { x: 100, y: 20, width: 40, height: 60 },
        targetColumns: [{ key: "name", label: "Campaign", valueType: "text" }]
      }
    )).rejects.toThrow("exceeds the managed screenshot bounds");
  });
});

async function tableScreenshot(color: number, capturedAt: string): Promise<Screenshot> {
  const png = await new Jimp({ width: 120, height: 100, color }).getBuffer("image/png");
  return {
    base64: png.toString("base64"),
    width: 120,
    height: 100,
    scaleFactor: 2,
    capturedAt,
    sha256: createHash("sha256").update(png).digest("hex"),
    surface: {
      platform: "darwin",
      app: "Google Chrome",
      bundleId: "com.google.Chrome",
      browserProfile: session.nativeProfileFingerprint,
      pid: 42,
      title: "Campaigns - Google Ads",
      windowId: "window-7",
      bounds: { x: 0, y: 0, width: 60, height: 50 },
      screenId: "screen-1",
      screenBounds: { x: 0, y: 0, width: 1440, height: 900 },
      scaleFactor: 2
    },
    surfaceFingerprint: "f".repeat(64)
  };
}

function tablePage(rows: unknown[], hasMore: boolean) {
  return {
    state: "ready" as const,
    headers: [
      { columnKey: "name", rawText: "Campaign", boundingBox: [0, 0, 40, 10], confidence: 0.99, fixed: true },
      { columnKey: "budget", rawText: "Budget", boundingBox: [40, 0, 40, 10], confidence: 0.99, fixed: true }
    ],
    rows,
    hasMore
  };
}

function tableRow(rowKey: string, rawLabel: string, budget: string, y = 12) {
  return {
    rowKey,
    rawLabel,
    boundingBox: [0, y, 80, 16],
    truncated: false,
    kind: "data" as const,
    cells: [
      { columnKey: "name", rawText: rawLabel, boundingBox: [0, y, 40, 16], confidence: 0.99 },
      { columnKey: "budget", rawText: budget, boundingBox: [40, y, 40, 16], confidence: 0.99 }
    ]
  };
}

describe("writeExperiment approval enforcement", () => {
  const guardrail: ApprovalGuardrailRequest = {
    input: {
      kind: "budget", currentValue: 100, proposedValue: 110, maxChangePercent: 20,
      activeExperimentVariables: [], measurementStatus: "reliable", mature: true, learning: false
    },
    evidenceFactIds: ["fact-measurement", "fact-maturity", "fact-learning"],
    singleVariable: true
  };

  async function experimentFixture() {
    const root = await mkdtemp(join(tmpdir(), "adpilot-tools-experiment-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const audit = new AuditLog(workspace);
    const approvals = new ApprovalService(workspace, "0123456789abcdef0123456789abcdef");
    const tools = new AdPilotTools(workspace, audit, approvals, new ExperimentStore(workspace));
    const experimentTaskId = crypto.randomUUID();
    const context = { clientId: "client-a", taskId: experimentTaskId, actor: "media_buyer", permission: "OBSERVE" as const };
    return { audit, approvals, tools, experimentTaskId, context };
  }

  function experimentPlan(planTaskId: string): ApprovalExecutionPlan {
    const now = Date.now();
    return ApprovalExecutionPlan.parse({
      schemaVersion: 1,
      planId: crypto.randomUUID(),
      taskId: planTaskId,
      clientId: "client-a",
      platform: "google_ads",
      browserProfile: "client-a-profile",
      applicationId: "com.google.Chrome",
      applicationName: "Google Chrome",
      windowId: "window-42",
      domain: "ads.google.com",
      allowedApplications: ["com.google.Chrome", "Google Chrome"],
      allowedDomains: ["ads.google.com"],
      accountName: "Example Ads",
      accountId: operation.account,
      campaignName: "Brand Search",
      campaignId: operation.campaign,
      pageType: "campaign_budget_editor",
      operation: operation.operation,
      currentValue: 100,
      proposedValue: 110,
      instruction: "Save the daily budget",
      target: "Save",
      expectedResult: "Budget is 110",
      allowedRegion: { x: 100, y: 80, width: 900, height: 650, coordinateSpace: "screenshot_pixels" },
      riskLevel: "mutate",
      surfaceFingerprint: "f".repeat(64),
      accountFingerprint: "a".repeat(64),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      experiment: {
        hypothesis: "budget adds volume", variable: "daily_budget", baseline: { budget: 100 },
        expected: "more conversions", successCriteria: "CPA holds", failureCriteria: "CPA rises 20%",
        maturityWindowDays: 7, rollbackCondition: "CPA rises 20%", reviewAt: new Date(now + 7 * 86_400_000).toISOString()
      }
    });
  }

  async function executedApproval(approvals: ApprovalService, approvalTaskId: string): Promise<string> {
    const plan = experimentPlan(approvalTaskId);
    const created = await approvals.create("client-a", approvalTaskId, operation, plan, guardrail);
    await approvals.recordRiskReview("client-a", created.id, true, "Within policy");
    const { token } = await approvals.approveByUser("client-a", created.id, "owner");
    await approvals.consume("client-a", created.id, token, operation, extractVisualExecutionPlan(plan));
    await approvals.finish("client-a", created.id, true);
    return created.id;
  }

  function experimentInput(approvalId: string, experimentTaskId: string) {
    return {
      clientId: "client-a",
      taskId: experimentTaskId,
      approvalId,
      hypothesis: "budget adds volume",
      variable: "daily_budget",
      baseline: { budget: 100 },
      expected: "more conversions",
      successCriteria: "CPA holds",
      failureCriteria: "CPA rises 20%",
      maturityWindowDays: 7,
      rollbackCondition: "CPA rises 20%",
      reviewAt: new Date(Date.now() + 7 * 86_400_000).toISOString()
    };
  }

  it("rejects a missing or non-executed approval and audits each denial", async () => {
    const { audit, approvals, tools, experimentTaskId, context } = await experimentFixture();
    await expect(tools.writeExperiment(context, experimentInput(crypto.randomUUID(), experimentTaskId))).rejects.toThrow("approval does not exist");

    const created = await approvals.create("client-a", experimentTaskId, operation, experimentPlan(experimentTaskId), guardrail);
    await expect(tools.writeExperiment(context, experimentInput(created.id, experimentTaskId))).rejects.toThrow("not executed");

    const denials = (await audit.list("client-a")).filter((event) => event.action === "write_experiment" && event.status === "denied");
    expect(denials).toHaveLength(2);
    expect(denials[0]?.details.reason).toContain("approval does not exist");
    expect(denials[1]?.details.reason).toContain("pending_risk_review");
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("rejects an executed approval that belongs to a different task", async () => {
    const { approvals, tools, context } = await experimentFixture();
    const approvalId = await executedApproval(approvals, crypto.randomUUID());
    await expect(tools.writeExperiment(context, experimentInput(approvalId, context.taskId))).rejects.toThrow("different task");
  });

  it("creates the draft experiment when the bound approval was executed", async () => {
    const { audit, approvals, tools, experimentTaskId, context } = await experimentFixture();
    const approvalId = await executedApproval(approvals, experimentTaskId);
    const experiment = await tools.writeExperiment(context, experimentInput(approvalId, experimentTaskId));
    expect(experiment.status).toBe("draft");
    expect(experiment.approvalId).toBe(approvalId);
    const succeeded = (await audit.list("client-a")).filter((event) => event.action === "write_experiment" && event.status === "succeeded");
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]?.details).toMatchObject({ experimentId: experiment.id, variable: "daily_budget" });
  });
});

describe("generalAgentTools (main-agent write-side set)", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "adpilot-agent-tools-audit-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const audit = new AuditLog(workspace);
    const tools = new AdPilotTools(workspace, audit, new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const context = { clientId: "client-a", taskId: crypto.randomUUID(), actor: "tester", permission: "OBSERVE" as const };
    return { root, workspace, audit, tools, context };
  }

  it("exposes read/grep/find/ls/write/edit/bash only on the main-agent surface", async () => {
    const { tools, context } = await fixture();
    const agent = tools.generalAgentTools(context);
    expect(agent.map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls", "write", "edit", "bash"]);
    // Specialists keep the read-only subset.
    expect(tools.generalReadTools().map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
  });

  it("chains every bash classification (allowed and denied) into the audit log with the run context", async () => {
    const { audit, tools, context } = await fixture();
    const bash = tools.generalAgentTools(context).find((tool) => tool.name === "bash")!;
    const run = (command: string) =>
      (bash.execute as (id: string, params: unknown) => Promise<unknown>)("call-1", { command });
    // Hard-denied command: refused, audited as denied, never executed.
    await expect(run("curl https://ads.google.com")).rejects.toThrow("denied by AdPilot policy");
    // Whitelisted read command: executes (sandboxed on macOS), audited as succeeded.
    if (process.platform === "darwin") {
      const result = (await run("pwd")) as { content: Array<{ text?: string }> };
      expect(result.content.map((item) => item.text ?? "").join("\n")).toContain("adpilot-agent-tools-audit-");
    }
    const events = (await audit.list("client-a")).filter((event) => event.action === "bash_classify");
    expect(events).toHaveLength(process.platform === "darwin" ? 2 : 1);
    expect(events[0]).toMatchObject({
      clientId: "client-a",
      taskId: context.taskId,
      actor: "tester",
      status: "denied",
      details: { verdict: "deny", executed: false }
    });
    const deniedCommands = events[0]?.details.commands as Array<{ program: string; rule: string }>;
    expect(deniedCommands[0]).toMatchObject({ program: "curl", rule: "network_egress" });
    if (process.platform === "darwin") {
      expect(events[1]).toMatchObject({ status: "succeeded", details: { verdict: "read", executed: true } });
    }
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("fails closed with an explicit error when the sandbox is unavailable", async () => {
    const { tools, context } = await fixture();
    const bash = tools.generalAgentTools(context).find((tool) => tool.name === "bash")!;
    if (process.platform === "darwin") return; // sandbox-exec exists; the fail-closed unit tests cover the missing case
    await expect(
      (bash.execute as (id: string, params: unknown) => Promise<unknown>)("call-1", { command: "ls" })
    ).rejects.toThrow("fail-closed");
  });
});
