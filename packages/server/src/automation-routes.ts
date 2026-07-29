import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdPilotSystem } from "@adpilot/application";
import {
  Automation,
  AutomationAction,
  AutomationScheduler,
  AutomationTrigger,
  AutomationsError,
  FileAutomationRunStore,
  FileAutomationStore,
  FileNotificationStore,
  nextFireAt,
  parseCron,
  type Automation as AutomationValue,
  type AutomationRun as AutomationRunValue
} from "@adpilot/automations";
import {
  DailyBriefService,
  DailyBriefThresholds,
  DecisionService,
  FileAdAccountStore,
  FileAdvertisingDecisionStore,
  FileCampaignStore,
  FileCreativeAssetStore,
  MeasurementIssue,
  MetricsSnapshot,
  PendingReport,
  type CampaignEntity as CampaignEntityValue,
  type CreativeAsset as CreativeAssetValue
} from "@adpilot/ads-intelligence";

const WorkspaceId = z.string().min(1).max(256);
const IdParams = z.object({ id: z.string().min(1).max(128) });

const AutomationCreateBody = z.object({
  workspaceId: WorkspaceId,
  projectId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(256),
  description: z.string().max(4_000).optional(),
  trigger: AutomationTrigger,
  action: AutomationAction,
  guards: z.object({
    maxRunsPerDay: z.number().int().min(1).max(1_000).default(10),
    maxCostUsd: z.number().finite().positive().optional(),
    requiresApprovalForMutation: z.literal(true).default(true)
  }).strict().default({ maxRunsPerDay: 10, requiresApprovalForMutation: true }),
  idempotencyWindowSeconds: z.number().int().min(1).max(31_536_000).default(3_600)
}).strict();

const WorkspaceOnlyBody = z.object({ workspaceId: WorkspaceId }).strict();

const ApproveRunBody = z.object({
  workspaceId: WorkspaceId,
  approvalId: z.string().trim().min(1).max(256)
}).strict();

const DailyBriefActionInput = z.object({
  projectId: z.string().uuid().optional(),
  facts: z.object({
    metrics: MetricsSnapshot,
    pendingReports: z.array(PendingReport).max(256).optional(),
    measurementIssues: z.array(MeasurementIssue).max(256).optional(),
    thresholds: DailyBriefThresholds.partial().optional()
  }).strict().optional()
}).strict();

/**
 * Automation routes: CRUD over first-class automations, manual run-now, the
 * approval release for gated mutation runs, and the notification inbox the
 * `notify` action writes into. Returns the live scheduler so the server can
 * drive `tick()` on an interval.
 */
