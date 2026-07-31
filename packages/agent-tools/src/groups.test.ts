import { execFile } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AdAccount, CampaignEntity } from "@adpilot/ads-intelligence";
import { Workflow } from "@adpilot/workflows";
import { runAgentToolCall } from "./lifecycle.js";
import type { AgentToolRegistry } from "./registry.js";
import type { AgentToolResult } from "./result.js";
import type { AgentToolDeps } from "./deps.js";
import { buildAgentToolRegistry } from "./index.js";
import { makeCtx, makeTestDeps } from "./testing.js";
import type { AgentExecutionContext } from "./context.js";

const exec = promisify(execFile);

const registry: AgentToolRegistry = buildAgentToolRegistry();
const terminals: Array<{ shutdown(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(terminals.splice(0).map((terminal) => terminal.shutdown().catch(() => undefined)));
});

async function call(
  name: string,
  params: unknown,
  ctx: AgentExecutionContext,
  deps: AgentToolDeps
): Promise<AgentToolResult> {
  const definition = registry.get(name);
  if (!definition) throw new Error(`tool not registered: ${name}`);
  return runAgentToolCall(definition, params, ctx, deps);
}

async function workspace(): Promise<{
  root: string;
  deps: AgentToolDeps;
  kernel: ReturnType<typeof makeTestDeps>["kernel"];
  auditEvents: ReturnType<typeof makeTestDeps>["auditEvents"];
  workflowStore: ReturnType<typeof makeTestDeps>["workflowStore"];
}> {
  const root = await mkdtemp(join(tmpdir(), "adpilot-groups-"));
  const testDeps = makeTestDeps(root);
  terminals.push(testDeps.terminal);
  return { root, deps: testDeps.deps, kernel: testDeps.kernel, auditEvents: testDeps.auditEvents, workflowStore: testDeps.workflowStore };
}

describe("project / goal / task tools (real kernel stores)", () => {
  it("drives the full project → goal → task graph flow", async () => {
    const { deps, kernel } = await workspace();
    const project = await kernel.createProject({ workspaceId: "client-a", name: "Growth" });
    const ctx = makeCtx({ projectId: project.id });

    const listed = await call("project.list", {}, ctx, deps);
    expect(listed.success).toBe(true);
    expect((listed.data as { count: number }).count).toBe(1);

    const opened = await call("project.open", { projectId: project.id }, ctx, deps);
    expect(opened.success).toBe(true);

    const rooted = await call("project.add_root", { path: "/tmp/adpilot-root" }, ctx, deps);
    expect((rooted.data as { project: { rootPaths: string[]; revision: number } }).project.rootPaths).toContain("/tmp/adpilot-root");
    expect((rooted.data as { project: { revision: number } }).project.revision).toBe(2);

    const goal = await call("goal.create", {
      title: "Ship 0.3.1",
      objective: "Wire the registry",
      successCriteria: ["tests green"]
    }, ctx, deps);
    const goalId = (goal.data as { goal: { id: string } }).goal.id;
    const ctxWithGoal = makeCtx({ projectId: project.id, goalId });

    const renamed = await call("goal.update", { goalId, title: "Ship the 0.3.1 integration" }, ctxWithGoal, deps);
    expect((renamed.data as { goal: { title: string } }).goal.title).toBe("Ship the 0.3.1 integration");
    await call("goal.set_progress", { goalId, progress: 0.5 }, ctxWithGoal, deps);
    expect(((await call("goal.get", { goalId }, ctxWithGoal, deps)).data as { goal: { progress: number } }).goal.progress).toBe(0.5);

    const batch = await call("task.create_many", {
      items: [
        { title: "Design" },
        { title: "Implement", dependsOn: [0] },
        { title: "Verify", dependsOn: [1] }
      ]
    }, ctxWithGoal, deps);
    const tasks = (batch.data as { tasks: Array<{ id: string; status: string; dependencies: string[] }> }).tasks;
    expect(tasks).toHaveLength(3);
    expect(tasks[1]!.dependencies).toEqual([tasks[0]!.id]);

    await call("task.start", { taskId: tasks[0]!.id }, ctxWithGoal, deps);
    await call("task.attach_evidence", { taskId: tasks[0]!.id, evidenceIds: ["screenshot:abc"] }, ctxWithGoal, deps);
    const completed = await call("task.complete", { taskId: tasks[0]!.id }, ctxWithGoal, deps);
    expect((completed.data as { unlocked: Array<{ id: string }> }).unlocked.map((task) => task.id)).toEqual([tasks[1]!.id]);

    const queuedOnly = await call("task.list", { status: "queued" }, ctxWithGoal, deps);
    expect((queuedOnly.data as { count: number }).count).toBe(2);

    const blocked = await call("task.block", { taskId: tasks[1]!.id }, ctxWithGoal, deps);
    expect((blocked.data as { task: { status: string } }).task.status).toBe("blocked");

    const projectContext = await call("project.get_context", {}, ctx, deps);
    const data = projectContext.data as { goals: unknown[]; tasks: unknown[]; sessionIds: string[] };
    expect(data.goals).toHaveLength(1);
    expect(data.tasks).toHaveLength(3);

    // Errors are recoverable and coded.
    const missing = await call("goal.get", { goalId: randomUUID() }, ctx, deps);
    expect(missing.error).toMatchObject({ code: "GOAL_NOT_FOUND", recoverable: true });
  });
});

