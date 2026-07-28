import { describe, expect, it } from "vitest";
import {
  ComputerUseEvaluation,
  createComputerUseMetrics,
  currentComputerUseEnvironment,
  emptyComputerUseTarget
} from "../scripts/computer-use-evaluation.js";

describe("ComputerUseEvaluation", () => {
  it("uses null rather than a fabricated 100% rate when no run occurred", () => {
    expect(createComputerUseMetrics()).toMatchObject({
      runs: 0,
      totalRuns: 0,
      completedRuns: 0,
      passedRuns: 0,
      failedRuns: 0,
      blockedRuns: 0,
      actionAttempts: 0,
      successfulActions: 0,
      verificationAttempts: 0,
      successfulVerifications: 0,
      successRate: null,
      permissionSuccessRate: null,
      captureSuccessRate: null,
      groundingSuccessRate: null,
      actionSuccessRate: null,
      identityValidationRate: null,
      valueReadAccuracy: null,
      verificationSuccessRate: null,
      userTakeoverRate: null,
      wrongWindowActions: 0,
      wrongAccountActions: 0,
      wrongCampaignActions: 0,
      unapprovedMutations: 0,
      duplicateMutations: 0
    });
  });

  it("rejects a report that claims a rate without observations", () => {
    expect(() => ComputerUseEvaluation.parse({
      schema: "ComputerUseEvaluation",
      schemaVersion: 1,
      generatedAt: "2026-07-28T00:00:00.000Z",
      command: "pnpm test:computer:google-ads-readonly",
      mode: "readonly",
      evidenceClass: "real-browser-readonly",
      status: "not-run",
      ...currentComputerUseEnvironment({}),
      execution: {
        fixtureUsed: false,
        liveModelCalled: false,
        realBrowserUsed: false,
        nativeInputExecuted: false,
        mutationExecuted: false
      },
      target: emptyComputerUseTarget(),
      metrics: {
        ...createComputerUseMetrics(),
        successRate: 1
      },
      blockers: [{ code: "NO_RUN", message: "No run." }],
      artifacts: [],
      notes: []
    })).toThrow(/successRate/);
  });

  it("computes observed rates from counts", () => {
    expect(createComputerUseMetrics({
      runs: 2,
      passedRuns: 1,
      failedRuns: 1,
      actionAttempts: 4,
      successfulActions: 3,
      verificationAttempts: 3,
      successfulVerifications: 2
    })).toMatchObject({
      successRate: 0.5,
      actionSuccessRate: 0.75,
      verificationSuccessRate: 2 / 3
    });
  });
});
