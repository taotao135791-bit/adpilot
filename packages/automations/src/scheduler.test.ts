import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Automation, type Automation as AutomationValue } from "./entities.js";
import { AutomationsError } from "./errors.js";
import { AutomationScheduler, type AutomationActionContext } from "./scheduler.js";
import { FileAutomationRunStore, FileAutomationStore, FileNotificationStore } from "./stores.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Mutable clock the test drives explicitly. */
function makeClock(startIso: string) {
  let current = Date.parse(startIso);
  return {
    clock: { now: () => new Date(current) },
    set(iso: string) { current = Date.parse(iso); },
    advance(ms: number) { current += ms; }
  };
}

function makeAutomation(overrides: Record<string, unknown> = {}): AutomationValue {
  const now = "2026-07-28T00:00:00.000Z";
  return Automation.parse({
    id: randomUUID(),
    workspaceId: "personal",
    title: "Test automation",
    trigger: { kind: "schedule", cron: { minute: "*", hour: "*", dom: "*", month: "*", dow: "*" } },
    action: { kind: "notify", message: "hello" },
    guards: { maxRunsPerDay: 10, requiresApprovalForMutation: true },
    state: "active",
    idempotencyWindowSeconds: 3_600,
    runCount: 0,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    ...overrides
  });
}

async function makeScheduler(startIso: string, options: { verifyApproval?: (approvalId: string) => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "adpilot-automations-"));
  roots.push(root);
  const { clock, set, advance } = makeClock(startIso);
  const automations = new FileAutomationStore(root);
  const runs = new FileAutomationRunStore(root);
  const notifications = new FileNotificationStore(root);
  const dailyBrief = vi.fn(async (_input: Record<string, unknown>, _context: AutomationActionContext) => ({ findings: 3 }));
  const createTask = vi.fn(async (task: { title: string }, _context: AutomationActionContext) => ({ taskId: `task-${task.title}` }));
  const verifyApproval = vi.fn(options.verifyApproval ?? (async () => undefined));
  const scheduler = new AutomationScheduler({
    automations,
    runs,
    notifications,
    clock,
    executors: { dailyBrief, createTask },
    verifyApproval
  });
  return { scheduler, automations, runs, notifications, dailyBrief, createTask, verifyApproval, set, advance };
}

