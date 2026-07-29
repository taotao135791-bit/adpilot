import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DailyBriefThresholds,
  DecisionConfidence,
  MeasurementIssue,
  MetricsSnapshot,
  PendingReport,
  UacAnalyzeRequest,
  hashRecommendation
} from "@adpilot/ads-intelligence";
import type { AgentToolDefinition } from "../registry.js";
import { succeed } from "../result.js";
import { toolError } from "../errors.js";

const ThresholdsInput = DailyBriefThresholds.partial();

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
        const store = deps.ads.stores?.accounts;
        if (!store) throw toolError("STORE_NOT_CONFIGURED", "the ads account store is not wired into this execution context");
        const accounts = await store.list({
          workspaceId: ctx.workspaceId,
          ...(params.platform !== undefined ? { platform: params.platform } : {})
        });
        return succeed("ads.list_accounts", ctx, { accounts, count: accounts.length });
      }
    },
    {
      name: "ads.list_campaigns",
      description: "List registered campaigns, optionally for one account. Use to ground spend/CPA analysis in the campaign registry.",
      capabilityPack: "ads",
      permission: "read",
      parameters: z.object({ accountId: z.string().min(1).optional() }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({ accountId: z.string().min(1).optional() }).parse(raw);
        const store = deps.ads.stores?.campaigns;
        if (!store) throw toolError("STORE_NOT_CONFIGURED", "the ads campaign store is not wired into this execution context");
        const campaigns = await store.list(params.accountId !== undefined ? { accountId: params.accountId } : {});
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
        projectId: z.string().min(1).optional(),
        campaignId: z.string().min(1).optional(),
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
          projectId: z.string().min(1).optional(),
          campaignId: z.string().min(1).optional(),
          recommendation: z.string().min(1),
          rationale: z.array(z.string().min(1)).optional(),
          evidenceIds: z.array(z.string().min(1)).optional(),
          confidence: DecisionConfidence,
          risks: z.array(z.string().min(1)).optional(),
          observationWindow: z.string().min(1).optional(),
          rollbackPlan: z.string().min(1).optional()
        }).parse(raw);
        const projectId = params.projectId ?? ctx.projectId;
        if (!projectId) {
          throw toolError("PROJECT_NOT_SELECTED", "no projectId was passed and the execution context has no current project");
        }
        const duplicate = await deps.ads.decisions.findSimilarOpen(projectId, params.campaignId, hashRecommendation(params.recommendation));
        if (duplicate) {
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
        projectId: z.string().min(1).optional(),
        metrics: MetricsSnapshot.optional(),
        thresholds: ThresholdsInput.optional(),
        pendingReports: z.array(PendingReport).optional(),
        measurementIssues: z.array(MeasurementIssue).optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({
          projectId: z.string().min(1).optional(),
          metrics: MetricsSnapshot.optional(),
          thresholds: ThresholdsInput.optional(),
          pendingReports: z.array(PendingReport).optional(),
          measurementIssues: z.array(MeasurementIssue).optional()
        }).parse(raw);
        const projectId = params.projectId ?? ctx.projectId;
        const accounts = deps.ads.stores?.accounts ? await deps.ads.stores.accounts.list({ workspaceId: ctx.workspaceId }) : [];
        const campaigns = deps.ads.stores?.campaigns ? await deps.ads.stores.campaigns.list() : [];
        const creatives = deps.ads.stores?.creatives ? await deps.ads.stores.creatives.list() : [];
        const decisions = projectId !== undefined ? await deps.ads.decisions.listByProject(projectId) : [];
        const brief = deps.ads.brief.generate({
          workspaceId: ctx.workspaceId,
          ...(projectId !== undefined ? { projectId } : {}),
          accounts,
          campaigns,
          creatives,
          metrics: params.metrics ?? MetricsSnapshot.parse({}),
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
