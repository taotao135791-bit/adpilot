import { createHash } from "node:crypto";
import { z } from "zod";
import { type AdPilotTools, type ToolContext } from "@adpilot/tools";
import {
  CampaignMetrics,
  ChangeGuardrailInput,
  CreativeFatigueInput,
  CreativeFatigueOutput,
  HealthCheck,
  calculateHealthScore,
  detectCreativeFatigue,
  type CalculatedMetrics,
  type MaturityResult,
  type ReliabilityResult
} from "@adpilot/advertising-core";
import { stableJson } from "@adpilot/shared";

export interface SkillDefinition<I, O> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  prerequisites: string[];
  requiredTools: string[];
  failureConditions: string[];
  forbidden: string[];
  execute(context: ToolContext, input: I, tools: AdPilotTools): Promise<O>;
}

const ReliabilityOutput = z.object({ status: z.enum(["reliable", "warning", "blocked"]), reasons: z.array(z.string()), coefficientOfVariation: z.number().nullable() });
const GuardrailOutput = z.object({ allowed: z.boolean(), changePercent: z.number(), cappedValue: z.number(), reasons: z.array(z.string()), requiresFreshReview: z.boolean() });

const checkConversionReliability: SkillDefinition<z.input<typeof CampaignMetrics>, z.output<typeof ReliabilityOutput>> = {
  name: "check-conversion-reliability",
  description: "Validate conversion volume, volatility, value completeness, reconciliation, and currency consistency.",
  input: CampaignMetrics,
  output: ReliabilityOutput,
  prerequisites: ["A bounded observation window", "Daily conversion observations or an explicit absence"],
  requiredTools: ["analyze_campaign_metrics"],
  failureConditions: ["Non-finite or negative metrics", "Missing observation days"],
  forbidden: ["Inferring reliability from spend alone", "Optimizing while status is blocked"],
  execute: async (context, input, tools) => ReliabilityOutput.parse(tools.analyzePerformance(context, input).reliability)
};

function changeSkill(name: string, kind: "budget" | "bid"): SkillDefinition<z.input<typeof ChangeGuardrailInput>, z.output<typeof GuardrailOutput>> {
  return {
    name,
    description: `Evaluate a proposed ${kind} change through deterministic safety gates.`,
    input: ChangeGuardrailInput,
    output: GuardrailOutput,
    prerequisites: ["Current and proposed value", "Measurement review", "Maturity review", "Learning state"],
    requiredTools: ["evaluate_change_guardrail"],
    failureConditions: ["Measurement is blocked", "Data is immature", "Campaign is learning", "A different experiment variable is active"],
    forbidden: ["Exceeding the staged cap", "Stacking variables", "Treating a recommendation as approval"],
    execute: async (context, input, tools) => {
      const parsed = ChangeGuardrailInput.parse(input);
      return GuardrailOutput.parse(tools.evaluateChange(context, { ...parsed, kind }));
    }
  };
}

const detectCreativeFatigueSkill: SkillDefinition<z.input<typeof CreativeFatigueInput>, z.output<typeof CreativeFatigueOutput>> = {
  name: "detect-creative-fatigue", description: "Detect directional creative fatigue without conflating it with conversion tracking failures.",
  input: CreativeFatigueInput, output: CreativeFatigueOutput,
  prerequisites: ["Comparable current and prior windows", "Frequency and spend share"], requiredTools: [],
  failureConditions: ["Prior CTR is zero", "Windows are not comparable"], forbidden: ["Pausing solely from CTR", "Ignoring downstream CPA/ROAS"],
  execute: async (_context, raw) => detectCreativeFatigue(CreativeFatigueInput.parse(raw))
};

