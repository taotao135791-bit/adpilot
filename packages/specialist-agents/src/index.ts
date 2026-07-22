import { z } from "zod";
import type { RuntimeRequest, RuntimeResult, StructuredRuntimeResult } from "@adpilot/runtime";
import {
  SharedFact as SharedFactSchema,
  SpecialistRole,
  type SharedFact,
  type SpecialistRole as Role
} from "@adpilot/shared";
import { ChangeGuardrailInput, CreativeFatigueInput, ObservedCampaignMetrics } from "@adpilot/advertising-core";
import { VisualTableReadToolInput, type AdPilotTools, type ToolContext } from "@adpilot/tools";
import { VisualAction, type VisualMicroTask } from "@adpilot/computer-use";
import { VisualTableReadResult } from "@adpilot/visual-table-reader";

export interface SpecialistRequest<I = unknown> {
  context: ToolContext;
  input: I;
  /** Canonical facts only. Legacy objects must go through the migration API. */
  sharedFacts: readonly SharedFact[];
}

export interface SpecialistAgent<I = unknown, O = unknown> {
  readonly role: Role;
  readonly inputSchema: z.ZodType<I, z.ZodTypeDef, any>;
  readonly outputSchema: z.ZodType<O, z.ZodTypeDef, any>;
  execute(request: SpecialistRequest<I>): Promise<O>;
}

export interface SpecialistRuntime {
  run(request: RuntimeRequest): Promise<RuntimeResult>;
  runStructuredDetailed?<S extends z.ZodTypeAny>(request: RuntimeRequest, schema: S): Promise<StructuredRuntimeResult<S>>;
}

export interface SpecialistSessionState {
  key: string;
  sessionId: string;
  taskId: string;
  role: Role;
  messages: RuntimeResult["messages"];
  createdAt: string;
  updatedAt: string;
}

/** Persistence seam for a root-owned durable specialist runtime. */
export interface SpecialistSessionRepository {
  load(key: string): Promise<SpecialistSessionState | undefined>;
  save(state: SpecialistSessionState): Promise<void>;
}

export class InMemorySpecialistSessionRepository implements SpecialistSessionRepository {
  private readonly sessions = new Map<string, SpecialistSessionState>();

  async load(key: string): Promise<SpecialistSessionState | undefined> {
    const state = this.sessions.get(key);
    return state ? structuredClone(state) : undefined;
  }

  async save(state: SpecialistSessionState): Promise<void> {
    this.sessions.set(state.key, structuredClone(state));
  }
}

export function specialistSessionKey(taskId: string, roleInput: Role): string {
  const normalizedTaskId = z.string().uuid().parse(taskId);
  const role = SpecialistRole.parse(roleInput);
  return `specialist-${normalizedTaskId}-${role}`;
}

export interface SharedFactSelection {
  clientId: string;
  taskId: string;
  role: Role;
  now?: Date;
}

/**
 * Produces the bounded production packet visible to one specialist. Only
 * independently verified, unexpired, same-client and same-task facts pass.
 */
export function selectSharedFactsForSpecialist(
  input: readonly SharedFact[],
  selection: SharedFactSelection
): SharedFact[] {
  const clientId = z.string().min(1).parse(selection.clientId);
  const taskId = z.string().uuid().parse(selection.taskId);
  SpecialistRole.parse(selection.role);
  const now = selection.now ?? new Date();
  const seen = new Set<string>();
  const selected: SharedFact[] = [];
  for (const rawFact of z.array(SharedFactSchema).parse(input)) {
    const fact = SharedFactSchema.parse(rawFact);
    if (seen.has(fact.factId)) throw new Error(`duplicate shared fact: ${fact.factId}`);
    seen.add(fact.factId);
    if (fact.clientId !== clientId || fact.taskId !== taskId) continue;
    if (fact.expiresAt && Date.parse(fact.expiresAt) <= now.getTime()) continue;
    if (fact.status !== "verified" || fact.sourceType === "migration") continue;
    selected.push(fact);
  }
  return selected.map((fact) => ({ ...fact, value: structuredClone(fact.value) }));
}

const EvidenceFinding = z.object({ finding: z.string().min(1), evidence: z.array(z.string()).default([]), confidence: z.number().min(0).max(1) });