describe("terminal tools (real TerminalService)", () => {
  it("creates a session inside the roots, executes echo, reads output, closes", async () => {
    const { root, deps } = await workspace();
    const canonical = await realpath(root);
    const ctx = makeCtx({ rootPaths: [canonical] });

    const created = await call("terminal.create", { cwd: root, title: "demo" }, ctx, deps);
    expect(created.success).toBe(true);
    const terminalId = (created.data as { session: { id: string; cwd: string } }).session.id;
    expect((created.data as { session: { cwd: string } }).session.cwd).toBe(canonical);

    const executed = await call("terminal.execute", { terminalId, command: "echo hello-adpilot" }, ctx, deps);
    expect((executed.data as { stdout: string; exitCode: number }).stdout).toContain("hello-adpilot");
    expect((executed.data as { exitCode: number }).exitCode).toBe(0);
    expect((executed.data as { sandboxed: boolean }).sandboxed).toBe(true);

    const oneShot = await call("terminal.execute", { cwd: root, command: "echo one-shot" }, ctx, deps);
    expect((oneShot.data as { stdout: string }).stdout).toContain("one-shot");

    const status = await call("terminal.get_exit_status", { terminalId }, ctx, deps);
    expect((status.data as { running: boolean }).running).toBe(true);

    const output = await call("terminal.get_output", { terminalId }, ctx, deps);
    expect(output.success).toBe(true);
    expect((output.data as { chunks: Array<{ data: string }> }).chunks.at(-1)?.data).toContain("hello-adpilot");

    await call("terminal.interrupt", { terminalId }, ctx, deps);
    const closed = await call("terminal.close", { terminalId }, ctx, deps);
    expect((closed.data as { closed: boolean }).closed).toBe(true);
  });

  it("refuses cwd outside the roots, allows sandboxed writes, and always denies dangerous commands", async () => {
    const { root, deps } = await workspace();
    const canonical = await realpath(root);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "adpilot-outside-")));

    const escaped = await call("terminal.create", { cwd: outside }, makeCtx({ rootPaths: [canonical] }), deps);
    expect(escaped.error).toMatchObject({ code: "PERMISSION_DENIED", recoverable: false });

    const workspaceWrite = makeCtx({ rootPaths: [canonical], permissions: { read: true, write: true, destructive: false, computerUse: false, network: false } });
    const writeCommand = await call("terminal.execute", { cwd: root, command: `touch ${join(root, "created.txt")}` }, workspaceWrite, deps);
    expect(writeCommand.success).toBe(true);
    expect((await stat(join(root, "created.txt"))).isFile()).toBe(true);

    const noWriteGrant = makeCtx({ rootPaths: [canonical], permissions: { read: true, write: false, destructive: false, computerUse: false, network: false } });
    const blockedWrite = await call("terminal.execute", { cwd: root, command: `touch ${join(root, "blocked.txt")}` }, noWriteGrant, deps);
    expect(blockedWrite.error).toMatchObject({ code: "PERMISSION_DENIED", recoverable: false });
    await expect(stat(join(root, "blocked.txt"))).rejects.toThrow();

    const denyCommand = await call(
      "terminal.execute",
      { cwd: root, command: "rm -rf /" },
      makeCtx({ rootPaths: [canonical] }),
      deps
    );
    expect(denyCommand.error).toMatchObject({ code: "PERMISSION_DENIED", recoverable: false });
  });

  it("pins terminal ids to one product session and never persists an escaped cwd", async () => {
    const { root, deps } = await workspace();
    const canonical = await realpath(root);
    const context = makeCtx({ rootPaths: [canonical], sessionId: "coding-session-a" });
    const created = await call("terminal.create", { cwd: canonical }, context, deps);
    const terminalId = (created.data as { session: { id: string } }).session.id;

    const crossSession = await call(
      "terminal.get_output",
      { terminalId },
      makeCtx({ rootPaths: [canonical], sessionId: "coding-session-b" }),
      deps
    );
    expect(crossSession.error).toMatchObject({ code: "TERMINAL_NOT_FOUND" });

    const ambiguous = await call(
      "terminal.execute",
      { terminalId, cwd: canonical, command: "pwd" },
      context,
      deps
    );
    expect(ambiguous.error).toMatchObject({ code: "INVALID" });

    const escaped = await call(
      "terminal.execute",
      { terminalId, command: "cd / && pwd" },
      context,
      deps
    );
    expect((escaped.data as { stdout: string }).stdout.trim()).toBe("/");
    const next = await call("terminal.execute", { terminalId, command: "pwd" }, context, deps);
    expect((next.data as { stdout: string }).stdout.trim()).toBe(canonical);

    await call("terminal.close", { terminalId }, context, deps);
  });

  it("takes a restorable git checkpoint before a sandboxed write command", async () => {
    const { deps } = await workspace();
    const repo = await realpath(await mkdtemp(join(tmpdir(), "adpilot-terminal-checkpoint-")));
    await exec("git", ["init", "-q", repo]);
    await exec("git", ["-C", repo, "config", "user.email", "test@adpilot.local"]);
    await exec("git", ["-C", repo, "config", "user.name", "AdPilot Test"]);
    await writeFile(join(repo, "README.md"), "# before\n", "utf8");
    await exec("git", ["-C", repo, "add", "README.md"]);
    await exec("git", ["-C", repo, "commit", "-q", "-m", "initial"]);
    const context = makeCtx({ rootPaths: [repo], sessionId: "checkpoint-session" });
    const created = await call("terminal.create", { cwd: repo }, context, deps);
    const terminalId = (created.data as { session: { id: string } }).session.id;

    const changed = await call(
      "terminal.execute",
      { terminalId, command: "printf 'after\\n' > README.md" },
      context,
      deps
    );
    const data = changed.data as { checkpointId: string; sandboxed: boolean };
    expect(data.sandboxed).toBe(true);
    expect(data.checkpointId).toBeTruthy();
    expect(changed.evidenceIds).toContain(`git-checkpoint:${data.checkpointId}`);

    await call("terminal.close", { terminalId }, context, deps);
  });
});