const LaunchInput = z.object({ measurementReliable: z.boolean(), budgetSufficient: z.boolean(), conversionEventEligible: z.boolean(), creativeCount: z.number().int().nonnegative(), complianceReviewed: z.boolean() });
const LaunchOutput = z.object({ ready: z.boolean(), blockers: z.array(z.string()) });
const assessCampaignLaunch: SkillDefinition<z.input<typeof LaunchInput>, z.output<typeof LaunchOutput>> = {
  name: "assess-campaign-launch", description: "Check launch readiness before creating a campaign.", input: LaunchInput, output: LaunchOutput,
  prerequisites: ["Measurement plan", "Budget", "Creative set", "Compliance category"], requiredTools: [],
  failureConditions: ["Any launch gate is missing"], forbidden: ["Launching without measurement", "Bypassing regulated-category review"],
  execute: async (_context, raw) => {
    const input = LaunchInput.parse(raw); const blockers: string[] = [];
    if (!input.measurementReliable) blockers.push("measurement is not reliable");
    if (!input.budgetSufficient) blockers.push("budget is insufficient for the learning unit");
    if (!input.conversionEventEligible) blockers.push("conversion event is not eligible");
    if (input.creativeCount < 3) blockers.push("fewer than three launch creatives");
    if (!input.complianceReviewed) blockers.push("compliance review is incomplete");
    return { ready: blockers.length === 0, blockers };
  }
};

const AttributionInput = z.object({ platformConversions: z.number().nonnegative(), sourceConversions: z.number().nonnegative(), duplicatedEvents: z.number().int().nonnegative(), currencyConsistency: z.number().min(0).max(1), eventIdsPresent: z.boolean() });
const AttributionOutput = z.object({ status: z.enum(["consistent", "warning", "blocked"]), differenceRate: z.number(), reasons: z.array(z.string()) });
const reviewAttribution: SkillDefinition<z.input<typeof AttributionInput>, z.output<typeof AttributionOutput>> = {
  name: "review-attribution-consistency", description: "Compare platform and source-of-truth conversion signals.", input: AttributionInput, output: AttributionOutput,
  prerequisites: ["Same timezone and attribution window", "Platform and source exports"], requiredTools: [],
  failureConditions: ["Windows cannot be aligned"], forbidden: ["Adding platform and source conversions together", "Ignoring deduplication"],
  execute: async (_context, raw) => {
    const input = AttributionInput.parse(raw); const denominator = Math.max(input.sourceConversions, 1); const differenceRate = Math.abs(input.platformConversions - input.sourceConversions) / denominator; const reasons: string[] = [];
    if (differenceRate >= 0.2) reasons.push("conversion difference is at least 20%"); else if (differenceRate >= 0.1) reasons.push("conversion difference is at least 10%");
    if (input.duplicatedEvents > 0 || !input.eventIdsPresent) reasons.push("deduplication evidence is incomplete");
    if (input.currencyConsistency < 0.95) reasons.push("currency consistency is below 95%");
    const blocked = differenceRate >= 0.2 || input.currencyConsistency < 0.95;
    return { status: blocked ? "blocked" : reasons.length ? "warning" : "consistent", differenceRate, reasons };
  }
};

const ExperimentDraftInput = z.object({ hypothesis: z.string().min(1), variable: z.string().min(1), baseline: z.record(z.number()), expected: z.string().min(1), successCriteria: z.string().min(1), failureCriteria: z.string().min(1), maturityWindowDays: z.number().int().positive(), rollbackCondition: z.string().min(1), reviewAt: z.string().datetime(), approvalId: z.string().uuid() });
const ExperimentDraftOutput = z.object({ experimentId: z.string().uuid(), status: z.literal("draft") });
const createExperiment: SkillDefinition<z.input<typeof ExperimentDraftInput>, z.output<typeof ExperimentDraftOutput>> = {
  name: "create-single-variable-experiment", description: "Create a reviewable experiment ledger entry tied to an approval.", input: ExperimentDraftInput, output: ExperimentDraftOutput,
  prerequisites: ["One declared variable", "Baseline", "Success, failure, maturity and rollback rules", "Approval id"], requiredTools: ["write_experiment"],
  failureConditions: ["Another variable is active", "Criteria are missing"], forbidden: ["Starting without an executed approval", "Changing more than one variable"],
  execute: async (context, input, tools) => {
    const value = ExperimentDraftInput.parse(input);
    const experiment = await tools.writeExperiment(context, { ...value, clientId: context.clientId, taskId: context.taskId });
    return { experimentId: experiment.id, status: "draft" };
  }
};