const AccountOperatorInput = z.union([
  z.object({ visualTask: z.custom<VisualMicroTask>() }).strict(),
  z.object({ visualTable: VisualTableReadToolInput }).strict()
]);
const VisualActionOutput = z.object({ status: z.enum(["done", "blocked"]), attempts: z.number().int().nonnegative(), action: VisualAction.optional(), evidence: z.array(z.string()), blocker: z.string().optional() });
const AccountOperatorOutput = z.union([VisualActionOutput, VisualTableReadResult]);
export class AccountOperator implements SpecialistAgent<z.infer<typeof AccountOperatorInput>, z.infer<typeof AccountOperatorOutput>> {
  readonly role = "account_operator" as const;
  readonly inputSchema = AccountOperatorInput;
  readonly outputSchema = AccountOperatorOutput;
  constructor(private readonly tools: AdPilotTools) {}
  async execute(request: SpecialistRequest<z.infer<typeof AccountOperatorInput>>) {
    const input = this.inputSchema.parse(request.input);
    if ("visualTable" in input) {
      return this.outputSchema.parse(await this.tools.readVisualTable(request.context, input.visualTable));
    }
    if (request.context.actor === "adpilot_agent" && input.visualTask.permission === "INTERACT") {
      const allowed = input.visualTask.allowedActions;
      if (input.visualTask.riskLevel !== "interact" || input.visualTask.retryPolicy !== "none"
        || !allowed?.includes("type") || allowed.some((action) => action !== "type" && action !== "done" && action !== "fail")) {
        throw new Error("conversational account interaction must be a one-attempt, type-only preparation step");
      }
    }
    const result = await this.tools.executeVisualTask(request.context, input.visualTask);
    return this.outputSchema.parse(result.status === "done"
      ? { status: "done", attempts: result.attempts, action: result.action, evidence: [`screenshot:${result.before.sha256}`, `screenshot:${result.after.sha256}`] }
      : { status: "blocked", attempts: result.attempts, evidence: [], blocker: result.blocker });
  }
}

abstract class PiSpecialist<I, O> implements SpecialistAgent<I, O> {
  abstract readonly role: Role;
  abstract readonly inputSchema: z.ZodType<I, z.ZodTypeDef, any>;
  abstract readonly outputSchema: z.ZodType<O, z.ZodTypeDef, any>;
  abstract readonly allowedSkills: string[];
  abstract readonly mission: string;
  constructor(
    protected readonly runtime: SpecialistRuntime,
    private readonly sessions: SpecialistSessionRepository = new InMemorySpecialistSessionRepository()
  ) {}
  protected routingTask(): RuntimeRequest["signals"]["task"] {
    return this.role === "risk_reviewer" ? "risk_review" : "causal_analysis";
  }
  async execute(request: SpecialistRequest<I>): Promise<O> {
    const input = this.inputSchema.parse(request.input);
    const key = specialistSessionKey(request.context.taskId, this.role);
    const previous = await this.sessions.load(key);
    if (previous && (previous.taskId !== request.context.taskId || previous.role !== this.role)) {
      throw new Error(`specialist session identity mismatch: ${key}`);
    }
    const sharedFacts = selectSharedFactsForSpecialist(request.sharedFacts, {
      clientId: request.context.clientId,
      taskId: request.context.taskId,
      role: this.role
    });
    assertSpecialistNumericFacts(this.role, input, sharedFacts);
    const runtimeRequest: RuntimeRequest = {
      context: { ...request.context, actor: this.role, sessionId: previous?.sessionId ?? key, role: this.role },
      systemPrompt: [
        `You are the isolated ${this.role} specialist inside AdPilot.`,
        this.mission,
        "Use only the supplied verified shared facts and tool results. Do not assume access to other specialists' transcripts.",
        "Never use hypothesis, observed, stale, rejected, superseded, expired, or migration facts for a definite recommendation.",
        "Separate observed facts, deterministic calculations, and inference.",
        "Return the final answer as one JSON object matching the requested specialist output. Do not wrap it in markdown."
      ].join("\n"),
      prompt: JSON.stringify({ input, sharedFacts }),
      signals: { task: this.routingTask() },
      allowedSkills: this.allowedSkills,
      ...(previous ? { priorMessages: previous.messages } : {})
    };
    const structured = this.runtime.runStructuredDetailed
      ? await this.runtime.runStructuredDetailed(runtimeRequest, this.outputSchema)
      : undefined;
    const result = structured?.runtime ?? await this.runtime.run(runtimeRequest);
    const output = structured?.output ?? this.outputSchema.parse(parseJsonObject(result.text));
    const now = new Date().toISOString();
    await this.sessions.save({
      key,
      sessionId: previous?.sessionId ?? key,
      taskId: request.context.taskId,
      role: this.role,
      messages: result.messages,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    });
    return output;
  }
}

