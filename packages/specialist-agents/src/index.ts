import { z } from "zod";
import { PiAgentRuntime } from "@adpilot/runtime";
import { SpecialistRole, type SpecialistRole as Role } from "@adpilot/shared";
import { CampaignMetrics, ChangeGuardrailInput } from "@adpilot/advertising-core";
import { type AdPilotTools, type ToolContext } from "@adpilot/tools";
import { VisualAction, type VisualMicroTask } from "@adpilot/computer-use";

export interface SpecialistRequest<I = unknown> {
  context: ToolContext;
  input: I;
  sharedFacts: Record<string, unknown>;
}

export interface SpecialistAgent<I = unknown, O = unknown> {
  readonly role: Role;
  readonly inputSchema: z.ZodType<I, z.ZodTypeDef, any>;
  readonly outputSchema: z.ZodType<O, z.ZodTypeDef, any>;
  execute(request: SpecialistRequest<I>): Promise<O>;
}

const EvidenceFinding = z.object({ finding: z.string().min(1), evidence: z.array(z.string()).default([]), confidence: z.number().min(0).max(1) });

const AccountOperatorInput = z.object({ visualTask: z.custom<VisualMicroTask>() });
const AccountOperatorOutput = z.object({ status: z.enum(["done", "blocked"]), attempts: z.number().int().nonnegative(), action: VisualAction.optional(), evidence: z.array(z.string()), blocker: z.string().optional() });
export class AccountOperator implements SpecialistAgent<z.infer<typeof AccountOperatorInput>, z.infer<typeof AccountOperatorOutput>> {
  readonly role = "account_operator" as const;
  readonly inputSchema = AccountOperatorInput;
  readonly outputSchema = AccountOperatorOutput;
  constructor(private readonly tools: AdPilotTools) {}
  async execute(request: SpecialistRequest<z.infer<typeof AccountOperatorInput>>) {
    const input = this.inputSchema.parse(request.input);
    const result = await this.tools.executeVisualTask(request.context, input.visualTask);
    return this.outputSchema.parse(result.status === "done"
      ? { status: "done", attempts: result.attempts, action: result.action, evidence: [result.before.sha256, result.after.sha256] }
      : { status: "blocked", attempts: result.attempts, evidence: [], blocker: result.blocker });
  }
}

abstract class PiSpecialist<I, O> implements SpecialistAgent<I, O> {
  abstract readonly role: Role;
  abstract readonly inputSchema: z.ZodType<I, z.ZodTypeDef, any>;
  abstract readonly outputSchema: z.ZodType<O, z.ZodTypeDef, any>;
  abstract readonly allowedSkills: string[];
  abstract readonly mission: string;
  constructor(protected readonly runtime: PiAgentRuntime) {}
  async execute(request: SpecialistRequest<I>): Promise<O> {
    const input = this.inputSchema.parse(request.input);
    return this.runtime.runStructured({
      context: { ...request.context, actor: this.role, sessionId: crypto.randomUUID(), role: this.role },
      systemPrompt: [
        `You are the isolated ${this.role} specialist inside AdPilot.`,
        this.mission,
        "Use only the supplied shared facts and tool results. Do not assume access to other specialists' transcripts.",
        "Separate observed facts, deterministic calculations, and inference."
      ].join("\n"),
      prompt: JSON.stringify({ input, sharedFacts: request.sharedFacts }),
      signals: { task: this.role === "risk_reviewer" ? "risk_review" : "causal_analysis" },
      allowedSkills: this.allowedSkills
    }, this.outputSchema);
  }
}

const PerformanceInput = z.object({ metrics: CampaignMetrics, target: z.number().positive(), objective: z.string().min(1) });
const PerformanceOutput = z.object({ calculated: z.object({ cpi: z.number().nullable(), cpa: z.number().nullable(), roas: z.number().nullable() }), findings: z.array(EvidenceFinding), maturity: z.enum(["mature", "immature"]), confidence: z.number().min(0).max(1) });
export class PerformanceAnalyst extends PiSpecialist<z.infer<typeof PerformanceInput>, z.infer<typeof PerformanceOutput>> {
  readonly role = "performance_analyst" as const; readonly inputSchema = PerformanceInput; readonly outputSchema = PerformanceOutput;
  readonly allowedSkills = ["check-conversion-reliability"]; readonly mission = "Analyze spend, CPI, CPA, ROAS, funnel, campaign and geo performance. Never fabricate a metric.";
}

const MediaBuyerInput = z.object({ change: ChangeGuardrailInput, objective: z.string().min(1), businessBoundary: z.string().min(1) });
const MediaBuyerOutput = z.object({ recommendation: z.enum(["increase", "decrease", "pause", "launch", "observe", "no_change"]), currentValue: z.number(), proposedValue: z.number(), stagedValue: z.number(), rationale: z.array(z.string()), requiresApproval: z.boolean(), observationWindow: z.string(), rollbackCondition: z.string() });
export class MediaBuyer extends PiSpecialist<z.infer<typeof MediaBuyerInput>, z.infer<typeof MediaBuyerOutput>> {
  readonly role = "media_buyer" as const; readonly inputSchema = MediaBuyerInput; readonly outputSchema = MediaBuyerOutput;
  readonly allowedSkills = ["evaluate-budget-change", "evaluate-bid-change", "create-single-variable-experiment"]; readonly mission = "Make explicit budget, bid, pause, launch, or observe recommendations while respecting deterministic caps and single-variable tests.";
}