const ReportInput = z.object({ observed: z.array(z.string()), calculated: z.array(z.string()), inferences: z.array(z.string()), risks: z.array(z.string()), actions: z.array(z.string()), requests: z.array(z.string()) });
const ReportOutput = z.object({ markdown: z.string().min(1) });
const generateReport: SkillDefinition<z.input<typeof ReportInput>, z.output<typeof ReportOutput>> = {
  name: "generate-client-report", description: "Generate a client-safe report with facts, calculations and inference separated.", input: ReportInput, output: ReportOutput,
  prerequisites: ["Evidence-backed observations"], requiredTools: [], failureConditions: ["Observed facts and inferences are mixed"], forbidden: ["Presenting inference as fact", "Including credentials or raw identifiers"],
  execute: async (_context, input) => ({ markdown: (["Observed", "Calculated", "Inferences", "Risks", "Actions", "Requests"] as const).map((heading) => `## ${heading}\n\n${input[heading.toLowerCase() as keyof typeof input].map((line) => `- ${line}`).join("\n") || "- None"}`).join("\n\n") })
};

interface PerformanceAnalysis {
  metrics: CampaignMetrics;
  calculated: CalculatedMetrics;
  maturity: MaturityResult;
  reliability: ReliabilityResult;
}

const ReportAudience = z.enum(["internal", "client"]).default("client");
const PerformanceReportOutput = z.object({
  markdown: z.string().min(1),
  reliability: z.enum(["reliable", "warning", "blocked"]),
  mature: z.boolean()
});

const DailyReportInput = z.object({
  metrics: CampaignMetrics.describe("Verified account metrics for the report day and its trailing observation window"),
  reportDate: z.string().date().describe("ISO calendar date the report covers, expressed in the account timezone"),
  timezone: z.string().min(1).describe("IANA timezone of the ad account"),
  currency: z.string().min(1).describe("ISO currency code used for every monetary value"),
  objective: z.string().min(1).describe("Primary KPI objective label, for example CPA or ROAS"),
  target: z.number().positive().optional().describe("Primary KPI target value when the client has one"),
  audience: ReportAudience.describe("Report audience; client reports avoid internal jargon")
});

const WeeklyReportInput = z.object({
  metrics: CampaignMetrics.describe("Verified account metrics for the current week"),
  priorMetrics: CampaignMetrics.optional().describe("Verified metrics for the previous comparable week; required for week-over-week deltas"),
  periodStart: z.string().date().describe("ISO first day of the reporting week, in the account timezone"),
  periodEnd: z.string().date().describe("ISO last day of the reporting week, in the account timezone"),
  timezone: z.string().min(1).describe("IANA timezone of the ad account"),
  currency: z.string().min(1).describe("ISO currency code used for every monetary value"),
  objective: z.string().min(1).describe("Primary KPI objective label, for example CPA or ROAS"),
  target: z.number().positive().optional().describe("Primary KPI target value when the client has one"),
  audience: ReportAudience.describe("Report audience; client reports avoid internal jargon")
});

const dailyReport: SkillDefinition<z.input<typeof DailyReportInput>, z.output<typeof PerformanceReportOutput>> = {
  name: "daily-report",
  description: "Generate a daily performance report with observed facts, deterministic calculations, and inferences strictly separated.",
  input: DailyReportInput,
  output: PerformanceReportOutput,
  prerequisites: ["Verified metrics for the reporting window", "Account timezone and currency"],
  requiredTools: ["analyze_campaign_metrics"],
  failureConditions: ["Metrics fail the input contract", "Measurement is blocked; the report must say so instead of drawing conclusions"],
  forbidden: ["Presenting inference as fact", "Inventing metrics absent from the input", "Mixing observed and calculated numbers"],
  execute: async (context, raw, tools) => {
    const input = DailyReportInput.parse(raw);
    const analysis = tools.analyzePerformance(context, input.metrics);
    const findings = deriveFindings(analysis, input.target, input.objective);
    const markdown = markdownReport("Daily Ads Report", [
      ["Date", input.reportDate],
      ["Timezone", input.timezone],
      ["Currency", input.currency],
      ["Objective", input.objective],
      ["Audience", input.audience]
    ], [
      ["Observed Facts", observedFactLines(analysis.metrics, input.currency)],
      ["Calculated", calculatedLines(analysis, input.currency)],
      ["Inferences", findings.inferences],
      ["Risks", findings.risks],
      ["Actions", findings.actions],
      ["Client Requests", []]
    ]);
    return PerformanceReportOutput.parse({ markdown, reliability: analysis.reliability.status, mature: analysis.maturity.mature });
  }
};