const FactBindings = z.record(z.string().min(1)).default({});

const PerformanceInput = z.object({
  metrics: ObservedCampaignMetrics,
  target: z.number().positive(),
  objective: z.string().min(1),
  factIds: FactBindings
}).strict();
const PerformanceOutput = z.object({ calculated: z.object({ cpi: z.number().nullable(), cpa: z.number().nullable(), roas: z.number().nullable() }), findings: z.array(EvidenceFinding), maturity: z.enum(["mature", "immature"]), confidence: z.number().min(0).max(1) });
export class PerformanceAnalyst extends PiSpecialist<z.infer<typeof PerformanceInput>, z.infer<typeof PerformanceOutput>> {
  readonly role = "performance_analyst" as const; readonly inputSchema = PerformanceInput; readonly outputSchema = PerformanceOutput;
  readonly allowedSkills = ["check-conversion-reliability"]; readonly mission = "Analyze spend, CPI, CPA, ROAS, funnel, campaign and geo performance. Never fabricate a metric.";
}

const MediaBuyerInput = z.object({
  change: ChangeGuardrailInput,
  objective: z.string().min(1),
  businessBoundary: z.string().min(1),
  factIds: FactBindings
}).strict();
const MediaBuyerOutput = z.object({ recommendation: z.enum(["increase", "decrease", "pause", "launch", "observe", "no_change"]), currentValue: z.number(), proposedValue: z.number(), stagedValue: z.number(), rationale: z.array(z.string()), requiresApproval: z.boolean(), observationWindow: z.string(), rollbackCondition: z.string() });
export class MediaBuyer extends PiSpecialist<z.infer<typeof MediaBuyerInput>, z.infer<typeof MediaBuyerOutput>> {
  readonly role = "media_buyer" as const; readonly inputSchema = MediaBuyerInput; readonly outputSchema = MediaBuyerOutput;
  readonly allowedSkills = ["evaluate-budget-change", "evaluate-bid-change", "create-single-variable-experiment", "assess-campaign-launch"]; readonly mission = "Make explicit budget, bid, pause, launch, or observe recommendations while respecting deterministic caps and single-variable tests.";
}

const MeasurementInput = z.object({
  metrics: ObservedCampaignMetrics,
  platformConversions: z.number().nonnegative(),
  sourceConversions: z.number().nonnegative(),
  duplicatedEvents: z.number().int().nonnegative(),
  eventIdsPresent: z.boolean(),
  factIds: FactBindings
}).strict();
const MeasurementOutput = z.object({ status: z.enum(["reliable", "warning", "blocked"]), findings: z.array(EvidenceFinding), safeToOptimize: z.boolean(), requiredFixes: z.array(z.string()) });
export class MeasurementReviewer extends PiSpecialist<z.infer<typeof MeasurementInput>, z.infer<typeof MeasurementOutput>> {
  readonly role = "measurement_reviewer" as const; readonly inputSchema = MeasurementInput; readonly outputSchema = MeasurementOutput;
  readonly allowedSkills = ["check-conversion-reliability", "review-attribution-consistency"]; readonly mission = "Review conversion events, attribution, analytics, MMP, payment data, deduplication, and signal trustworthiness before optimization.";
}

const CreativeInput = CreativeFatigueInput.extend({ message: z.string(), format: z.string() });
const CreativeOutput = z.object({ fatigued: z.boolean(), findings: z.array(EvidenceFinding), testDirections: z.array(z.object({ hypothesis: z.string(), variable: z.string(), concept: z.string() })), nextReviewDays: z.number().int().positive() });
export class CreativeStrategist extends PiSpecialist<z.infer<typeof CreativeInput>, z.infer<typeof CreativeOutput>> {
  readonly role = "creative_strategist" as const; readonly inputSchema = CreativeInput; readonly outputSchema = CreativeOutput;
  readonly allowedSkills = ["detect-creative-fatigue"]; readonly mission = "Analyze creative angle, fatigue and performance, then propose single-variable creative tests.";
}

