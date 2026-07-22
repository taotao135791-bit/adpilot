import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { AuditLog } from "@adpilot/audit";
import {
  ApprovalExecutionPlan,
  ApprovalExperiment,
  ApprovalGuardrailRequest,
  ApprovalService,
  VisualAllowedRegion,
  VisualExecutionPlan,
  type Approval,
  type ApprovalOperation
} from "@adpilot/approvals";
import {
  CampaignMetrics,
  calculateMetrics,
  assessMaturity,
  reviewMeasurementReliability,
  evaluateChangeGuardrail,
  ChangeGuardrailInput
} from "@adpilot/advertising-core";
import { ExperimentStore, type Experiment } from "@adpilot/experiments";
import { WorkspaceStore } from "@adpilot/workspace";
import {
  BrowserSessionManager,
  DualVisualIdentityVerifier,
  defaultBrowserContentRoi,
  fingerprintSurface,
  ModelPrivacyDescriptor,
  ScreenshotMask,
  ScreenshotPrivacyMode,
  ScreenshotPrivacyPipeline,
  type BrowserSession,
  type ExpectedVisualIdentity,
  type Screenshot,
  type VisualMicroTask,
  type VisualStepResult,
  VisualComputerRuntime,
  VisualIdentityRegions,
  type VisualIdentityRegions as VisualIdentityRegionsType
} from "@adpilot/computer-use";
import { Platform, RiskLevel, SharedFactLedger, stableJson, type PermissionLevel, type SharedFact } from "@adpilot/shared";
import {
  VisualTableColumn,
  VisualTableReadResult,
  VisualTableReader,
  VisualTableScreenshot,
  type VisualTableImagePreparer,
  type VisualTableSurface
} from "@adpilot/visual-table-reader";

const ExecutionValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

/** Intent supplied by the agent; every native/visual field is bound by AdPilot. */
export const VisualApprovalPlanDraft = z.object({
  schemaVersion: z.literal(1).optional(),
  planId: z.string().uuid().optional(),
  platform: Platform,
  browserProfile: z.string().min(1).optional(),
  domain: z.string().min(1).nullable().optional(),
  allowedApplications: z.array(z.string().min(1)).min(1).optional(),
  allowedDomains: z.array(z.string().min(1)).min(1).optional(),
  accountName: z.string().min(1),
  accountId: z.string().min(1),
  campaignName: z.string().min(1),
  campaignId: z.string().min(1),
  pageType: z.string().min(1),
  operation: z.string().min(1),
  currentValue: ExecutionValue,
  proposedValue: ExecutionValue,
  instruction: z.string().min(1),
  target: z.string().min(1),
  expectedResult: z.string().min(1),
  allowedRegion: VisualAllowedRegion.optional(),
  riskLevel: RiskLevel,
  expiresAt: z.string().datetime().optional(),
  experiment: ApprovalExperiment
}).strict();
export type VisualApprovalPlanDraft = z.infer<typeof VisualApprovalPlanDraft>;

export const VisualApprovalPlanInput = z.union([ApprovalExecutionPlan, VisualApprovalPlanDraft]);
export type VisualApprovalPlanInput = z.infer<typeof VisualApprovalPlanInput>;

export const ApprovalGuardrailEvidence = z.object({
  measurementStatusFactId: z.string().min(1),
  maturityFactId: z.string().min(1),
  learningFactId: z.string().min(1)
}).strict();
export type ApprovalGuardrailEvidence = z.infer<typeof ApprovalGuardrailEvidence>;

/** Raw, screenshot-backed facts from ordinary campaign and measurement views. */
export const ApprovalGuardrailMetricEvidence = z.object({
  conversionsFactId: z.string().min(1),
  observationDaysFactId: z.string().min(1),
  learningStatusFactId: z.string().min(1),
  measurementStatusFactId: z.string().min(1).optional(),
  conversionDelayDaysFactId: z.string().min(1).optional(),
  dailyConversionFactIds: z.array(z.string().min(1)).default([]),
  currencyConsistencyFactId: z.string().min(1).optional(),
  missingValueRateFactId: z.string().min(1).optional(),
  reconciliationDifferenceFactId: z.string().min(1).optional()
}).strict();
export type ApprovalGuardrailMetricEvidence = z.infer<typeof ApprovalGuardrailMetricEvidence>;

export const ApprovalGuardrailEvidenceInput = z.union([
  ApprovalGuardrailEvidence,
  ApprovalGuardrailMetricEvidence
]);
export type ApprovalGuardrailEvidenceInput = z.infer<typeof ApprovalGuardrailEvidenceInput>;

const PersistedVisualIdentityRegions = z.object({
  planId: z.string().uuid(),
  fingerprintHash: z.string().length(64),
  evidenceRegions: VisualIdentityRegions
}).passthrough();

export interface ToolContext {
  clientId: string;
  taskId: string;
  actor: string;
  permission: PermissionLevel;
}

export const VisualTableRoi = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  coordinateSpace: z.literal("screenshot_pixels").default("screenshot_pixels")
}).strict();
export type VisualTableRoi = z.infer<typeof VisualTableRoi>;

export const VisualTableReadToolInput = z.object({
  platform: Platform,
  browserProfile: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  tableRoi: VisualTableRoi.optional(),
  targetColumns: z.array(VisualTableColumn).min(1),
  targetRows: z.array(z.string().min(1)).default([]),
  scrollDirection: z.enum(["none", "down", "right"]).default("none"),
  historicalOverlapRows: z.array(z.union([
    z.string().min(1),
    z.object({ rowKey: z.string().min(1), fingerprint: z.string().min(1).optional() }).strict()
  ])).default([]),
  pageScale: z.number().positive().default(1),
  factTtlMs: z.number().int().positive().default(15 * 60_000),
  maxPages: z.number().int().min(1).max(100).default(30),
  sensitiveRegions: z.array(ScreenshotMask).default([])
}).strict();
export type VisualTableReadToolInput = z.infer<typeof VisualTableReadToolInput>;

export interface VisualTableToolsRuntime {
  reader: VisualTableReader;
  screenshotPrivacy: ScreenshotPrivacyPipeline;
  readerModel: ModelPrivacyDescriptor;
  verifierModel: ModelPrivacyDescriptor;
  privacyMode: ScreenshotPrivacyMode;
}

export class AdPilotTools {
  constructor(
    readonly workspace: WorkspaceStore,
    readonly audit: AuditLog,
    readonly approvals: ApprovalService,
    readonly experiments: ExperimentStore,
    readonly computer?: VisualComputerRuntime,
    readonly visualIdentity?: DualVisualIdentityVerifier,
    readonly browserSessions?: BrowserSessionManager,
    readonly visualTables?: VisualTableToolsRuntime,
    readonly sharedFacts?: SharedFactLedger
  ) {}

  async readWorkspace(context: ToolContext) {
    const client = await this.workspace.readClient(context.clientId);
    await this.audit.append({ clientId: context.clientId, taskId: context.taskId, actor: context.actor, action: "read_workspace", status: "succeeded", details: {} });
    return client;
  }

  analyzePerformance(context: ToolContext, input: z.input<typeof CampaignMetrics>) {
    const metrics = CampaignMetrics.parse(input);
    const calculated = calculateMetrics(metrics);
    const maturity = assessMaturity(metrics);
    const reliability = reviewMeasurementReliability(metrics);
    void this.audit.append({ clientId: context.clientId, taskId: context.taskId, actor: context.actor, action: "analyze_performance", status: "succeeded", details: { calculated, maturity, reliability } });
    return { metrics, calculated, maturity, reliability };
  }

  evaluateChange(context: ToolContext, input: z.input<typeof ChangeGuardrailInput>) {
    const decision = evaluateChangeGuardrail(ChangeGuardrailInput.parse(input));
    void this.audit.append({ clientId: context.clientId, taskId: context.taskId, actor: context.actor, action: "evaluate_change_guardrail", status: decision.allowed ? "succeeded" : "denied", details: decision });
    return decision;
  }