const weeklyReport: SkillDefinition<z.input<typeof WeeklyReportInput>, z.output<typeof PerformanceReportOutput>> = {
  name: "weekly-report",
  description: "Generate a weekly performance report with observed facts, deterministic calculations and deltas, and inferences strictly separated.",
  input: WeeklyReportInput,
  output: PerformanceReportOutput,
  prerequisites: ["Verified metrics for the current week", "Verified metrics for a comparable prior week when deltas are reported", "Account timezone and currency"],
  requiredTools: ["analyze_campaign_metrics"],
  failureConditions: ["Metrics fail the input contract", "Measurement is blocked; the report must say so instead of drawing conclusions"],
  forbidden: ["Presenting inference as fact", "Inventing metrics absent from the input", "Reporting deltas without a verified prior period"],
  execute: async (context, raw, tools) => {
    const input = WeeklyReportInput.parse(raw);
    const analysis = tools.analyzePerformance(context, input.metrics);
    const findings = deriveFindings(analysis, input.target, input.objective);
    const markdown = markdownReport("Weekly Ads Report", [
      ["Period", `${input.periodStart} → ${input.periodEnd}`],
      ["Timezone", input.timezone],
      ["Currency", input.currency],
      ["Objective", input.objective],
      ["Audience", input.audience]
    ], [
      ["Observed Facts", observedFactLines(analysis.metrics, input.currency)],
      ["Calculated", calculatedLines(analysis, input.currency)],
      ["What Changed", deltaLines(analysis.metrics, input.priorMetrics, input.currency)],
      ["Inferences", findings.inferences],
      ["Risks", findings.risks],
      ["Next Week Plan", findings.actions],
      ["Client Decisions Needed", []]
    ]);
    return PerformanceReportOutput.parse({ markdown, reliability: analysis.reliability.status, mature: analysis.maturity.mature });
  }
};

const AccountAuditInput = z.object({
  metrics: CampaignMetrics.describe("Verified account metrics for the audit observation window"),
  objective: z.string().min(1).describe("Primary KPI objective label, for example CPA or ROAS"),
  currency: z.string().min(1).describe("ISO currency code used for every monetary value"),
  target: z.number().positive().optional().describe("Primary KPI target value when the client has one")
});
const AUDIT_CATEGORY_WEIGHTS: Record<string, number> = { measurement: 2, performance: 1.5, efficiency: 1 };
const AUDIT_CHECK_NAMES = ["measurement_reliability", "data_maturity", "conversion_volume", "ctr_sanity", "cpa_vs_target", "roas_efficiency"] as const;
const AccountAuditOutput = z.object({
  markdown: z.string().min(1),
  score: z.number().min(0).max(100),
  grade: z.enum(["A", "B", "C", "D"]),
  checks: z.array(HealthCheck)
});

