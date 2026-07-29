import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import { Automation, FileAutomationStore } from "@adpilot/automations";
import { createServer } from "./index.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-automation-routes-"));
  roots.push(root);
  const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
  // Disable the interval loop: tests drive runs explicitly via run-now.
  const server = await createServer(system, { uiRoot: join(root, "missing-ui"), automationTickMs: 0 });
  return { server, system };
}

const EVERY_MINUTE = { minute: "*", hour: "*", dom: "*", month: "*", dow: "*" };

async function createAutomation(server: Awaited<ReturnType<typeof boot>>["server"], overrides: Record<string, unknown> = {}) {
  const response = await server.inject({
    method: "POST",
    url: "/api/automations",
    payload: {
      workspaceId: "personal",
      title: "每小时同步账户",
      trigger: { kind: "schedule", cron: EVERY_MINUTE },
      action: { kind: "notify", message: "同步完成" },
      ...overrides
    }
  });
  return response;
}

describe("automation REST routes", () => {
  it("runs the create → run-now → runs → notifications → read flow end to end", async () => {
    const { server, system } = await boot();

    const created = await createAutomation(server);
    expect(created.statusCode).toBe(201);
    const { automation } = created.json();
    expect(automation).toMatchObject({
      workspaceId: "personal",
      title: "每小时同步账户",
      state: "active",
      runCount: 0,
      idempotencyWindowSeconds: 3_600,
      guards: { maxRunsPerDay: 10, requiresApprovalForMutation: true }
    });
    expect(automation.nextFireAt).toBeDefined();

    const listed = await server.inject({ method: "GET", url: "/api/automations?workspaceId=personal" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().automations.map((entry: { id: string }) => entry.id)).toEqual([automation.id]);
    expect(listed.json().latestRuns).toEqual({});

    const detail = await server.inject({
      method: "GET",
      url: `/api/automations/${automation.id}?workspaceId=personal`
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().automation.id).toBe(automation.id);
    expect(detail.json().runs).toEqual([]);

    const ran = await server.inject({
      method: "POST",
      url: `/api/automations/${automation.id}/run-now`,
      payload: { workspaceId: "personal" }
    });
    expect(ran.statusCode).toBe(200);
    const { run } = ran.json();
    expect(run).toMatchObject({ automationId: automation.id, status: "succeeded" });
    expect(run.result.notificationId).toBeDefined();

    const runs = await server.inject({
      method: "GET",
      url: `/api/automations/${automation.id}/runs?workspaceId=personal`
    });
    expect(runs.json().runs.map((entry: { id: string }) => entry.id)).toEqual([run.id]);

    const fetchedRun = await server.inject({
      method: "GET",
      url: `/api/automation-runs/${run.id}?workspaceId=personal`
    });
    expect(fetchedRun.json().run.id).toBe(run.id);

    const listedAfter = await server.inject({ method: "GET", url: "/api/automations?workspaceId=personal" });
    expect(listedAfter.json().latestRuns[automation.id].status).toBe("succeeded");

    const unread = await server.inject({ method: "GET", url: "/api/notifications?workspaceId=personal&unread=true" });
    expect(unread.json().notifications).toHaveLength(1);
    const notification = unread.json().notifications[0];
    expect(notification).toMatchObject({ message: "同步完成", read: false, automationId: automation.id, runId: run.id });

    const marked = await server.inject({
      method: "POST",
      url: `/api/notifications/${notification.id}/read`,
      payload: { workspaceId: "personal" }
    });
    expect(marked.json().notification.read).toBe(true);
    const stillUnread = await server.inject({ method: "GET", url: "/api/notifications?workspaceId=personal&unread=true" });
    expect(stillUnread.json().notifications).toHaveLength(0);

    const audits = await system.audit.list("personal");
    expect(audits.map((event) => event.action)).toEqual(
      expect.arrayContaining(["automation_create", "automation_run_now"])
    );
  });

  it("pauses and resumes, re-arming the schedule instead of catching up", async () => {
    const { server } = await boot();
    const { automation } = (await createAutomation(server)).json();

    const paused = await server.inject({
      method: "POST",
      url: `/api/automations/${automation.id}/pause`,
      payload: { workspaceId: "personal" }
    });
    expect(paused.json().automation.state).toBe("paused");

    // run-now is an explicit operator action and works while paused.
    const manual = await server.inject({
      method: "POST",
      url: `/api/automations/${automation.id}/run-now`,
      payload: { workspaceId: "personal" }
    });
    expect(manual.json().run.status).toBe("succeeded");

    const resumed = await server.inject({
      method: "POST",
      url: `/api/automations/${automation.id}/resume`,
      payload: { workspaceId: "personal" }
    });
    expect(resumed.json().automation.state).toBe("active");
    expect(Date.parse(resumed.json().automation.nextFireAt)).toBeGreaterThan(Date.now());

    const audits = await server.inject({ method: "GET", url: "/api/automations?workspaceId=personal&state=active" });
    expect(audits.json().automations).toHaveLength(1);
  });

  it("gates mutating actions behind the central ApprovalService chain", async () => {
    const { server, system } = await boot();
    const created = await createAutomation(server, {
      title: "每日建任务",
      action: { kind: "create-task", task: { title: "复盘昨日 CPA", description: "读取成本并建跟进任务" } }
    });
    expect(created.statusCode).toBe(201);
    const { automation } = created.json();

    const ran = await server.inject({
      method: "POST",
      url: `/api/automations/${automation.id}/run-now`,
      payload: { workspaceId: "personal" }
    });
    const { run } = ran.json();
    expect(run.status).toBe("waiting-approval");
    expect(run.actionFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const tasksBefore = await server.inject({ method: "GET", url: "/api/kernel/tasks?workspaceId=personal" });
    expect(tasksBefore.json().tasks).toHaveLength(0);

    // The client never supplies an approvalId: the server mints, reviews,
    // approves, and consumes the central approval, then releases the run.
    const approved = await server.inject({
      method: "POST",
      url: `/api/automation-runs/${run.id}/approve`,
      payload: { workspaceId: "personal" }
    });
    expect(approved.statusCode).toBe(200);
    const approvedRun = approved.json().run;
    expect(approvedRun.status).toBe("succeeded");
    expect(approvedRun.approvalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // The central approval went through its full lifecycle: consumed into
    // executing, then finished with the run's outcome.
    const approval = await system.approvals.get("personal", approvedRun.approvalId);
    expect(approval).toMatchObject({ taskId: automation.id, status: "executed" });
    expect(approval.executionPlan?.surfaceFingerprint).toBe(run.actionFingerprint);

    const tasksAfter = await server.inject({ method: "GET", url: "/api/kernel/tasks?workspaceId=personal" });
    expect(tasksAfter.json().tasks.map((task: { title: string }) => task.title)).toEqual(["复盘昨日 CPA"]);

    const audits = await system.audit.list("personal");
    const approveAudit = audits.find((event) => event.action === "automation_run_approve");
    expect(approveAudit?.details).toMatchObject({
      runId: run.id,
      automationId: automation.id,
      approvalId: approvedRun.approvalId,
      runStatus: "succeeded"
    });

    // Replay: the run is no longer waiting and its one-time token was consumed.
    const reapproved = await server.inject({
      method: "POST",
      url: `/api/automation-runs/${run.id}/approve`,
      payload: { workspaceId: "personal" }
    });
    expect(reapproved.statusCode).toBe(409);
    expect(reapproved.json()).toMatchObject({ code: "RUN_NOT_WAITING_APPROVAL" });
    expect((await server.inject({ method: "GET", url: "/api/kernel/tasks?workspaceId=personal" })).json().tasks).toHaveLength(1);
  });

  it("rejects a client-forged approvalId: the server mints the approval itself", async () => {
    const { server } = await boot();
    const created = await createAutomation(server, {
      action: { kind: "create-task", task: { title: "伪造审批", description: "forged" } }
    });
    const { automation } = created.json();
    const { run } = (await server.inject({
      method: "POST",
      url: `/api/automations/${automation.id}/run-now`,
      payload: { workspaceId: "personal" }
    })).json();
    expect(run.status).toBe("waiting-approval");

    const forged = await server.inject({
      method: "POST",
      url: `/api/automation-runs/${run.id}/approve`,
      payload: { workspaceId: "personal", approvalId: "forged-approval-id" }
    });
    expect(forged.statusCode).toBe(400);

    const after = await server.inject({ method: "GET", url: `/api/automation-runs/${run.id}?workspaceId=personal` });
    expect(after.json().run).toMatchObject({ status: "waiting-approval" });
    expect(after.json().run.approvalId).toBeUndefined();
    const tasks = await server.inject({ method: "GET", url: "/api/kernel/tasks?workspaceId=personal" });
    expect(tasks.json().tasks).toHaveLength(0);
  });

  it("rejects approval with APPROVAL_STALE when the action changed after parking", async () => {
    const { server, system } = await boot();
    const created = await createAutomation(server, {
      action: { kind: "create-task", task: { title: "原始任务", description: "original" } }
    });
    const { automation } = created.json();
    const { run } = (await server.inject({
      method: "POST",
      url: `/api/automations/${automation.id}/run-now`,
      payload: { workspaceId: "personal" }
    })).json();
    expect(run.status).toBe("waiting-approval");

    // The automation definition drifts while the run waits for approval.
    const store = new FileAutomationStore(system.workspace.root);
    const stored = (await store.get(automation.id))!;
    await store.save(Automation.parse({
      ...stored,
      action: { kind: "create-task", task: { title: "被篡改的任务", description: "tampered" } },
      updatedAt: new Date().toISOString(),
      revision: stored.revision + 1
    }));

    const approved = await server.inject({
      method: "POST",
      url: `/api/automation-runs/${run.id}/approve`,
      payload: { workspaceId: "personal" }
    });
    expect(approved.statusCode).toBe(409);
    expect(approved.json()).toMatchObject({ code: "APPROVAL_STALE" });

    // No approval was even minted, and the run stays parked without executing.
    expect(await system.approvals.list("personal")).toHaveLength(0);
    const after = await server.inject({ method: "GET", url: `/api/automation-runs/${run.id}?workspaceId=personal` });
    expect(after.json().run.status).toBe("waiting-approval");
    const tasks = await server.inject({ method: "GET", url: "/api/kernel/tasks?workspaceId=personal" });
    expect(tasks.json().tasks).toHaveLength(0);
  });

  it("executes daily-brief actions against live workspace data and audits them", async () => {
    const { server, system } = await boot();
    const created = await createAutomation(server, {
      title: "每日简报",
      action: { kind: "daily-brief", input: {} }
    });
    const { automation } = created.json();

    const ran = await server.inject({
      method: "POST",
      url: `/api/automations/${automation.id}/run-now`,
      payload: { workspaceId: "personal" }
    });
    expect(ran.json().run.status).toBe("succeeded");
    expect(ran.json().run.result).toMatchObject({ totalFindings: 0, criticalCount: 0 });

    const audits = await system.audit.list("personal");
    const briefAudit = audits.find((event) => event.action === "ads_daily_brief_generate");
    expect(briefAudit).toMatchObject({ actor: "automation", status: "succeeded" });
  });

  it("rejects invalid and unschedulable cron specs with CRON_INVALID", async () => {
    const { server } = await boot();
    const badSyntax = await createAutomation(server, {
      trigger: { kind: "schedule", cron: { minute: "99", hour: "*", dom: "*", month: "*", dow: "*" } }
    });
    expect(badSyntax.statusCode).toBe(400);
    expect(badSyntax.json()).toMatchObject({ code: "CRON_INVALID" });

    const neverFires = await createAutomation(server, {
      trigger: { kind: "schedule", cron: { minute: "0", hour: "0", dom: "31", month: "2", dow: "*" } }
    });
    expect(neverFires.statusCode).toBe(400);
    expect(neverFires.json()).toMatchObject({ code: "CRON_INVALID" });
  });

  it("enforces workspace scoping with coded not-found errors", async () => {
    const { server, system } = await boot();
    const { automation } = (await createAutomation(server)).json();
    await system.workspace.initializeClient({
      profile: { id: "someone-else", name: "Other" },
      kpi: { primary: "CPA", target: 10 }
    });

    const crossGet = await server.inject({
      method: "GET",
      url: `/api/automations/${automation.id}?workspaceId=someone-else`
    });
    expect(crossGet.statusCode).toBe(404);
    expect(crossGet.json()).toMatchObject({ code: "AUTOMATION_NOT_FOUND" });

    const crossRun = await server.inject({
      method: "POST",
      url: `/api/automations/${automation.id}/run-now`,
      payload: { workspaceId: "someone-else" }
    });
    expect(crossRun.statusCode).toBe(404);

    const missingNotification = await server.inject({
      method: "POST",
      url: `/api/notifications/${crypto.randomUUID()}/read`,
      payload: { workspaceId: "personal" }
    });
    expect(missingNotification.statusCode).toBe(404);
    expect(missingNotification.json()).toMatchObject({ code: "NOTIFICATION_NOT_FOUND" });
  });

  it("deletes an automation together with its runs", async () => {
    const { server, system } = await boot();
    const { automation } = (await createAutomation(server)).json();
    await server.inject({
      method: "POST",
      url: `/api/automations/${automation.id}/run-now`,
      payload: { workspaceId: "personal" }
    });

    const deleted = await server.inject({
      method: "DELETE",
      url: `/api/automations/${automation.id}?workspaceId=personal`
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });

    const after = await server.inject({
      method: "GET",
      url: `/api/automations/${automation.id}?workspaceId=personal`
    });
    expect(after.statusCode).toBe(404);
    const listed = await server.inject({ method: "GET", url: "/api/automations?workspaceId=personal" });
    expect(listed.json().automations).toHaveLength(0);

    const audits = await system.audit.list("personal");
    expect(audits.map((event) => event.action)).toContain("automation_delete");
  });
});