const MeasurementInput = z.object({ metrics: CampaignMetrics, platformConversions: z.number().nonnegative(), sourceConversions: z.number().nonnegative(), duplicatedEvents: z.number().int().nonnegative(), eventIdsPresent: z.boolean() });
const MeasurementOutput = z.object({ status: z.enum(["reliable", "warning", "blocked"]), findings: z.array(EvidenceFinding), safeToOptimize: z.boolean(), requiredFixes: z.array(z.string()) });
export class MeasurementReviewer extends PiSpecialist<z.infer<typeof MeasurementInput>, z.infer<typeof MeasurementOutput>> {
  readonly role = "measurement_reviewer" as const; readonly inputSchema = MeasurementInput; readonly outputSchema = MeasurementOutput;
  readonly allowedSkills = ["check-conversion-reliability", "review-attribution-consistency"]; readonly mission = "Review conversion events, attribution, analytics, MMP, payment data, deduplication, and signal trustworthiness before optimization.";
}

const CreativeInput = z.object({ currentCtr: z.number().nonnegative(), priorCtr: z.number().positive(), frequency: z.number().nonnegative(), daysRunning: z.number().int().positive(), spendShare: z.number().min(0).max(1), message: z.string(), format: z.string() });
const CreativeOutput = z.object({ fatigued: z.boolean(), findings: z.array(EvidenceFinding), testDirections: z.array(z.object({ hypothesis: z.string(), variable: z.string(), concept: z.string() })), nextReviewDays: z.number().int().positive() });
export class CreativeStrategist extends PiSpecialist<z.infer<typeof CreativeInput>, z.infer<typeof CreativeOutput>> {
  readonly role = "creative_strategist" as const; readonly inputSchema = CreativeInput; readonly outputSchema = CreativeOutput;
  readonly allowedSkills = ["detect-creative-fatigue"]; readonly mission = "Analyze creative angle, fatigue and performance, then propose single-variable creative tests.";
}

const RiskInput = z.object({ approvalId: z.string().uuid(), guardrailAllowed: z.boolean(), guardrailReasons: z.array(z.string()), evidenceCount: z.number().int().nonnegative(), hasBeforeScreenshot: z.boolean(), singleVariable: z.boolean(), rollbackDefined: z.boolean(), operationSummary: z.string().min(1) });
const RiskOutput = z.object({ approved: z.boolean(), reason: z.string().min(1), vetoes: z.array(z.string()), requiredChecks: z.array(z.string()) });
export class RiskReviewer extends PiSpecialist<z.infer<typeof RiskInput>, z.infer<typeof RiskOutput>> {
  readonly role = "risk_reviewer" as const; readonly inputSchema = RiskInput; readonly outputSchema = RiskOutput;
  readonly allowedSkills: string[] = []; readonly mission = "Independently review every real account mutation. You have veto power; safety and evidence outrank optimization upside.";
  constructor(runtime: PiAgentRuntime, private readonly tools: AdPilotTools) { super(runtime); }
  override async execute(request: SpecialistRequest<z.infer<typeof RiskInput>>) {
    const input = this.inputSchema.parse(request.input); const vetoes: string[] = [];
    if (!input.guardrailAllowed) vetoes.push(...input.guardrailReasons.length ? input.guardrailReasons : ["deterministic guardrail denied the operation"]);
    if (input.evidenceCount < 1) vetoes.push("no evidence is attached");
    if (!input.hasBeforeScreenshot) vetoes.push("before screenshot is missing");
    if (!input.singleVariable) vetoes.push("operation changes more than one variable");
    if (!input.rollbackDefined) vetoes.push("rollback condition is missing");
    const result = vetoes.length
      ? this.outputSchema.parse({ approved: false, reason: "Independent risk gates vetoed the operation.", vetoes, requiredChecks: [] })
      : await super.execute(request);
    await this.tools.approvals.recordRiskReview(request.context.clientId, input.approvalId, result.approved, result.reason);
    return result;
  }
}

export class SpecialistCoordinator {
  private readonly agents = new Map<Role, SpecialistAgent>();
  constructor(agents: SpecialistAgent[]) { for (const agent of agents) { if (this.agents.has(agent.role)) throw new Error(`duplicate specialist: ${agent.role}`); this.agents.set(agent.role, agent); } }
  list(): Role[] { return [...this.agents.keys()]; }
  async dispatch(roleInput: Role, request: SpecialistRequest): Promise<unknown> {
    const role = SpecialistRole.parse(roleInput); const agent = this.agents.get(role); if (!agent) throw new Error(`specialist unavailable: ${role}`);
    return agent.execute({ ...request, input: agent.inputSchema.parse(request.input) });
  }
}

export const specialistSchemas = { AccountOperatorInput, AccountOperatorOutput, PerformanceInput, PerformanceOutput, MediaBuyerInput, MediaBuyerOutput, MeasurementInput, MeasurementOutput, CreativeInput, CreativeOutput, RiskInput, RiskOutput };
