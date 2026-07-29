import { z } from "zod";
import { CronSpec } from "./cron.js";

/**
 * Automation domain entities: first-class scheduled / conditional actors of
 * the Universal Workspace. Same persistence contract as the kernel entities —
 * UUID primary key, ISO-8601 timestamps, monotonically increasing revision.
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
/* Trigger                                                                   */
/* ------------------------------------------------------------------------ */

export const AutomationTrigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), cron: CronSpec }).strict(),
  z.object({
    kind: z.literal("event"),
    event: z.string().trim().min(1).max(128),
    condition: z.string().trim().min(1).max(512).optional()
  }).strict()
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

/* ------------------------------------------------------------------------ */
/* Action                                                                    */
/* ------------------------------------------------------------------------ */

export const AutomationAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily-brief"), input: z.record(z.unknown()).default({}) }).strict(),
  z.object({
    kind: z.literal("create-task"),
    task: z.object({
      goalId: Uuid.optional(),
      title: z.string().trim().min(1).max(512),
      description: z.string().max(8_000).default("")
    }).strict()
  }).strict(),
  z.object({ kind: z.literal("notify"), message: z.string().trim().min(1).max(4_000) }).strict()
]);
export type AutomationAction = z.infer<typeof AutomationAction>;

/**
 * Actions that mutate domain state outside the automations package. When the
 * guard `requiresApprovalForMutation` is set, mutating actions park their run
 * in `waiting-approval` instead of executing.
 */
export function actionIsMutating(action: AutomationAction): boolean {
  return action.kind === "create-task";
}

/* ------------------------------------------------------------------------ */
/* Automation                                                                */
/* ------------------------------------------------------------------------ */

export const AutomationGuards = z.object({
  /** Executions (runs that actually entered the action) allowed per UTC day. */
  maxRunsPerDay: z.number().int().min(1).max(1_000).default(10),
  /** Cumulative executor-reported cost ceiling per UTC day; enforced pre-run. */
  maxCostUsd: z.number().finite().positive().optional(),
  /** Mutating actions require an explicit approval before executing. */
  requiresApprovalForMutation: z.literal(true)
}).strict();
export type AutomationGuards = z.infer<typeof AutomationGuards>;

export const AutomationState = z.enum(["active", "paused"]);
export type AutomationState = z.infer<typeof AutomationState>;

export const Automation = z.object({
  ...EntityBase,
  workspaceId: z.string().min(1),
  projectId: Uuid.optional(),
  title: z.string().trim().min(1).max(256),
  description: z.string().max(4_000).optional(),
  trigger: AutomationTrigger,
  action: AutomationAction,
  guards: AutomationGuards,
  state: AutomationState.default("active"),
  /**
   * Idempotency window, in seconds. The idempotency key of a run is
   * `automationId:floor(triggerInstant / window)`, so a second attempt inside
   * the same trigger period bucket is recorded as `skipped-duplicate`
   * instead of executing the action twice.
   */
  idempotencyWindowSeconds: z.number().int().min(1).max(31_536_000),
  nextFireAt: IsoTimestamp.optional(),
  lastRunAt: IsoTimestamp.optional(),
  /** Number of times the action actually executed (approval-gated runs count when approved). */
  runCount: z.number().int().min(0).default(0)
});
export type Automation = z.infer<typeof Automation>;

/* ------------------------------------------------------------------------ */
/* AutomationRun                                                             */
/* ------------------------------------------------------------------------ */

export const AutomationRunStatus = z.enum([
  "running",
  "succeeded",
  "failed",
  "skipped-duplicate",
  "waiting-approval"
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatus>;

/** Statuses that count as "the effect happened (or will)": they block re-execution under the same idempotency key. */
export const IDEMPOTENCY_BLOCKING_STATUSES: readonly AutomationRunStatus[] = [
  "running",
  "succeeded",
  "waiting-approval"
];

export const AutomationRunLogEntry = z.object({
  ts: IsoTimestamp,
  message: z.string().min(1).max(2_000)
}).strict();
export type AutomationRunLogEntry = z.infer<typeof AutomationRunLogEntry>;

/** Run logs are capped so a chatty executor cannot grow a run record without bound. */
export const RUN_LOG_LIMIT = 200;

export const AutomationRun = z.object({
  ...EntityBase,
  automationId: Uuid,
  idempotencyKey: z.string().min(1).max(256),
  startedAt: IsoTimestamp,
  finishedAt: IsoTimestamp.optional(),
  status: AutomationRunStatus,
  /** Approval reference recorded when a waiting-approval run is released. */
  approvalId: z.string().min(1).max(256).optional(),
  result: z.unknown().optional(),
  error: z.string().max(4_000).optional(),
  runLog: z.array(AutomationRunLogEntry).max(RUN_LOG_LIMIT).default([])
});
export type AutomationRun = z.infer<typeof AutomationRun>;

/* ------------------------------------------------------------------------ */
/* Notification                                                              */
/* ------------------------------------------------------------------------ */

export const AppNotification = z.object({
  ...EntityBase,
  workspaceId: z.string().min(1),
  automationId: Uuid.optional(),
  runId: Uuid.optional(),
  message: z.string().trim().min(1).max(4_000),
  read: z.boolean().default(false)
});
export type AppNotification = z.infer<typeof AppNotification>;
