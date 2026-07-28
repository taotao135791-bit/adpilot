import type { Experiment } from "@adpilot/experiments";
import { z } from "zod";
import type {
  AdAccount,
  AdvertisingDecision,
  CampaignEntity,
  CreativeAsset
} from "./entities.js";

export const BriefSeverity = z.enum(["info", "warning", "critical"]);
export type BriefSeverity = z.infer<typeof BriefSeverity>;

/** Caller-supplied facts: a metrics snapshot plus optional explicit flags. */
export const AccountMetricsRow = z.object({
  accountId: z.string().min(1),
  spend: z.number().nonnegative().optional(),
  cpa: z.number().nonnegative().optional(),
  /** Recent daily spend series, oldest first; used for spike detection. */
  dailySpend: z.array(z.number().nonnegative()).optional(),
  /** Platform-vs-backend reconciliation gap, 0..1 (advertising-core convention). */
  reconciliationDifference: z.number().min(0).max(1).optional(),
  evidenceIds: z.array(z.string().min(1)).optional()
}).strict();
export type AccountMetricsRow = z.infer<typeof AccountMetricsRow>;

export const CampaignMetricsRow = z.object({
  campaignId: z.string().min(1),
  spend: z.number().nonnegative().optional(),
  cpa: z.number().nonnegative().optional(),
  conversions: z.number().nonnegative().optional(),
  /** Platform learning status string, e.g. "learning", "learning_limited". */
  learningStatus: z.string().min(1).optional(),
  conversionsInLearning: z.number().nonnegative().optional(),
  /** Recent CTR series (fractions, oldest first); used for decline detection. */
  dailyCtr: z.array(z.number().nonnegative()).optional(),
  reconciliationDifference: z.number().min(0).max(1).optional(),
  evidenceIds: z.array(z.string().min(1)).optional()
}).strict();
export type CampaignMetricsRow = z.infer<typeof CampaignMetricsRow>;

export const CreativeMetricsRow = z.object({
  creativeId: z.string().min(1),
  dailyCtr: z.array(z.number().nonnegative()).optional(),
  evidenceIds: z.array(z.string().min(1)).optional()
}).strict();
export type CreativeMetricsRow = z.infer<typeof CreativeMetricsRow>;

export const MetricsSnapshot = z.object({
  generatedAt: z.string().datetime().optional(),
  accounts: z.array(AccountMetricsRow).default([]),
  campaigns: z.array(CampaignMetricsRow).default([]),
  creatives: z.array(CreativeMetricsRow).default([])
}).strict();
export type MetricsSnapshot = z.infer<typeof MetricsSnapshot>;

export const PendingReport = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  dueAt: z.string().datetime().optional(),
  evidenceIds: z.array(z.string().min(1)).optional()
}).strict();
export type PendingReport = z.infer<typeof PendingReport>;

export const MeasurementIssue = z.object({
  issue: z.string().min(1),
  accountId: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  evidenceIds: z.array(z.string().min(1)).optional()
}).strict();
export type MeasurementIssue = z.infer<typeof MeasurementIssue>;

/** Deterministic rule thresholds; every rule is pure data, no model calls. */
export const DailyBriefThresholds = z.object({
  /** Absolute daily spend ceiling per account; exceeded → critical anomaly. */
  maxDailySpend: z.number().positive().optional(),
  /** Target CPA ceiling per account; exceeded → warning, hard breach → critical. */
  maxCpa: z.number().positive().optional(),
  /** A CPA above maxCpa × cpaCriticalRatio is critical. */
  cpaCriticalRatio: z.number().min(1).default(1.5),
  /** Spend above spendSpikeRatio × trailing average is an anomaly. */
  spendSpikeRatio: z.number().min(1).default(2),
  /** Minimum trailing dailySpend points required before spike detection runs. */
  spendSpikeMinSamples: z.number().int().min(2).default(3),
  /** Consecutive declining CTR periods that mark a creative as fatiguing. */
  ctrDeclinePeriods: z.number().int().min(2).default(3),
  /** Minimum relative CTR drop across the decline window. */
  ctrDeclineMinDrop: z.number().min(0).max(1).default(0.3),
  /** Learning campaigns below this conversion count are at risk. */
  learningMinConversions: z.number().nonnegative().default(10),
  /** Reconciliation gap above this ratio raises a measurement reminder. */
  reconciliationMaxDifference: z.number().min(0).max(1).default(0.05)
}).strict();
export type DailyBriefThresholds = z.infer<typeof DailyBriefThresholds>;