export function registerAutomationRoutes(app: FastifyInstance, system: AdPilotSystem): AutomationScheduler {
  const automationStore = new FileAutomationStore(system.workspace.root);
  const runStore = new FileAutomationRunStore(system.workspace.root);
  const notificationStore = new FileNotificationStore(system.workspace.root);

  const accountStore = new FileAdAccountStore(system.workspace.root);
  const campaignStore = new FileCampaignStore(system.workspace.root);
  const creativeStore = new FileCreativeAssetStore(system.workspace.root);
  const decisionService = new DecisionService(
    new FileAdvertisingDecisionStore(system.workspace.root),
    async (projectId) => (await system.kernel.getProject(projectId)) !== undefined
  );
  const dailyBriefs = new DailyBriefService();

  async function workspaceCampaigns(workspaceId: string): Promise<CampaignEntityValue[]> {
    const accounts = await accountStore.list({ workspaceId });
    const byAccount = await Promise.all(accounts.map((account) => campaignStore.list({ accountId: account.id })));
    return byAccount.flat();
  }

  async function workspaceCreatives(workspaceId: string): Promise<CreativeAssetValue[]> {
    const accounts = await accountStore.list({ workspaceId });
    const byAccount = await Promise.all(accounts.map((account) => creativeStore.list({ accountId: account.id })));
    return byAccount.flat();
  }

  const scheduler = new AutomationScheduler({
    automations: automationStore,
    runs: runStore,
    notifications: notificationStore,
    executors: {
      dailyBrief: async (input, context) => {
        const parsed = DailyBriefActionInput.parse(input);
        const workspaceId = context.automation.workspaceId;
        const projectId = parsed.projectId ?? context.automation.projectId;
        const [accounts, campaigns, creatives, experiments, projects] = await Promise.all([
          accountStore.list({ workspaceId }),
          workspaceCampaigns(workspaceId),
          workspaceCreatives(workspaceId),
          system.experiments.list(workspaceId),
          system.kernel.listProjects({ workspaceId })
        ]);
        const decisions = projectId
          ? await decisionService.listByProject(projectId)
          : (await Promise.all(projects.map((project) => decisionService.listByProject(project.id)))).flat();
        const brief = dailyBriefs.generate({
          workspaceId,
          ...(projectId !== undefined ? { projectId } : {}),
          accounts,
          campaigns,
          creatives,
          metrics: parsed.facts?.metrics ?? MetricsSnapshot.parse({}),
          decisions,
          experiments,
          ...(parsed.facts?.pendingReports !== undefined ? { pendingReports: parsed.facts.pendingReports } : {}),
          ...(parsed.facts?.measurementIssues !== undefined ? { measurementIssues: parsed.facts.measurementIssues } : {}),
          ...(parsed.facts?.thresholds !== undefined ? { thresholds: parsed.facts.thresholds } : {})
        });
        await system.audit.append({
          clientId: workspaceId,
          actor: "automation",
          action: "ads_daily_brief_generate",
          status: "succeeded",
          details: {
            automationId: context.automation.id,
            runId: context.run.id,
            totalFindings: brief.summary.totalFindings,
            criticalCount: brief.summary.criticalCount
          }
        });
        return { generatedAt: brief.generatedAt, ...brief.summary };
      },
      createTask: async (task) => {
        const created = await system.kernel.createTask({
          title: task.title,
          description: task.description,
          ...(task.goalId !== undefined ? { goalId: task.goalId } : {})
        });
        return { taskId: created.id };
      }
    }
  });

  async function requireWorkspace(workspaceId: string): Promise<void> {
    await system.workspace.readClient(workspaceId);
  }

  async function requireAutomationInWorkspace(automationId: string, workspaceId: string): Promise<AutomationValue> {
    const automation = await automationStore.get(automationId);
    if (!automation || automation.workspaceId !== workspaceId) {
      throw new AutomationsError(`automation not found in this workspace: ${automationId}`, "AUTOMATION_NOT_FOUND");
    }
    return automation;
  }

  async function requireRunInWorkspace(runId: string, workspaceId: string): Promise<AutomationRunValue> {
    const run = await runStore.get(runId);
    if (!run) throw new AutomationsError(`automation run not found: ${runId}`, "RUN_NOT_FOUND");
    await requireAutomationInWorkspace(run.automationId, workspaceId);
    return run;
  }

  async function latestRunsByAutomation(workspaceId: string): Promise<Record<string, AutomationRunValue>> {
    const automations = await automationStore.list({ workspaceId });
    const result: Record<string, AutomationRunValue> = {};
    for (const automation of automations) {
      const runs = await runStore.list({ automationId: automation.id });
      const latest = runs.filter((run) => run.status !== "skipped-duplicate").at(-1);
      if (latest) result[automation.id] = latest;
    }
    return result;
  }

  function saveAutomation(automation: AutomationValue, patch: Partial<AutomationValue>): Promise<void> {
    return automationStore.save(Automation.parse({
      ...automation,
      ...patch,
      updatedAt: new Date().toISOString(),
      revision: automation.revision + 1
    }));
  }

  app.get("/api/automations", async (request) => {
    const query = z.object({
      workspaceId: WorkspaceId,
      state: z.enum(["active", "paused"]).optional()
    }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    const automations = await automationStore.list({
      workspaceId: query.workspaceId,
      ...(query.state ? { state: query.state } : {})
    });
    return { automations, latestRuns: await latestRunsByAutomation(query.workspaceId) };
  });

  app.post("/api/automations", async (request, reply) => {
    const body = AutomationCreateBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    if (body.projectId) {
      const project = await system.kernel.getProject(body.projectId);
      if (!project || project.workspaceId !== body.workspaceId) {
        throw new AutomationsError(`project not found in this workspace: ${body.projectId}`, "PROJECT_NOT_FOUND");
      }
    }
    let firstFireAt: string | undefined;
    if (body.trigger.kind === "schedule") {
      parseCron(body.trigger.cron);
      const fire = nextFireAt(body.trigger.cron, new Date());
      if (!fire) {
        throw new AutomationsError("schedule never fires within the next 366 days", "CRON_INVALID");
      }
      firstFireAt = fire.toISOString();
    }
    const now = new Date().toISOString();
    const automation = Automation.parse({
      id: randomUUID(),
      workspaceId: body.workspaceId,
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      title: body.title,
      ...(body.description !== undefined ? { description: body.description } : {}),
      trigger: body.trigger,
      action: body.action,
      guards: body.guards,
      state: "active",
      idempotencyWindowSeconds: body.idempotencyWindowSeconds,
      ...(firstFireAt !== undefined ? { nextFireAt: firstFireAt } : {}),
      runCount: 0,
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    await automationStore.save(automation);
    await system.audit.append({
      clientId: body.workspaceId,
      actor: "workspace-owner",
      action: "automation_create",
      status: "succeeded",
      details: { automationId: automation.id, title: automation.title, triggerKind: automation.trigger.kind, actionKind: automation.action.kind }
    });
    reply.code(201);
    return { automation };
  });

  app.get("/api/automations/:id", async (request) => {
    const params = IdParams.parse(request.params);
    const query = WorkspaceOnlyBody.parse(request.query);
    await requireWorkspace(query.workspaceId);
    const automation = await requireAutomationInWorkspace(params.id, query.workspaceId);
    const runs = (await runStore.list({ automationId: automation.id }))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, 20);
    return { automation, runs };
  });

  app.post("/api/automations/:id/pause", async (request) => {
    const params = IdParams.parse(request.params);
    const body = WorkspaceOnlyBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const automation = await requireAutomationInWorkspace(params.id, body.workspaceId);
    if (automation.state !== "paused") await saveAutomation(automation, { state: "paused" });
    await system.audit.append({
      clientId: body.workspaceId,
      actor: "workspace-owner",
      action: "automation_pause",
      status: "succeeded",
      details: { automationId: automation.id }
    });
    return { automation: await automationStore.get(automation.id) };
  });

  app.post("/api/automations/:id/resume", async (request) => {
    const params = IdParams.parse(request.params);
    const body = WorkspaceOnlyBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const automation = await requireAutomationInWorkspace(params.id, body.workspaceId);
    if (automation.state !== "active") {
      // Re-arm from now: a long-paused schedule must not instantly catch up.
      const patch: Partial<AutomationValue> = { state: "active" };
      if (automation.trigger.kind === "schedule") {
        const fire = nextFireAt(automation.trigger.cron, new Date());
        patch.nextFireAt = fire ? fire.toISOString() : undefined;
      }
      await saveAutomation(automation, patch);
    }
    await system.audit.append({
      clientId: body.workspaceId,
      actor: "workspace-owner",
      action: "automation_resume",
      status: "succeeded",
      details: { automationId: automation.id }
    });
    return { automation: await automationStore.get(automation.id) };
  });

  app.post("/api/automations/:id/run-now", async (request) => {
    const params = IdParams.parse(request.params);
    const body = WorkspaceOnlyBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    await requireAutomationInWorkspace(params.id, body.workspaceId);
    const run = await scheduler.runNow(params.id);
    await system.audit.append({
      clientId: body.workspaceId,
      actor: "workspace-owner",
      action: "automation_run_now",
      status: "succeeded",
      details: { automationId: params.id, runId: run.id, runStatus: run.status }
    });
    return { run };
  });

  app.get("/api/automations/:id/runs", async (request) => {
    const params = IdParams.parse(request.params);
    const query = WorkspaceOnlyBody.parse(request.query);
    await requireWorkspace(query.workspaceId);
    const automation = await requireAutomationInWorkspace(params.id, query.workspaceId);
    const runs = (await runStore.list({ automationId: automation.id }))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id))
      .slice(0, 50);
    return { runs };
  });

  app.get("/api/automation-runs/:id", async (request) => {
    const params = IdParams.parse(request.params);
    const query = WorkspaceOnlyBody.parse(request.query);
    await requireWorkspace(query.workspaceId);
    return { run: await requireRunInWorkspace(params.id, query.workspaceId) };
  });

  app.post("/api/automation-runs/:id/approve", async (request) => {
    const params = IdParams.parse(request.params);
    const body = ApproveRunBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    await requireRunInWorkspace(params.id, body.workspaceId);
    const run = await scheduler.approveRun(params.id, body.approvalId);
    await system.audit.append({
      clientId: body.workspaceId,
      actor: "workspace-owner",
      action: "automation_run_approve",
      status: "succeeded",
      details: { runId: run.id, automationId: run.automationId, approvalId: body.approvalId, runStatus: run.status }
    });
    return { run };
  });

  app.delete("/api/automations/:id", async (request) => {
    const params = IdParams.parse(request.params);
    const query = WorkspaceOnlyBody.parse(request.query);
    await requireWorkspace(query.workspaceId);
    const automation = await requireAutomationInWorkspace(params.id, query.workspaceId);
    const runs = await runStore.list({ automationId: automation.id });
    for (const run of runs) await runStore.delete(run.id);
    await automationStore.delete(automation.id);
    await system.audit.append({
      clientId: query.workspaceId,
      actor: "workspace-owner",
      action: "automation_delete",
      status: "succeeded",
      details: { automationId: automation.id, title: automation.title, removedRuns: runs.length }
    });
    return { deleted: true };
  });

  app.get("/api/notifications", async (request) => {
    const query = z.object({
      workspaceId: WorkspaceId,
      unread: z.enum(["true", "false"]).optional()
    }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    const notifications = (await notificationStore.list({
      workspaceId: query.workspaceId,
      ...(query.unread !== undefined ? { unread: query.unread === "true" } : {})
    })).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { notifications };
  });

  app.post("/api/notifications/:id/read", async (request) => {
    const params = IdParams.parse(request.params);
    const body = WorkspaceOnlyBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const notification = await notificationStore.get(params.id);
    if (!notification || notification.workspaceId !== body.workspaceId) {
      throw new AutomationsError(`notification not found in this workspace: ${params.id}`, "NOTIFICATION_NOT_FOUND");
    }
    if (!notification.read) {
      await notificationStore.save({
        ...notification,
        read: true,
        updatedAt: new Date().toISOString(),
        revision: notification.revision + 1
      });
    }
    return { notification: await notificationStore.get(notification.id) };
  });

  return scheduler;
}
