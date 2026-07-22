import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { AuditLog } from "@adpilot/audit";
import {
  ApprovalExecutionPlan,
  ApprovalExperiment,
  ApprovalService,
  VisualAllowedRegion,
  VisualExecutionPlan,
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
  fingerprintSurface,
  type BrowserSession,
  type ExpectedVisualIdentity,
  type Screenshot,
  type VisualMicroTask,
  type VisualStepResult,
  VisualComputerRuntime
} from "@adpilot/computer-use";
import { Platform, RiskLevel, type PermissionLevel } from "@adpilot/shared";

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
  allowedRegion: VisualAllowedRegion,
  riskLevel: RiskLevel,
  expiresAt: z.string().datetime().optional(),
  experiment: ApprovalExperiment
}).strict();
export type VisualApprovalPlanDraft = z.infer<typeof VisualApprovalPlanDraft>;

export const VisualApprovalPlanInput = z.union([ApprovalExecutionPlan, VisualApprovalPlanDraft]);
export type VisualApprovalPlanInput = z.infer<typeof VisualApprovalPlanInput>;

export interface ToolContext {
  clientId: string;
  taskId: string;
  actor: string;
  permission: PermissionLevel;
}

export class AdPilotTools {
  constructor(
    readonly workspace: WorkspaceStore,
    readonly audit: AuditLog,
    readonly approvals: ApprovalService,
    readonly experiments: ExperimentStore,
    readonly computer?: VisualComputerRuntime,
    readonly visualIdentity?: DualVisualIdentityVerifier,
    readonly browserSessions?: BrowserSessionManager
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

  async createApproval(context: ToolContext, operation: ApprovalOperation, executionPlan?: VisualApprovalPlanInput) {
    if (context.permission !== "OBSERVE" && context.permission !== "INTERACT" && context.permission !== "MUTATE" && context.permission !== "DESTRUCTIVE") throw new Error("invalid permission context");
    const boundPlan = executionPlan ? await this.bindApprovalPlan(context, operation, executionPlan) : undefined;
    const approval = await this.approvals.create(context.clientId, context.taskId, operation, boundPlan);
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
        accountFingerprint: boundPlan?.accountFingerprint
      }
    });
    return approval;
  }

  async writeExperiment(context: ToolContext, input: Omit<Experiment, "id" | "status" | "finalConclusion" | "startedAt" | "completedAt" | "createdAt" | "updatedAt">) {
    const experiment = await this.experiments.create(input);
    await this.audit.append({ clientId: context.clientId, taskId: context.taskId, actor: context.actor, action: "write_experiment", status: "succeeded", details: { experimentId: experiment.id, variable: experiment.variable } });
    return experiment;
  }

  async executeVisualTask(context: ToolContext, task: VisualMicroTask, initialScreenshot?: Screenshot): Promise<VisualStepResult> {
    if (!this.computer) throw new Error("native computer runtime is unavailable");
    if (task.permission !== context.permission) throw new Error("visual task permission differs from tool context");
    const boundTask = await this.bindManagedTask(context, task);
    const client = await this.workspace.readClient(context.clientId);
    const profile = boundTask.surface.browserProfile;
    const domain = boundTask.surface.domain?.toLowerCase();
    if (domain && (domain === "ads.google.com" || domain.endsWith(".ads.google.com")) && !/browser|chrome|safari|edge|arc|brave|firefox/i.test(boundTask.surface.app)) {
      throw new Error(`Google Ads visual work requires an allowlisted browser application, not ${boundTask.surface.app}`);
    }
    const account = client.accounts?.accounts.find((candidate) => {
      if (!profile || candidate.browserProfile !== profile) return false;
      if (!domain) return true;
      return candidate.allowedDomains.some((allowed) => domain === allowed.toLowerCase() || domain.endsWith(`.${allowed.toLowerCase()}`));
    });
    if (client.accounts?.accounts.length && !account) throw new Error("visual surface is not bound to an allowed client browser Profile and domain");
    if (account) {
      const overlyBroadDomain = boundTask.surface.allowedDomains.some((candidate) => !account.allowedDomains.some((allowed) => candidate.toLowerCase() === allowed.toLowerCase()));
      if (overlyBroadDomain) throw new Error("visual task attempted to broaden the client domain allowlist");
    } else {
      assertPlatformDomain(boundTask.platform, domain, boundTask.surface.allowedDomains);
    }
    const result = await this.computer.runMicroTask(boundTask, initialScreenshot);
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
      const expected = expectedIdentityFromTask(context, boundTask, screenshot);
      const confirmed = await this.visualIdentity.confirm(expected, screenshot);
      if (confirmed.fingerprintHash !== boundTask.accountFingerprint) {
        throw new Error("current visual account fingerprint differs from the approved task binding");
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
      allowedRegion: intent.allowedRegion,
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
        ...(domain ? { domain } : {}),
        allowedApps: [...new Set([applicationId, applicationName])],
        allowedDomains
      }
    };
    const screenshot = await this.computer.captureForTask(provisionalTask);
    if (!screenshot.surface) throw new Error("approval screenshot has no native surface identity");
    const expected = expectedIdentityFromTask(context, provisionalTask, screenshot);
    const confirmed = await this.visualIdentity.confirm(expected, screenshot);
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
      allowedRegion: intent.allowedRegion,
      riskLevel: intent.riskLevel,
      surfaceFingerprint: screenshot.surfaceFingerprint ?? fingerprintSurface(screenshot.surface),
      accountFingerprint: confirmed.fingerprintHash,
      createdAt,
      expiresAt,
      experiment: intent.experiment
    });
    await this.workspace.writeJson(context.clientId, `identity/${context.taskId}-approval-${Date.now()}.json`, {
      planId: bound.planId,
      purpose: "approval_binding",
      ...confirmed
    });
    return bound;
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
        allowedApps
      }
    };
  }

  toPiTools(context: ToolContext): AgentTool[] {
    return [
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
  }
}

function textResult(details: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function expectedIdentityFromTask(context: ToolContext, task: VisualMicroTask, screenshot: Screenshot): ExpectedVisualIdentity {
  if (!task.identity) throw new Error("visual task is missing account and Campaign identity fields");
  if (!task.platform) throw new Error("visual task is missing platform binding");
  if (!task.surface.browserProfile || !task.surface.applicationId || !task.surface.windowId) {
    throw new Error("visual task is missing native Profile, application, or window binding");
  }
  if (!screenshot.surface) throw new Error("visual identity screenshot has no native surface");
  assertTaskSurfaceExact(task, screenshot);
  return {
    clientId: context.clientId,
    taskId: context.taskId,
    platform: Platform.parse(task.platform),
    browserProfile: task.surface.browserProfile,
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
    target: task.target
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
  if (task.surface.browserProfile !== surface.browserProfile) mismatches.push("browserProfile");
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