describe("AutomationScheduler", () => {
  it("fires a due schedule slot exactly once and advances nextFireAt", async () => {
    const { scheduler, automations, dailyBrief } = await makeScheduler("2026-07-28T09:00:30.000Z");
    const automation = makeAutomation({
      trigger: { kind: "schedule", cron: { minute: "0", hour: "9", dom: "*", month: "*", dow: "*" } },
      action: { kind: "daily-brief", input: {} },
      nextFireAt: "2026-07-28T09:00:00.000Z"
    });
    await automations.save(automation);

    const runs = await scheduler.tick();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", automationId: automation.id, result: { findings: 3 } });
    expect(dailyBrief).toHaveBeenCalledTimes(1);

    const updated = await automations.get(automation.id);
    expect(updated?.nextFireAt).toBe("2026-07-29T09:00:00.000Z");
    expect(updated?.runCount).toBe(1);
    expect(updated?.lastRunAt).toBe(runs[0]?.startedAt);

    // A second tick in the same period does nothing: the slot was consumed.
    expect(await scheduler.tick()).toHaveLength(0);
    expect(dailyBrief).toHaveBeenCalledTimes(1);
  });

  it("records skipped-duplicate instead of re-executing inside the idempotency window", async () => {
    const { scheduler, automations, runs, dailyBrief, advance } = await makeScheduler("2026-07-28T09:00:05.000Z");
    const automation = makeAutomation({
      action: { kind: "daily-brief", input: {} },
      nextFireAt: "2026-07-28T09:00:00.000Z"
    });
    await automations.save(automation);
    await scheduler.tick();
    expect(dailyBrief).toHaveBeenCalledTimes(1);

    // Simulate a crash/reload double-delivery: the same slot becomes due again.
    advance(1_000);
    const stale = (await automations.get(automation.id))!;
    await automations.save(Automation.parse({
      ...stale,
      nextFireAt: "2026-07-28T09:00:00.000Z",
      revision: stale.revision + 1
    }));
    const second = await scheduler.tick();
    expect(second).toHaveLength(1);
    expect(second[0]?.status).toBe("skipped-duplicate");
    expect(dailyBrief).toHaveBeenCalledTimes(1);

    // Manual run-now inside the same window dedupes the same way.
    advance(1_000);
    const manual = await scheduler.runNow(automation.id);
    expect(manual.status).toBe("skipped-duplicate");
    expect(dailyBrief).toHaveBeenCalledTimes(1);

    const all = await runs.list({ automationId: automation.id });
    expect(all.map((run) => run.status)).toEqual(["succeeded", "skipped-duplicate", "skipped-duplicate"]);
  });

  it("never fires a paused automation", async () => {
    const { scheduler, automations, dailyBrief } = await makeScheduler("2026-07-28T09:00:30.000Z");
    const automation = makeAutomation({
      action: { kind: "daily-brief", input: {} },
      state: "paused",
      nextFireAt: "2026-07-28T09:00:00.000Z"
    });
    await automations.save(automation);
    expect(await scheduler.tick()).toHaveLength(0);
    expect(dailyBrief).not.toHaveBeenCalled();
  });

  it("enforces maxRunsPerDay across manual and scheduled attempts", async () => {
    const { scheduler, automations, createTask, advance } = await makeScheduler("2026-07-28T00:00:00.000Z");
    const automation = makeAutomation({
      action: { kind: "notify", message: "ping" },
      guards: { maxRunsPerDay: 1, requiresApprovalForMutation: true }
    });
    await automations.save(automation);
    void createTask;

    const first = await scheduler.runNow(automation.id);
    expect(first.status).toBe("succeeded");

    // Move past the idempotency window so dedupe is not what blocks us.
    advance(2 * 3_600_000);
    const capped = await scheduler.runNow(automation.id);
    expect(capped.status).toBe("failed");
    expect(capped.error).toContain("daily run cap");
  });

  it("parks mutating actions in waiting-approval and executes only after approveRun", async () => {
    const { scheduler, automations, createTask, verifyApproval } = await makeScheduler("2026-07-28T09:00:30.000Z");
    const automation = makeAutomation({
      trigger: { kind: "schedule", cron: { minute: "0", hour: "9", dom: "*", month: "*", dow: "*" } },
      action: { kind: "create-task", task: { title: "Review CPA", description: "check daily spend" } },
      nextFireAt: "2026-07-28T09:00:00.000Z"
    });
    await automations.save(automation);

    const [parked] = await scheduler.tick();
    expect(parked?.status).toBe("waiting-approval");
    expect(parked?.actionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(createTask).not.toHaveBeenCalled();
    // The schedule still advanced: the slot is consumed by the parked run.
    expect((await automations.get(automation.id))?.nextFireAt).toBe("2026-07-29T09:00:00.000Z");

    const approved = await scheduler.approveRun(parked!.id, "approval-123");
    expect(approved.status).toBe("succeeded");
    expect(approved.approvalId).toBe("approval-123");
    expect(approved.result).toEqual({ taskId: "task-Review CPA" });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(verifyApproval).toHaveBeenCalledWith("approval-123", expect.objectContaining({
      automation: expect.objectContaining({ id: automation.id }),
      run: expect.objectContaining({ id: parked!.id })
    }));
    expect((await automations.get(automation.id))?.runCount).toBe(1);

    await expect(scheduler.approveRun(parked!.id, "approval-456")).rejects.toMatchObject({
      code: "RUN_NOT_WAITING_APPROVAL"
    });
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("rejects a fabricated approvalId without executing the parked run", async () => {
    const { scheduler, automations, runs, createTask } = await makeScheduler("2026-07-28T09:00:30.000Z", {
      verifyApproval: async (approvalId) => {
        throw new AutomationsError(`approvalId is not a consumed central approval: ${approvalId}`, "APPROVAL_INVALID");
      }
    });
    const automation = makeAutomation({
      action: { kind: "create-task", task: { title: "Review CPA", description: "check daily spend" } },
      nextFireAt: "2026-07-28T09:00:00.000Z"
    });
    await automations.save(automation);

    const [parked] = await scheduler.tick();
    expect(parked?.status).toBe("waiting-approval");

    await expect(scheduler.approveRun(parked!.id, crypto.randomUUID())).rejects.toMatchObject({
      code: "APPROVAL_INVALID"
    });
    expect(createTask).not.toHaveBeenCalled();
    expect((await runs.get(parked!.id))?.status).toBe("waiting-approval");
    expect((await runs.get(parked!.id))?.approvalId).toBeUndefined();
  });

  it("rejects approval with APPROVAL_STALE when the action changed after parking", async () => {
    const { scheduler, automations, runs, createTask } = await makeScheduler("2026-07-28T09:00:30.000Z");
    const automation = makeAutomation({
      action: { kind: "create-task", task: { title: "Review CPA", description: "check daily spend" } },
      nextFireAt: "2026-07-28T09:00:00.000Z"
    });
    await automations.save(automation);

    const [parked] = await scheduler.tick();
    expect(parked?.status).toBe("waiting-approval");

    // The automation definition drifts while the run waits for approval.
    const stale = (await automations.get(automation.id))!;
    await automations.save(Automation.parse({
      ...stale,
      action: { kind: "create-task", task: { title: "Review CPA — edited", description: "check daily spend" } },
      revision: stale.revision + 1
    }));

    await expect(scheduler.approveRun(parked!.id, "approval-123")).rejects.toMatchObject({
      code: "APPROVAL_STALE"
    });
    expect(createTask).not.toHaveBeenCalled();
    expect((await runs.get(parked!.id))?.status).toBe("waiting-approval");
  });

  it("rejects approving unknown or missing runs with coded errors", async () => {
    const { scheduler } = await makeScheduler("2026-07-28T00:00:00.000Z");
    await expect(scheduler.approveRun(randomUUID(), "a")).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(scheduler.runNow(randomUUID())).rejects.toMatchObject({ code: "AUTOMATION_NOT_FOUND" });
    await expect(scheduler.approveRun(randomUUID(), " ")).rejects.toMatchObject({ code: "APPROVAL_ID_REQUIRED" });
    await expect(scheduler.approveRun(randomUUID(), " ")).rejects.toBeInstanceOf(AutomationsError);
  });

  it("caps the run log at 200 entries, dropping the oldest", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-automations-"));
    roots.push(root);
    const automations = new FileAutomationStore(root);
    const runs = new FileAutomationRunStore(root);
    const notifications = new FileNotificationStore(root);
    const chatty = async (_input: Record<string, unknown>, context: AutomationActionContext) => {
      for (let index = 1; index <= 250; index += 1) context.log(`m${index}`);
      return { ok: true };
    };
    const scheduler = new AutomationScheduler({
      automations,
      runs,
      notifications,
      clock: { now: () => new Date("2026-07-28T00:00:00.000Z") },
      executors: { dailyBrief: chatty, createTask: async () => ({}) },
      verifyApproval: async () => undefined
    });
    const automation = makeAutomation({ action: { kind: "daily-brief", input: {} } });
    await automations.save(automation);

    const run = await scheduler.runNow(automation.id);
    expect(run.status).toBe("succeeded");
    expect(run.runLog).toHaveLength(200);
    expect(run.runLog.at(-1)?.message).toBe("action succeeded");
    expect(run.runLog[0]?.message).toBe("m52");
  });

  it("persists a notification record for notify actions", async () => {
    const { scheduler, automations, notifications } = await makeScheduler("2026-07-28T00:00:00.000Z");
    const automation = makeAutomation({ action: { kind: "notify", message: "CPA 超目标 20%" } });
    await automations.save(automation);

    const run = await scheduler.runNow(automation.id);
    expect(run.status).toBe("succeeded");
    const all = await notifications.list({ workspaceId: "personal" });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      automationId: automation.id,
      runId: run.id,
      message: "CPA 超目标 20%",
      read: false
    });
    expect(run.result).toEqual({ notificationId: all[0]?.id });
  });

  it("records executor failures as failed runs without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-automations-"));
    roots.push(root);
    const automations = new FileAutomationStore(root);
    const scheduler = new AutomationScheduler({
      automations,
      runs: new FileAutomationRunStore(root),
      notifications: new FileNotificationStore(root),
      clock: { now: () => new Date("2026-07-28T00:00:00.000Z") },
      executors: {
        dailyBrief: async () => { throw new Error("brief engine down"); },
        createTask: async () => ({})
      },
      verifyApproval: async () => undefined
    });
    const automation = makeAutomation({ action: { kind: "daily-brief", input: {} } });
    await automations.save(automation);

    const run = await scheduler.runNow(automation.id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("brief engine down");
    expect(run.finishedAt).toBeDefined();
  });
});
