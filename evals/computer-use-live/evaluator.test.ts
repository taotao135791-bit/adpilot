import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { Screenshot, VisualMicroTask } from "@adpilot/computer-use";
import type { ModelTier } from "@adpilot/shared";
import {
  runLiveModelEvaluation,
  type ProductLiveProviderSuite,
  type VerificationEvalCorpus,
  type VisualEvalCorpus
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
        tableCellAccuracy: 1,
        campaignIdentityAccuracy: 1,
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
    expect(loader).not.toHaveBeenCalled();
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
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