/** Caller-facing partial thresholds (every rule keeps its default otherwise). */
export const DailyBriefThresholdsInput = DailyBriefThresholds.partial();
export type DailyBriefThresholdsInput = z.infer<typeof DailyBriefThresholdsInput>;

export type DailyBriefInput = {
  workspaceId: string;
  projectId?: string;
  accounts: AdAccount[];
  campaigns: CampaignEntity[];
  creatives: CreativeAsset[];
  metrics: MetricsSnapshot;
  decisions: AdvertisingDecision[];
  experiments: Experiment[];
  pendingReports?: PendingReport[];
  measurementIssues?: MeasurementIssue[];
  thresholds?: DailyBriefThresholdsInput;
  now?: Date;
};

export type BriefItem = {
  ruleId: string;
  severity: BriefSeverity;
  title: string;
  detail: string;
  entityRefs: {
    accountId?: string;
    campaignId?: string;
    creativeId?: string;
    decisionId?: string;
    experimentId?: string;
    reportId?: string;
  };
  evidenceIds: string[];
};

export type DailyBrief = {
  schemaVersion: "1.0";
  generatedAt: string;
  workspaceId: string;
  projectId?: string;
  thresholds: DailyBriefThresholds;
  sections: {
    anomalyAccounts: BriefItem[];
    creativeFatigue: BriefItem[];
    learningPhaseRisks: BriefItem[];
    pendingObservations: BriefItem[];
    pendingApprovals: BriefItem[];
    pendingReports: BriefItem[];
    measurementIssues: BriefItem[];
  };
  summary: {
    totalFindings: number;
    criticalCount: number;
    warningCount: number;
    infoCount: number;
  };
};

/**
 * Deterministic Daily Brief aggregator. Every finding comes from an explicit
 * threshold rule over caller-supplied facts — no model calls, no hidden state.
 */
export class DailyBriefService {
  generate(input: DailyBriefInput): DailyBrief {
    const thresholds = DailyBriefThresholds.parse(input.thresholds ?? {});
    const now = input.now ?? new Date();
    const sections: DailyBrief["sections"] = {
      anomalyAccounts: this.anomalyAccounts(input, thresholds),
      creativeFatigue: this.creativeFatigue(input, thresholds),
      learningPhaseRisks: this.learningPhaseRisks(input, thresholds),
      pendingObservations: this.pendingObservations(input, now),
      pendingApprovals: this.pendingApprovals(input),
      pendingReports: this.pendingReports(input),
      measurementIssues: this.measurementIssues(input, thresholds)
    };
    const items = Object.values(sections).flat();
    return {
      schemaVersion: "1.0",
      generatedAt: now.toISOString(),
      workspaceId: input.workspaceId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      thresholds,
      sections,
      summary: {
        totalFindings: items.length,
        criticalCount: items.filter((item) => item.severity === "critical").length,
        warningCount: items.filter((item) => item.severity === "warning").length,
        infoCount: items.filter((item) => item.severity === "info").length
      }
    };
  }

  private anomalyAccounts(input: DailyBriefInput, thresholds: DailyBriefThresholds): BriefItem[] {
    const items: BriefItem[] = [];
    const accountNames = new Map(input.accounts.map((account) => [account.id, account.name]));
    for (const row of input.metrics.accounts) {
      const name = accountNames.get(row.accountId) ?? row.accountId;
      const evidenceIds = row.evidenceIds ?? [];
      if (thresholds.maxDailySpend !== undefined && row.spend !== undefined && row.spend > thresholds.maxDailySpend) {
        items.push({
          ruleId: "account_spend_over_ceiling",
          severity: "critical",
          title: `${name}: spend ${row.spend} exceeds the daily ceiling ${thresholds.maxDailySpend}`,
          detail: "Declared daily spend is above the configured account ceiling.",
          entityRefs: { accountId: row.accountId },
          evidenceIds
        });
      }
      if (
        row.spend !== undefined
        && row.dailySpend !== undefined
        && row.dailySpend.length >= thresholds.spendSpikeMinSamples
      ) {
        const average = row.dailySpend.reduce((sum, value) => sum + value, 0) / row.dailySpend.length;
        if (average > 0 && row.spend > thresholds.spendSpikeRatio * average) {
          items.push({
            ruleId: "account_spend_spike",
            severity: "warning",
            title: `${name}: spend ${row.spend} is a spike vs trailing average ${round2(average)}`,
            detail: `Latest spend exceeds ${thresholds.spendSpikeRatio}× the trailing ${row.dailySpend.length}-day average.`,
            entityRefs: { accountId: row.accountId },
            evidenceIds
          });
        }
      }
      if (thresholds.maxCpa !== undefined && row.cpa !== undefined && row.cpa > thresholds.maxCpa) {
        const critical = row.cpa > thresholds.maxCpa * thresholds.cpaCriticalRatio;
        items.push({
          ruleId: "account_cpa_over_target",
          severity: critical ? "critical" : "warning",
          title: `${name}: CPA ${row.cpa} is above target ${thresholds.maxCpa}`,
          detail: critical
            ? `CPA breached ${thresholds.cpaCriticalRatio}× the configured target.`
            : "CPA is above the configured target.",
          entityRefs: { accountId: row.accountId },
          evidenceIds
        });
      }
    }
    return items;
  }