const accountAudit: SkillDefinition<z.input<typeof AccountAuditInput>, z.output<typeof AccountAuditOutput>> = {
  name: "account-audit",
  description: "Produce a graded account health audit from verified facts, deterministic health checks, reliability, and maturity.",
  input: AccountAuditInput,
  output: AccountAuditOutput,
  prerequisites: ["Verified metrics for a bounded observation window"],
  requiredTools: ["analyze_campaign_metrics"],
  failureConditions: ["Metrics fail the input contract", "Every check is na, which scores zero and must be explained"],
  forbidden: ["Letting model judgment override a deterministic check result", "Hiding a blocked measurement status behind a good grade"],
  execute: async (context, raw, tools) => {
    const input = AccountAuditInput.parse(raw);
    const analysis = tools.analyzePerformance(context, input.metrics);
    const checks = buildAuditChecks(analysis, input.target);
    const score = calculateHealthScore(checks, AUDIT_CATEGORY_WEIGHTS);
    const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : "D";
    const rows = checks.map((check, index) => `| ${AUDIT_CHECK_NAMES[index]} | ${check.category} | ${check.severity} | ${check.result} |`);
    const markdown = markdownReport("Account Health Audit", [
      ["Objective", input.objective],
      ["Currency", input.currency]
    ], [
      ["Observed Facts", observedFactLines(analysis.metrics, input.currency)],
      ["Calculated", calculatedLines(analysis, input.currency)],
      ["Health Checks", ["| Check | Category | Severity | Result |", "| --- | --- | --- | --- |", ...rows]],
      ["Grade", [
        `**${grade} — ${score} / 100**`,
        "Bands: A ≥ 90, B ≥ 75, C ≥ 60, D < 60",
        `Category weights: ${Object.entries(AUDIT_CATEGORY_WEIGHTS).map(([category, weight]) => `${category} ${weight}`).join(", ")}`
      ]]
    ]);
    return AccountAuditOutput.parse({ markdown, score, grade, checks });
  }
};

function buildAuditChecks(analysis: PerformanceAnalysis, target: number | undefined): HealthCheck[] {
  const { metrics, calculated, maturity, reliability } = analysis;
  return [
    HealthCheck.parse({ category: "measurement", severity: "critical", result: reliability.status === "reliable" ? "pass" : reliability.status === "warning" ? "warning" : "fail" }),
    HealthCheck.parse({ category: "measurement", severity: "high", result: maturity.mature ? "pass" : "warning" }),
    HealthCheck.parse({ category: "performance", severity: "high", result: metrics.conversions >= 20 ? "pass" : metrics.conversions > 0 ? "warning" : "fail" }),
    HealthCheck.parse({ category: "performance", severity: "low", result: metrics.impressions > 0 ? (calculated.ctr !== null && calculated.ctr > 0 ? "pass" : "warning") : "na" }),
    HealthCheck.parse({ category: "efficiency", severity: "medium", result: target !== undefined && calculated.cpa !== null ? (calculated.cpa <= target ? "pass" : calculated.cpa <= target * 1.2 ? "warning" : "fail") : "na" }),
    HealthCheck.parse({ category: "efficiency", severity: "medium", result: metrics.revenue > 0 && calculated.roas !== null ? (calculated.roas >= 1 ? "pass" : "fail") : "na" })
  ];
}

function observedFactLines(metrics: CampaignMetrics, currency: string): string[] {
  return [
    `Spend: ${round2(metrics.spend)} ${currency} over ${metrics.days} day(s)`,
    `Impressions: ${metrics.impressions}; clicks: ${metrics.clicks}; installs: ${metrics.installs}`,
    `Conversions: ${metrics.conversions}; revenue: ${round2(metrics.revenue)} ${currency}`,
    `Conversion delay: ${metrics.conversionDelayDays} day(s); daily conversion observations: ${metrics.dailyConversions.length ? metrics.dailyConversions.join(", ") : "none"}`,
    `Currency consistency: ${percent(metrics.currencyConsistency)}; missing value rate: ${percent(metrics.missingValueRate)}; reconciliation difference: ${percent(metrics.reconciliationDifference)}`
  ];
}

function calculatedLines(analysis: PerformanceAnalysis, currency: string): string[] {
  const { calculated, maturity, reliability } = analysis;
  return [
    `CPI: ${money(calculated.cpi, currency)}; CPA: ${money(calculated.cpa, currency)}; ROAS: ${calculated.roas === null ? "n/a" : round2(calculated.roas)}`,
    `CTR: ${percent(calculated.ctr)}; CVR: ${percent(calculated.cvr)}`,
    `Measurement reliability: ${reliability.status}${reliability.coefficientOfVariation === null ? "" : ` (daily conversion CV ${round2(reliability.coefficientOfVariation)})`}${reliability.reasons.length ? ` — ${reliability.reasons.join("; ")}` : ""}`,
    `Maturity: ${maturity.mature ? "mature" : `immature (${maturity.reasons.join("; ")})`}`
  ];
}