describe("git tools (real git repository)", () => {
  async function gitRepo(): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "adpilot-git-")));
    await exec("git", ["init", "-q", dir]);
    await exec("git", ["-C", dir, "config", "user.email", "test@adpilot.local"]);
    await exec("git", ["-C", dir, "config", "user.name", "AdPilot Test"]);
    await writeFile(join(dir, "README.md"), "# demo\n", "utf8");
    await exec("git", ["-C", dir, "add", "README.md"]);
    await exec("git", ["-C", dir, "commit", "-q", "-m", "initial"]);
    return dir;
  }

  it("runs the checkpoint-first mutation flow: stage, commit, branch, discard, restore", async () => {
    const { deps } = await workspace();
    const repo = await gitRepo();
    const ctx = makeCtx({ rootPaths: [repo] });

    const status = await call("git.status", { root: repo }, ctx, deps);
    expect((status.data as { status: { branch: string; staged: unknown[] } }).status.staged).toHaveLength(0);

    await writeFile(join(repo, "feature.ts"), "export const x = 1;\n", "utf8");
    await call("git.stage", { root: repo, paths: ["feature.ts"] }, ctx, deps);
    const commit = await call("git.commit", { root: repo, message: "add feature" }, ctx, deps);
    const commitData = commit.data as { sha: string; checkpointId: string };
    expect(commitData.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commitData.checkpointId).toBeTruthy();
    expect(commit.evidenceIds).toContain(`git-commit:${commitData.sha}`);

    const log = await call("git.log", { root: repo, limit: 5 }, ctx, deps);
    expect((log.data as { entries: Array<{ subject: string }> }).entries.map((entry) => entry.subject)).toEqual(["add feature", "initial"]);

    const branched = await call("git.create_branch", { root: repo, name: "feature/x" }, ctx, deps);
    expect(branched.success).toBe(true);
    await call("git.switch", { root: repo, name: "feature/x" }, ctx, deps);
    expect(((await call("git.status", { root: repo }, ctx, deps)).data as { status: { branch: string } }).status.branch).toBe("feature/x");

    // Destructive discard snapshots a safety checkpoint first, then restores the file.
    await writeFile(join(repo, "README.md"), "# changed\n", "utf8");
    const discard = await call("git.discard", { root: repo, paths: ["README.md"] }, ctx, deps);
    expect((discard.data as { safetyCheckpointId: string }).safetyCheckpointId).toBeTruthy();
    expect((await call("git.diff", { root: repo }, ctx, deps)).data as { diff: { raw: string } }).toMatchObject({ diff: { raw: "" } });

    // Restore the pre-commit checkpoint (before feature.ts was committed).
    const checkpoint = await call("git.checkpoint", { root: repo, label: "before-restore-test" }, ctx, deps);
    const checkpointId = (checkpoint.data as { checkpointId: string }).checkpointId;
    await writeFile(join(repo, "README.md"), "# dirty again\n", "utf8");
    const restored = await call("git.restore_checkpoint", { root: repo, checkpointId }, ctx, deps);
    expect(restored.success).toBe(true);
    expect((await call("git.diff", { root: repo }, ctx, deps)).data as { diff: { raw: string } }).toMatchObject({ diff: { raw: "" } });

    const worktree = await call("git.create_worktree", { root: repo, name: "parallel" }, ctx, deps);
    expect((worktree.data as { worktree: { path: string } }).worktree.path).toContain(".adpilot-worktrees");
  });

  it("refuses repositories outside the roots", async () => {
    const { root, deps } = await workspace();
    const repo = await gitRepo();
    const result = await call("git.status", { root: repo }, makeCtx({ rootPaths: [await realpath(root)] }), deps);
    expect(result.error).toMatchObject({ code: "PERMISSION_DENIED", recoverable: false });
  });
});