  private creativeFatigue(input: DailyBriefInput, thresholds: DailyBriefThresholds): BriefItem[] {
    const items: BriefItem[] = [];
    const metricRows = new Map(input.metrics.creatives.map((row) => [row.creativeId, row]));
    for (const creative of input.creatives) {
      const row = metricRows.get(creative.id);
      const evidenceIds = row?.evidenceIds ?? [];
      if (creative.lifecycle === "fatiguing") {
        items.push({
          ruleId: "creative_declared_fatiguing",
          severity: "warning",
          title: `${creative.name}: lifecycle marked fatiguing`,
          detail: "The creative was declared fatiguing in the asset registry.",
          entityRefs: { creativeId: creative.id, accountId: creative.accountId },
          evidenceIds
        });
        continue;
      }
      if (creative.lifecycle === "retired") continue;
      const series = row?.dailyCtr;
      if (series && ctrDecline(series, thresholds.ctrDeclinePeriods, thresholds.ctrDeclineMinDrop)) {
        items.push({
          ruleId: "creative_ctr_decline",
          severity: "warning",
          title: `${creative.name}: CTR declined ${thresholds.ctrDeclinePeriods} consecutive periods`,
          detail: `CTR series ${series.map(String).join(" → ")} shows a sustained decline of at least ${thresholds.ctrDeclineMinDrop * 100}%.`,
          entityRefs: { creativeId: creative.id, accountId: creative.accountId },
          evidenceIds
        });
      }
    }
    return items;
  }

  private learningPhaseRisks(input: DailyBriefInput, thresholds: DailyBriefThresholds): BriefItem[] {
    const items: BriefItem[] = [];
    const campaignNames = new Map(input.campaigns.map((campaign) => [campaign.id, campaign.name]));
    for (const row of input.metrics.campaigns) {
      if (row.learningStatus === undefined) continue;
      const name = campaignNames.get(row.campaignId) ?? row.campaignId;
      const normalized = row.learningStatus.trim().toLowerCase().replace(/[\s-]+/g, "_");
      const evidenceIds = row.evidenceIds ?? [];
      if (normalized === "learning_limited" || normalized === "limited") {
        items.push({
          ruleId: "campaign_learning_limited",
          severity: "critical",
          title: `${name}: learning limited`,
          detail: "The platform reports a constrained learning phase; delivery cannot optimize reliably.",
          entityRefs: { campaignId: row.campaignId },
          evidenceIds
        });
        continue;
      }
      if (normalized === "learning") {
        const lowVolume = row.conversionsInLearning !== undefined
          && row.conversionsInLearning < thresholds.learningMinConversions;
        items.push({
          ruleId: "campaign_learning_phase",
          severity: lowVolume ? "warning" : "info",
          title: `${name}: still in learning phase`,
          detail: lowVolume
            ? `Only ${row.conversionsInLearning} conversions observed; below the ${thresholds.learningMinConversions} minimum for stable learning.`
            : "Campaign is still in the platform learning phase; avoid structural edits.",
          entityRefs: { campaignId: row.campaignId },
          evidenceIds
        });
      }
    }
    return items;
  }

