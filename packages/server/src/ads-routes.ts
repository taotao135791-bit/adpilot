import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdPilotSystem } from "@adpilot/application";
import {
  AdAccount,
  AdsIntelligenceError,
  CampaignEntity,
  CreativeAsset,
  DailyBriefService,
  DailyBriefThresholds,
  DecisionService,
  DecisionStatus,
  FileAdAccountStore,
  FileAdvertisingDecisionStore,
  FileCampaignStore,
  FileCreativeAssetStore,
  MeasurementIssue,
  MetricsSnapshot,
  PendingReport,
  PythonUacEngine,
  UAC_ENGINE_UNAVAILABLE,
  hashRecommendation,
  type AdAccount as AdAccountValue,
  type CampaignEntity as CampaignEntityValue,
  type CreativeAsset as CreativeAssetValue
} from "@adpilot/ads-intelligence";

const WorkspaceId = z.string().min(1).max(256);

const AccountCreateBody = z.object({
  workspaceId: WorkspaceId,
  platform: z.enum(["google", "meta", "tiktok", "other"]),
  externalId: z.string().min(1).max(256).optional(),
  name: z.string().trim().min(1).max(256),
  currency: z.string().min(1).max(16).optional(),
  timezone: z.string().min(1).max(64).optional()
}).strict();

const CampaignCreateBody = z.object({
  workspaceId: WorkspaceId,
  accountId: z.string().uuid(),
  externalId: z.string().min(1).max(256).optional(),
  name: z.string().trim().min(1).max(256),
  objective: z.string().min(1).max(256).optional(),
  optimizationEvent: z.string().min(1).max(256).optional(),
  budget: z.number().finite().nonnegative().optional(),
  bid: z.number().finite().nonnegative().optional(),
  status: z.string().min(1).max(64).optional()
}).strict();

const DecisionCreateBody = z.object({
  workspaceId: WorkspaceId,
  projectId: z.string().uuid(),
  campaignId: z.string().uuid().optional(),
  recommendation: z.string().trim().min(1).max(4_000),
  rationale: z.array(z.string().min(1).max(2_000)).max(64).default([]),
  evidenceIds: z.array(z.string().min(1).max(256)).max(256).default([]),
  confidence: z.enum(["low", "medium", "high"]),
  risks: z.array(z.string().min(1).max(2_000)).max(64).default([]),
  observationWindow: z.string().min(1).max(256).optional(),
  rollbackPlan: z.string().min(1).max(4_000).optional()
}).strict();

const DecisionTransitionBody = z.object({
  workspaceId: WorkspaceId,
  status: DecisionStatus
}).strict();

const CreativeCreateBody = z.object({
  workspaceId: WorkspaceId,
  accountId: z.string().uuid(),
  name: z.string().trim().min(1).max(256),
  platform: z.enum(["google", "meta", "tiktok", "other"]),
  country: z.string().min(1).max(64).optional(),
  product: z.string().min(1).max(256).optional(),
  copy: z.string().max(8_000).optional(),
  visualTheme: z.string().max(256).optional(),
  hook: z.string().max(512).optional(),
  cta: z.string().max(256).optional(),
  format: z.string().min(1).max(64).optional(),
  launchedAt: z.string().datetime().optional(),
  campaignIds: z.array(z.string().uuid()).max(256).default([]),
  metrics: z.object({
    spend: z.number().finite().nonnegative().optional(),
    ctr: z.number().finite().nonnegative().optional(),
    cpi: z.number().finite().nonnegative().optional(),
    cpa: z.number().finite().nonnegative().optional()
  }).strict().optional(),
  lifecycle: z.enum(["new", "active", "fatiguing", "retired"]).optional()
}).strict();

const CreativeLifecycleBody = z.object({
  workspaceId: WorkspaceId,
  lifecycle: z.enum(["new", "active", "fatiguing", "retired"])
}).strict();

