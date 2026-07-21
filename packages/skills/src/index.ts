import { z } from "zod";
import { type AdPilotTools, type ToolContext } from "@adpilot/tools";
import { CampaignMetrics, ChangeGuardrailInput } from "@adpilot/advertising-core";

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

const FatigueInput = z.object({ currentCtr: z.number().nonnegative(), priorCtr: z.number().positive(), frequency: z.number().nonnegative(), daysRunning: z.number().int().positive(), spendShare: z.number().min(0).max(1) });
const FatigueOutput = z.object({ fatigued: z.boolean(), ctrDeclinePercent: z.number(), reasons: z.array(z.string()), nextStep: z.string() });
const detectCreativeFatigue: SkillDefinition<z.input<typeof FatigueInput>, z.output<typeof FatigueOutput>> = {
  name: "detect-creative-fatigue", description: "Detect directional creative fatigue without conflating it with conversion tracking failures.",
  input: FatigueInput, output: FatigueOutput,
  prerequisites: ["Comparable current and prior windows", "Frequency and spend share"], requiredTools: [],
  failureConditions: ["Prior CTR is zero", "Windows are not comparable"], forbidden: ["Pausing solely from CTR", "Ignoring downstream CPA/ROAS"],
  execute: async (_context, raw) => {
    const input = FatigueInput.parse(raw);
    const decline = ((input.priorCtr - input.currentCtr) / input.priorCtr) * 100;
    const reasons = [decline >= 25 ? "CTR declined at least 25%" : "CTR decline below 25%", input.frequency >= 3 ? "frequency is elevated" : "frequency is not elevated"];
    const fatigued = decline >= 25 && input.frequency >= 3 && input.daysRunning >= 7;
    return FatigueOutput.parse({ fatigued, ctrDeclinePercent: decline, reasons, nextStep: fatigued ? "Design a single-variable creative replacement test" : "Continue observation" });
  }
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

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition<unknown, unknown>>();
  constructor(definitions: SkillDefinition<unknown, unknown>[] = defaultSkills) { for (const skill of definitions) this.register(skill); }
  register(skill: SkillDefinition<unknown, unknown>): void { if (this.skills.has(skill.name)) throw new Error(`duplicate skill: ${skill.name}`); this.skills.set(skill.name, skill); }
  list(): SkillDefinition<unknown, unknown>[] { return [...this.skills.values()]; }
  get(name: string): SkillDefinition<unknown, unknown> { const skill = this.skills.get(name); if (!skill) throw new Error(`unknown skill: ${name}`); return skill; }
  async execute(name: string, context: ToolContext, input: unknown, tools: AdPilotTools): Promise<unknown> { const skill = this.get(name); return skill.output.parse(await skill.execute(context, skill.input.parse(input), tools)); }
}

export const defaultSkills: SkillDefinition<unknown, unknown>[] = [
  checkConversionReliability as SkillDefinition<unknown, unknown>,
  changeSkill("evaluate-budget-change", "budget") as SkillDefinition<unknown, unknown>,
  changeSkill("evaluate-bid-change", "bid") as SkillDefinition<unknown, unknown>,
  detectCreativeFatigue as SkillDefinition<unknown, unknown>,
  assessCampaignLaunch as SkillDefinition<unknown, unknown>,
  createExperiment as SkillDefinition<unknown, unknown>,
  generateReport as SkillDefinition<unknown, unknown>,
  reviewAttribution as SkillDefinition<unknown, unknown>
];
