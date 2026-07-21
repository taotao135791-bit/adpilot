import { describe, expect, it } from "vitest";
import {
  assessMaturity,
  calculateHealthScore,
  calculateMetrics,
  evaluateChangeGuardrail,
  reviewMeasurementReliability
} from "./index.js";

const matureMetrics = {
  spend: 1000,
  impressions: 10_000,
  clicks: 1000,
  installs: 100,
  conversions: 50,
  revenue: 2000,
  days: 14,
  conversionDelayDays: 2,
  dailyConversions: [8, 9, 10, 9, 8],
  currencyConsistency: 1,
  missingValueRate: 0,
  reconciliationDifference: 0
};

describe("advertising deterministic engine", () => {
  it("calculates CPA, CPI and ROAS without division-by-zero guesses", () => {
    expect(calculateMetrics(matureMetrics)).toMatchObject({ cpi: 10, cpa: 20, roas: 2 });
    expect(calculateMetrics({ ...matureMetrics, conversions: 0 }).cpa).toBeNull();
  });

  it("gates immature and unreliable data", () => {
    expect(assessMaturity({ ...matureMetrics, days: 2, conversions: 2 }).mature).toBe(false);
    expect(reviewMeasurementReliability({ ...matureMetrics, missingValueRate: 0.12 }).status).toBe("blocked");
  });

  it("caps large changes and never admits changes during learning", () => {
    const decision = evaluateChangeGuardrail({
      kind: "budget",
      currentValue: 100,
      proposedValue: 150,
      maxChangePercent: 20,
      activeExperimentVariables: [],
      measurementStatus: "reliable",
      mature: true,
      learning: false
    });
    expect(decision.allowed).toBe(true);
    expect(decision.cappedValue).toBe(120);
    expect(decision.requiresFreshReview).toBe(true);
    expect(evaluateChangeGuardrail({ ...decisionInput(), learning: true }).allowed).toBe(false);
  });

  it("calculates stable severity-weighted health scores", () => {
    const score = calculateHealthScore([
      { category: "tracking", severity: "critical", result: "pass" },
      { category: "creative", severity: "low", result: "fail" }
    ], { tracking: 0.7, creative: 0.3 });
    expect(score).toBeGreaterThan(90);
  });
});

function decisionInput() {
  return {
    kind: "budget" as const,
    currentValue: 100,
    proposedValue: 110,
    maxChangePercent: 20,
    activeExperimentVariables: [],
    measurementStatus: "reliable" as const,
    mature: true,
    learning: false
  };
}