const UacAnalyzeBody = z.object({
  workspaceId: WorkspaceId,
  kind: z.enum(["analyze", "decide"]),
  case: z.record(z.unknown()),
  question: z.string().min(1).max(4_000).optional()
}).strict();

const DailyBriefBody = z.object({
  workspaceId: WorkspaceId,
  projectId: z.string().uuid().optional(),
  facts: z.object({
    metrics: MetricsSnapshot,
    pendingReports: z.array(PendingReport).max(256).optional(),
    measurementIssues: z.array(MeasurementIssue).max(256).optional(),
    thresholds: DailyBriefThresholds.partial().optional()
  }).strict()
}).strict();

const IdParams = z.object({ id: z.string().min(1).max(128) });

/**
 * Advertising intelligence routes: account/campaign/creative registries, the
 * decision ledger with its lifecycle state machine, the Python UAC engine
 * bridge, and the deterministic Daily Brief. Everything is scoped by the
 * workspace (client) boundary.
 */
export function registerAdsRoutes(app: FastifyInstance, system: AdPilotSystem): void {
  const accountStore = new FileAdAccountStore(system.workspace.root);
  const campaignStore = new FileCampaignStore(system.workspace.root);
  const creativeStore = new FileCreativeAssetStore(system.workspace.root);
  const decisionService = new DecisionService(
    new FileAdvertisingDecisionStore(system.workspace.root),
    async (projectId) => (await system.kernel.getProject(projectId)) !== undefined
  );
  const uacEngine = new PythonUacEngine({
    ...(process.env.ADPILOT_UAC_PYTHON ? { pythonPath: process.env.ADPILOT_UAC_PYTHON } : {})
  });
  const dailyBriefs = new DailyBriefService();

  async function requireWorkspace(workspaceId: string): Promise<void> {
    await system.workspace.readClient(workspaceId);
  }

  async function requireProjectInWorkspace(projectId: string, workspaceId: string) {
    const project = await system.kernel.getProject(projectId);
    if (!project || project.workspaceId !== workspaceId) {
      throw new AdsIntelligenceError(`project not found in this workspace: ${projectId}`, "PROJECT_NOT_FOUND");
    }
    return project;
  }

  async function requireAccountInWorkspace(accountId: string, workspaceId: string): Promise<AdAccountValue> {
    const account = await accountStore.get(accountId);
    if (!account || account.workspaceId !== workspaceId) {
      throw new AdsIntelligenceError(`ad account not found in this workspace: ${accountId}`, "AD_ACCOUNT_NOT_FOUND");
    }
    return account;
  }

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

  app.get("/api/ads/accounts", async (request) => {
    const query = z.object({ workspaceId: WorkspaceId }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    return { accounts: await accountStore.list({ workspaceId: query.workspaceId }) };
  });

  app.post("/api/ads/accounts", async (request, reply) => {
    const body = AccountCreateBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const now = new Date().toISOString();
    const account = AdAccount.parse({
      id: randomUUID(),
      workspaceId: body.workspaceId,
      platform: body.platform,
      ...(body.externalId !== undefined ? { externalId: body.externalId } : {}),
      name: body.name,
      ...(body.currency !== undefined ? { currency: body.currency } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    await accountStore.save(account);
    reply.code(201);
    return account;
  });

  app.get("/api/ads/campaigns", async (request) => {
    const query = z.object({
      workspaceId: WorkspaceId,
      accountId: z.string().uuid().optional()
    }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    if (query.accountId) {
      await requireAccountInWorkspace(query.accountId, query.workspaceId);
      return { campaigns: await campaignStore.list({ accountId: query.accountId }) };
    }
    return { campaigns: await workspaceCampaigns(query.workspaceId) };
  });

  app.post("/api/ads/campaigns", async (request, reply) => {
    const body = CampaignCreateBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    await requireAccountInWorkspace(body.accountId, body.workspaceId);
    const now = new Date().toISOString();
    const campaign = CampaignEntity.parse({
      id: randomUUID(),
      accountId: body.accountId,
      ...(body.externalId !== undefined ? { externalId: body.externalId } : {}),
      name: body.name,
      ...(body.objective !== undefined ? { objective: body.objective } : {}),
      ...(body.optimizationEvent !== undefined ? { optimizationEvent: body.optimizationEvent } : {}),
      ...(body.budget !== undefined ? { budget: body.budget } : {}),
      ...(body.bid !== undefined ? { bid: body.bid } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    await campaignStore.save(campaign);
    reply.code(201);
    return campaign;
  });

  app.get("/api/ads/decisions", async (request) => {
    const query = z.object({
      workspaceId: WorkspaceId,
      projectId: z.string().uuid(),
      status: DecisionStatus.optional()
    }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    await requireProjectInWorkspace(query.projectId, query.workspaceId);
    const decisions = query.status
      ? (await decisionService.listByStatus(query.status)).filter((decision) => decision.projectId === query.projectId)
      : await decisionService.listByProject(query.projectId);
    return { decisions };
  });

  app.post("/api/ads/decisions", async (request, reply) => {
    const body = DecisionCreateBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    await requireProjectInWorkspace(body.projectId, body.workspaceId);
    const similar = await decisionService.findSimilarOpen(
      body.projectId,
      body.campaignId,
      hashRecommendation(body.recommendation)
    );
    if (similar) {
      return reply.code(409).send({
        error: `an open decision already covers this recommendation: ${similar.id}`,
        code: "DECISION_DUPLICATE",
        decision: similar
      });
    }
    const decision = await decisionService.createDecision({
      projectId: body.projectId,
      ...(body.campaignId !== undefined ? { campaignId: body.campaignId } : {}),
      recommendation: body.recommendation,
      rationale: body.rationale,
      evidenceIds: body.evidenceIds,
      confidence: body.confidence,
      risks: body.risks,
      ...(body.observationWindow !== undefined ? { observationWindow: body.observationWindow } : {}),
      ...(body.rollbackPlan !== undefined ? { rollbackPlan: body.rollbackPlan } : {})
    });
    reply.code(201);
    return decision;
  });

  app.post("/api/ads/decisions/:id/transition", async (request, reply) => {
    const params = IdParams.parse(request.params);
    const body = DecisionTransitionBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const current = await decisionService.getDecision(params.id);
    if (!current) {
      throw new AdsIntelligenceError(`decision not found: ${params.id}`, "DECISION_NOT_FOUND");
    }
    await requireProjectInWorkspace(current.projectId, body.workspaceId);
    const decision = await decisionService.transitionStatus(params.id, body.status);
    await system.audit.append({
      clientId: body.workspaceId,
      actor: "workspace-owner",
      action: "ads_decision_transition",
      status: "succeeded",
      details: { decisionId: decision.id, from: current.status, to: decision.status, revision: decision.revision }
    });
    return decision;
  });

  app.get("/api/ads/decisions/similar", async (request) => {
    const query = z.object({
      workspaceId: WorkspaceId,
      projectId: z.string().uuid(),
      campaignId: z.string().uuid().optional(),
      recommendation: z.string().min(1).max(4_000)
    }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    await requireProjectInWorkspace(query.projectId, query.workspaceId);
    const similar = await decisionService.findSimilarOpen(
      query.projectId,
      query.campaignId,
      hashRecommendation(query.recommendation)
    );
    return { similar: similar ?? null };
  });

  app.get("/api/ads/creatives", async (request) => {
    const query = z.object({
      workspaceId: WorkspaceId,
      accountId: z.string().uuid().optional()
    }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    if (query.accountId) {
      await requireAccountInWorkspace(query.accountId, query.workspaceId);
      return { creatives: await creativeStore.list({ accountId: query.accountId }) };
    }
    return { creatives: await workspaceCreatives(query.workspaceId) };
  });

  app.post("/api/ads/creatives", async (request, reply) => {
    const body = CreativeCreateBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    await requireAccountInWorkspace(body.accountId, body.workspaceId);
    const now = new Date().toISOString();
    const creative = CreativeAsset.parse({
      id: randomUUID(),
      accountId: body.accountId,
      name: body.name,
      platform: body.platform,
      ...(body.country !== undefined ? { country: body.country } : {}),
      ...(body.product !== undefined ? { product: body.product } : {}),
      ...(body.copy !== undefined ? { copy: body.copy } : {}),
      ...(body.visualTheme !== undefined ? { visualTheme: body.visualTheme } : {}),
      ...(body.hook !== undefined ? { hook: body.hook } : {}),
      ...(body.cta !== undefined ? { cta: body.cta } : {}),
      ...(body.format !== undefined ? { format: body.format } : {}),
      ...(body.launchedAt !== undefined ? { launchedAt: body.launchedAt } : {}),
      campaignIds: body.campaignIds,
      ...(body.metrics !== undefined ? { metrics: body.metrics } : {}),
      ...(body.lifecycle !== undefined ? { lifecycle: body.lifecycle } : {}),
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    await creativeStore.save(creative);
    reply.code(201);
    return creative;
  });

  app.post("/api/ads/creatives/:id/lifecycle", async (request) => {
    const params = IdParams.parse(request.params);
    const body = CreativeLifecycleBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const current = await creativeStore.get(params.id);
    if (!current) {
      throw new AdsIntelligenceError(`creative not found: ${params.id}`, "CREATIVE_NOT_FOUND");
    }
    await requireAccountInWorkspace(current.accountId, body.workspaceId);
    const next = CreativeAsset.parse({
      ...current,
      lifecycle: body.lifecycle,
      updatedAt: new Date().toISOString(),
      revision: current.revision + 1
    });
    await creativeStore.save(next);
    return next;
  });

  app.post("/api/ads/uac/analyze", async (request, reply) => {
    const body = UacAnalyzeBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    try {
      return await uacEngine.analyze({
        kind: body.kind,
        case: body.case,
        ...(body.question !== undefined ? { question: body.question } : {})
      });
    } catch (error) {
      if (error instanceof AdsIntelligenceError && error.code === UAC_ENGINE_UNAVAILABLE) {
        return reply.code(503).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.post("/api/ads/daily-brief", async (request, reply) => {
    const body = DailyBriefBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    if (body.projectId) await requireProjectInWorkspace(body.projectId, body.workspaceId);
    const [accounts, campaigns, creatives, experiments, projects] = await Promise.all([
      accountStore.list({ workspaceId: body.workspaceId }),
      workspaceCampaigns(body.workspaceId),
      workspaceCreatives(body.workspaceId),
      system.experiments.list(body.workspaceId),
      system.kernel.listProjects({ workspaceId: body.workspaceId })
    ]);
    const decisions = body.projectId
      ? await decisionService.listByProject(body.projectId)
      : (await Promise.all(projects.map((project) => decisionService.listByProject(project.id)))).flat();
    const brief = dailyBriefs.generate({
      workspaceId: body.workspaceId,
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      accounts,
      campaigns,
      creatives,
      metrics: body.facts.metrics,
      decisions,
      experiments,
      ...(body.facts.pendingReports !== undefined ? { pendingReports: body.facts.pendingReports } : {}),
      ...(body.facts.measurementIssues !== undefined ? { measurementIssues: body.facts.measurementIssues } : {}),
      ...(body.facts.thresholds !== undefined ? { thresholds: body.facts.thresholds } : {})
    });
    await system.audit.append({
      clientId: body.workspaceId,
      actor: "workspace-owner",
      action: "ads_daily_brief_generate",
      status: "succeeded",
      details: {
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        totalFindings: brief.summary.totalFindings,
        criticalCount: brief.summary.criticalCount
      }
    });
    return reply.send(brief);
  });
}