const ReportType = z.enum(["daily", "weekly", "account_audit", "client"]);
const ReportingInput = z.object({
  reportType: ReportType,
  metrics: ObservedCampaignMetrics,
  priorMetrics: ObservedCampaignMetrics.optional(),
  target: z.number().positive().optional(),
  objective: z.string().min(1),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  timezone: z.string().min(1),
  currency: z.string().min(1),
  audience: z.enum(["internal", "client"]).default("client"),
  factIds: FactBindings
}).strict();
const ReportingOutput = z.object({
  reportType: ReportType,
  markdown: z.string().min(1),
  reliability: z.enum(["reliable", "warning", "blocked"]),
  findings: z.array(EvidenceFinding),
  confidence: z.number().min(0).max(1)
});
export class ReportingAnalyst extends PiSpecialist<z.infer<typeof ReportingInput>, z.infer<typeof ReportingOutput>> {
  readonly role = "reporting_analyst" as const; readonly inputSchema = ReportingInput; readonly outputSchema = ReportingOutput;
  readonly allowedSkills = ["daily-report", "weekly-report", "account-audit", "generate-client-report"];
  readonly mission = "Produce daily, weekly, account-audit, and client reports from verified facts and deterministic calculations. Observed facts, calculations, and inferences stay strictly separated; never fabricate a metric.";
  protected override routingTask(): RuntimeRequest["signals"]["task"] {
    return "report";
  }
}

const RiskInput = z.object({ approvalId: z.string().uuid(), guardrailAllowed: z.boolean(), guardrailReasons: z.array(z.string()), evidenceCount: z.number().int().nonnegative(), hasBeforeScreenshot: z.boolean(), executionPlanPresent: z.boolean(), singleVariable: z.boolean(), rollbackDefined: z.boolean(), operationSummary: z.string().min(1) });
const RiskOutput = z.object({ approved: z.boolean(), reason: z.string().min(1), vetoes: z.array(z.string()), requiredChecks: z.array(z.string()) });
export class RiskReviewer extends PiSpecialist<z.infer<typeof RiskInput>, z.infer<typeof RiskOutput>> {
  readonly role = "risk_reviewer" as const; readonly inputSchema = RiskInput; readonly outputSchema = RiskOutput;
  readonly allowedSkills: string[] = []; readonly mission = "Independently review every real account mutation. You have veto power; safety and evidence outrank optimization upside.";
  constructor(runtime: SpecialistRuntime, private readonly tools: AdPilotTools, sessions?: SpecialistSessionRepository) { super(runtime, sessions); }
  override async execute(request: SpecialistRequest<z.infer<typeof RiskInput>>) {
    const input = this.inputSchema.parse(request.input); const vetoes: string[] = [];
    if (!input.guardrailAllowed) vetoes.push(...input.guardrailReasons.length ? input.guardrailReasons : ["deterministic guardrail denied the operation"]);
    if (input.evidenceCount < 1) vetoes.push("no evidence is attached");
    if (!input.hasBeforeScreenshot) vetoes.push("before screenshot is missing");
    if (!input.executionPlanPresent) vetoes.push("visual execution plan is missing");
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
    const input = agent.inputSchema.parse(request.input);
    const sharedFacts = selectSharedFactsForSpecialist(request.sharedFacts, {
      clientId: request.context.clientId,
      taskId: request.context.taskId,
      role
    });
    assertSpecialistNumericFacts(role, input, sharedFacts);
    return agent.execute({ ...request, input, sharedFacts });
  }
}

export const specialistSchemas = { AccountOperatorInput, AccountOperatorOutput, PerformanceInput, PerformanceOutput, MediaBuyerInput, MediaBuyerOutput, MeasurementInput, MeasurementOutput, CreativeInput, CreativeOutput, RiskInput, RiskOutput, ReportingInput, ReportingOutput };

interface NumericFactClaim {
  path: string;
  value: number;
  predicates: ReadonlySet<string>;
  arrayIndex?: number;
}

/**
 * Deterministic production boundary for model-authored specialist input.
 * A prompt instruction is not sufficient: every account number must resolve to
 * fresh screenshot evidence for this exact client/task before Pi receives it.
 */
