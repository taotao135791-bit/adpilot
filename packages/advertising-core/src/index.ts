import { z } from "zod";

/** Single source of truth for campaign-metric field validators. */
const campaignMetricsFields = {
  spend: z.number().nonnegative(),
  impressions: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
  installs: z.number().int().nonnegative(),
  conversions: z.number().nonnegative(),
  revenue: z.number().nonnegative(),
  days: z.number().int().positive(),
  conversionDelayDays: z.number().nonnegative(),
  dailyConversions: z.array(z.number().nonnegative()),
  currencyConsistency: z.number().min(0).max(1),
  missingValueRate: z.number().min(0).max(1),
  reconciliationDifference: z.number().min(0).max(1)
} as const;

export const CampaignMetrics = z.object({
  spend: campaignMetricsFields.spend,
  impressions: campaignMetricsFields.impressions.default(0),
  clicks: campaignMetricsFields.clicks.default(0),
  installs: campaignMetricsFields.installs.default(0),
  conversions: campaignMetricsFields.conversions.default(0),
  revenue: campaignMetricsFields.revenue.default(0),
  days: campaignMetricsFields.days,
  conversionDelayDays: campaignMetricsFields.conversionDelayDays.default(0),
  dailyConversions: campaignMetricsFields.dailyConversions.default([]),
  currencyConsistency: campaignMetricsFields.currencyConsistency.default(1),
  missingValueRate: campaignMetricsFields.missingValueRate.default(0),
  reconciliationDifference: campaignMetricsFields.reconciliationDifference.default(0)
});
export type CampaignMetrics = z.infer<typeof CampaignMetrics>;

/**
 * Specialist-boundary variant of CampaignMetrics. No field carries a default,
 * so every number a model supplies stays explicit and must resolve to a
 * verified Shared Fact before it reaches deterministic tooling.
 */
export const ObservedCampaignMetrics = z.object({
  spend: campaignMetricsFields.spend,
  impressions: campaignMetricsFields.impressions.optional(),
  clicks: campaignMetricsFields.clicks.optional(),
  installs: campaignMetricsFields.installs.optional(),
  conversions: campaignMetricsFields.conversions.optional(),
  revenue: campaignMetricsFields.revenue.optional(),
  days: campaignMetricsFields.days,
  conversionDelayDays: campaignMetricsFields.conversionDelayDays.optional(),
  dailyConversions: campaignMetricsFields.dailyConversions.optional(),
  currencyConsistency: campaignMetricsFields.currencyConsistency.optional(),
  missingValueRate: campaignMetricsFields.missingValueRate.optional(),
  reconciliationDifference: campaignMetricsFields.reconciliationDifference.optional()
}).strict();
export type ObservedCampaignMetrics = z.infer<typeof ObservedCampaignMetrics>;

export type CalculatedMetrics = {
  cpi: number | null;
  cpa: number | null;
  roas: number | null;
  ctr: number | null;
  cvr: number | null;
};

function safeDivide(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

export function calculateMetrics(input: CampaignMetrics): CalculatedMetrics {
  const metrics = CampaignMetrics.parse(input);
  return {
    cpi: safeDivide(metrics.spend, metrics.installs),
    cpa: safeDivide(metrics.spend, metrics.conversions),
    roas: safeDivide(metrics.revenue, metrics.spend),
    ctr: safeDivide(metrics.clicks, metrics.impressions),
    cvr: safeDivide(metrics.conversions, metrics.clicks)
  };
}

export const MaturityPolicy = z.object({
  minimumDays: z.number().int().positive().default(7),
  minimumConversions: z.number().nonnegative().default(20),
  delayBufferMultiplier: z.number().min(1).default(1.5)
});
export type MaturityPolicy = z.infer<typeof MaturityPolicy>;

export type MaturityResult = {
  mature: boolean;
  reasons: string[];
  effectiveDays: number;
};

export function assessMaturity(input: CampaignMetrics, policyInput: z.input<typeof MaturityPolicy> = {}): MaturityResult {
  const metrics = CampaignMetrics.parse(input);
  const policy = MaturityPolicy.parse(policyInput);
  const requiredDays = Math.max(policy.minimumDays, Math.ceil(metrics.conversionDelayDays * policy.delayBufferMultiplier));
  const reasons: string[] = [];
  if (metrics.days < requiredDays) reasons.push(`needs ${requiredDays - metrics.days} more day(s)`);
  if (metrics.conversions < policy.minimumConversions) reasons.push(`needs ${policy.minimumConversions - metrics.conversions} more conversion(s)`);
  return { mature: reasons.length === 0, reasons, effectiveDays: requiredDays };
}

export type ReliabilityResult = {
  status: "reliable" | "warning" | "blocked";
  reasons: string[];
  coefficientOfVariation: number | null;
};

function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 3) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