function deltaLines(current: CampaignMetrics, prior: CampaignMetrics | undefined, currency: string): string[] {
  if (!prior) return ["No verified prior-period metrics supplied; week-over-week comparison is unavailable."];
  const delta = (label: string, now: number, before: number, unit = ""): string => {
    if (before === 0) return `${label}: ${round2(now)}${unit} (prior was 0; change is not computable)`;
    const change = round2(((now - before) / before) * 100);
    return `${label}: ${round2(now)}${unit} vs ${round2(before)}${unit} (${change >= 0 ? "+" : ""}${change}%)`;
  };
  return [
    delta("Spend", current.spend, prior.spend, ` ${currency}`),
    delta("Conversions", current.conversions, prior.conversions),
    delta("Revenue", current.revenue, prior.revenue, ` ${currency}`),
    delta("Clicks", current.clicks, prior.clicks),
    delta("Installs", current.installs, prior.installs)
  ];
}

interface DeterministicFindings {
  inferences: string[];
  risks: string[];
  actions: string[];
}

function deriveFindings(analysis: PerformanceAnalysis, target: number | undefined, objective: string): DeterministicFindings {
  const { calculated, maturity, reliability } = analysis;
  const inferences: string[] = [];
  const risks: string[] = [];
  const actions: string[] = [];
  if (reliability.status === "blocked") {
    inferences.push("Measurement is blocked, so every performance conclusion in this report is unreliable.");
    risks.push(...reliability.reasons);
    actions.push("Fix conversion tracking before any optimization change.");
  } else if (reliability.status === "warning") {
    inferences.push("Measurement has warnings; treat this report as directional, not definitive.");
    risks.push(...reliability.reasons);
  }
  if (!maturity.mature) {
    inferences.push(`Data is not yet mature (${maturity.reasons.join("; ")}).`);
    actions.push("Continue observation until the maturity window completes.");
  }
  if (target !== undefined && calculated.cpa !== null) {
    const ratioToTarget = calculated.cpa / target;
    if (ratioToTarget > 1.2) {
      inferences.push(`CPA is ${round2((ratioToTarget - 1) * 100)}% above the ${objective} target.`);
      risks.push("Cost per conversion is materially above target.");
      actions.push("Prepare a single-variable cost-control experiment instead of a broad change.");
    } else if (ratioToTarget < 0.8) {
      inferences.push(`CPA is ${round2((1 - ratioToTarget) * 100)}% below the ${objective} target, leaving headroom.`);
    } else {
      inferences.push(`CPA is within 20% of the ${objective} target.`);
    }
  }
  if (calculated.roas !== null && calculated.roas < 1) {
    inferences.push("Revenue does not cover spend (ROAS below 1).");
    risks.push("Spend is not recovered by tracked revenue.");
  }
  if (analysis.metrics.conversions === 0) {
    inferences.push("No conversions were observed in the reporting window.");
    risks.push("Optimization signals are absent at zero conversions.");
  }
  if (inferences.length === 0) inferences.push("Performance is within expected bounds; no strong signal this period.");
  if (actions.length === 0) actions.push("Continue observation; no change is justified by this window.");
  return { inferences, risks, actions };
}

