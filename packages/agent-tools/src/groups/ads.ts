import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DailyBriefThresholds,
  DecisionConfidence,
  MeasurementIssue,
  MetricsSnapshot,
  PendingReport,
  UacAnalyzeRequest,
  hashRecommendation,
  listAdAccountsForWorkspace,
  listCampaignsForWorkspace,
  loadWorkspaceAdsSnapshot,
  requireAdAccountForWorkspace,
  requireCampaignForWorkspace,
  requireCreativeForWorkspace,
  type AdAccountStore,
  type AdvertisingDecisionValue,
  type CampaignStore,
  type CreativeAssetStore,
  type WorkspaceAdsSnapshot,
  type WorkspaceAdsStores,
  type WorkspaceCampaignStores,
  type WorkspaceCreativeStores
} from "@adpilot/ads-intelligence";
import type { AgentExecutionContext } from "../context.js";
import type { AgentToolDeps } from "../deps.js";
import type { AgentToolDefinition } from "../registry.js";
import { succeed } from "../result.js";
import { toolError } from "../errors.js";

const ThresholdsInput = DailyBriefThresholds.partial();
const EntityId = z.string().uuid();

/**
 * Ads tools: read the advertising account registry, run the deterministic UAC
 * engine, create advertising decisions, and generate the daily brief. The
 * account/campaign/creative stores are optional deps: without them the
 * registry tools answer with a recoverable STORE_NOT_CONFIGURED error instead
 * of fabricating account data.
 */