describe("artifact tools (real renderers and stores)", () => {
  it("creates, previews, revises, exports a slides deck and attaches it to a task", async () => {
    const { deps, kernel } = await workspace();
    const project = await kernel.createProject({ workspaceId: "client-a", name: "Decks" });
    const task = await kernel.createTask({ title: "build deck" });
    const ctx = makeCtx({ projectId: project.id, taskId: task.id });

    const created = await call("artifact.create", {
      type: "slides",
      title: "Weekly report",
      spec: {
        title: "Weekly report",
        slides: [
          { layout: "title", heading: "Weekly report", subheading: "Week 30" },
          { layout: "bullets", heading: "Highlights", bullets: ["Spend steady", "CPA on target"] }
        ]
      }
    }, ctx, deps);
    expect(created.success).toBe(true);
    const artifact = (created.data as { artifact: { id: string; status: string; version: number; previewUrl?: string } }).artifact;
    expect(artifact.status).toBe("ready");
    expect(created.artifactIds).toEqual([artifact.id]);

    // The kernel project mirrors the artifact (idempotent re-link on revise).
    expect((await kernel.getProject(project.id))!.artifactIds).toContain(artifact.id);

    const preview = await call("artifact.preview", { id: artifact.id }, ctx, deps);
    expect((preview.data as { thumbnails: string[] }).thumbnails.length).toBeGreaterThan(0);

    const revised = await call("artifact.revise", { id: artifact.id, slideIndex: 0, patch: { heading: "Weekly report (v2)" } }, ctx, deps);
    expect((revised.data as { artifact: { version: number } }).artifact.version).toBe(2);

    const exported = await call("artifact.export", { id: artifact.id, format: "pptx" }, ctx, deps);
    const downloads = (exported.data as { downloads: string[] }).downloads;
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/\.pptx$/);
    await expect(stat(downloads[0]!)).resolves.toBeTruthy();

    const attached = await call("artifact.attach_to_task", { id: artifact.id }, ctx, deps);
    expect(attached.success).toBe(true);
    expect((await kernel.listTasks())[0]!.evidenceIds).toContain(`artifact:${artifact.id}`);

    // Invalid specs surface a coded, recoverable error instead of a render crash.
    const invalid = await call("artifact.create", { type: "slides", title: "Broken", spec: { title: "x", slides: [] } }, ctx, deps);
    expect(invalid.error).toMatchObject({ code: "INVALID", recoverable: true });
  });

  it("renders documents and spreadsheets through their real renderers", async () => {
    const { deps, kernel } = await workspace();
    const project = await kernel.createProject({ workspaceId: "client-a", name: "Docs" });
    const ctx = makeCtx({ projectId: project.id });

    const doc = await call("artifact.create", {
      type: "document",
      title: "Audit notes",
      spec: { title: "Audit notes", blocks: [{ kind: "paragraph", text: "Findings so far." }] }
    }, ctx, deps);
    expect((doc.data as { artifact: { status: string } }).artifact.status).toBe("ready");

    const sheet = await call("artifact.create", {
      type: "spreadsheet",
      title: "Metrics",
      spec: { sheets: [{ name: "Spend", columns: [{ header: "Day", key: "day" }, { header: "Spend", key: "spend" }], rows: [{ day: "Mon", spend: 10 }] }] }
    }, ctx, deps);
    expect((sheet.data as { artifact: { status: string } }).artifact.status).toBe("ready");

    const list = await call("artifact.list", {}, ctx, deps);
    expect((list.data as { count: number }).count).toBe(2);
  });
});