  async createApproval(
    context: ToolContext,
    operation: ApprovalOperation,
    executionPlan?: VisualApprovalPlanInput,
    guardrailEvidence?: ApprovalGuardrailEvidenceInput
  ) {
    if (context.permission !== "OBSERVE" && context.permission !== "INTERACT" && context.permission !== "MUTATE" && context.permission !== "DESTRUCTIVE") throw new Error("invalid permission context");
    const boundPlan = executionPlan ? await this.bindApprovalPlan(context, operation, executionPlan) : undefined;
    const resolvedGuardrailEvidence = operation.riskLevel === "mutate" || operation.riskLevel === "destructive"
      ? await this.resolveApprovalGuardrailEvidence(context, operation, boundPlan, guardrailEvidence)
      : undefined;
    const guardrail = operation.riskLevel === "mutate" || operation.riskLevel === "destructive"
      ? await this.buildApprovalGuardrail(context, operation, boundPlan, resolvedGuardrailEvidence)
      : undefined;
    const approval = await this.approvals.create(context.clientId, context.taskId, operation, boundPlan, guardrail);
    await this.audit.append({
      clientId: context.clientId,
      taskId: context.taskId,
      actor: context.actor,
      action: "create_approval",
      status: "succeeded",
      details: {
        approvalId: approval.id,
        operation: approval.operation,
        planId: boundPlan?.planId,
        surfaceFingerprint: boundPlan?.surfaceFingerprint,
        accountFingerprint: boundPlan?.accountFingerprint,
        guardrailFingerprint: approval.guardrailFingerprint
      }
    });
    return approval;
  }