export function assertSpecialistNumericFacts(
  role: Role,
  input: unknown,
  sharedFacts: readonly SharedFact[]
): void {
  if (role !== "performance_analyst" && role !== "media_buyer" && role !== "measurement_reviewer" && role !== "reporting_analyst") return;
  const record = asRecord(input);
  const bindings = asRecord(record.factIds);
  const claims = numericClaims(role, record);
  const factsById = new Map(sharedFacts.map((fact) => [fact.factId, fact]));
  const boundSubjects = new Set<string>();

  for (const claim of claims) {
    const requestedFactId = bindings[claim.path];
    if (typeof requestedFactId !== "string") {
      throw new Error(`unverified numerical specialist input: ${claim.path}`);
    }
    const candidates = [factsById.get(requestedFactId)].filter((fact): fact is SharedFact => Boolean(fact));
    const matches = candidates.filter((fact) => factHasVisualProof(fact) && factMatchesClaim(fact, claim));
    if (matches.length !== 1) {
      throw new Error(`unverified numerical specialist input: ${claim.path}`);
    }
    boundSubjects.add(normalizePredicate(matches[0]!.subject));
  }
  if (boundSubjects.size > 1) {
    throw new Error("unverified numerical specialist input: bound facts span multiple Campaign subjects");
  }
}

function numericClaims(role: Role, input: Record<string, unknown>): NumericFactClaim[] {
  if (role === "media_buyer") {
    const change = asRecord(input.change);
    const currentValue = change.currentValue;
    if (typeof currentValue !== "number") return [];
    const kind = typeof change.kind === "string" ? normalizePredicate(change.kind) : "";
    const aliases = kind === "budget"
      ? ["daily_budget", "budget", "current_budget"]
      : kind === "bid"
        ? ["bid", "current_bid"]
        : kind === "target_cpa"
          ? ["target_cpa", "current_target_cpa"]
          : ["target_roas", "current_target_roas"];
    return [{ path: "change.currentValue", value: currentValue, predicates: new Set(aliases) }];
  }

  const claims = collectNumericClaims(input.metrics, "metrics");
  if (role === "reporting_analyst" && input.priorMetrics !== undefined) {
    claims.push(...collectNumericClaims(input.priorMetrics, "priorMetrics"));
  }
  if (role === "performance_analyst" || role === "reporting_analyst") {
    const target = input.target;
    if (typeof target === "number") {
      const objective = typeof input.objective === "string" ? normalizePredicate(input.objective) : "";
      claims.push({
        path: "target",
        value: target,
        predicates: new Set(["target", `${objective}_target`, `target_${objective}`].filter(Boolean))
      });
    }
    return claims;
  }

  for (const key of ["platformConversions", "sourceConversions", "duplicatedEvents"] as const) {
    const value = input[key];
    if (typeof value === "number") claims.push(claimForPath(key, value));
  }
  return claims;
}

function collectNumericClaims(value: unknown, path: string): NumericFactClaim[] {
  if (typeof value === "number") return [claimForPath(path, value)];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => typeof entry === "number"
      ? [{ ...claimForPath(`${path}.${index}`, entry), arrayIndex: index }]
      : collectNumericClaims(entry, `${path}.${index}`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, entry]) => collectNumericClaims(entry, `${path}.${key}`));
}

function claimForPath(path: string, value: number): NumericFactClaim {
  const parts = path.split(".");
  const leaf = parts.at(-1) ?? path;
  const parentLeaf = /^\d+$/.test(leaf) ? parts.at(-2) ?? leaf : leaf;
  const normalizedLeaf = normalizePredicate(parentLeaf);
  const normalizedPath = normalizePredicate(parts.filter((part) => !/^\d+$/.test(part)).join("_"));
  const aliases = new Set([normalizedLeaf, normalizedPath]);
  if (/^\d+$/.test(leaf)) aliases.add(`${normalizedLeaf}_${leaf}`);
  return { path, value, predicates: aliases };
}

function factHasVisualProof(fact: SharedFact): boolean {
  return Boolean(
    fact.status === "verified"
    && fact.sourceType !== "migration"
    && fact.sourceScreenshotId
    && fact.sourceBoundingBox
    && fact.evidenceIds.includes(`screenshot:${fact.sourceScreenshotId}`)
  );
}

function factMatchesClaim(fact: SharedFact, claim: NumericFactClaim): boolean {
  if (!claim.predicates.has(normalizePredicate(fact.predicate))) return false;
  if (typeof fact.value === "number") return Object.is(fact.value, claim.value);
  return claim.arrayIndex !== undefined
    && Array.isArray(fact.value)
    && Object.is(fact.value[claim.arrayIndex], claim.value);
}

function normalizePredicate(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("structured specialist output is not JSON");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