  private pendingObservations(input: DailyBriefInput, now: Date): BriefItem[] {
    const items: BriefItem[] = [];
    for (const decision of input.decisions) {
      if (decision.status !== "observing") continue;
      items.push({
        ruleId: "decision_observing",
        severity: "info",
        title: `Decision ${decision.id}: awaiting observation`,
        detail: decision.observationWindow !== undefined
          ? `Observation window: ${decision.observationWindow}. Recommendation: ${decision.recommendation}`
          : `Recommendation: ${decision.recommendation}`,
        entityRefs: { decisionId: decision.id, ...(decision.campaignId !== undefined ? { campaignId: decision.campaignId } : {}) },
        evidenceIds: decision.evidenceIds
      });
    }
    for (const experiment of input.experiments) {
      if (experiment.status !== "active" && experiment.status !== "waiting") continue;
      const overdue = Date.parse(experiment.reviewAt) < now.getTime();
      items.push({
        ruleId: overdue ? "experiment_review_overdue" : "experiment_in_flight",
        severity: overdue ? "warning" : "info",
        title: `Experiment ${experiment.id}: ${overdue ? "review overdue" : "awaiting observation"}`,
        detail: `${experiment.variable}: ${experiment.hypothesis} (review at ${experiment.reviewAt})`,
        entityRefs: { experimentId: experiment.id },
        evidenceIds: []
      });
    }
    return items;
  }

  private pendingApprovals(input: DailyBriefInput): BriefItem[] {
    return input.decisions
      .filter((decision) => decision.status === "proposed")
      .map((decision) => ({
        ruleId: "decision_proposed",
        severity: "info" as const,
        title: `Decision ${decision.id}: awaiting approval`,
        detail: `Recommendation: ${decision.recommendation}`,
        entityRefs: { decisionId: decision.id, ...(decision.campaignId !== undefined ? { campaignId: decision.campaignId } : {}) },
        evidenceIds: decision.evidenceIds
      }));
  }

  private pendingReports(input: DailyBriefInput): BriefItem[] {
    return (input.pendingReports ?? []).map((report) => ({
      ruleId: "report_pending",
      severity: "info" as const,
      title: `Report ${report.kind} (${report.id}): not yet sent`,
      detail: report.dueAt !== undefined ? `Due at ${report.dueAt}.` : "No due date declared.",
      entityRefs: { reportId: report.id },
      evidenceIds: report.evidenceIds ?? []
    }));
  }

  private measurementIssues(input: DailyBriefInput, thresholds: DailyBriefThresholds): BriefItem[] {
    const items: BriefItem[] = (input.measurementIssues ?? []).map((entry) => ({
      ruleId: "measurement_declared_issue",
      severity: "warning" as const,
      title: `Measurement definition: ${entry.issue}`,
      detail: "Caller-declared measurement/definition issue that must be resolved before trusting the numbers.",
      entityRefs: {
        ...(entry.accountId !== undefined ? { accountId: entry.accountId } : {}),
        ...(entry.campaignId !== undefined ? { campaignId: entry.campaignId } : {})
      },
      evidenceIds: entry.evidenceIds ?? []
    }));
    for (const row of input.metrics.accounts) {
      if (row.reconciliationDifference !== undefined && row.reconciliationDifference > thresholds.reconciliationMaxDifference) {
        items.push({
          ruleId: "measurement_reconciliation_gap",
          severity: "warning",
          title: `Account ${row.accountId}: reconciliation gap ${round2(row.reconciliationDifference * 100)}%`,
          detail: `Platform-vs-backend reconciliation difference exceeds ${thresholds.reconciliationMaxDifference * 100}%.`,
          entityRefs: { accountId: row.accountId },
          evidenceIds: row.evidenceIds ?? []
        });
      }
    }
    for (const row of input.metrics.campaigns) {
      if (row.reconciliationDifference !== undefined && row.reconciliationDifference > thresholds.reconciliationMaxDifference) {
        items.push({
          ruleId: "measurement_reconciliation_gap",
          severity: "warning",
          title: `Campaign ${row.campaignId}: reconciliation gap ${round2(row.reconciliationDifference * 100)}%`,
          detail: `Platform-vs-backend reconciliation difference exceeds ${thresholds.reconciliationMaxDifference * 100}%.`,
          entityRefs: { campaignId: row.campaignId },
          evidenceIds: row.evidenceIds ?? []
        });
      }
    }
    return items;
  }
}

function ctrDecline(series: number[], periods: number, minDrop: number): boolean {
  if (series.length < periods + 1) return false;
  const window = series.slice(-(periods + 1));
  for (let index = 1; index < window.length; index += 1) {
    if (window[index]! >= window[index - 1]!) return false;
  }
  const first = window[0]!;
  if (first <= 0) return false;
  return (first - window[window.length - 1]!) / first >= minDrop;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