describe("ads tools (real stores, decisions, brief; unavailable UAC engine)", () => {
  it("lists accounts/campaigns, records and de-duplicates decisions, generates a brief, and survives a missing UAC engine", async () => {
    const { deps, kernel, auditEvents } = await workspace();
    const project = await kernel.createProject({ workspaceId: "client-a", name: "Ads" });
    const ctx = makeCtx({ projectId: project.id });

    const now = "2026-07-29T00:00:00.000Z";
    const account = AdAccount.parse({
      id: randomUUID(), workspaceId: "client-a", platform: "google", name: "Main", createdAt: now, updatedAt: now, revision: 1
    });
    await deps.ads.stores!.accounts!.save(account);
    const campaign = CampaignEntity.parse({
      id: randomUUID(), accountId: account.id, name: "Search", createdAt: now, updatedAt: now, revision: 1
    });
    await deps.ads.stores!.campaigns!.save(campaign);

    const accounts = await call("ads.list_accounts", {}, ctx, deps);
    expect((accounts.data as { count: number }).count).toBe(1);
    const campaigns = await call("ads.list_campaigns", { accountId: account.id }, ctx, deps);
    expect((campaigns.data as { count: number }).count).toBe(1);

    const decision = await call("ads.create_decision", {
      recommendation: "Raise daily budget 10%",
      confidence: "medium",
      evidenceIds: ["screenshot:abc"]
    }, ctx, deps);
    expect((decision.data as { duplicate: boolean }).duplicate).toBe(false);
    const duplicate = await call("ads.create_decision", { recommendation: "Raise daily budget 10%", confidence: "medium" }, ctx, deps);
    expect((duplicate.data as { duplicate: boolean }).duplicate).toBe(true);

    const brief = await call("ads.generate_daily_brief", {
      metrics: { accounts: [{ accountId: account.id, spend: 500 }], campaigns: [], creatives: [] },
      thresholds: { maxDailySpend: 100 }
    }, ctx, deps);
    const briefData = (brief.data as { brief: { summary: { criticalCount: number }; sections: { anomalyAccounts: unknown[] } } }).brief;
    expect(briefData.summary.criticalCount).toBe(1);
    expect(briefData.sections.anomalyAccounts).toHaveLength(1);

    const uac = await call("ads.run_uac_analysis", { kind: "analyze", case: { scope: "account" } }, ctx, deps);
    expect(uac.error).toMatchObject({ code: "UAC_ENGINE_UNAVAILABLE", recoverable: true });

    const observation = await call("ads.record_observation", { subject: "campaign-1", detail: "Spend spiked at noon", severity: "warning" }, ctx, deps);
    expect((observation.data as { observationId: string }).observationId).toMatch(/^observation:/);
    expect(auditEvents.some((event) => event.action === "agent_tool:ads.observation")).toBe(true);
  });
});

