import { randomUUID } from "node:crypto";
import { nextFireAt } from "./cron.js";
import {
  AppNotification,
  Automation,
  AutomationRun,
  RUN_LOG_LIMIT,
  actionIsMutating,
  automationActionFingerprint,
  IDEMPOTENCY_BLOCKING_STATUSES,
  type Automation as AutomationValue,
  type AutomationAction,
  type AutomationRun as AutomationRunValue,
  type AutomationRunLogEntry
} from "./entities.js";
import { AutomationsError } from "./errors.js";
import type { AutomationRunStore, AutomationStore, NotificationStore } from "./stores.js";

/** Injectable clock so tests can drive deterministic fire times. */
export interface AutomationClock {
  now(): Date;
}

const systemClock: AutomationClock = { now: () => new Date() };

/** What the action layer sees of an executing run. */
export interface AutomationActionContext {
  automation: AutomationValue;
  run: AutomationRunValue;
  /** Append a run-log entry (capped at RUN_LOG_LIMIT, oldest dropped). */
  log(message: string): void;
}

export type CreateTaskAction = { goalId?: string; title: string; description: string };

/**
 * Action executors injected by the composition root (the server). `notify` is
 * owned by the scheduler itself (it writes to the notification store); the
 * other two kinds bridge to their real subsystems.
 *
 * Executors may return any JSON-shaped value as the run result; an object
 * with a numeric `costUsd` contributes to the automation's daily cost guard.
 */
export interface AutomationActionExecutors {
  dailyBrief(input: Record<string, unknown>, context: AutomationActionContext): Promise<unknown>;
  createTask(task: CreateTaskAction, context: AutomationActionContext): Promise<unknown>;
}

export interface AutomationSchedulerDeps {
  automations: AutomationStore;
  runs: AutomationRunStore;
  notifications: NotificationStore;
  executors: AutomationActionExecutors;
  /**
   * Fail-closed check that an approval id names a real, consumed central
   * ApprovalService approval for this exact run context. `approveRun` never
   * executes without it passing, so a fabricated or replayed approvalId can
   * never release a gated mutation.
   */
  verifyApproval: AutomationApprovalVerifier;
  clock?: AutomationClock;
}

/** Context handed to the central-approval verifier for one release attempt. */
export interface AutomationApprovalContext {
  automation: AutomationValue;
  run: AutomationRunValue;
}

export type AutomationApprovalVerifier = (approvalId: string, context: AutomationApprovalContext) => Promise<void>;

/** Run results larger than this are replaced by a truncation marker. */
const RESULT_LIMIT_CHARS = 32_000;
const DAY_MS = 86_400_000;

/**
 * Drives automations: `tick()` fires due schedule slots, `runNow()` forces an
 * immediate attempt, `approveRun()` releases a mutation gated run. Every path
 * funnels through one dispatch pipeline so idempotency, the daily run/cost
 * guards, and the approval gate apply uniformly.
 *
 * Concurrency: the scheduler is single-process. A re-entrant `tick()` while a
 * previous one is still running is a no-op, and the same automation never
 * executes twice concurrently (an in-flight guard throws AUTOMATION_BUSY for
 * manual paths). The schedule advances exactly once per slot — catch-up never
 * replays missed slots.
 */
export class AutomationScheduler {
  private readonly clock: AutomationClock;
  private readonly inflight = new Set<string>();
  private ticking = false;

