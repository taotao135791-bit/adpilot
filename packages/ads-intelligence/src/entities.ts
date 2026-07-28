import { z } from "zod";

/**
 * Ads intelligence domain entities.
 *
 * Persistence follows the kernel discipline (see packages/kernel/src/entities.ts):
 * a UUID primary key, ISO-8601 createdAt/updatedAt timestamps, and a
 * monotonically increasing `revision` (starts at 1, bumped on each mutation).
 */

const IsoTimestamp = z.string().datetime();
const Uuid = z.string().uuid();
const Revision = z.number().int().min(1);

const EntityBase = {
  id: Uuid,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  revision: Revision
} as const;

/* ------------------------------------------------------------------------ */
/* AdAccount                                                                 */
/* ------------------------------------------------------------------------ */

export const AdPlatform = z.enum(["google", "meta", "tiktok", "other"]);
export type AdPlatform = z.infer<typeof AdPlatform>;

export const AdAccount = z.object({
  ...EntityBase,
  workspaceId: z.string().min(1),
  platform: AdPlatform,
  externalId: z.string().min(1).optional(),
  name: z.string().min(1),
  currency: z.string().min(1).optional(),
  timezone: z.string().min(1).optional()
});
export type AdAccount = z.infer<typeof AdAccount>;

/* ------------------------------------------------------------------------ */
/* CampaignEntity                                                            */
/* ------------------------------------------------------------------------ */

export const CampaignEntity = z.object({
  ...EntityBase,
  accountId: Uuid,
  externalId: z.string().min(1).optional(),
  name: z.string().min(1),
  objective: z.string().min(1).optional(),
  optimizationEvent: z.string().min(1).optional(),
  budget: z.number().nonnegative().optional(),
  bid: z.number().nonnegative().optional(),
  status: z.string().min(1).optional()
});
export type CampaignEntity = z.infer<typeof CampaignEntity>;

/* ------------------------------------------------------------------------ */
/* AdvertisingDecision                                                       */
/* ------------------------------------------------------------------------ */

export const DecisionConfidence = z.enum(["low", "medium", "high"]);
export type DecisionConfidence = z.infer<typeof DecisionConfidence>;

export const DecisionStatus = z.enum([
  "proposed",
  "approved",
  "executed",
  "observing",
  "successful",
  "failed",
  "reverted"
]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

export const AdvertisingDecision = z.object({
  ...EntityBase,
  projectId: Uuid,
  campaignId: Uuid.optional(),
  recommendation: z.string().min(1),
  rationale: z.array(z.string().min(1)).default([]),
  /** Shared Fact / evidence ids this decision is grounded in. */
  evidenceIds: z.array(z.string().min(1)).default([]),
  confidence: DecisionConfidence,
  risks: z.array(z.string().min(1)).default([]),
  observationWindow: z.string().min(1).optional(),
  rollbackPlan: z.string().min(1).optional(),
  status: DecisionStatus.default("proposed")
});
export type AdvertisingDecision = z.infer<typeof AdvertisingDecision>;

/* ------------------------------------------------------------------------ */
/* CreativeAsset                                                             */
/* ------------------------------------------------------------------------ */

export const CreativeLifecycle = z.enum(["new", "active", "fatiguing", "retired"]);
export type CreativeLifecycle = z.infer<typeof CreativeLifecycle>;

export const CreativeMetrics = z.object({
  spend: z.number().nonnegative().optional(),
  ctr: z.number().nonnegative().optional(),
  cpi: z.number().nonnegative().optional(),
  cpa: z.number().nonnegative().optional()
});
export type CreativeMetrics = z.infer<typeof CreativeMetrics>;

export const CreativeAsset = z.object({
  ...EntityBase,
  accountId: Uuid,
  name: z.string().min(1),
  platform: AdPlatform,
  country: z.string().min(1).optional(),
  product: z.string().min(1).optional(),
  copy: z.string().optional(),
  visualTheme: z.string().optional(),
  hook: z.string().optional(),
  cta: z.string().optional(),
  format: z.string().min(1).optional(),
  launchedAt: IsoTimestamp.optional(),
  campaignIds: z.array(Uuid).default([]),
  metrics: CreativeMetrics.optional(),
  lifecycle: CreativeLifecycle.optional()
});
export type CreativeAsset = z.infer<typeof CreativeAsset>;
