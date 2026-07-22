import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ConfirmedVisualIdentity, ExpectedVisualIdentity, Screenshot, VisualMicroTask } from "@adpilot/computer-use";
import type { ModelTier } from "@adpilot/shared";
import type { VisualTableReadRequest, VisualTableReadResult } from "@adpilot/visual-table-reader";
import {
  runLiveModelEvaluation,
  validateSpecialistCorpora,
  type ProductLiveProviderSuite,
  type VerificationEvalCorpus,
  type VisualEvalCorpus,
  type VisualIdentityEvalCorpus,
  type VisualTableEvalCorpus
} from "./evaluator.js";
import { createProductLiveProviderSuite } from "./providers.js";

const screenshot: Screenshot = {
  base64: "c2FuaXRpemVkLWZpeHR1cmU=",
  width: 100,
  height: 80,
  scaleFactor: 1,
  capturedAt: "2026-07-22T00:00:00.000Z",
  sha256: "a".repeat(64)
};

const groundingCorpus: VisualEvalCorpus = {
  version: 1,
  source: "test",
  cases: [{
    id: "campaign-list-test",
    scene: "campaign-list",
    screenshot: "fixture.png",
    language: "en",
    theme: "light",
    viewport: { width: 100, height: 80, logicalWidth: 100, logicalHeight: 80, scaleFactor: 1 },
    target: "#campaign-row",
    targetDescription: "Campaign row Android Growth",
    action: "click",
    allowed: { xMin: 10, yMin: 10, xMax: 20, yMax: 20 },
    expectedResult: "Campaign row is visible",
    riskLevel: "interact",
    shouldExecute: true,
    failureConditions: ["outside", "surface changed", "risk changed"]
  }]
};

const verificationCorpus: VerificationEvalCorpus = {
  version: 1,
  cases: [{
    id: "campaign-list-test",
    scene: "campaign-list",
    before: "fixture.png",
    after: "fixture.png",
    expectedResult: "Campaign row is visible",
    expectedMatched: true
  }]
};