  constructor(private readonly deps: AutomationSchedulerDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Fire every active schedule-kind automation whose slot is due. */
  async tick(): Promise<AutomationRunValue[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const now = this.clock.now();
      const actives = await this.deps.automations.list({ state: "active" });
      const runs: AutomationRunValue[] = [];
      for (const candidate of actives) {
        if (candidate.trigger.kind !== "schedule") continue;
        if (!candidate.nextFireAt) continue;
        const slotMs = Date.parse(candidate.nextFireAt);
        if (slotMs > now.getTime()) continue;
        if (this.inflight.has(candidate.id)) continue;
        const run = await this.dispatch(candidate.id, new Date(slotMs), true);
        if (run) runs.push(run);
      }
      return runs;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Force an immediate run, bypassing the schedule but not the guards: the
   * idempotency bucket is derived from the current time, and the daily caps
   * and approval gate apply exactly as for a scheduled fire. The schedule
   * itself (nextFireAt) is left untouched.
   */
  async runNow(automationId: string): Promise<AutomationRunValue> {
    const automation = await this.requireAutomation(automationId);
    const run = await this.dispatch(automation.id, this.clock.now(), false);
    if (!run) throw new AutomationsError(`automation not found: ${automationId}`, "AUTOMATION_NOT_FOUND");
    return run;
  }

  /**
   * Release a waiting-approval run. `approvalId` must name a central
   * ApprovalService approval that the caller has already driven through
   * create → risk review → user approval → consume; the injected verifier
   * re-checks that here so a fabricated or replayed id always fails. The run
   * also re-pins its parked action fingerprint against the live automation
   * definition (APPROVAL_STALE) before anything executes.
   */
  async approveRun(runId: string, approvalId: string): Promise<AutomationRunValue> {
    if (!approvalId.trim()) {
      throw new AutomationsError("approvalId is required to approve a run", "APPROVAL_ID_REQUIRED");
    }
    const current = await this.deps.runs.get(runId);
    if (!current) throw new AutomationsError(`automation run not found: ${runId}`, "RUN_NOT_FOUND");
    if (current.status !== "waiting-approval") {
      throw new AutomationsError(
        `automation run ${runId} is not waiting for approval (status: ${current.status})`,
        "RUN_NOT_WAITING_APPROVAL"
      );
    }
    const automation = await this.requireAutomation(current.automationId);
    if (
      !current.actionFingerprint
      || current.actionFingerprint !== automationActionFingerprint(automation.action)
    ) {
      throw new AutomationsError(
        `automation action changed since run ${runId} was parked; run a fresh approval cycle`,
        "APPROVAL_STALE"
      );
    }
    await this.deps.verifyApproval(approvalId, { automation, run: current });
    if (this.inflight.has(automation.id)) {
      throw new AutomationsError(`automation is already executing: ${automation.id}`, "AUTOMATION_BUSY");
    }
    this.inflight.add(automation.id);
    try {
      let run = this.persisted({
        ...current,
        status: "running" as const,
        approvalId,
        runLog: appendLog(current.runLog, this.clock.now(), `approved by ${approvalId}`)
      });
      await this.deps.runs.save(run);
      run = await this.execute(automation, run);
      await this.bumpAutomationRunCount(automation, run.startedAt);
      return run;
    } finally {
      this.inflight.delete(automation.id);
    }
  }

  /**
   * Shared dispatch pipeline: dedupe → daily caps → approval gate → execute.
   * `triggerInstant` is the schedule slot (tick) or "now" (manual), and feeds
   * the idempotency bucket. `advanceSchedule` consumes the current slot.
   */
  private async dispatch(
    automationId: string,
    triggerInstant: Date,
    advanceSchedule: boolean
  ): Promise<AutomationRunValue | undefined> {
    const automation = await this.deps.automations.get(automationId);
    if (!automation) return undefined;
    if (this.inflight.has(automation.id)) {
      throw new AutomationsError(`automation is already executing: ${automation.id}`, "AUTOMATION_BUSY");
    }
    this.inflight.add(automation.id);
    try {
      const now = this.clock.now();
      const idempotencyKey = this.idempotencyKey(automation, triggerInstant);

      const duplicate = await this.findBlockingRun(automation.id, idempotencyKey);
      if (duplicate) {
        const run = this.newRun(automation, idempotencyKey, now, {
          status: "skipped-duplicate",
          finishedAt: now.toISOString(),
          runLog: [{ ts: now.toISOString(), message: `duplicate of run ${duplicate.id} within the idempotency window` }]
        });
        await this.deps.runs.save(run);
        if (advanceSchedule) await this.advanceSchedule(automation, now, false);
        return run;
      }

      const capHit = await this.dailyRunCapHit(automation, now);
      if (capHit) {
        const run = this.newRun(automation, idempotencyKey, now, {
          status: "failed",
          finishedAt: now.toISOString(),
          error: `daily run cap reached (${automation.guards.maxRunsPerDay} runs per day)`,
          runLog: [{ ts: now.toISOString(), message: "skipped: AUTOMATION_RUN_CAP" }]
        });
        await this.deps.runs.save(run);
        if (advanceSchedule) await this.advanceSchedule(automation, now, true);
        return run;
      }

      const costHit = await this.dailyCostCapHit(automation, now);
      if (costHit) {
        const run = this.newRun(automation, idempotencyKey, now, {
          status: "failed",
          finishedAt: now.toISOString(),
          error: `daily cost cap reached (${automation.guards.maxCostUsd} USD per day)`,
          runLog: [{ ts: now.toISOString(), message: "skipped: AUTOMATION_COST_EXCEEDED" }]
        });
        await this.deps.runs.save(run);
        if (advanceSchedule) await this.advanceSchedule(automation, now, true);
        return run;
      }

      if (actionIsMutating(automation.action) && automation.guards.requiresApprovalForMutation) {
        const run = this.newRun(automation, idempotencyKey, now, {
          status: "waiting-approval",
          actionFingerprint: automationActionFingerprint(automation.action),
          runLog: [{ ts: now.toISOString(), message: "mutating action parked: waiting for approval" }]
        });
        await this.deps.runs.save(run);
        if (advanceSchedule) await this.advanceSchedule(automation, now, true);
        else await this.touchLastRun(automation, run.startedAt);
        return run;
      }

      let run = this.newRun(automation, idempotencyKey, now, { status: "running" });
      await this.deps.runs.save(run);
      run = await this.execute(automation, run);
      await this.bumpAutomationRunCount(automation, run.startedAt);
      if (advanceSchedule) await this.advanceSchedule(automation, now, true);
      else await this.touchLastRun(automation, run.startedAt);
      return run;
    } finally {
      this.inflight.delete(automation.id);
    }
  }

  /** Run the action, persist the terminal state, and return the final run. */
  private async execute(automation: AutomationValue, run: AutomationRunValue): Promise<AutomationRunValue> {
    const entries = [...run.runLog];
    const context: AutomationActionContext = {
      automation,
      run,
      log: (message) => {
        entries.push({ ts: this.clock.now().toISOString(), message: message.slice(0, 2_000) });
      }
    };
    let terminal: Pick<AutomationRunValue, "status"> & { result?: unknown; error?: string };
    try {
      const result = await this.invokeAction(automation.action, context);
      context.log("action succeeded");
      terminal = { status: "succeeded", result: capResult(result) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      context.log(`action failed: ${message}`);
      terminal = { status: "failed", error: message.slice(0, 4_000) };
    }
    const finished = this.persisted({
      ...run,
      status: terminal.status,
      finishedAt: this.clock.now().toISOString(),
      runLog: entries.slice(-RUN_LOG_LIMIT),
      ...(terminal.result !== undefined ? { result: terminal.result } : {}),
      ...(terminal.error !== undefined ? { error: terminal.error } : {})
    });
    await this.deps.runs.save(finished);
    return finished;
  }

  private async invokeAction(action: AutomationAction, context: AutomationActionContext): Promise<unknown> {
    if (action.kind === "daily-brief") return this.deps.executors.dailyBrief(action.input, context);
    if (action.kind === "create-task") {
      return this.deps.executors.createTask({
        ...(action.task.goalId !== undefined ? { goalId: action.task.goalId } : {}),
        title: action.task.title,
        description: action.task.description
      }, context);
    }
    const now = this.clock.now().toISOString();
    const notification = AppNotification.parse({
      id: randomUUID(),
      workspaceId: context.automation.workspaceId,
      automationId: context.automation.id,
      runId: context.run.id,
      message: action.message,
      read: false,
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    await this.deps.notifications.save(notification);
    return { notificationId: notification.id };
  }

  private idempotencyKey(automation: AutomationValue, triggerInstant: Date): string {
    const bucket = Math.floor(triggerInstant.getTime() / (automation.idempotencyWindowSeconds * 1_000));
    return `${automation.id}:${bucket}`;
  }

  private async findBlockingRun(automationId: string, idempotencyKey: string): Promise<AutomationRunValue | undefined> {
    const existing = await this.deps.runs.list({ automationId, idempotencyKey });
    return existing.find((run) => (IDEMPOTENCY_BLOCKING_STATUSES as readonly string[]).includes(run.status));
  }

  /** Runs created in the current UTC day count toward the daily cap (duplicates excluded). */
  private async runsToday(automation: AutomationValue, now: Date): Promise<AutomationRunValue[]> {
    const dayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
    const runs = await this.deps.runs.list({ automationId: automation.id });
    return runs.filter((run) => run.status !== "skipped-duplicate" && Date.parse(run.startedAt) >= dayStart);
  }

  private async dailyRunCapHit(automation: AutomationValue, now: Date): Promise<boolean> {
    return (await this.runsToday(automation, now)).length >= automation.guards.maxRunsPerDay;
  }

  private async dailyCostCapHit(automation: AutomationValue, now: Date): Promise<boolean> {
    const cap = automation.guards.maxCostUsd;
    if (cap === undefined) return false;
    let spent = 0;
    for (const run of await this.runsToday(automation, now)) {
      const result = run.result;
      if (result && typeof result === "object" && typeof (result as { costUsd?: unknown }).costUsd === "number") {
        spent += (result as { costUsd: number }).costUsd;
      }
    }
    return spent >= cap;
  }

  private newRun(
    automation: AutomationValue,
    idempotencyKey: string,
    startedAt: Date,
    fields: {
      status: AutomationRunValue["status"];
      finishedAt?: string;
      error?: string;
      actionFingerprint?: string;
      runLog?: AutomationRunLogEntry[];
    }
  ): AutomationRunValue {
    const now = startedAt.toISOString();
    return AutomationRun.parse({
      id: randomUUID(),
      automationId: automation.id,
      idempotencyKey,
      startedAt: now,
      ...(fields.finishedAt !== undefined ? { finishedAt: fields.finishedAt } : {}),
      status: fields.status,
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.actionFingerprint !== undefined ? { actionFingerprint: fields.actionFingerprint } : {}),
      runLog: fields.runLog ?? [],
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
  }

  /** Re-parse through the schema so a persisted run always satisfies its invariants. */
  private persisted(run: AutomationRunValue): AutomationRunValue {
    return AutomationRun.parse({
      ...run,
      updatedAt: this.clock.now().toISOString(),
      revision: run.revision + 1
    });
  }

  /** Advance nextFireAt past `now` (catch-up never replays missed slots). */
  private async advanceSchedule(automation: AutomationValue, now: Date, countRun: boolean): Promise<void> {
    if (automation.trigger.kind !== "schedule") return;
    const next = nextFireAt(automation.trigger.cron, now);
    await this.saveAutomation(automation, {
      nextFireAt: next ? next.toISOString() : undefined,
      lastRunAt: countRun ? now.toISOString() : automation.lastRunAt
    });
  }

  private async touchLastRun(automation: AutomationValue, startedAt: string): Promise<void> {
    await this.saveAutomation(automation, { lastRunAt: startedAt });
  }

  private async bumpAutomationRunCount(automation: AutomationValue, startedAt: string): Promise<void> {
    await this.saveAutomation(automation, { runCount: automation.runCount + 1, lastRunAt: startedAt });
  }

  /**
   * Apply scheduler-owned fields onto the freshest stored record, so a pause
   * or edit that landed while the action executed is never clobbered.
   */
  private async saveAutomation(
    automation: AutomationValue,
    patch: { nextFireAt?: string | undefined; lastRunAt?: string | undefined; runCount?: number }
  ): Promise<void> {
    const fresh = (await this.deps.automations.get(automation.id)) ?? automation;
    const next = Automation.parse({
      ...fresh,
      nextFireAt: patch.nextFireAt !== undefined ? patch.nextFireAt : patch.nextFireAt === undefined && "nextFireAt" in patch ? undefined : fresh.nextFireAt,
      lastRunAt: patch.lastRunAt !== undefined ? patch.lastRunAt : fresh.lastRunAt,
      runCount: patch.runCount ?? fresh.runCount,
      updatedAt: this.clock.now().toISOString(),
      revision: fresh.revision + 1
    });
    await this.deps.automations.save(next);
  }

  private async requireAutomation(automationId: string): Promise<AutomationValue> {
    const automation = await this.deps.automations.get(automationId);
    if (!automation) throw new AutomationsError(`automation not found: ${automationId}`, "AUTOMATION_NOT_FOUND");
    return automation;
  }
}

function appendLog(entries: readonly AutomationRunLogEntry[], at: Date, message: string): AutomationRunLogEntry[] {
  return [...entries, { ts: at.toISOString(), message }].slice(-RUN_LOG_LIMIT);
}

function capResult(result: unknown): unknown {
  if (result === undefined) return undefined;
  try {
    if (JSON.stringify(result).length <= RESULT_LIMIT_CHARS) return result;
  } catch {
    // Unserializable results collapse to the truncation marker as well.
  }
  return { truncated: true };
}