describe("automation tools (real scheduler and stores)", () => {
  it("creates, runs, lists runs, pauses and resumes an automation", async () => {
    const { deps } = await workspace();
    const ctx = makeCtx();

    const created = await call("automation.create", {
      title: "Hourly ping",
      trigger: { kind: "schedule", cron: { minute: "*", hour: "*", dom: "*", month: "*", dow: "*" } },
      action: { kind: "notify", message: "check the account" }
    }, ctx, deps);
    const automation = (created.data as { automation: { id: string; nextFireAt?: string; state: string } }).automation;
    expect(automation.state).toBe("active");
    expect(automation.nextFireAt).toBeTruthy();

    const ran = await call("automation.run_now", { automationId: automation.id }, ctx, deps);
    expect((ran.data as { run: { status: string } }).run.status).toBe("succeeded");

    const runs = await call("automation.get_runs", { automationId: automation.id }, ctx, deps);
    expect((runs.data as { count: number }).count).toBe(1);

    const paused = await call("automation.pause", { automationId: automation.id }, ctx, deps);
    expect((paused.data as { automation: { state: string } }).automation.state).toBe("paused");
    const resumed = await call("automation.resume", { automationId: automation.id }, ctx, deps);
    expect((resumed.data as { automation: { state: string } }).automation.state).toBe("active");

    const listed = await call("automation.list", { state: "active" }, ctx, deps);
    expect((listed.data as { count: number }).count).toBe(1);
  });

  it("rejects unimplemented event triggers and cross-workspace automation ids", async () => {
    const { deps } = await workspace();
    const owner = makeCtx({ workspaceId: "client-a" });
    const created = await call("automation.create", {
      title: "Owner schedule",
      trigger: { kind: "schedule", cron: { minute: "0", hour: "9", dom: "*", month: "*", dow: "*" } },
      action: { kind: "notify", message: "owner only" }
    }, owner, deps);
    const automationId = (created.data as { automation: { id: string } }).automation.id;

    const event = await call("automation.create", {
      title: "Unsupported event",
      trigger: { kind: "event", event: "campaign.changed" },
      action: { kind: "notify", message: "never" }
    }, owner, deps);
    expect(event.error).toMatchObject({ code: "INVALID_PARAMS" });

    const foreign = makeCtx({ workspaceId: "client-b" });
    for (const [tool, params] of [
      ["automation.pause", { automationId }],
      ["automation.resume", { automationId }],
      ["automation.run_now", { automationId }],
      ["automation.get_runs", { automationId }]
    ] as const) {
      const result = await call(tool, params, foreign, deps);
      expect(result.error, tool).toMatchObject({ code: "AUTOMATION_NOT_FOUND" });
    }
  });
});

describe("workflow tools (real store and runner)", () => {
  it("lists, gets and runs a published workflow", async () => {
    const { deps, workflowStore } = await workspace();
    const ctx = makeCtx();
    const now = "2026-07-29T00:00:00.000Z";
    const step = {
      id: randomUUID(),
      order: 1,
      title: "Wait briefly",
      action: { kind: "wait" as const, milliseconds: 50 },
      anchor: {},
      parameters: [],
      expectedResult: "the wait elapsed",
      mutation: false
    };
    const workflow = Workflow.parse({
      id: randomUUID(),
      workspaceId: "client-a",
      title: "Demo flow",
      description: "",
      source: { kind: "manual" },
      parameters: [],
      steps: [step],
      permissions: { requiresMutation: false, requiresApproval: false, requiredPermissions: ["INTERACT"] },
      successCriteria: [],
      failurePolicy: "stop",
      status: "published",
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    await workflowStore.save(workflow);

    const listed = await call("workflow.list", { status: "published" }, ctx, deps);
    expect((listed.data as { count: number }).count).toBe(1);

    const got = await call("workflow.get", { workflowId: workflow.id }, ctx, deps);
    expect((got.data as { workflow: { title: string } }).workflow.title).toBe("Demo flow");

    const run = await call("workflow.run", { workflowId: workflow.id }, ctx, deps);
    const runData = (run.data as { run: { status: string; steps: Array<{ status: string }> } }).run;
    expect(runData.status).toBe("completed");
    expect(runData.steps[0]!.status).toBe("succeeded");
  });
});