  /**
   * Revalidates the live fact ledger, workspace limits, and experiment state.
   * Approval records intentionally contain a snapshot; this check prevents a
   * stale or superseded snapshot from surviving until user approval/execution.
   */
  async validateApprovalGuardrail(clientId: string, approvalId: string, cancelOnFailure = true): Promise<Approval> {
    const approval = await this.approvals.get(clientId, approvalId);
    try {
      if (!approval.executionPlan || !approval.guardrail) throw new Error("approval has no live deterministic guardrail binding");
      if (!this.sharedFacts) throw new Error("canonical Shared Facts are unavailable for guardrail revalidation");
      const facts = await this.sharedFacts.list(clientId, { includeTerminal: true });
      const bound = new Set(approval.guardrail.evidenceFactIds);
      const locate = (predicate: string) => facts.find((fact) => bound.has(fact.factId) && fact.predicate === predicate);
      const evidence = ApprovalGuardrailEvidence.parse({
        measurementStatusFactId: locate("measurement_status")?.factId,
        maturityFactId: locate("campaign_mature")?.factId,
        learningFactId: locate("learning_phase")?.factId
      });
      if (new Set(Object.values(evidence)).size !== 3 || bound.size !== 3) {
        throw new Error("approval guardrail evidence set no longer matches its three bound facts");
      }
      const current = await this.buildApprovalGuardrail(
        { clientId, taskId: approval.taskId, actor: "guardrail_revalidator", permission: "OBSERVE" },
        approval.operation,
        approval.executionPlan,
        evidence
      );
      if (stableJson(current.input) !== stableJson(approval.guardrail.input)
        || current.singleVariable !== approval.guardrail.singleVariable
        || stableJson([...current.evidenceFactIds].sort()) !== stableJson([...approval.guardrail.evidenceFactIds].sort())) {
        throw new Error("live deterministic guardrail state changed after approval preparation");
      }
      const decision = evaluateChangeGuardrail(current.input);
      if (!decision.allowed || decision.requiresFreshReview || !current.singleVariable) {
        throw new Error("live deterministic guardrail no longer permits this operation");
      }
      return approval;
    } catch (error) {
      if (cancelOnFailure && ["pending_risk_review", "pending_user", "approved"].includes(approval.status)) {
        await this.approvals.cancel(clientId, approvalId);
      }
      await this.audit.append({
        clientId,
        taskId: approval.taskId,
        actor: "guardrail_revalidator",
        action: "revalidate_approval_guardrail",
        status: "denied",
        details: { approvalId, reason: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  }

  private async resolveApprovalGuardrailEvidence(
    context: ToolContext,
    operation: ApprovalOperation,
    plan: ApprovalExecutionPlan | undefined,
    evidenceInput: ApprovalGuardrailEvidenceInput | undefined
  ): Promise<ApprovalGuardrailEvidence> {
    const direct = ApprovalGuardrailEvidence.safeParse(evidenceInput);
    if (direct.success) return direct.data;
    if (!plan) throw new Error("a complete visual execution plan is required for deterministic guardrail derivation");
    if (!this.sharedFacts) throw new Error("canonical Shared Facts are required for deterministic guardrail derivation");
    const evidence = ApprovalGuardrailMetricEvidence.parse(evidenceInput);
    const facts = await this.sharedFacts.list(context.clientId, { taskId: context.taskId, includeTerminal: true });
    const metric = (id: string, predicates: readonly string[]) => requireVerifiedGuardrailFact(facts, id, predicates, plan, operation);
    const conversions = metric(evidence.conversionsFactId, ["conversions", "conversion_count"]);
    const days = metric(evidence.observationDaysFactId, ["observation_days", "date_range_days", "days"]);
    const learning = metric(evidence.learningStatusFactId, ["learning_phase", "bid_strategy_status", "campaign_status"]);
    const measurement = evidence.measurementStatusFactId
      ? metric(evidence.measurementStatusFactId, ["measurement_status", "conversion_tracking_status"])
      : undefined;
    const delay = evidence.conversionDelayDaysFactId
      ? metric(evidence.conversionDelayDaysFactId, ["conversion_delay_days"])
      : undefined;
    const daily = evidence.dailyConversionFactIds.map((id) => metric(id, ["daily_conversions", "conversions"]));
    const currency = evidence.currencyConsistencyFactId
      ? metric(evidence.currencyConsistencyFactId, ["currency_consistency"])
      : undefined;
    const missing = evidence.missingValueRateFactId
      ? metric(evidence.missingValueRateFactId, ["missing_value_rate"])
      : undefined;
    const reconciliation = evidence.reconciliationDifferenceFactId
      ? metric(evidence.reconciliationDifferenceFactId, ["reconciliation_difference"])
      : undefined;

    const metrics = CampaignMetrics.parse({
      spend: 0,
      conversions: nonnegativeFactNumber(conversions, "conversions"),
      days: positiveIntegerFactNumber(days, "observation days"),
      conversionDelayDays: delay ? nonnegativeFactNumber(delay, "conversion delay days") : 0,
      dailyConversions: daily.map((fact) => nonnegativeFactNumber(fact, "daily conversions")),
      currencyConsistency: currency ? ratioFactNumber(currency, "currency consistency") : 1,
      missingValueRate: missing ? ratioFactNumber(missing, "missing value rate") : 0,
      reconciliationDifference: reconciliation ? ratioFactNumber(reconciliation, "reconciliation difference") : 0
    });
    const maturityDecision = assessMaturity(metrics);
    const calculatedReliability = reviewMeasurementReliability(metrics);
    const visibleReliability = measurement ? parseVisibleMeasurementHealth(measurement.value) : undefined;
    const missingIntegrityEvidence = !currency || !missing || !reconciliation;
    const reliability = strictestMeasurementStatus(
      visibleReliability,
      calculatedReliability.status,
      missingIntegrityEvidence && !visibleReliability ? "warning" : undefined
    );
    const learningPhase = parseVisibleLearningStatus(learning.value);
    const sourceFacts = [conversions, days, learning, measurement, delay, ...daily, currency, missing, reconciliation]
      .filter((fact): fact is SharedFact => Boolean(fact));
    const measurementFact = await this.persistDerivedGuardrailFact(context, plan, "measurement_status", reliability, measurement ?? conversions, sourceFacts);
    const maturityFact = await this.persistDerivedGuardrailFact(context, plan, "campaign_mature", maturityDecision.mature, conversions, sourceFacts);
    const learningFact = await this.persistDerivedGuardrailFact(context, plan, "learning_phase", learningPhase, learning, sourceFacts);
    return ApprovalGuardrailEvidence.parse({
      measurementStatusFactId: measurementFact.factId,
      maturityFactId: maturityFact.factId,
      learningFactId: learningFact.factId
    });
  }

  private async persistDerivedGuardrailFact(
    context: ToolContext,
    plan: ApprovalExecutionPlan,
    predicate: "measurement_status" | "campaign_mature" | "learning_phase",
    value: string | boolean,
    primary: SharedFact,
    sources: readonly SharedFact[]
  ): Promise<SharedFact> {
    if (!this.sharedFacts || !primary.sourceScreenshotId || !primary.sourceBoundingBox) {
      throw new Error(`cannot derive ${predicate} without screenshot-backed source evidence`);
    }
    const ttlCeiling = Date.now() + 15 * 60_000;
    const expiresAt = new Date(Math.min(
      ttlCeiling,
      ...sources.map((fact) => fact.expiresAt ? Date.parse(fact.expiresAt) : ttlCeiling)
    )).toISOString();
    const observed = await this.sharedFacts.observe({
      clientId: context.clientId,
      taskId: context.taskId,
      subject: plan.campaignId,
      predicate,
      value,
      unit: typeof value === "boolean" ? "boolean" : "status",
      sourceType: "visual_verification",
      sourceScreenshotId: primary.sourceScreenshotId,
      sourceBoundingBox: primary.sourceBoundingBox,
      evidenceIds: [...new Set(sources.flatMap((fact) => [
        ...fact.evidenceIds,
        `fact:${fact.factId}`,
        ...(fact.sourceScreenshotId ? [`screenshot:${fact.sourceScreenshotId}`] : [])
      ]))],
      confidence: Math.min(...sources.map((fact) => fact.confidence)),
      createdBy: "deterministic_guardrail_derivation",
      expiresAt,
      derivedFromFactId: primary.factId
    });
    return this.sharedFacts.verify(context.clientId, observed.factId, {
      verifier: "deterministic_guardrail_evaluator",
      confidence: observed.confidence
    });
  }

  private async buildApprovalGuardrail(
    context: ToolContext,
    operation: ApprovalOperation,
    plan: ApprovalExecutionPlan | undefined,
    evidenceInput: ApprovalGuardrailEvidence | undefined
  ): Promise<ApprovalGuardrailRequest> {
    if (!plan) throw new Error("a complete visual execution plan is required for deterministic mutation guardrails");
    if (!this.sharedFacts) throw new Error("canonical Shared Facts are required for deterministic mutation guardrails");
    const evidence = ApprovalGuardrailEvidence.parse(evidenceInput);
    const facts = await this.sharedFacts.list(context.clientId, { includeTerminal: true });
    const measurement = requireVerifiedGuardrailFact(facts, evidence.measurementStatusFactId, ["measurement_status"], plan, operation);
    const maturity = requireVerifiedGuardrailFact(facts, evidence.maturityFactId, ["campaign_mature"], plan, operation);
    const learning = requireVerifiedGuardrailFact(facts, evidence.learningFactId, ["learning_phase"], plan, operation);
    for (const fact of [measurement, maturity, learning]) {
      assertLiveGuardrailLineage(fact, facts, plan, operation);
    }
    const measurementStatus = parseMeasurementStatus(measurement.value);
    const mature = parseVisibleBoolean(maturity.value, "mature", "not_mature");
    const learningPhase = parseVisibleBoolean(learning.value, "learning", "not_learning");
    if (typeof operation.currentValue !== "number" || typeof operation.proposedValue !== "number") {
      throw new Error("deterministic visual mutation guardrails require numeric current and proposed values");
    }
    const client = await this.workspace.readClient(context.clientId);
    if (client.constraints?.blockedOperations.includes(operation.operation)) throw new Error("operation is blocked by the client workspace");
    if (operation.riskLevel === "destructive" && !client.constraints?.allowDestructive) throw new Error("destructive operations are disabled for this client");
    const activeExperiments = (await this.experiments.list(context.clientId)).filter((item) => ["active", "waiting"].includes(item.status));
    const kind = guardrailKindFromOperation(operation.operation);
    return ApprovalGuardrailRequest.parse({
      input: {
        kind,
        currentValue: operation.currentValue,
        proposedValue: operation.proposedValue,
        maxChangePercent: Math.min(client.constraints?.maxBudgetChangePercent ?? 20, 20),
        activeExperimentVariables: activeExperiments.map((item) => item.variable),
        measurementStatus,
        mature,
        learning: learningPhase
      },
      evidenceFactIds: [measurement.factId, maturity.factId, learning.factId],
      singleVariable: activeExperiments.length === 0 && experimentVariableMatches(kind, plan.experiment.variable)
    });
  }

  /**
   * Creates the experiment ledger entry only when the bound approval exists in
   * this client and task and has actually been executed; anything else is
   * denied and audited, enforcing the declared single-variable contract.
   */
  async writeExperiment(context: ToolContext, input: Omit<Experiment, "id" | "status" | "finalConclusion" | "startedAt" | "completedAt" | "createdAt" | "updatedAt">) {
    const approval = await this.approvals.get(context.clientId, input.approvalId).catch(() => undefined);
    const denial = !approval
      ? "approval does not exist"
      : approval.taskId !== context.taskId
        ? "approval belongs to a different task"
        : approval.status !== "executed"
          ? `approval status is ${approval.status}, not executed`
          : undefined;
    if (denial) {
      const reason = `create-single-variable-experiment requires an executed approval: ${denial}`;
      await this.audit.append({ clientId: context.clientId, taskId: context.taskId, actor: context.actor, action: "write_experiment", status: "denied", details: { approvalId: input.approvalId, reason } });
      throw new Error(reason);
    }
    const experiment = await this.experiments.create(input);
    await this.audit.append({ clientId: context.clientId, taskId: context.taskId, actor: context.actor, action: "write_experiment", status: "succeeded", details: { experimentId: experiment.id, variable: experiment.variable } });
    return experiment;
  }

  /**
   * Reads a table from one strictly managed browser window. Complete captures
   * stay local; the reader and independent verifier receive separately audited
   * sanitized ROIs. Scrolling is a one-attempt, scroll-only Computer Use task.
   */
  async readVisualTable(context: ToolContext, rawInput: z.input<typeof VisualTableReadToolInput>): Promise<VisualTableReadResult> {
    if (!this.computer || !this.browserSessions || !this.visualTables) {
      throw new Error("managed visual table reading is unavailable");
    }
    const input = VisualTableReadToolInput.parse(rawInput);
    const permissionIssue = context.permission === "MUTATE" || context.permission === "DESTRUCTIVE"
      ? "visual table reading accepts only OBSERVE or INTERACT permission"
      : input.scrollDirection !== "none" && context.permission !== "INTERACT"
        ? "visual table scrolling requires explicit INTERACT permission"
        : undefined;
    if (permissionIssue) {
      await this.audit.append({
        clientId: context.clientId,
        taskId: context.taskId,
        actor: context.actor,
        action: "read_visual_table",
        status: "denied",
        details: { reason: permissionIssue, scrollDirection: input.scrollDirection, permission: context.permission }
      });
      throw new Error(permissionIssue);
    }
    const found = await this.browserSessions.get(context.clientId, input.browserProfile);
    if (!found) throw new Error("visual table reading requires a connected managed browser session");
    if (found.platform !== input.platform) throw new Error("visual table platform differs from the managed browser session");
    const session = await this.browserSessions.assertActive(context.clientId, found.browserProfile, input.platform);
    if (!session.processId || !session.windowId) throw new Error("managed browser session is missing process or window identity");
    const domain = (input.domain ?? platformDefaultDomain(input.platform))?.toLowerCase();
    if (!domain) throw new Error("visual table reading requires an exact platform domain");
    assertPlatformDomain(input.platform, domain, [domain]);

    const captureTask = await this.bindManagedTask(context, {
      clientId: context.clientId,
      taskId: context.taskId,
      platform: input.platform,
      instruction: "Capture the visible advertising table without changing the page",
      target: "visible advertising table",
      expectedResult: "the current table remains visible",
      riskLevel: "observe",
      permission: "OBSERVE",
      allowedActions: ["screenshot", "done", "fail"],
      retryPolicy: "none",
      surface: {
        app: session.browserApp,
        applicationId: session.browserApplicationId,
        processId: session.processId,
        windowId: session.windowId,
        browserProfile: session.browserProfile,
        domain,
        allowedApps: [session.browserApplicationId, session.browserApp],
        allowedDomains: [domain]
      }
    });
    await this.assertClientSurfaceBinding(context, captureTask);

    try {
      const firstNative = await this.computer.captureForTask(captureTask);
      assertTaskSurfaceExact(captureTask, firstNative);
      const tableRoi = resolveVisualTableRoi(input.tableRoi, firstNative);
      const tableTask: VisualMicroTask = { ...captureTask, allowedRegion: tableRoi };
      const nativeScreenshots = new Map<string, Screenshot>();
      let queuedAfterScroll: Screenshot | undefined;
      let scrollStep = 0;
      const register = (screenshot: Screenshot): VisualTableScreenshot => {
        assertTaskSurfaceExact(tableTask, screenshot);
        const screenshotId = crypto.randomUUID();
        nativeScreenshots.set(screenshotId, screenshot);
        return VisualTableScreenshot.parse({
          screenshotId,
          base64: screenshot.base64,
          width: screenshot.width,
          height: screenshot.height,
          sha256: screenshot.sha256,
          capturedAt: screenshot.capturedAt
        });
      };
      const capture = async (): Promise<VisualTableScreenshot> => {
        const screenshot = queuedAfterScroll ?? await this.computer!.captureForTask(tableTask);
        queuedAfterScroll = undefined;
        return register(screenshot);
      };
      const surface: VisualTableSurface = {
        capture,
        scroll: async (direction) => {
          const scrollTask: VisualMicroTask = {
            ...tableTask,
            stepId: `table-scroll-${++scrollStep}-${crypto.randomUUID()}`,
            instruction: `Scroll the visible advertising table ${direction} exactly once. Do not click, type, drag, or change filters.`,
            target: "visible advertising table body",
            expectedResult: `the next table ${direction === "down" ? "rows" : "columns"} are visible, or the table boundary is visibly reached`,
            riskLevel: "interact",
            permission: "INTERACT",
            allowedActions: ["scroll", "done", "fail"],
            allowedScrollDirections: [direction],
            retryPolicy: "none"
          };
          const result = await this.executeVisualTask(context, scrollTask);
          if (result.status === "failed") throw new Error(`visual table scroll failed: ${result.blocker}`);
          if (result.action.action === "done") return "end";
          if (result.action.action !== "scroll" || result.action.direction !== direction) {
            throw new Error(`visual table scroll returned an unexpected ${result.action.action} action`);
          }
          queuedAfterScroll = result.after;
          return "advanced";
        }
      };
      const imagePreparer: VisualTableImagePreparer = {
        prepare: async (request) => {
          const native = nativeScreenshots.get(request.screenshot.screenshotId);
          if (!native) throw new Error("visual table image is not linked to a managed native capture");
          const model = request.phase === "reader" ? this.visualTables!.readerModel : this.visualTables!.verifierModel;
          if (request.modelIdentity !== `${model.provider}/${model.modelId}`) {
            throw new Error(`visual table ${request.phase} model differs from its screenshot audit descriptor`);
          }
          const prepared = await this.visualTables!.screenshotPrivacy.prepareForModel({
            clientId: context.clientId,
            taskId: context.taskId,
            purpose: "table_read",
            callRole: request.phase === "reader" ? "table_reader" : "table_verifier",
            screenshot: native,
            roi: { x: tableRoi.x, y: tableRoi.y, width: tableRoi.width, height: tableRoi.height },
            sensitiveRegions: input.sensitiveRegions,
            requiredVisibleRegions: [{ x: tableRoi.x, y: tableRoi.y, width: tableRoi.width, height: tableRoi.height }],
            includeDefaultMasks: false,
            model,
            privacyMode: this.visualTables!.privacyMode,
            localFullRetentionPolicy: `local visual-table ${request.phase} evidence`
          });
          return {
            screenshotId: prepared.screenshotId,
            base64: prepared.screenshot.base64,
            width: prepared.screenshot.width,
            height: prepared.screenshot.height
          };
        }
      };
      const initial = register(firstNative);
      const result = await this.visualTables.reader.withRuntime({ surface, imagePreparer }).read({
        clientId: context.clientId,
        taskId: context.taskId,
        platform: input.platform,
        screenshot: initial,
        tableRoi: [tableRoi.x, tableRoi.y, tableRoi.width, tableRoi.height],
        targetColumns: input.targetColumns,
        targetRows: input.targetRows,
        scrollDirection: input.scrollDirection,
        historicalOverlapRows: input.historicalOverlapRows,
        pageScale: input.pageScale,
        dpr: firstNative.scaleFactor,
        factTtlMs: input.factTtlMs,
        maxPages: input.maxPages
      });
      await this.audit.append({
        clientId: context.clientId,
        taskId: context.taskId,
        actor: context.actor,
        action: "read_visual_table",
        status: result.status === "done" ? "succeeded" : "failed",
        details: {
          status: result.status,
          platform: input.platform,
          browserProfile: session.browserProfile,
          applicationId: session.browserApplicationId,
          windowId: session.windowId,
          tableRoi,
          tableRoiSource: input.tableRoi ? "explicit" : "browser_content_default",
          cells: result.cells.length,
          verifiedFacts: result.facts.filter((fact) => fact.status === "verified").map((fact) => fact.factId),
          screenshots: result.screenshots,
          checks: result.checks,
          ...(result.status === "blocked" ? { blocker: result.blocker } : {})
        }
      });
      return VisualTableReadResult.parse(result);
    } catch (error) {
      await this.audit.append({
        clientId: context.clientId,
        taskId: context.taskId,
        actor: context.actor,
        action: "read_visual_table",
        status: "failed",
        details: { reason: error instanceof Error ? error.message : String(error), platform: input.platform, tableRoi: input.tableRoi }
      });
      throw error;
    }
  }

  async executeVisualTask(context: ToolContext, task: VisualMicroTask, initialScreenshot?: Screenshot): Promise<VisualStepResult> {
    if (!this.computer) throw new Error("native computer runtime is unavailable");
    if (task.permission !== context.permission) throw new Error("visual task permission differs from tool context");
    const boundTask = await this.bindManagedTask(context, task);
    await this.assertClientSurfaceBinding(context, boundTask);
    const result = await this.computer.runMicroTask(
      boundTask,
      initialScreenshot,
      boundTask.allowedActions ? { allowedActions: boundTask.allowedActions } : undefined
    );
    if (result.status === "done") {
      await this.workspace.writeJson(context.clientId, `screenshots/${context.taskId}-${Date.now()}.json`, {
        task: {
          planId: boundTask.planId,
          target: boundTask.target,
          expectedResult: boundTask.expectedResult,
          riskLevel: boundTask.riskLevel,
          accountFingerprint: boundTask.accountFingerprint,
          allowedRegion: boundTask.allowedRegion
        },
        before: screenshotMetadata(result.before),
        after: screenshotMetadata(result.after)
      });
    }
    await this.audit.append({
      clientId: context.clientId, taskId: context.taskId, actor: context.actor,
      action: "execute_visual_task", status: result.status === "done" ? "succeeded" : "failed",
      details: {
        status: result.status,
        attempts: result.attempts,
        planId: boundTask.planId,
        accountFingerprint: boundTask.accountFingerprint,
        allowedRegion: boundTask.allowedRegion,
        ...(result.status === "failed" ? { blocker: result.blocker, blockerCode: result.blockerCode } : { action: result.action.action, beforeHash: result.before.sha256, afterHash: result.after.sha256 })
      }
    });
    return result;
  }

  async commitApprovedVisualAction(context: ToolContext, approvalId: string, token: string, operation: ApprovalOperation, task: VisualMicroTask): Promise<VisualStepResult> {
    if (context.permission !== "MUTATE" && context.permission !== "DESTRUCTIVE") throw new Error("commit requires mutation permission");
    await this.validateApprovalGuardrail(context.clientId, approvalId, true);
    const unfinished = (await this.experiments.list(context.clientId)).filter((item) => ["active", "waiting"].includes(item.status));
    if (unfinished.length > 0) throw new Error("an unfinished experiment blocks a new mutation");
    if (!this.computer) throw new Error("native computer runtime is unavailable");
    if (!this.visualIdentity) throw new Error("two independent visual identity reviewers are required for mutation");
    const boundTask = await this.bindManagedTask(context, task);
    let screenshot: Screenshot;
    let actualPlan: VisualExecutionPlan;
    try {
      screenshot = await this.computer.captureForTask(boundTask);
      if (!screenshot.surface) throw new Error("mutation preflight screenshot has no native window identity");
      const evidenceRegions = await this.loadPersistedIdentityRegions(context.clientId, boundTask.planId!);
      const expected = expectedIdentityFromTask(context, boundTask, screenshot, evidenceRegions);
      const confirmed = await this.visualIdentity.confirm(expected, screenshot);
      if (confirmed.fingerprintHash !== boundTask.accountFingerprint) {
        throw new Error("current visual account fingerprint differs from the approved task binding");
      }
      if (!boundTask.allowedRegion || !regionAgreementWithApprovedTarget(confirmed.targetRegion, boundTask.allowedRegion, screenshot.scaleFactor)) {
        throw new Error("current visual target moved outside the approved control region");
      }
      await this.workspace.writeJson(context.clientId, `identity/${context.taskId}-${Date.now()}.json`, {
        approvalId,
        planId: boundTask.planId,
        ...confirmed
      });
      actualPlan = actualExecutionPlanFromTask(context, boundTask, screenshot, confirmed.fingerprintHash);
      await this.audit.append({
        clientId: context.clientId,
        taskId: context.taskId,
        actor: context.actor,
        action: "verify_visual_mutation_identity",
        status: "succeeded",
        details: {
          approvalId,
          planId: actualPlan.planId,
          accountFingerprint: confirmed.fingerprintHash,
          reviewers: confirmed.reviewers,
          confidence: confirmed.fingerprint.confidence,
          screenshotHash: confirmed.fingerprint.screenshotHash,
          criticalRegionHashes: confirmed.fingerprint.criticalRegionHashes
        }
      });
    } catch (error) {
      await this.approvals.cancel(context.clientId, approvalId);
      await this.audit.append({
        clientId: context.clientId,
        taskId: context.taskId,
        actor: context.actor,
        action: "verify_visual_mutation_identity",
        status: "denied",
        details: { approvalId, reason: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
    const executing = await this.approvals.consume(context.clientId, approvalId, token, operation, actualPlan);
    try {
      const result = await this.executeVisualTask(context, boundTask, screenshot);
      if (result.status === "done" && executing.executionPlan) {
        const experiment = await this.experiments.create({
          ...executing.executionPlan.experiment,
          clientId: context.clientId,
          taskId: context.taskId,
          approvalId
        });
        await this.experiments.start(context.clientId, experiment.id);
      }
      await this.approvals.finish(context.clientId, approvalId, result.status === "done");
      return result;
    } catch (error) {
      await this.approvals.finish(context.clientId, approvalId, false);
      throw error;
    }
  }

  private async bindApprovalPlan(context: ToolContext, operation: ApprovalOperation, input: VisualApprovalPlanInput): Promise<ApprovalExecutionPlan> {
    if (!this.computer) throw new Error("a native computer runtime is required to bind an approval");
    if (!this.visualIdentity) throw new Error("two independent visual identity reviewers are required to bind an approval");
    const complete = ApprovalExecutionPlan.safeParse(input);
    const intent = complete.success ? complete.data : VisualApprovalPlanDraft.parse(input);
    const existingSession = this.browserSessions
      ? await this.browserSessions.get(context.clientId, intent.browserProfile)
      : undefined;
    if (this.browserSessions && !existingSession) throw new Error("a managed browser session is required before preparing an approval");
    const session = existingSession && this.browserSessions
      ? await this.browserSessions.assertActive(context.clientId, existingSession.browserProfile, intent.platform)
      : undefined;
    const browserProfile = session?.browserProfile ?? intent.browserProfile;
    const applicationName = session?.browserApp ?? (complete.success ? complete.data.applicationName : undefined);
    const applicationId = session?.browserApplicationId ?? (complete.success ? complete.data.applicationId : undefined);
    const windowId = session?.windowId ?? (complete.success ? complete.data.windowId : undefined);
    if (!browserProfile || !applicationName || !applicationId || !windowId) {
      throw new Error("live browser Profile, application, and window identity are required to bind an approval");
    }
    const domain = intent.domain ?? platformDefaultDomain(intent.platform);
    const allowedDomains = intent.allowedDomains ?? (domain ? [domain] : []);
    assertPlatformDomain(intent.platform, domain?.toLowerCase(), allowedDomains);
    const provisionalTask: VisualMicroTask = {
      clientId: context.clientId,
      taskId: context.taskId,
      planId: intent.planId ?? crypto.randomUUID(),
      platform: intent.platform,
      instruction: intent.instruction,
      target: intent.target,
      expectedResult: intent.expectedResult,
      riskLevel: intent.riskLevel,
      permission: "OBSERVE",
      ...(intent.allowedRegion ? { allowedRegion: intent.allowedRegion } : {}),
      identity: {
        accountName: intent.accountName,
        accountId: intent.accountId,
        campaignName: intent.campaignName,
        campaignId: intent.campaignId,
        pageType: intent.pageType,
        currency: (await this.workspace.readClient(context.clientId)).kpi.currency,
        currentValue: intent.currentValue,
        proposedValue: intent.proposedValue,
        operation: intent.operation
      },
      surface: {
        app: applicationName,
        applicationId,
        ...(session?.processId ? { processId: session.processId } : {}),
        windowId,
        browserProfile,
        ...(session?.nativeProfileFingerprint ? { nativeProfileFingerprint: session.nativeProfileFingerprint } : {}),
        ...(domain ? { domain } : {}),
        allowedApps: [...new Set([applicationId, applicationName])],
        allowedDomains
      }
    };
    const screenshot = await this.computer.captureForTask(provisionalTask);
    if (!screenshot.surface) throw new Error("approval screenshot has no native surface identity");
    const expected = expectedIdentityFromTask(context, provisionalTask, screenshot);
    const confirmed = await this.visualIdentity.confirm(expected, screenshot);
    const allowedRegion = deriveTargetAllowedRegion(confirmed.targetRegion, screenshot);
    if (intent.allowedRegion) assertRequestedRegionIsTight(intent.allowedRegion, allowedRegion, screenshot.scaleFactor);
    const createdAt = new Date().toISOString();
    const expiresAt = intent.expiresAt ?? new Date(Date.parse(createdAt) + 10 * 60_000).toISOString();
    const bound = ApprovalExecutionPlan.parse({
      schemaVersion: 1,
      planId: provisionalTask.planId,
      taskId: context.taskId,
      clientId: context.clientId,
      platform: intent.platform,
      browserProfile,
      applicationId: screenshot.surface.bundleId ?? screenshot.surface.app,
      applicationName: screenshot.surface.app,
      windowId: screenshot.surface.windowId,
      domain: domain ?? null,
      allowedApplications: [...new Set([screenshot.surface.bundleId ?? screenshot.surface.app, screenshot.surface.app])],
      allowedDomains,
      accountName: intent.accountName,
      accountId: intent.accountId,
      campaignName: intent.campaignName,
      campaignId: intent.campaignId,
      pageType: intent.pageType,
      operation: intent.operation,
      currentValue: intent.currentValue,
      proposedValue: intent.proposedValue,
      instruction: intent.instruction,
      target: intent.target,
      expectedResult: intent.expectedResult,
      allowedRegion,
      riskLevel: intent.riskLevel,
      surfaceFingerprint: screenshot.surfaceFingerprint ?? fingerprintSurface(screenshot.surface),
      accountFingerprint: confirmed.fingerprintHash,
      createdAt,
      expiresAt,
      experiment: intent.experiment
    });
    const identityRecord = {
      planId: bound.planId,
      purpose: "approval_binding",
      ...confirmed
    };
    await Promise.all([
      this.workspace.writeJson(context.clientId, `identity/${context.taskId}-approval-${Date.now()}.json`, identityRecord),
      this.workspace.writeJson(context.clientId, `identity/plans/${bound.planId}.json`, identityRecord)
    ]);
    return bound;
  }

  private async loadPersistedIdentityRegions(clientId: string, planId: string): Promise<VisualIdentityRegionsType | undefined> {
    const content = await this.workspace.readText(clientId, `identity/plans/${planId}.json`);
    if (content === undefined) return undefined;
    try {
      const record = PersistedVisualIdentityRegions.parse(JSON.parse(content));
      if (record.planId !== planId) throw new Error("plan id differs from the requested approval plan");
      return record.evidenceRegions;
    } catch (error) {
      throw new Error(`persisted visual identity regions are invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async assertClientSurfaceBinding(context: ToolContext, task: VisualMicroTask): Promise<void> {
    const client = await this.workspace.readClient(context.clientId);
    const profile = task.surface.browserProfile;
    const domain = task.surface.domain?.toLowerCase();
    if (domain && (domain === "ads.google.com" || domain.endsWith(".ads.google.com"))
      && !/browser|chrome|safari|edge|arc|brave|firefox/i.test(task.surface.app)) {
      throw new Error(`Google Ads visual work requires an allowlisted browser application, not ${task.surface.app}`);
    }
    const account = client.accounts?.accounts.find((candidate) => {
      if (!profile || candidate.browserProfile !== profile) return false;
      if (!domain) return true;
      return candidate.allowedDomains.some((allowed) => domain === allowed.toLowerCase() || domain.endsWith(`.${allowed.toLowerCase()}`));
    });
    if (client.accounts?.accounts.length && !account) {
      throw new Error("visual surface is not bound to an allowed client browser Profile and domain");
    }
    if (account) {
      const overlyBroadDomain = task.surface.allowedDomains.some((candidate) => !account.allowedDomains.some((allowed) => candidate.toLowerCase() === allowed.toLowerCase()));
      if (overlyBroadDomain) throw new Error("visual task attempted to broaden the client domain allowlist");
    } else {
      assertPlatformDomain(task.platform, domain, task.surface.allowedDomains);
    }
  }

  private async bindManagedTask(context: ToolContext, task: VisualMicroTask): Promise<VisualMicroTask> {
    if (task.clientId && task.clientId !== context.clientId) throw new Error("visual task client differs from tool context");
    if (task.taskId && task.taskId !== context.taskId) throw new Error("visual task id differs from tool context");
    if (!this.browserSessions) return { ...task, clientId: context.clientId, taskId: context.taskId };
    const found = await this.browserSessions.get(context.clientId, task.surface.browserProfile);
    if (!found) throw new Error("visual task requires a connected managed browser session");
    const platform = task.platform ?? found.platform;
    const session = await this.browserSessions.assertActive(context.clientId, found.browserProfile, platform);
    if (!session.processId || !session.windowId) throw new Error("managed browser session is missing process or window identity");
    const suppliedApplication = task.surface.applicationId;
    if (suppliedApplication && suppliedApplication !== session.browserApplicationId) throw new Error("visual task application identity differs from managed browser session");
    if (task.surface.processId && task.surface.processId !== session.processId) throw new Error("visual task process differs from managed browser session");
    if (task.surface.windowId && task.surface.windowId !== session.windowId) throw new Error("visual task window differs from managed browser session");
    if (task.surface.browserProfile && task.surface.browserProfile !== session.browserProfile) throw new Error("visual task Profile differs from managed browser session");
    if (task.surface.nativeProfileFingerprint && task.surface.nativeProfileFingerprint !== session.nativeProfileFingerprint) {
      throw new Error("visual task native Profile proof differs from managed browser session");
    }
    const allowedApps = [...new Set([session.browserApplicationId, session.browserApp])];
    if ((task.riskLevel === "mutate" || task.riskLevel === "destructive")
      && !allowedApps.every((candidate) => task.surface.allowedApps.includes(candidate))) {
      throw new Error("mutation task application allowlist differs from the approved managed browser");
    }
    return {
      ...task,
      clientId: context.clientId,
      taskId: context.taskId,
      platform,
      surface: {
        ...task.surface,
        app: session.browserApp,
        applicationId: session.browserApplicationId,
        processId: session.processId,
        windowId: session.windowId,
        browserProfile: session.browserProfile,
        nativeProfileFingerprint: session.nativeProfileFingerprint,
        allowedApps
      }
    };
  }

  toPiTools(context: ToolContext): AgentTool[] {
    const tools: AgentTool[] = [
      {
        name: "read_workspace",
        label: "Read client workspace",
        description: "Read the current client's profile, KPI, accounts and constraints.",
        parameters: Type.Object({}),
        executionMode: "parallel",
        execute: async () => textResult(await this.readWorkspace(context))
      },
      {
        name: "analyze_campaign_metrics",
        label: "Analyze campaign metrics",
        description: "Deterministically calculate CPA, CPI, ROAS, maturity and measurement reliability.",
        parameters: Type.Object({
          spend: Type.Number({ minimum: 0 }), impressions: Type.Number({ minimum: 0 }), clicks: Type.Number({ minimum: 0 }),
          installs: Type.Number({ minimum: 0 }), conversions: Type.Number({ minimum: 0 }), revenue: Type.Number({ minimum: 0 }),
          days: Type.Number({ minimum: 1 }), conversionDelayDays: Type.Optional(Type.Number({ minimum: 0 })),
          dailyConversions: Type.Optional(Type.Array(Type.Number({ minimum: 0 }))),
          currencyConsistency: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          missingValueRate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          reconciliationDifference: Type.Optional(Type.Number({ minimum: 0, maximum: 1 }))
        }),
        executionMode: "parallel",
        execute: async (_id, params) => textResult(this.analyzePerformance(context, CampaignMetrics.parse(params)))
      },
      {
        name: "evaluate_change_guardrail",
        label: "Evaluate budget or bid change",
        description: "Apply deterministic maturity, learning, measurement, single-variable, and magnitude gates.",
        parameters: Type.Object({
          kind: Type.Union([Type.Literal("budget"), Type.Literal("bid"), Type.Literal("target_cpa"), Type.Literal("target_roas")]),
          currentValue: Type.Number({ exclusiveMinimum: 0 }), proposedValue: Type.Number({ exclusiveMinimum: 0 }),
          maxChangePercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
          activeExperimentVariables: Type.Optional(Type.Array(Type.String())),
          measurementStatus: Type.Union([Type.Literal("reliable"), Type.Literal("warning"), Type.Literal("blocked")]),
          mature: Type.Boolean(), learning: Type.Optional(Type.Boolean())
        }),
        executionMode: "sequential",
        execute: async (_id, params) => textResult(this.evaluateChange(context, ChangeGuardrailInput.parse(params)))
      }
    ];
    if (this.visualTables && this.computer && this.browserSessions) {
      tools.push({
        name: "read_visual_table",
        label: "Read a visible advertising table",
        description: "Read and independently verify values from a managed browser table. Only cropped, sanitized table ROIs are sent to vision models; complete screenshots remain local. Scrolling is restricted to one scroll action at a time.",
        parameters: Type.Object({
          platform: Type.Union(Platform.options.map((value) => Type.Literal(value))),
          browserProfile: Type.Optional(Type.String({ minLength: 1 })),
          domain: Type.Optional(Type.String({ minLength: 1 })),
          tableRoi: Type.Optional(Type.Object({
            x: Type.Number({ minimum: 0 }),
            y: Type.Number({ minimum: 0 }),
            width: Type.Number({ exclusiveMinimum: 0 }),
            height: Type.Number({ exclusiveMinimum: 0 }),
            coordinateSpace: Type.Optional(Type.Literal("screenshot_pixels"))
          })),
          targetColumns: Type.Array(Type.Object({
            key: Type.String({ minLength: 1 }),
            label: Type.String({ minLength: 1 }),
            valueType: Type.Optional(Type.Union(["auto", "currency", "percentage", "number", "text", "status"].map((value) => Type.Literal(value)))),
            unit: Type.Optional(Type.String()),
            critical: Type.Optional(Type.Boolean())
          }), { minItems: 1 }),
          targetRows: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          scrollDirection: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("down"), Type.Literal("right")])),
          historicalOverlapRows: Type.Optional(Type.Array(Type.Union([
            Type.String({ minLength: 1 }),
            Type.Object({ rowKey: Type.String({ minLength: 1 }), fingerprint: Type.Optional(Type.String({ minLength: 1 })) })
          ]))),
          pageScale: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          factTtlMs: Type.Optional(Type.Number({ minimum: 1 })),
          maxPages: Type.Optional(Type.Number({ minimum: 1, maximum: 100 }))
        }),
        executionMode: "sequential",
        execute: async (_id, params) => textResult(await this.readVisualTable(context, VisualTableReadToolInput.parse(params)))
      });
    }
    return tools;
  }
}

function textResult(details: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function expectedIdentityFromTask(
  context: ToolContext,
  task: VisualMicroTask,
  screenshot: Screenshot,
  evidenceRegions?: VisualIdentityRegionsType
): ExpectedVisualIdentity {
  if (!task.identity) throw new Error("visual task is missing account and Campaign identity fields");
  if (!task.platform) throw new Error("visual task is missing platform binding");
  if (!task.surface.browserProfile || !task.surface.nativeProfileFingerprint || !task.surface.applicationId || !task.surface.windowId) {
    throw new Error("visual task is missing Profile alias, native Profile proof, application, or window binding");
  }
  if (!screenshot.surface) throw new Error("visual identity screenshot has no native surface");
  assertTaskSurfaceExact(task, screenshot);
  return {
    clientId: context.clientId,
    taskId: context.taskId,
    platform: Platform.parse(task.platform),
    browserProfile: task.surface.browserProfile,
    nativeProfileFingerprint: task.surface.nativeProfileFingerprint,
    applicationId: task.surface.applicationId,
    windowId: task.surface.windowId,
    pageType: task.identity.pageType,
    accountName: task.identity.accountName,
    accountId: task.identity.accountId,
    campaignName: task.identity.campaignName,
    campaignId: task.identity.campaignId,
    currency: task.identity.currency,
    currentValue: task.identity.currentValue,
    operation: task.identity.operation,
    proposedValue: task.identity.proposedValue,
    target: task.target,
    ...(evidenceRegions ? { evidenceRegions } : {})
  };
}

function actualExecutionPlanFromTask(
  context: ToolContext,
  task: VisualMicroTask,
  screenshot: Screenshot,
  accountFingerprint: string
): VisualExecutionPlan {
  if (!task.planId || !task.planCreatedAt || !task.planExpiresAt || !task.allowedRegion || !task.identity || !task.platform) {
    throw new Error("mutation task is missing complete visual execution plan bindings");
  }
  if (!task.surface.browserProfile || !task.surface.applicationId || !task.surface.windowId || !screenshot.surface) {
    throw new Error("mutation task is missing complete native surface bindings");
  }
  assertTaskSurfaceExact(task, screenshot);
  return VisualExecutionPlan.parse({
    schemaVersion: 1,
    planId: task.planId,
    taskId: context.taskId,
    clientId: context.clientId,
    platform: task.platform,
    browserProfile: task.surface.browserProfile,
    applicationId: task.surface.applicationId,
    applicationName: task.surface.app,
    windowId: task.surface.windowId,
    domain: task.surface.domain ?? null,
    allowedApplications: task.surface.allowedApps,
    allowedDomains: task.surface.allowedDomains,
    accountName: task.identity.accountName,
    accountId: task.identity.accountId,
    campaignName: task.identity.campaignName,
    campaignId: task.identity.campaignId,
    pageType: task.identity.pageType,
    operation: task.identity.operation,
    currentValue: task.identity.currentValue,
    proposedValue: task.identity.proposedValue,
    instruction: task.instruction,
    target: task.target,
    expectedResult: task.expectedResult,
    allowedRegion: task.allowedRegion,
    riskLevel: task.riskLevel,
    surfaceFingerprint: screenshot.surfaceFingerprint ?? fingerprintSurface(screenshot.surface),
    accountFingerprint,
    createdAt: task.planCreatedAt,
    expiresAt: task.planExpiresAt
  });
}

function assertTaskSurfaceExact(task: VisualMicroTask, screenshot: Screenshot): void {
  const surface = screenshot.surface;
  if (!surface) throw new Error("native surface identity is unavailable");
  const actualApplicationId = surface.bundleId ?? surface.app;
  const mismatches: string[] = [];
  if (task.surface.app !== surface.app) mismatches.push("applicationName");
  if (task.surface.applicationId !== actualApplicationId) mismatches.push("applicationId");
  if (task.surface.processId && task.surface.processId !== surface.pid) mismatches.push("processId");
  if (task.surface.windowId !== surface.windowId) mismatches.push("windowId");
  const expectedNativeProfile = task.surface.nativeProfileFingerprint ?? task.surface.browserProfile;
  if (expectedNativeProfile !== surface.browserProfile) mismatches.push("nativeProfileFingerprint");
  if (mismatches.length) throw new Error(`native screenshot differs from visual task: ${mismatches.join(", ")}`);
}

function platformDefaultDomain(platform: string): string | undefined {
  return ({
    google_ads: "ads.google.com",
    meta_ads: "business.facebook.com",
    tiktok_ads: "ads.tiktok.com",
    apple_ads: "searchads.apple.com",
    microsoft_ads: "ads.microsoft.com",
    amazon_ads: "advertising.amazon.com",
    linkedin_ads: "campaignmanager.linkedin.com",
    youtube_ads: "ads.google.com"
  } as Record<string, string>)[platform];
}

function guardrailKindFromOperation(operation: string): "budget" | "bid" | "target_cpa" | "target_roas" {
  const normalized = operation.toLowerCase().replaceAll("-", "_");
  if (normalized.includes("target_roas") || normalized.includes("troas")) return "target_roas";
  if (normalized.includes("target_cpa") || normalized.includes("tcpa")) return "target_cpa";
  if (normalized.includes("budget")) return "budget";
  if (normalized.includes("bid")) return "bid";
  throw new Error(`unsupported guarded operation: ${operation}`);
}

function experimentVariableMatches(kind: "budget" | "bid" | "target_cpa" | "target_roas", variable: string): boolean {
  const normalized = variable.toLowerCase().replaceAll("-", "_");
  if (kind === "budget") return normalized.includes("budget");
  if (kind === "target_cpa") return normalized.includes("target_cpa") || normalized.includes("tcpa");
  if (kind === "target_roas") return normalized.includes("target_roas") || normalized.includes("troas");
  return normalized.includes("bid");
}

function guardrailFactMatchesCampaign(fact: SharedFact, plan: ApprovalExecutionPlan, operation: ApprovalOperation): boolean {
  const subject = normalizeGuardrailLabel(fact.subject);
  return [plan.campaignId, plan.campaignName, operation.campaign]
    .map(normalizeGuardrailLabel)
    .some((candidate) => candidate.length > 0 && candidate === subject);
}

function requireVerifiedGuardrailFact(
  facts: readonly SharedFact[],
  id: string,
  predicates: readonly string[],
  plan: ApprovalExecutionPlan,
  operation: ApprovalOperation
): SharedFact {
  const fact = facts.find((candidate) => candidate.factId === id);
  if (!fact || !predicates.includes(fact.predicate)) {
    throw new Error(`guardrail evidence is missing verified ${predicates.join(" or ")}`);
  }
  if (fact.taskId !== plan.taskId) throw new Error(`guardrail evidence ${fact.predicate} belongs to a different task`);
  if (!guardrailFactMatchesCampaign(fact, plan, operation)) {
    throw new Error(`guardrail evidence ${fact.predicate} belongs to a different campaign`);
  }
  if (fact.status !== "verified" || fact.sourceType === "migration" || fact.confidence < 0.85
    || !fact.sourceScreenshotId || !fact.sourceBoundingBox || !fact.evidenceIds.some((item) => item.startsWith("screenshot:"))) {
    throw new Error(`guardrail evidence ${fact.predicate} is not verified screenshot evidence`);
  }
  if (fact.expiresAt && Date.parse(fact.expiresAt) <= Date.now()) throw new Error(`guardrail evidence ${fact.predicate} is stale`);
  return fact;
}

function assertLiveGuardrailLineage(
  fact: SharedFact,
  facts: readonly SharedFact[],
  plan: ApprovalExecutionPlan,
  operation: ApprovalOperation,
  visited = new Set<string>()
): void {
  if (visited.has(fact.factId)) throw new Error(`guardrail fact lineage contains a cycle at ${fact.factId}`);
  visited.add(fact.factId);
  const sourceIds = new Set([
    ...(fact.derivedFromFactId ? [fact.derivedFromFactId] : []),
    ...fact.evidenceIds.filter((item) => item.startsWith("fact:")).map((item) => item.slice("fact:".length))
  ]);
  for (const sourceId of sourceIds) {
    const source = facts.find((candidate) => candidate.factId === sourceId);
    if (!source) throw new Error(`guardrail source fact ${sourceId} is missing`);
    if (!guardrailFactMatchesCampaign(source, plan, operation)) {
      throw new Error(`guardrail source fact ${sourceId} belongs to a different campaign`);
    }
    if (source.status !== "verified" || source.sourceType === "migration" || source.confidence < 0.85
      || !source.sourceScreenshotId || !source.sourceBoundingBox || !source.evidenceIds.includes(`screenshot:${source.sourceScreenshotId}`)) {
      throw new Error(`guardrail source fact ${sourceId} is not current verified screenshot evidence`);
    }
    if (source.expiresAt && Date.parse(source.expiresAt) <= Date.now()) {
      throw new Error(`guardrail source fact ${sourceId} is stale`);
    }
    assertLiveGuardrailLineage(source, facts, plan, operation, new Set(visited));
  }
}

function normalizeGuardrailLabel(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function parseMeasurementStatus(value: SharedFact["value"]): "reliable" | "warning" | "blocked" {
  if (typeof value !== "string") throw new Error("measurement_status must be a visible reliable, warning, or blocked label");
  const normalized = normalizeGuardrailLabel(value).replaceAll("-", "_").replaceAll(" ", "_");
  return z.enum(["reliable", "warning", "blocked"]).parse(normalized);
}

function parseVisibleBoolean(
  value: SharedFact["value"],
  trueLabel: "mature" | "learning",
  falseLabel: "not_mature" | "not_learning"
): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") throw new Error(`${trueLabel} guardrail evidence must be a visible boolean status`);
  const normalized = normalizeGuardrailLabel(value).replaceAll("-", "_").replaceAll(" ", "_");
  if (normalized === trueLabel || normalized === "true") return true;
  if (normalized === falseLabel || normalized === "false") return false;
  throw new Error(`${trueLabel} guardrail evidence must be exactly ${trueLabel} or ${falseLabel}`);
}

function nonnegativeFactNumber(fact: SharedFact, label: string): number {
  if (typeof fact.value !== "number" || !Number.isFinite(fact.value) || fact.value < 0) {
    throw new Error(`${label} guardrail fact must be a non-negative number`);
  }
  return fact.value;
}

function positiveIntegerFactNumber(fact: SharedFact, label: string): number {
  const value = nonnegativeFactNumber(fact, label);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} guardrail fact must be a positive integer`);
  return value;
}

function ratioFactNumber(fact: SharedFact, label: string): number {
  const value = nonnegativeFactNumber(fact, label);
  const normalized = fact.unit === "percent" || value > 1 ? value / 100 : value;
  if (normalized < 0 || normalized > 1) throw new Error(`${label} guardrail fact must be between 0 and 1`);
  return normalized;
}

function parseVisibleMeasurementHealth(value: SharedFact["value"]): "reliable" | "warning" | "blocked" {
  if (typeof value !== "string") throw new Error("visible measurement health must be a status label");
  const normalized = normalizeGuardrailLabel(value).replaceAll("-", "_").replaceAll(" ", "_");
  if (["reliable", "active", "recording_conversions", "no_issues"].includes(normalized)) return "reliable";
  if (["warning", "limited", "needs_attention"].includes(normalized)) return "warning";
  if (["blocked", "inactive", "not_recording", "not_recording_conversions", "unverified"].includes(normalized)) return "blocked";
  throw new Error("visible measurement health is not an accepted diagnostics status");
}

function parseVisibleLearningStatus(value: SharedFact["value"]): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") throw new Error("visible learning status must be a status label");
  const normalized = normalizeGuardrailLabel(value).replaceAll("-", "_").replaceAll(" ", "_");
  if (["true", "learning", "learning_limited"].includes(normalized)) return true;
  if (["false", "not_learning", "eligible", "active"].includes(normalized)) return false;
  throw new Error("visible learning status is not an accepted campaign status");
}

function strictestMeasurementStatus(
  ...values: Array<"reliable" | "warning" | "blocked" | undefined>
): "reliable" | "warning" | "blocked" {
  const rank = { reliable: 0, warning: 1, blocked: 2 } as const;
  return values.filter((value): value is keyof typeof rank => Boolean(value))
    .sort((left, right) => rank[right] - rank[left])[0] ?? "blocked";
}

function resolveVisualTableRoi(explicit: VisualTableRoi | undefined, screenshot: Screenshot): VisualTableRoi {
  const content = explicit ?? defaultBrowserContentRoi(screenshot.width, screenshot.height);
  const roi = VisualTableRoi.parse({ ...content, coordinateSpace: "screenshot_pixels" });
  if (roi.x + roi.width > screenshot.width || roi.y + roi.height > screenshot.height) {
    throw new Error("visual table ROI exceeds the managed screenshot bounds");
  }
  if (!explicit && roi.x === 0 && roi.y === 0 && roi.width === screenshot.width && roi.height === screenshot.height) {
    throw new Error("default visual table ROI must exclude browser chrome from the model image");
  }
  return roi;
}

function assertPlatformDomain(platform: string | undefined, domain: string | undefined, allowedDomains: string[]): void {
  if (!platform) throw new Error("visual task is missing platform binding");
  const expected = platformDefaultDomain(platform);
  if (!expected) {
    if (!domain || !allowedDomains.length) throw new Error("a configured domain allowlist is required for this visual platform");
    return;
  }
  if (!domain || !(domain === expected || domain.endsWith(`.${expected}`))) {
    throw new Error(`visual task domain does not match ${platform}`);
  }
  if (allowedDomains.some((candidate) => {
    const normalized = candidate.toLowerCase();
    return normalized !== expected && !normalized.endsWith(`.${expected}`);
  })) throw new Error("visual task attempted to broaden the platform domain allowlist");
}

function screenshotMetadata(screenshot: Screenshot) {
  return {
    sha256: screenshot.sha256,
    width: screenshot.width,
    height: screenshot.height,
    scaleFactor: screenshot.scaleFactor,
    capturedAt: screenshot.capturedAt,
    surfaceFingerprint: screenshot.surfaceFingerprint,
    surface: screenshot.surface
  };
}

function deriveTargetAllowedRegion(
  targetRegion: { x: number; y: number; width: number; height: number } | undefined,
  screenshot: Screenshot
): z.infer<typeof VisualAllowedRegion> {
  if (!targetRegion) throw new Error("dual visual identity review did not return a target control region");
  const parsed = VisualTableRoi.parse({ ...targetRegion, coordinateSpace: "screenshot_pixels" });
  if (parsed.x + parsed.width > screenshot.width || parsed.y + parsed.height > screenshot.height) {
    throw new Error("dual-reviewed target control region exceeds the current screenshot");
  }
  return VisualAllowedRegion.parse(parsed);
}

function assertRequestedRegionIsTight(
  requested: z.infer<typeof VisualAllowedRegion>,
  derived: z.infer<typeof VisualAllowedRegion>,
  scaleFactor: number
): void {
  const normalized = requested.coordinateSpace === "screen_points"
    ? { x: requested.x * scaleFactor, y: requested.y * scaleFactor, width: requested.width * scaleFactor, height: requested.height * scaleFactor }
    : requested;
  const overlap = regionIntersectionArea(normalized, derived);
  const derivedArea = derived.width * derived.height;
  const requestedArea = normalized.width * normalized.height;
  if (overlap / derivedArea < 0.9 || requestedArea > derivedArea * 1.5) {
    throw new Error("requested allowed region is not tightly bound to the dual-reviewed target control");
  }
}

function regionAgreementWithApprovedTarget(
  current: { x: number; y: number; width: number; height: number } | undefined,
  approved: z.infer<typeof VisualAllowedRegion>,
  scaleFactor: number
): boolean {
  if (!current) return false;
  const normalized = approved.coordinateSpace === "screen_points"
    ? { x: approved.x * scaleFactor, y: approved.y * scaleFactor, width: approved.width * scaleFactor, height: approved.height * scaleFactor }
    : approved;
  const overlap = regionIntersectionArea(current, normalized);
  if (!overlap) return false;
  const union = current.width * current.height + normalized.width * normalized.height - overlap;
  return overlap / union >= 0.5;
}

function regionIntersectionArea(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** Canonical server/operator projection; no execution field is reconstructed from defaults. */
export function visualTaskFromExecutionPlan(
  planInput: ApprovalExecutionPlan,
  currency: string | null,
  permission: "MUTATE" | "DESTRUCTIVE" = "MUTATE"
): VisualMicroTask {
  const plan = ApprovalExecutionPlan.parse(planInput);
  return {
    clientId: plan.clientId,
    taskId: plan.taskId,
    planId: plan.planId,
    platform: plan.platform,
    accountFingerprint: plan.accountFingerprint,
    allowedRegion: plan.allowedRegion,
    planCreatedAt: plan.createdAt,
    planExpiresAt: plan.expiresAt,
    identity: {
      accountName: plan.accountName,
      accountId: plan.accountId,
      campaignName: plan.campaignName,
      campaignId: plan.campaignId,
      pageType: plan.pageType,
      currency,
      currentValue: plan.currentValue,
      proposedValue: plan.proposedValue,
      operation: plan.operation
    },
    instruction: plan.instruction,
    target: plan.target,
    expectedResult: plan.expectedResult,
    riskLevel: plan.riskLevel,
    permission,
    surface: {
      app: plan.applicationName,
      applicationId: plan.applicationId,
      windowId: plan.windowId,
      browserProfile: plan.browserProfile,
      ...(plan.domain ? { domain: plan.domain } : {}),
      allowedApps: plan.allowedApplications,
      allowedDomains: plan.allowedDomains
    }
  };
}