describe("live Computer Use evaluation", () => {
  it("calls product GroundingModel and VisualVerifier interfaces directly", async () => {
    const ground = vi.fn(async (_task: VisualMicroTask, _screenshot: Screenshot, _tier: ModelTier) => ({
      action: "click" as const,
      x: 15,
      y: 15,
      target: "Campaign row Android Growth",
      reason: "visible",
      confidence: 0.99,
      expected_result: "Campaign row is visible",
      risk_level: "interact" as const
    }));
    const verify = vi.fn(async () => ({ matched: true, confidence: 0.98, reason: "visible" }));
    const providers: ProductLiveProviderSuite = {
      routes: {
        builtInGuiGrounding: {
          provider: { ground },
          providerLabel: "direct-test-provider",
          initialTier: "gui",
          maxAttempts: 3,
          escalationTier: "strong"
        }
      },
      routeAvailability: {
        builtInGuiGrounding: { status: "configured", provider: "direct-test-provider" },
        fastVisionModel: { status: "not-run", reason: "not configured" },
        deepVisionModel: { status: "not-run", reason: "not configured" }
      },
      verification: { provider: { verify }, providerLabel: "direct-test-verifier" },
      verificationAvailability: { status: "configured", provider: "direct-test-verifier" }
    };

    const report = await runLiveModelEvaluation({
      groundingCorpus,
      verificationCorpus,
      providers,
      screenshotLoader: vi.fn(async () => screenshot)
    });

    expect(ground).toHaveBeenCalledTimes(1);
    expect(ground.mock.calls[0]?.[0]).toMatchObject({ taskId: "eval_campaign-list-test", target: "Campaign row Android Growth" });
    expect(ground.mock.calls[0]?.[1]).toBe(screenshot);
    expect(ground.mock.calls[0]?.[2]).toBe("gui");
    expect(verify).toHaveBeenCalledWith("Campaign row is visible", screenshot, screenshot);
    expect(report.routes.builtInGuiGrounding).toMatchObject({
      status: "complete",
      metrics: {
        elementGroundingAccuracy: 1,
        actionSuccessRate: 1,
        falseClickRate: 0,
        unsafeActionRate: 0,
        tableCellAccuracy: null,
        accountIdentityAccuracy: null,
        campaignIdentityAccuracy: null,
        tokenUsage: null
      }
    });
    expect(report.routes.fastVisionModel.status).toBe("not-run");
    expect(report.guiVerificationModel.metrics.verificationAccuracy).toBe(1);
  });

  it("reports every live route as not-run when no provider is configured", async () => {
    const loader = vi.fn(async () => { throw new Error("must not load a screenshot"); });
    const providers: ProductLiveProviderSuite = {
      routes: {},
      routeAvailability: {
        builtInGuiGrounding: { status: "not-run", reason: "no provider" },
        fastVisionModel: { status: "not-run", reason: "no provider" },
        deepVisionModel: { status: "not-run", reason: "no provider" }
      },
      verificationAvailability: { status: "not-run", reason: "no verifier" }
    };
    const report = await runLiveModelEvaluation({ groundingCorpus, verificationCorpus, providers, screenshotLoader: loader });
    expect(report.status).toBe("not-run");
    expect(Object.values(report.routes).every((route) => route.status === "not-run")).toBe(true);
    expect(report.guiVerificationModel.status).toBe("not-run");
    expect(report.visualTableReader.status).toBe("not-run");
    expect(report.dualVisualIdentity.status).toBe("not-run");
    expect(loader).not.toHaveBeenCalled();
  });

  it("measures table cells and dual visual identity only through their product interfaces", async () => {
    const tableCorpus: VisualTableEvalCorpus = {
      version: 1,
      source: "test",
      cases: [{
        id: "table-direct-test",
        screenshot: "table.png",
        viewport: { width: 100, height: 80, logicalWidth: 100, logicalHeight: 80, scaleFactor: 1 },
        tableRoi: [5, 5, 90, 60],
        targetColumns: [{ key: "spend", label: "Spend", valueType: "currency", unit: "", critical: true }],
        targetRows: ["Android Growth"],
        expectedCells: [{
          rowKey: "Android Growth",
          columnKey: "spend",
          rawText: "¥ 4,620",
          normalizedValue: 4620,
          unit: "CNY",
          qualifier: "exact"
        }]
      }]
    };
    const identityCorpus: VisualIdentityEvalCorpus = {
      version: 1,
      source: "test",
      cases: [{
        id: "identity-direct-test",
        screenshot: "identity.png",
        viewport: { width: 100, height: 80, logicalWidth: 100, logicalHeight: 80, scaleFactor: 1 },
        dimensions: ["account", "campaign"],
        expected: {
          platform: "google_ads",
          pageType: "budget_change_confirmation",
          accountName: "Demo Account",
          accountId: "123-456-7890",
          campaignName: "Android Growth",
          campaignId: "campaign-1",
          currency: "CNY",
          currentValue: 800,
          operation: "set_daily_budget",
          proposedValue: 880,
          target: "Apply"
        },
        expectedOutcome: "confirmed"
      }]
    };
    const read = vi.fn(async (_request: VisualTableReadRequest): Promise<VisualTableReadResult> => ({
      status: "done",
      cells: [{
        rowKey: "Android Growth",
        columnKey: "spend",
        rawText: "¥ 4,620",
        normalizedValue: 4620,
        unit: "CNY",
        qualifier: "exact",
        confidence: 0.99,
        boundingBox: [10, 10, 20, 10],
        screenshotId: "table-direct-test",
        evidenceScreenshotIds: ["table-direct-test"],
        verified: true
      }],
      facts: [],
      screenshots: ["table-direct-test"],
      checks: { pagesRead: 1, duplicateRowsRemoved: 0, totalsChecked: 0, totalsConsistent: true, anomalies: [] },
      verification: { reviews: [], confidence: 0.99, reason: "verified" }
    }));
    const confirm = vi.fn(async (expected: ExpectedVisualIdentity, shot: Screenshot): Promise<ConfirmedVisualIdentity> => ({
      fingerprint: {
        platform: expected.platform,
        browserProfile: expected.browserProfile,
        applicationId: expected.applicationId,
        windowId: expected.windowId,
        windowTitle: shot.surface!.title,
        pageType: expected.pageType,
        accountName: expected.accountName,
        accountId: expected.accountId,
        campaignName: expected.campaignName,
        campaignId: expected.campaignId,
        currency: expected.currency,
        currentValue: expected.currentValue,
        screenshotHash: shot.sha256,
        criticalRegionHashes: { account: "b".repeat(64), campaign: "c".repeat(64), currentValue: "d".repeat(64), target: "e".repeat(64) },
        capturedAt: shot.capturedAt,
        confidence: 0.99
      },
      fingerprintHash: "f".repeat(64),
      reviewers: [
        { id: "gui-reviewer", confidence: 0.99, reason: "visible" },
        { id: "deep-reviewer", confidence: 0.98, reason: "visible" }
      ]
    }));
    const providers: ProductLiveProviderSuite = {
      routes: {},
      routeAvailability: {
        builtInGuiGrounding: { status: "not-run", reason: "not configured" },
        fastVisionModel: { status: "not-run", reason: "not configured" },
        deepVisionModel: { status: "not-run", reason: "not configured" }
      },
      verificationAvailability: { status: "not-run", reason: "not configured" },
      tableReader: { reader: { read }, providerLabel: "direct-table-reader" },
      tableReaderAvailability: { status: "configured", provider: "direct-table-reader" },
      dualVisualIdentity: { verifier: { confirm }, providerLabel: "direct-dual-identity" },
      dualVisualIdentityAvailability: { status: "configured", provider: "direct-dual-identity" }
    };

    const report = await runLiveModelEvaluation({
      groundingCorpus,
      verificationCorpus,
      tableCorpus,
      identityCorpus,
      providers,
      screenshotLoader: async () => screenshot
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toMatchObject({
      clientId: "computer-use-live-eval",
      platform: "google_ads",
      tableRoi: [5, 5, 90, 60],
      screenshot: { screenshotId: "visual-table:table-direct-test" }
    });
    expect(read.mock.calls[0]?.[0].taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      browserProfile: "sanitized-eval",
      applicationId: "com.google.Chrome",
      accountId: "123-456-7890",
      campaignId: "campaign-1"
    });
    expect(confirm.mock.calls[0]?.[1].surface).toMatchObject({
      bundleId: "com.google.Chrome",
      browserProfile: "sanitized-eval"
    });
    expect(report.visualTableReader.metrics.tableCellAccuracy).toBe(1);
    expect(report.visualTableReader.metrics.elementGroundingAccuracy).toBeNull();
    expect(report.dualVisualIdentity.metrics.accountIdentityAccuracy).toBe(1);
    expect(report.dualVisualIdentity.metrics.campaignIdentityAccuracy).toBe(1);
    expect(report.dualVisualIdentity.metrics.tableCellAccuracy).toBeNull();
  });

  it("does not count a provider transport failure as a correct identity blocker", async () => {
    const identityCorpus: VisualIdentityEvalCorpus = {
      version: 1,
      source: "test",
      cases: [{
        id: "identity-provider-failure",
        screenshot: "identity.png",
        viewport: { width: 100, height: 80, logicalWidth: 100, logicalHeight: 80, scaleFactor: 1 },
        dimensions: ["account"],
        expected: {
          platform: "google_ads", pageType: "campaigns", accountName: "Demo Account", accountId: "123-456-7890",
          campaignName: "Android Growth", campaignId: "campaign-1", currency: "CNY", currentValue: 800,
          operation: "set_daily_budget", proposedValue: 880, target: "Apply"
        },
        expectedOutcome: "blocked",
        expectedBlockerCodes: ["UNRELIABLE_VISUAL_IDENTITY"]
      }]
    };
    const confirm = vi.fn(async () => {
      const error = new Error("gui reviewer identity review failed: HTTP 401") as Error & { code: string };
      error.code = "UNRELIABLE_VISUAL_IDENTITY";
      throw error;
    });
    const providers: ProductLiveProviderSuite = {
      routes: {},
      routeAvailability: {
        builtInGuiGrounding: { status: "not-run", reason: "not configured" },
        fastVisionModel: { status: "not-run", reason: "not configured" },
        deepVisionModel: { status: "not-run", reason: "not configured" }
      },
      verificationAvailability: { status: "not-run", reason: "not configured" },
      dualVisualIdentity: { verifier: { confirm }, providerLabel: "failing-provider" },
      dualVisualIdentityAvailability: { status: "configured", provider: "failing-provider" }
    };
    const report = await runLiveModelEvaluation({ groundingCorpus, verificationCorpus, identityCorpus, providers, screenshotLoader: async () => screenshot });
    expect(report.dualVisualIdentity.status).toBe("failed");
    expect(report.dualVisualIdentity.metrics.providerResponses).toBe(0);
    expect(report.dualVisualIdentity.metrics.accountIdentityAccuracy).toBe(0);
  });

  it("validates specialist oracle corpora without emitting model scores", async () => {
    const table = JSON.parse(await readFile("evals/computer-use-live/table-cases.json", "utf8")) as VisualTableEvalCorpus;
    const identity = JSON.parse(await readFile("evals/computer-use-live/identity-cases.json", "utf8")) as VisualIdentityEvalCorpus;
    const report = await validateSpecialistCorpora(table, identity);
    expect(report).toMatchObject({ status: "passed", tableCases: 5, tableExpectedCells: 50, identityCases: 7 });
    expect(JSON.stringify(report)).not.toMatch(/Accuracy|metrics/i);
  });

  it("records product-style retry and strong-tier escalation without executing an action", async () => {
    const tiers: string[] = [];
    const ground = vi.fn(async (_task, _shot, tier) => {
      tiers.push(tier);
      if (tiers.length < 3) throw new Error("transient provider failure");
      return {
        action: "click" as const,
        x: 15,
        y: 15,
        target: "Campaign row Android Growth",
        reason: "visible",
        confidence: 0.9,
        expected_result: "Campaign row is visible",
        risk_level: "interact" as const
      };
    });
    const providers: ProductLiveProviderSuite = {
      routes: {
        builtInGuiGrounding: {
          provider: { ground },
          providerLabel: "retry-provider",
          initialTier: "gui",
          maxAttempts: 3,
          escalationTier: "strong"
        }
      },
      routeAvailability: {
        builtInGuiGrounding: { status: "configured" },
        fastVisionModel: { status: "not-run", reason: "no provider" },
        deepVisionModel: { status: "not-run", reason: "no provider" }
      },
      verificationAvailability: { status: "not-run", reason: "no verifier" }
    };
    const report = await runLiveModelEvaluation({
      groundingCorpus,
      verificationCorpus,
      providers,
      screenshotLoader: async () => screenshot
    });
    expect(tiers).toEqual(["gui", "gui", "strong"]);
    expect(report.routes.builtInGuiGrounding.metrics.averageRetries).toBe(2);
    expect(report.routes.builtInGuiGrounding.metrics.escalationRate).toBe(1);
  });

  it("assembles an honest unconfigured suite without network calls", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adpilot-live-eval-"));
    try {
      const { providers } = await createProductLiveProviderSuite({ env: {}, workspaceRoot, models: createModels() });
      expect(providers.routes).toEqual({});
      expect(providers.routeAvailability.builtInGuiGrounding.status).toBe("not-run");
      expect(providers.verificationAvailability.status).toBe("not-run");
      expect(providers.tableReaderAvailability?.status).toBe("not-run");
      expect(providers.dualVisualIdentityAvailability?.status).toBe("not-run");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
