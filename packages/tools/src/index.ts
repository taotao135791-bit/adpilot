import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { AuditLog } from "@adpilot/audit";
import { ApprovalExecutionPlan, ApprovalService, type ApprovalOperation } from "@adpilot/approvals";
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
import { VisualComputerRuntime, type VisualMicroTask, type VisualStepResult } from "@adpilot/computer-use";
import type { PermissionLevel } from "@adpilot/shared";

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
    readonly computer?: VisualComputerRuntime
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

  async createApproval(context: ToolContext, operation: ApprovalOperation, executionPlan?: ApprovalExecutionPlan) {
    if (context.permission !== "OBSERVE" && context.permission !== "INTERACT" && context.permission !== "MUTATE" && context.permission !== "DESTRUCTIVE") throw new Error("invalid permission context");
    let boundPlan = executionPlan;
    if (executionPlan) {
      if (!this.computer) throw new Error("a native computer runtime is required to bind an approval to a live surface");
      const live = await this.computer.identifySurface();
      if (live.surface && live.surface.app !== executionPlan.surface.app) {
        throw new Error(`approval surface does not match the active application: ${live.surface.app}`);
      }
      boundPlan = ApprovalExecutionPlan.parse({
        ...executionPlan,
        surface: { ...executionPlan.surface, surfaceFingerprint: live.fingerprint }
      });
    }
    const approval = await this.approvals.create(context.clientId, context.taskId, operation, boundPlan);
    await this.audit.append({ clientId: context.clientId, taskId: context.taskId, actor: context.actor, action: "create_approval", status: "succeeded", details: { approvalId: approval.id, operation: approval.operation } });
    return approval;
  }

  async writeExperiment(context: ToolContext, input: Omit<Experiment, "id" | "status" | "finalConclusion" | "startedAt" | "completedAt" | "createdAt" | "updatedAt">) {
    const experiment = await this.experiments.create(input);
    await this.audit.append({ clientId: context.clientId, taskId: context.taskId, actor: context.actor, action: "write_experiment", status: "succeeded", details: { experimentId: experiment.id, variable: experiment.variable } });
    return experiment;
  }

  async executeVisualTask(context: ToolContext, task: VisualMicroTask): Promise<VisualStepResult> {
    if (!this.computer) throw new Error("native computer runtime is unavailable");
    if (task.permission !== context.permission) throw new Error("visual task permission differs from tool context");
    const client = await this.workspace.readClient(context.clientId);
    const profile = task.surface.browserProfile;
    const domain = task.surface.domain?.toLowerCase();
    if (domain && (domain === "ads.google.com" || domain.endsWith(".ads.google.com")) && !/browser|chrome|safari|edge|arc|brave|firefox/i.test(task.surface.app)) {
      throw new Error(`Google Ads visual work requires an allowlisted browser application, not ${task.surface.app}`);
    }
    const account = client.accounts?.accounts.find((candidate) => {
      if (!profile || candidate.browserProfile !== profile) return false;
      if (!domain) return true;
      return candidate.allowedDomains.some((allowed) => domain === allowed.toLowerCase() || domain.endsWith(`.${allowed.toLowerCase()}`));
    });
    if (!account) throw new Error("visual surface is not bound to an allowed client browser profile and domain");
    const overlyBroadDomain = task.surface.allowedDomains.some((candidate) => !account.allowedDomains.some((allowed) => candidate.toLowerCase() === allowed.toLowerCase()));
    if (overlyBroadDomain) throw new Error("visual task attempted to broaden the client domain allowlist");
    const result = await this.computer.runMicroTask(task);
    if (result.status === "done") {
      await this.workspace.writeJson(context.clientId, `screenshots/${context.taskId}-${Date.now()}.json`, {
        task: { target: task.target, expectedResult: task.expectedResult, riskLevel: task.riskLevel },
        before: result.before, after: result.after
      });
    }
    await this.audit.append({
      clientId: context.clientId, taskId: context.taskId, actor: context.actor,
      action: "execute_visual_task", status: result.status === "done" ? "succeeded" : "failed",
      details: { status: result.status, attempts: result.attempts, ...(result.status === "failed" ? { blocker: result.blocker } : { action: result.action.action, beforeHash: result.before.sha256, afterHash: result.after.sha256 }) }
    });
    return result;
  }

  async commitApprovedVisualAction(context: ToolContext, approvalId: string, token: string, operation: ApprovalOperation, task: VisualMicroTask): Promise<VisualStepResult> {
    if (context.permission !== "MUTATE" && context.permission !== "DESTRUCTIVE") throw new Error("commit requires mutation permission");
    const unfinished = (await this.experiments.list(context.clientId)).filter((item) => ["active", "waiting"].includes(item.status));
    if (unfinished.length > 0) throw new Error("an unfinished experiment blocks a new mutation");
    if (!this.computer) throw new Error("native computer runtime is unavailable");
    let confirmation: Awaited<ReturnType<VisualComputerRuntime["verifyVisible"]>>;
    try {
      confirmation = await this.computer.verifyVisible([
        `Platform: ${operation.platform}`,
        `Account: ${operation.account}`,
        `Campaign: ${operation.campaign}`,
        `Operation: ${operation.operation}`,
        `Current value: ${String(operation.currentValue)}`,
        `Proposed value: ${String(operation.proposedValue)}`,
        "All six facts are visible and consistent on the current authorized surface."
      ].join("\n"));
    } catch (error) {
      await this.approvals.cancel(context.clientId, approvalId);
      throw error;
    }
    if (!confirmation.matched || confirmation.confidence < 0.7) {
      await this.approvals.cancel(context.clientId, approvalId);
      throw new Error(`mutation preflight could not confirm the exact platform/account/campaign/values: ${confirmation.reason}`);
    }
    const liveSurface = await this.computer.identifySurface();
    const executing = await this.approvals.consume(context.clientId, approvalId, token, operation, liveSurface.fingerprint);
    try {
      const result = await this.executeVisualTask(context, task);
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