export function reviewMeasurementReliability(input: CampaignMetrics): ReliabilityResult {
  const metrics = CampaignMetrics.parse(input);
  const warnings: string[] = [];
  const blockers: string[] = [];
  const cv = coefficientOfVariation(metrics.dailyConversions);
  const zeroRate = metrics.dailyConversions.length
    ? metrics.dailyConversions.filter((value) => value === 0).length / metrics.dailyConversions.length
    : 0;
  if (metrics.dailyConversions.length > 0 && metrics.dailyConversions.length < 3) blockers.push("fewer than three daily conversion observations");
  if (cv !== null && cv > 0.5) warnings.push("daily conversion signal is volatile");
  if (zeroRate > 0.2) warnings.push("more than 20% of observed days have zero conversions");
  if (metrics.missingValueRate >= 0.1) blockers.push("missing conversion value rate is at least 10%");
  else if (metrics.missingValueRate >= 0.05) warnings.push("missing conversion value rate is at least 5%");
  if (metrics.reconciliationDifference >= 0.2) blockers.push("platform and source-of-truth values differ by at least 20%");
  else if (metrics.reconciliationDifference >= 0.1) warnings.push("platform and source-of-truth values differ by at least 10%");
  if (metrics.currencyConsistency < 0.95) blockers.push("currency consistency is below 95%");
  else if (metrics.currencyConsistency < 0.99) warnings.push("currency consistency is below 99%");
  return {
    status: blockers.length ? "blocked" : warnings.length ? "warning" : "reliable",
    reasons: [...blockers, ...warnings],
    coefficientOfVariation: cv
  };
}

export const ChangeGuardrailInput = z.object({
  kind: z.enum(["budget", "bid", "target_cpa", "target_roas"]),
  currentValue: z.number().positive(),
  proposedValue: z.number().positive(),
  maxChangePercent: z.number().min(0).max(100).default(20),
  activeExperimentVariables: z.array(z.string()).default([]),
  measurementStatus: z.enum(["reliable", "warning", "blocked"]),
  mature: z.boolean(),
  learning: z.boolean().default(false)
});
export type ChangeGuardrailInput = z.infer<typeof ChangeGuardrailInput>;

export type GuardrailDecision = {
  allowed: boolean;
  changePercent: number;
  cappedValue: number;
  reasons: string[];
  requiresFreshReview: boolean;
};

export function evaluateChangeGuardrail(inputValue: ChangeGuardrailInput): GuardrailDecision {
  const input = ChangeGuardrailInput.parse(inputValue);
  const changePercent = ((input.proposedValue - input.currentValue) / input.currentValue) * 100;
  const direction = Math.sign(changePercent) || 1;
  const cappedValue = input.currentValue * (1 + direction * input.maxChangePercent / 100);
  const reasons: string[] = [];
  if (input.measurementStatus === "blocked") reasons.push("measurement reliability blocks optimization");
  if (!input.mature) reasons.push("data is not mature");
  if (input.learning) reasons.push("campaign is in a learning phase");
  if (input.activeExperimentVariables.length > 0 && !input.activeExperimentVariables.includes(input.kind)) {
    reasons.push("single-variable experiment guardrail blocks variable stacking");
  }
  const exceedsCap = Math.abs(changePercent) > input.maxChangePercent;
  return {
    allowed: reasons.length === 0,
    changePercent,
    cappedValue: exceedsCap ? cappedValue : input.proposedValue,
    reasons,
    requiresFreshReview: exceedsCap
  };
}

export const CreativeFatigueInput = z.object({
  currentCtr: z.number().nonnegative(),
  priorCtr: z.number().positive(),
  frequency: z.number().nonnegative(),
  daysRunning: z.number().int().positive(),
  spendShare: z.number().min(0).max(1)
});
export type CreativeFatigueInput = z.infer<typeof CreativeFatigueInput>;

export const CreativeFatigueOutput = z.object({
  fatigued: z.boolean(),
  ctrDeclinePercent: z.number(),
  reasons: z.array(z.string()),
  nextStep: z.string()
});
export type CreativeFatigueOutput = z.infer<typeof CreativeFatigueOutput>;

/** Directional creative fatigue check; never conflates fatigue with tracking failures. */
export function detectCreativeFatigue(inputValue: CreativeFatigueInput): CreativeFatigueOutput {
  const input = CreativeFatigueInput.parse(inputValue);
  const decline = ((input.priorCtr - input.currentCtr) / input.priorCtr) * 100;
  const reasons = [
    decline >= 25 ? "CTR declined at least 25%" : "CTR decline below 25%",
    input.frequency >= 3 ? "frequency is elevated" : "frequency is not elevated"
  ];
  const fatigued = decline >= 25 && input.frequency >= 3 && input.daysRunning >= 7;
  return CreativeFatigueOutput.parse({
    fatigued,
    ctrDeclinePercent: decline,
    reasons,
    nextStep: fatigued ? "Design a single-variable creative replacement test" : "Continue observation"
  });
}

export const HealthCheck = z.object({
  category: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  result: z.enum(["pass", "warning", "fail", "na"])
});
export type HealthCheck = z.infer<typeof HealthCheck>;

const severityWeight = { critical: 5, high: 3, medium: 1.5, low: 0.5 } as const;
const resultPoints = { pass: 1, warning: 0.5, fail: 0 } as const;

export function calculateHealthScore(checks: HealthCheck[], categoryWeights: Record<string, number>): number {
  let earned = 0;
  let total = 0;
  for (const check of checks) {
    if (check.result === "na") continue;
    const categoryWeight = categoryWeights[check.category];
    if (categoryWeight === undefined || categoryWeight < 0) throw new Error(`missing category weight: ${check.category}`);
    const weight = severityWeight[check.severity] * categoryWeight;
    total += weight;
    earned += resultPoints[check.result] * weight;
  }
  return total === 0 ? 0 : Math.round((earned / total) * 10_000) / 100;
}

export {
  formatKnowledgeCatalogForPrompt,
  formatKnowledgeSkillContext,
  getKnowledgeReference,
  getKnowledgeSkill,
  listKnowledgeSkills,
  matchKnowledgeSkills,
  type KnowledgeSkill,
  type KnowledgeSkillSummary
} from "./knowledge.js";