function markdownReport(title: string, header: Array<[string, string]>, sections: Array<[string, string[]]>): string {
  const head = [`# ${title}`, "", ...header.map(([key, value]) => `**${key}:** ${value}`)].join("\n");
  const body = sections.map(([name, lines]) => `## ${name}\n\n${lines.length ? lines.map((line) => line.startsWith("|") || line.startsWith("**") ? line : `- ${line}`).join("\n") : "- None"}`);
  return `${head}\n\n${body.join("\n\n")}\n`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function money(value: number | null, currency: string): string {
  return value === null ? "n/a" : `${round2(value)} ${currency}`;
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${round2(value * 100)}%`;
}

export interface SkillFieldSpec {
  path: string;
  type: string;
  required: boolean;
  description?: string;
}

const MAX_CONTRACT_DEPTH = 3;

/** Flattened, model-readable field inventory derived from a skill's zod contract. */
export function skillInputFields(skill: SkillDefinition<unknown, unknown>): SkillFieldSpec[] {
  const fields: SkillFieldSpec[] = [];
  collectObjectFields(skill.input, "", 0, fields);
  return fields;
}

/** Full model-readable contract for one skill: input/output fields, gates, and forbidden behavior. */
export function formatSkillContract(skill: SkillDefinition<unknown, unknown>): string {
  const formatFields = (schema: z.ZodTypeAny): string => {
    const fields: SkillFieldSpec[] = [];
    collectObjectFields(schema, "", 0, fields);
    if (!fields.length) return "- free-form value matching the skill description";
    return fields.map((field) => `- ${field.path}: ${field.type} (${field.required ? "required" : "optional"})${field.description ? ` — ${field.description}` : ""}`).join("\n");
  };
  return [
    `${skill.name}: ${skill.description}`,
    "Input fields:",
    formatFields(skill.input),
    "Output fields:",
    formatFields(skill.output),
    `Prerequisites: ${skill.prerequisites.join("; ") || "none"}`,
    `Required tools: ${skill.requiredTools.join("; ") || "none"}`,
    `Failure conditions: ${skill.failureConditions.join("; ")}`,
    `Forbidden: ${skill.forbidden.join("; ")}`
  ].join("\n");
}

function collectObjectFields(schema: z.ZodTypeAny, prefix: string, depth: number, out: SkillFieldSpec[], parentOptional = false): void {
  const objectSchema = unwrapToObject(schema);
  if (!objectSchema || depth >= MAX_CONTRACT_DEPTH) return;
  for (const [key, child] of Object.entries(objectSchema.shape)) {
    const { schema: unwrapped, optional } = unwrapModifiers(child);
    if (unwrapToObject(unwrapped) && depth + 1 < MAX_CONTRACT_DEPTH) {
      collectObjectFields(unwrapped, `${prefix}${key}.`, depth + 1, out, parentOptional || optional);
      continue;
    }
    const description = child.description ?? unwrapped.description;
    out.push({
      path: `${prefix}${key}`,
      type: describeFieldType(child),
      required: !optional && !parentOptional,
      ...(description ? { description } : {})
    });
  }
}

function unwrapToObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> | undefined {
  const { schema: unwrapped } = unwrapModifiers(schema);
  return unwrapped instanceof z.ZodObject ? unwrapped : undefined;
}

function unwrapModifiers(schema: z.ZodTypeAny): { schema: z.ZodTypeAny; optional: boolean } {
  let current = schema;
  let optional = false;
  for (;;) {
    if (current instanceof z.ZodOptional) { optional = true; current = current._def.innerType; continue; }
    if (current instanceof z.ZodDefault) { optional = true; current = current._def.innerType; continue; }
    if (current instanceof z.ZodNullable) { current = current._def.innerType; continue; }
    if (current instanceof z.ZodEffects) { current = current._def.schema; continue; }
    if (current instanceof z.ZodPipeline) { current = current._def.in; continue; }
    return { schema: current, optional };
  }
}

function describeFieldType(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return describeFieldType(schema._def.innerType);
  if (schema instanceof z.ZodNullable) return `${describeFieldType(schema._def.innerType)} | null`;
  if (schema instanceof z.ZodEffects) return describeFieldType(schema._def.schema);
  if (schema instanceof z.ZodPipeline) return describeFieldType(schema._def.in);
  if (schema instanceof z.ZodNumber) {
    const checks = schema._def.checks;
    const parts: string[] = [];
    for (const check of checks) {
      if (check.kind === "min") parts.push(`${check.inclusive ? ">=" : ">"} ${check.value}`);
      if (check.kind === "max") parts.push(`${check.inclusive ? "<=" : "<"} ${check.value}`);
    }
    return `${checks.some((check) => check.kind === "int") ? "integer" : "number"}${parts.length ? ` ${parts.join(", ")}` : ""}`;
  }
  if (schema instanceof z.ZodString) {
    const checks = schema._def.checks;
    if (checks.some((check) => check.kind === "uuid")) return "string (uuid)";
    if (checks.some((check) => check.kind === "datetime")) return "string (ISO datetime)";
    if (checks.some((check) => check.kind === "date")) return "string (ISO date)";
    const minimum = checks.find((check): check is Extract<z.ZodStringCheck, { kind: "min" }> => check.kind === "min");
    return `string${minimum && minimum.value > 0 ? " (non-empty)" : ""}`;
  }
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodEnum) return schema._def.values.map((value: string) => JSON.stringify(value)).join(" | ");
  if (schema instanceof z.ZodLiteral) return JSON.stringify(schema._def.value);
  if (schema instanceof z.ZodArray) return `array of ${describeFieldType(schema._def.type)}`;
  if (schema instanceof z.ZodRecord) return `Record<string, ${describeFieldType(schema._def.valueType)}>`;
  if (schema instanceof z.ZodUnion) return schema._def.options.map((option: z.ZodTypeAny) => describeFieldType(option)).join(" | ");
  if (schema instanceof z.ZodObject) return "object";
  if (schema instanceof z.ZodTuple) return "tuple";
  return "unknown";
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition<unknown, unknown>>();
  constructor(definitions: SkillDefinition<unknown, unknown>[] = defaultSkills) { for (const skill of definitions) this.register(skill); }
  register(skill: SkillDefinition<unknown, unknown>): void { if (this.skills.has(skill.name)) throw new Error(`duplicate skill: ${skill.name}`); this.skills.set(skill.name, skill); }
  list(): SkillDefinition<unknown, unknown>[] { return [...this.skills.values()]; }
  get(name: string): SkillDefinition<unknown, unknown> { const skill = this.skills.get(name); if (!skill) throw new Error(`unknown skill: ${name}`); return skill; }

  /**
   * Validates both ends of a skill and appends the outcome to the audit chain,
   * so pure-function skills leave the same tamper-evident trail as tool calls.
   */
  async execute(name: string, context: ToolContext, input: unknown, tools: AdPilotTools): Promise<unknown> {
    const skill = this.get(name);
    let parsed: unknown;
    try {
      parsed = skill.input.parse(input);
    } catch (error) {
      await tools.audit.append({
        clientId: context.clientId, taskId: context.taskId, actor: context.actor,
        action: "execute_skill", status: "denied",
        details: { skill: name, reason: `input contract rejected: ${errorMessage(error)}` }
      });
      throw error;
    }
    const inputHash = fingerprint(parsed);
    let output: unknown;
    try {
      output = skill.output.parse(await skill.execute(context, parsed, tools));
    } catch (error) {
      await tools.audit.append({
        clientId: context.clientId, taskId: context.taskId, actor: context.actor,
        action: "execute_skill", status: "failed",
        details: { skill: name, inputHash, reason: errorMessage(error) }
      });
      throw error;
    }
    await tools.audit.append({
      clientId: context.clientId, taskId: context.taskId, actor: context.actor,
      action: "execute_skill", status: "succeeded",
      details: { skill: name, inputHash, outputHash: fingerprint(output) }
    });
    return output;
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export const defaultSkills: SkillDefinition<unknown, unknown>[] = [
  checkConversionReliability as SkillDefinition<unknown, unknown>,
  changeSkill("evaluate-budget-change", "budget") as SkillDefinition<unknown, unknown>,
  changeSkill("evaluate-bid-change", "bid") as SkillDefinition<unknown, unknown>,
  detectCreativeFatigueSkill as SkillDefinition<unknown, unknown>,
  assessCampaignLaunch as SkillDefinition<unknown, unknown>,
  createExperiment as SkillDefinition<unknown, unknown>,
  generateReport as SkillDefinition<unknown, unknown>,
  reviewAttribution as SkillDefinition<unknown, unknown>,
  dailyReport as SkillDefinition<unknown, unknown>,
  weeklyReport as SkillDefinition<unknown, unknown>,
  accountAudit as SkillDefinition<unknown, unknown>
];