export function createAdsTools(): AgentToolDefinition[] {
  return [
    {
      name: "ads.list_accounts",
      description: "List the workspace's registered advertising accounts. Use to discover account ids before listing campaigns or assembling a brief.",
      capabilityPack: "ads",
      permission: "read",
      parameters: z.object({ platform: z.enum(["google", "meta", "tiktok", "other"]).optional() }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({ platform: z.enum(["google", "meta", "tiktok", "other"]).optional() }).parse(raw);
        await assertContextProjectOwned(ctx, deps);
        const store = requireAccountStore(deps);
        const scoped = await listAdAccountsForWorkspace(store, ctx.workspaceId);
        const accounts = params.platform === undefined
          ? scoped
          : scoped.filter((account) => account.platform === params.platform);
        return succeed("ads.list_accounts", ctx, { accounts, count: accounts.length });
      }
    },
    {
      name: "ads.list_campaigns",
      description: "List registered campaigns, optionally for one account. Use to ground spend/CPA analysis in the campaign registry.",
      capabilityPack: "ads",
      permission: "read",
      parameters: z.object({ accountId: EntityId.optional() }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({ accountId: EntityId.optional() }).parse(raw);
        await assertContextProjectOwned(ctx, deps);
        const stores = requireCampaignStores(deps);
        const campaigns = await listCampaignsForWorkspace(
          stores,
          ctx.workspaceId,
          params.accountId
        );
        return succeed("ads.list_campaigns", ctx, { campaigns, count: campaigns.length });
      }
    },
    {
      name: "ads.run_uac_analysis",
      description: "Run the deterministic Python UAC engine: kind=analyze for a full diagnosis, kind=decide for a Campaign Level Quick Decision card. Returns a recoverable error when the engine is unavailable — report that honestly instead of fabricating analysis.",
      capabilityPack: "ads",
      permission: "read",
      parameters: z.object({
        kind: z.enum(["analyze", "decide"]),
        case: z.record(z.string(), z.unknown()),
        question: z.string().min(1).max(4000).optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({
          kind: z.enum(["analyze", "decide"]),
          case: z.record(z.string(), z.unknown()),
          question: z.string().min(1).max(4000).optional()
        }).parse(raw);
        await assertContextProjectOwned(ctx, deps);
        if (!(await deps.ads.uac.isAvailable())) {
          throw toolError(
            "UAC_ENGINE_UNAVAILABLE",
            "the Python UAC engine is not available in this environment (python3 not runnable); tell the user the analysis needs the engine instead of approximating it"
          );
        }
        const result = await deps.ads.uac.analyze(UacAnalyzeRequest.parse({
          kind: params.kind,
          case: params.case,
          ...(params.question !== undefined ? { question: params.question } : {})
        }));
        return succeed("ads.run_uac_analysis", ctx, result);
      }
    },
    {
      name: "ads.create_decision",
      description: "Record an advertising decision (recommendation, rationale, evidence ids, confidence, risks, observation window, rollback plan) on the current project. An identical open recommendation returns the existing decision with duplicate=true instead of a second record.",
      capabilityPack: "ads",
      permission: "write",
      parameters: z.object({
        projectId: EntityId.optional(),
        campaignId: EntityId.optional(),
        recommendation: z.string().min(1),
        rationale: z.array(z.string().min(1)).optional(),
        evidenceIds: z.array(z.string().min(1)).optional(),
        confidence: DecisionConfidence,
        risks: z.array(z.string().min(1)).optional(),
        observationWindow: z.string().min(1).optional(),
        rollbackPlan: z.string().min(1).optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({
          projectId: EntityId.optional(),
          campaignId: EntityId.optional(),
          recommendation: z.string().min(1),
          rationale: z.array(z.string().min(1)).optional(),
          evidenceIds: z.array(z.string().min(1)).optional(),
          confidence: DecisionConfidence,
          risks: z.array(z.string().min(1)).optional(),
          observationWindow: z.string().min(1).optional(),
          rollbackPlan: z.string().min(1).optional()
        }).parse(raw);
        await assertContextProjectOwned(ctx, deps);
        const projectId = params.projectId ?? ctx.projectId;
        if (!projectId) {
          throw toolError("PROJECT_NOT_SELECTED", "no projectId was passed and the execution context has no current project");
        }
        await requireProjectOwned(projectId, ctx.workspaceId, deps);
        if (params.campaignId !== undefined) {
          await requireCampaignForWorkspace(
            requireCampaignStores(deps),
            ctx.workspaceId,
            params.campaignId
          );
        }
        await assertEvidenceReferencesOwned(params.evidenceIds ?? [], ctx.workspaceId, deps);
        const duplicate = await deps.ads.decisions.findSimilarOpen(projectId, params.campaignId, hashRecommendation(params.recommendation));
        if (duplicate) {
          await assertDecisionOwned(duplicate, projectId, ctx.workspaceId, deps);
          return succeed("ads.create_decision", ctx, { decision: duplicate, duplicate: true });
        }
        const decision = await deps.ads.decisions.createDecision({
          projectId,
          ...(params.campaignId !== undefined ? { campaignId: params.campaignId } : {}),
          recommendation: params.recommendation,
          ...(params.rationale !== undefined ? { rationale: params.rationale } : {}),
          ...(params.evidenceIds !== undefined ? { evidenceIds: params.evidenceIds } : {}),
          confidence: params.confidence,
          ...(params.risks !== undefined ? { risks: params.risks } : {}),
          ...(params.observationWindow !== undefined ? { observationWindow: params.observationWindow } : {}),
          ...(params.rollbackPlan !== undefined ? { rollbackPlan: params.rollbackPlan } : {})
        });
        return succeed("ads.create_decision", ctx, { decision, duplicate: false }, {
          evidenceIds: [`decision:${decision.id}`]
        });
      }
    },
    {
      name: "ads.generate_daily_brief",
      description: "Generate the deterministic daily brief (anomalies, creative fatigue, learning-phase risks, pending observations/approvals/reports, measurement issues). Facts come from the registered accounts/campaigns/creatives plus the metrics snapshot you pass; thresholds are optional rule overrides.",
      capabilityPack: "ads",
      permission: "read",
      parameters: z.object({
        projectId: EntityId.optional(),
        metrics: MetricsSnapshot.optional(),
        thresholds: ThresholdsInput.optional(),
        pendingReports: z.array(PendingReport).optional(),
        measurementIssues: z.array(MeasurementIssue).optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({
          projectId: EntityId.optional(),
          metrics: MetricsSnapshot.optional(),
          thresholds: ThresholdsInput.optional(),
          pendingReports: z.array(PendingReport).optional(),
          measurementIssues: z.array(MeasurementIssue).optional()
        }).parse(raw);
        await assertContextProjectOwned(ctx, deps);
        const projectId = params.projectId ?? ctx.projectId;
        if (projectId !== undefined) {
          await requireProjectOwned(projectId, ctx.workspaceId, deps);
        }
        const snapshot = await loadWorkspaceAdsSnapshot(requireAdsStores(deps), ctx.workspaceId);
        const decisions = projectId !== undefined ? await deps.ads.decisions.listByProject(projectId) : [];
        for (const decision of decisions) {
          await assertDecisionOwned(decision, projectId!, ctx.workspaceId, deps, snapshot);
        }
        const metrics = params.metrics ?? MetricsSnapshot.parse({});
        await assertBriefReferencesOwned(
          metrics,
          params.measurementIssues ?? [],
          params.pendingReports ?? [],
          decisions,
          snapshot,
          ctx.workspaceId,
          deps
        );
        const brief = deps.ads.brief.generate({
          workspaceId: ctx.workspaceId,
          ...(projectId !== undefined ? { projectId } : {}),
          accounts: snapshot.accounts,
          campaigns: snapshot.campaigns,
          creatives: snapshot.creatives,
          metrics,
          decisions,
          experiments: [],
          ...(params.pendingReports !== undefined ? { pendingReports: params.pendingReports } : {}),
          ...(params.measurementIssues !== undefined ? { measurementIssues: params.measurementIssues } : {}),
          ...(params.thresholds !== undefined ? { thresholds: params.thresholds } : {}),
          now: deps.now()
        });
        return succeed("ads.generate_daily_brief", ctx, { brief });
      }
    },
    {
      name: "ads.record_observation",
      description: "Register one observation into the workspace audit trail (the daily-brief input ledger) and return its observation id to cite as evidence in decisions and briefs. Use for facts you observed that later runs should account for.",
      capabilityPack: "ads",
      permission: "write",
      parameters: z.object({
        subject: z.string().min(1),
        detail: z.string().min(1),
        severity: z.enum(["info", "warning", "critical"]).optional(),
        evidenceIds: z.array(z.string().min(1)).optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({
          subject: z.string().min(1),
          detail: z.string().min(1),
          severity: z.enum(["info", "warning", "critical"]).optional(),
          evidenceIds: z.array(z.string().min(1)).optional()
        }).parse(raw);
        await assertContextProjectOwned(ctx, deps);
        await assertKnownEntityReferenceOwned(params.subject, ctx.workspaceId, deps);
        await assertEvidenceReferencesOwned(params.evidenceIds ?? [], ctx.workspaceId, deps);
        const observationId = `observation:${randomUUID()}`;
        // The lifecycle audits this call with the (redacted) parameters, so the
        // observation lands in the workspace's hash-chained audit trail — the
        // ledger daily-brief assembly reads from. Record the id explicitly too.
        const auditEventId = await deps.audit(ctx.workspaceId, "agent_tool:ads.observation", {
          observationId,
          subject: params.subject,
          severity: params.severity ?? "info",
          detailLength: params.detail.length,
          evidenceIds: params.evidenceIds ?? [],
          ...(ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
          sessionId: ctx.sessionId
        });
        return succeed("ads.record_observation", ctx, { observationId, auditEventId }, {
          evidenceIds: [observationId, ...(params.evidenceIds ?? [])]
        });
      }
    }
  ];
}

function requireAccountStore(deps: AgentToolDeps): AdAccountStore {
  const store = deps.ads.stores?.accounts;
  if (!store) {
    throw toolError(
      "STORE_NOT_CONFIGURED",
      "the ads account store is required for workspace ownership checks"
    );
  }
  return store;
}

function requireCampaignStore(deps: AgentToolDeps): CampaignStore {
  const store = deps.ads.stores?.campaigns;
  if (!store) {
    throw toolError(
      "STORE_NOT_CONFIGURED",
      "the ads campaign store is required for workspace ownership checks"
    );
  }
  return store;
}

function requireCreativeStore(deps: AgentToolDeps): CreativeAssetStore {
  const store = deps.ads.stores?.creatives;
  if (!store) {
    throw toolError(
      "STORE_NOT_CONFIGURED",
      "the ads creative store is required for workspace ownership checks"
    );
  }
  return store;
}

function requireCampaignStores(deps: AgentToolDeps): WorkspaceCampaignStores {
  return {
    accounts: requireAccountStore(deps),
    campaigns: requireCampaignStore(deps)
  };
}

function requireCreativeStores(deps: AgentToolDeps): WorkspaceCreativeStores {
  return {
    accounts: requireAccountStore(deps),
    creatives: requireCreativeStore(deps)
  };
}

function requireAdsStores(deps: AgentToolDeps): WorkspaceAdsStores {
  return {
    ...requireCampaignStores(deps),
    creatives: requireCreativeStore(deps)
  };
}

async function assertContextProjectOwned(
  ctx: AgentExecutionContext,
  deps: AgentToolDeps
): Promise<void> {
  if (ctx.projectId !== undefined) {
    await requireProjectOwned(ctx.projectId, ctx.workspaceId, deps);
  }
}

async function requireProjectOwned(
  projectId: string,
  workspaceId: string,
  deps: AgentToolDeps
): Promise<void> {
  if (!EntityId.safeParse(projectId).success) {
    throw toolError(
      "PROJECT_NOT_FOUND",
      `project not found in workspace: ${projectId}`
    );
  }
  const project = await deps.kernel.getProject(projectId);
  if (!project || project.workspaceId !== workspaceId) {
    throw toolError(
      "PROJECT_NOT_FOUND",
      `project not found in workspace: ${projectId}`
    );
  }
}

async function assertDecisionOwned(
  decision: AdvertisingDecisionValue,
  expectedProjectId: string,
  workspaceId: string,
  deps: AgentToolDeps,
  snapshot?: WorkspaceAdsSnapshot
): Promise<void> {
  if (decision.projectId !== expectedProjectId) {
    throw toolError(
      "ADS_STORE_SCOPE_DENIED",
      "decision store returned a record outside the requested project"
    );
  }
  await requireProjectOwned(decision.projectId, workspaceId, deps);
  if (decision.campaignId !== undefined) {
    if (snapshot !== undefined) {
      if (!snapshot.campaigns.some((campaign) => campaign.id === decision.campaignId)) {
        throw toolError(
          "DECISION_NOT_FOUND",
          `decision not found in workspace: ${decision.id}`
        );
      }
    } else {
      await requireCampaignForWorkspace(
        requireCampaignStores(deps),
        workspaceId,
        decision.campaignId
      );
    }
  }
  await assertEvidenceReferencesOwned(
    decision.evidenceIds,
    workspaceId,
    deps,
    snapshot
  );
}

async function assertBriefReferencesOwned(
  metrics: z.infer<typeof MetricsSnapshot>,
  measurementIssues: readonly z.infer<typeof MeasurementIssue>[],
  pendingReports: readonly z.infer<typeof PendingReport>[],
  decisions: readonly AdvertisingDecisionValue[],
  snapshot: WorkspaceAdsSnapshot,
  workspaceId: string,
  deps: AgentToolDeps
): Promise<void> {
  const accounts = new Map(snapshot.accounts.map((account) => [account.id, account]));
  const campaigns = new Map(snapshot.campaigns.map((campaign) => [campaign.id, campaign]));
  const creatives = new Map(snapshot.creatives.map((creative) => [creative.id, creative]));
  for (const row of metrics.accounts) {
    if (!accounts.has(row.accountId)) {
      throw scopedReferenceNotFound("account", row.accountId);
    }
    await assertEvidenceReferencesOwned(row.evidenceIds ?? [], workspaceId, deps, snapshot);
  }
  for (const row of metrics.campaigns) {
    if (!campaigns.has(row.campaignId)) {
      throw scopedReferenceNotFound("campaign", row.campaignId);
    }
    await assertEvidenceReferencesOwned(row.evidenceIds ?? [], workspaceId, deps, snapshot);
  }
  for (const row of metrics.creatives) {
    if (!creatives.has(row.creativeId)) {
      throw scopedReferenceNotFound("creative", row.creativeId);
    }
    await assertEvidenceReferencesOwned(row.evidenceIds ?? [], workspaceId, deps, snapshot);
  }
  for (const issue of measurementIssues) {
    const account = issue.accountId === undefined ? undefined : accounts.get(issue.accountId);
    const campaign = issue.campaignId === undefined ? undefined : campaigns.get(issue.campaignId);
    if (issue.accountId !== undefined && !account) {
      throw scopedReferenceNotFound("account", issue.accountId);
    }
    if (issue.campaignId !== undefined && !campaign) {
      throw scopedReferenceNotFound("campaign", issue.campaignId);
    }
    if (account && campaign && campaign.accountId !== account.id) {
      throw toolError(
        "ADS_REFERENCE_NOT_FOUND",
        "measurement issue account and campaign do not share an owner"
      );
    }
    await assertEvidenceReferencesOwned(issue.evidenceIds ?? [], workspaceId, deps, snapshot);
  }
  for (const report of pendingReports) {
    await assertEvidenceReferencesOwned(report.evidenceIds ?? [], workspaceId, deps, snapshot);
  }
  // Decision ownership itself was checked before this call; repeat only the
  // evidence walk here so every caller-supplied or persisted reference is
  // constrained to the same snapshot.
  for (const decision of decisions) {
    await assertEvidenceReferencesOwned(decision.evidenceIds, workspaceId, deps, snapshot);
  }
}

async function assertEvidenceReferencesOwned(
  evidenceIds: readonly string[],
  workspaceId: string,
  deps: AgentToolDeps,
  snapshot?: WorkspaceAdsSnapshot
): Promise<void> {
  for (const evidenceId of evidenceIds) {
    await assertKnownEntityReferenceOwned(evidenceId, workspaceId, deps, snapshot);
  }
}

/**
 * Evidence types such as screenshot:, fact:, observation:, and audit: are
 * opaque handles owned by other workspace-scoped ledgers, so this layer does
 * not dereference them. Known ads/kernel entity references are resolved here
 * and fail closed. This preserves existing evidence strings while preventing
 * an Agent from smuggling a foreign ads entity into a decision or brief.
 */
async function assertKnownEntityReferenceOwned(
  reference: string,
  workspaceId: string,
  deps: AgentToolDeps,
  snapshot?: WorkspaceAdsSnapshot
): Promise<void> {
  const separator = reference.indexOf(":");
  if (separator < 0) return;
  const kind = reference.slice(0, separator);
  if (!["account", "campaign", "creative", "decision", "project"].includes(kind)) return;
  const id = reference.slice(separator + 1);
  if (!EntityId.safeParse(id).success) {
    throw toolError(
      "ADS_REFERENCE_INVALID",
      `invalid ${kind} evidence reference`
    );
  }
  if (kind === "project") {
    await requireProjectOwned(id, workspaceId, deps);
    return;
  }
  if (kind === "account") {
    if (snapshot !== undefined) {
      if (!snapshot.accounts.some((account) => account.id === id)) {
        throw scopedReferenceNotFound(kind, id);
      }
      return;
    }
    await requireAdAccountForWorkspace(requireAccountStore(deps), workspaceId, id);
    return;
  }
  if (kind === "campaign") {
    if (snapshot !== undefined) {
      if (!snapshot.campaigns.some((campaign) => campaign.id === id)) {
        throw scopedReferenceNotFound(kind, id);
      }
      return;
    }
    await requireCampaignForWorkspace(requireCampaignStores(deps), workspaceId, id);
    return;
  }
  if (kind === "creative") {
    if (snapshot !== undefined) {
      if (!snapshot.creatives.some((creative) => creative.id === id)) {
        throw scopedReferenceNotFound(kind, id);
      }
      return;
    }
    await requireCreativeForWorkspace(requireCreativeStores(deps), workspaceId, id);
    return;
  }
  const decision = await deps.ads.decisions.getDecision(id);
  if (!decision) {
    throw scopedReferenceNotFound(kind, id);
  }
  await requireProjectOwned(decision.projectId, workspaceId, deps);
  if (decision.campaignId !== undefined) {
    if (snapshot !== undefined) {
      if (!snapshot.campaigns.some((campaign) => campaign.id === decision.campaignId)) {
        throw scopedReferenceNotFound(kind, id);
      }
    } else {
      await requireCampaignForWorkspace(
        requireCampaignStores(deps),
        workspaceId,
        decision.campaignId
      );
    }
  }
}

function scopedReferenceNotFound(kind: string, id: string): Error {
  return toolError(
    "ADS_REFERENCE_NOT_FOUND",
    `${kind} reference not found in workspace: ${id}`
  );
}
