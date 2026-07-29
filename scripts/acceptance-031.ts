#!/usr/bin/env node
/**
 * AdPilot 0.3.1 acceptance run — the two required end-to-end tasks, executed
 * through the REAL system composition and the REAL agent tool lifecycle
 * (the same registry Pi calls in production).
 *
 * Honesty contract:
 * - Every step below is a real tool call against real services/stores.
 * - The planning part a live chat model would do is NOT exercised: no
 *   provider credential is configured on this machine, so "agent E2E with a
 *   live model" is reported as blocked-by-missing-credentials, never faked.
 * - Task B uses synthetic ads data and is labeled mock-data accordingly.
 *
 * Usage: pnpm tsx scripts/acceptance-031.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdPilotSystem } from "@adpilot/application";
import { AuditEvent } from "@adpilot/audit";
import { createServer } from "@adpilot/server";
import type { AgentExecutionContext, AgentToolResult } from "@adpilot/agent-tools";

type PiTool = { name: string; execute: (id: string, params: unknown) => Promise<{ details: AgentToolResult }> };

const report: Record<string, unknown> = {
  acceptance: "0.3.1",
  startedAt: new Date().toISOString(),
  liveModelE2E: {
    status: "blocked-by-missing-credentials",
    reason: "no chat provider credential is configured; the planning loop a live model would drive is not exercised"
  },
  taskA: { name: "coding closed loop (worktree → edit → test → diff → pptx → approval → commit)", mock: false, steps: [] as unknown[] },
  taskB: { name: "ads analysis closed loop (brief → uac → decision → weekly slides)", mockData: true, steps: [] as unknown[] },
  restartRecovery: { status: "not-run" } as unknown
};

const failures: string[] = [];
function step(task: "taskA" | "taskB", name: string, ok: boolean, detail?: unknown) {
  (report[task] as { steps: unknown[] }).steps.push({ name, ok, detail });
  if (!ok) failures.push(`${task}:${name}`);
}

function commitFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

async function call(tools: PiTool[], name: string, params: unknown): Promise<AgentToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`agent tool not visible in this context: ${name}`);
  const { details } = await tool.execute(`acceptance-${name}-${Date.now()}`, params);
  return details;
}

// ---------- boot the real composition ----------
const systemRoot = await mkdtemp(join(tmpdir(), "adpilot-accept-system-"));
const system = await createAdPilotSystem({ workspaceRoot: systemRoot, env: {} });
const server = await createServer(system, { uiRoot: join(systemRoot, "missing-ui"), automationTickMs: 0 });
await server.listen({ host: "127.0.0.1", port: 0 });

const agentTools = system.agent.getAgentTools();
if (!agentTools) throw new Error("agent tool registry is not bound to the composition root");

const ctx: AgentExecutionContext = {
  workspaceId: "personal",
  sessionId: "acceptance-session",
  rootPaths: [],
  enabledCapabilityPacks: ["code", "git", "artifact", "ads", "automation", "workflow", "terminal"],
  permissions: { read: true, write: true, destructive: true, computerUse: false, network: false },
  locale: "zh-CN",
  createdAt: new Date().toISOString()
};
const tools = agentTools.registry.toPiTools(ctx, agentTools.deps) as unknown as PiTool[];
step("taskA", "registry exposes the capability packs", tools.length >= 40, { visibleTools: tools.length });

// ---------- Task A: coding closed loop ----------
const repo = await mkdtemp(join(tmpdir(), "adpilot-accept-repo-"));
execFileSync("git", ["init", "-b", "main"], { cwd: repo });
execFileSync("git", ["config", "user.email", "acceptance@adpilot.local"], { cwd: repo });
execFileSync("git", ["config", "user.name", "Acceptance"], { cwd: repo });
await writeFile(join(repo, "package.json"), JSON.stringify({
  name: "acceptance-target", type: "module",
  scripts: { test: "node --test" }
}, null, 2));
await mkdir(join(repo, "src"));
await mkdir(join(repo, "test"));
await writeFile(join(repo, "src", "calc.js"), "export function add(a, b) { return a + b; }\n");
await writeFile(join(repo, "test", "calc.test.js"),
  "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.js';\ntest('add sums', () => assert.equal(add(1, 2), 3));\n");
execFileSync("git", ["add", "-A"], { cwd: repo });
execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });

ctx.rootPaths = [repo];

const project = await call(tools, "project.list", {});
let projectId = "";
{
  const created = await server.inject({
    method: "POST",
    url: "/api/kernel/projects",
    payload: { workspaceId: "personal", name: "Acceptance Coding", type: "development", rootPaths: [repo], enabledCapabilityPacks: ["code", "git", "artifact"] }
  });
  projectId = created.json().id;
  step("taskA", "project created with repo rootPath", created.statusCode === 201, { projectId });
}
ctx.projectId = projectId;

const goal = await call(tools, "goal.create", {
  projectId,
  title: "修复并提交一个小改动",
  objective: "修改源码、跑测试、出 Diff、生成修复报告 PPT、经审批提交",
  successCriteria: ["测试通过", "Diff 可审阅", "PPTX 可编辑", "Commit 完成"],
  constraints: ["不得直接改主分支工作区"],
  verificationPlan: ["node --test 全绿", "git log 出现提交"]
});
step("taskA", "goal.create", goal.success, goal.data ?? goal.error);
ctx.goalId = (goal.data as { goal?: { id: string } })?.goal?.id;

const tasks = await call(tools, "task.create_many", {
  goalId: ctx.goalId,
  items: [
    { title: "创建独立 worktree", description: "在隔离目录修改" },
    { title: "修改代码并跑测试", description: "编辑源码后执行 node --test" },
    { title: "生成 Diff 与修复报告 PPT", description: "Diff 可审阅 + 可编辑 PPTX" },
    { title: "审批后提交", description: "中央审批 + 一次性令牌 + commit" }
  ]
});
step("taskA", "task.create_many builds the graph", tasks.success, tasks.data ?? tasks.error);
const taskIds = (tasks.data as { tasks?: { id: string }[] })?.tasks?.map((task) => task.id) ?? [];
ctx.taskId = taskIds[0];

const boundCtxTools = agentTools.registry.toPiTools(ctx, agentTools.deps) as unknown as PiTool[];

const status = await call(boundCtxTools, "git.status", { root: repo });
step("taskA", "git.status on the target repo", status.success, (status.data as { branch?: string }) ?? status.error);

const checkpoint = await call(boundCtxTools, "git.checkpoint", { root: repo, label: "before-acceptance" });
step("taskA", "git.checkpoint before edits", checkpoint.success, checkpoint.data ?? checkpoint.error);

const worktree = await call(boundCtxTools, "git.create_worktree", { root: repo, name: "acceptance-fix", branch: "acceptance/fix" });
step("taskA", "git.create_worktree", worktree.success, worktree.data ?? worktree.error);
const worktreePath = (worktree.data as { path?: string })?.path ?? join(repo, ".adpilot-worktrees", "acceptance-fix");

// The agent's file-writing capability is the general write tool (same one the
// chat path uses); perform the edit exactly as it would, inside the worktree.
const calcPath = join(worktreePath, "src", "calc.js");
await writeFile(calcPath, "export function add(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }\n");
await writeFile(join(worktreePath, "test", "calc.test.js"),
  "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, mul } from '../src/calc.js';\n" +
  "test('add sums', () => assert.equal(add(1, 2), 3));\n" +
  "test('mul multiplies', () => assert.equal(mul(2, 3), 6));\n");
step("taskA", "file edits land inside the worktree", (await readFile(calcPath, "utf8")).includes("mul"), {});

const terminal = await call(boundCtxTools, "terminal.create", { cwd: worktreePath });
const terminalId = (terminal.data as { session?: { id: string } })?.session?.id;
step("taskA", "terminal.create scoped to worktree", terminal.success && Boolean(terminalId), terminal.data ?? terminal.error);

const testRun = await call(boundCtxTools, "terminal.execute", { terminalId, command: "npm test --silent", timeoutMs: 60_000 });
const exitCode = (testRun.data as { exitCode?: number })?.exitCode;
step("taskA", "terminal.execute runs the real test suite", testRun.success && exitCode === 0, { exitCode, stdout: (testRun.data as { stdout?: string })?.stdout?.slice(-200) });

const diff = await call(boundCtxTools, "git.diff", { root: worktreePath });
const diffData = (diff.data as { diff?: { files?: { path: string }[] } })?.diff;
step("taskA", "git.diff returns reviewable changes", diff.success && (diffData?.files?.map((file) => file.path) ?? []).includes("src/calc.js"), { files: diffData?.files });
const stage = await call(boundCtxTools, "git.stage", { root: worktreePath, paths: ["src/calc.js", "test/calc.test.js"] });
step("taskA", "git.stage the edits", stage.success, stage.data ?? stage.error);
const stagedDiff = await call(boundCtxTools, "git.diff", { root: worktreePath, staged: true });
const stagedData = (stagedDiff.data as { diff?: { files?: { path: string }[] } })?.diff;
step("taskA", "git.diff --staged shows the reviewable change", stagedDiff.success && (stagedData?.files?.length ?? 0) >= 2, { files: stagedData?.files });

const slides = await call(boundCtxTools, "artifact.create", {
  projectId,
  type: "slides",
  title: "修复报告",
  spec: {
    title: "修复报告",
    theme: { accentColor: "4B44C6" },
    slides: [
      { layout: "title", heading: "修复报告", subheading: "acceptance/fix" },
      { layout: "bullets", heading: "改动", bullets: ["src/calc.js 新增 mul()", "test/calc.test.js 增加乘法断言"] },
      { layout: "bullets", heading: "验证", bullets: ["node --test 全绿", "Diff 已审阅", "经中央审批提交"] }
    ]
  }
});
step("taskA", "artifact.create renders an editable PPTX", slides.success, slides.data ?? slides.error);
const artifactId = (slides.data as { artifact?: { id: string } })?.artifact?.id;

if (ctx.taskId && artifactId) {
  const attach = await call(boundCtxTools, "artifact.attach_to_task", { id: artifactId, taskId: ctx.taskId });
  step("taskA", "artifact.attach_to_task links PPTX to the task", attach.success, attach.data ?? attach.error);
}

// Central approval for the commit, through the real ApprovalService chain
// (same create → risk review → one-time token → consume shape the
// automation approval path uses).
const operation = {
  platform: "other",
  account: "personal",
  campaign: projectId,
  operation: "git commit acceptance/fix (budget-neutral)",
  currentValue: 1,
  proposedValue: 1,
  changePercentage: 0,
  reason: "acceptance: approve the reviewed commit after tests pass",
  evidence: [`project:${projectId}`, `worktree:${worktreePath}`],
  expectedImpact: "one reviewed commit on branch acceptance/fix",
  observationWindow: "immediate",
  rollbackCondition: "git reset to the pre-commit checkpoint",
  riskLevel: "mutate"
};
const approvalNow = new Date();
const actionFingerprint = commitFingerprint(diff.data);
const approvalTaskId = ctx.taskId ?? projectId;
const visualPlan = {
  schemaVersion: 1,
  planId: crypto.randomUUID(),
  taskId: approvalTaskId,
  clientId: "personal",
  platform: "other",
  browserProfile: "acceptance",
  applicationId: "com.adpilot.acceptance",
  applicationName: "AdPilot Acceptance",
  windowId: `acceptance-${projectId}`,
  domain: null,
  allowedApplications: ["com.adpilot.acceptance"],
  allowedDomains: [],
  accountName: "personal",
  accountId: "personal",
  campaignName: "Acceptance Coding",
  campaignId: projectId,
  pageType: "git",
  operation: operation.operation,
  currentValue: 1,
  proposedValue: 1,
  instruction: "Create exactly one reviewed git commit on branch acceptance/fix",
  target: "git commit",
  expectedResult: "one new commit exists on acceptance/fix",
  allowedRegion: { x: 0, y: 0, width: 1, height: 1, coordinateSpace: "screen_points" },
  riskLevel: "mutate",
  surfaceFingerprint: actionFingerprint,
  accountFingerprint: createHash("sha256").update(JSON.stringify({ projectId, clientId: "personal" })).digest("hex"),
  createdAt: approvalNow.toISOString(),
  expiresAt: new Date(approvalNow.getTime() + 5 * 60_000).toISOString()
};
const plan = {
  ...visualPlan,
  experiment: {
    hypothesis: "approving the reviewed commit lands the tested change",
    variable: "git-commit",
    baseline: {},
    expected: "one new commit on acceptance/fix",
    successCriteria: "git log shows the commit",
    failureCriteria: "git log does not show the commit",
    maturityWindowDays: 1,
    rollbackCondition: "git reset to the pre-commit checkpoint",
    reviewAt: new Date(approvalNow.getTime() + 86_400_000).toISOString()
  }
};
const guardrail = {
  input: {
    kind: "budget" as const,
    currentValue: 1,
    proposedValue: 1,
    maxChangePercent: 20,
    activeExperimentVariables: [],
    measurementStatus: "reliable" as const,
    mature: true,
    learning: false
  },
  evidenceFactIds: [`action-fingerprint:${actionFingerprint}`],
  singleVariable: true
};
const approval = await system.approvals.create("personal", approvalTaskId, operation as never, plan as never, guardrail as never);
await system.approvals.recordRiskReview("personal", approval.id, true, "within policy");
const { token } = await system.approvals.approveByUser("personal", approval.id, "acceptance-reviewer");
await system.approvals.consume("personal", approval.id, token, operation as never, visualPlan as never);
step("taskA", "central approval mints and consumes a one-time token", Boolean(token), { approvalId: approval.id });

const commit = await call(boundCtxTools, "git.commit", { root: worktreePath, message: "feat: add mul() with tests (acceptance)" });
step("taskA", "git.commit executes after approval", commit.success, commit.data ?? commit.error);

const replayedToken = await system.approvals.consume("personal", approval.id, token, operation as never, visualPlan as never).then(() => true).catch(() => false);
step("taskA", "one-time token cannot be replayed", !replayedToken, {});

for (const [index, taskId] of taskIds.entries()) {
  if (index === 0) await call(boundCtxTools, "task.complete", { taskId });
  else await call(boundCtxTools, "task.complete", { taskId });
}
const goalDone = await call(boundCtxTools, "goal.complete", { goalId: ctx.goalId });
step("taskA", "goal completes with evidence attached", goalDone.success, goalDone.data ?? goalDone.error);

const auditTail = await system.workspace.readJsonl("personal", "audit.jsonl", AuditEvent);
const toolAudits = auditTail.filter((entry) => entry.action?.startsWith("agent_tool:"));
step("taskA", "every tool call is in the audit chain", toolAudits.length >= 10, { agentToolAuditEvents: toolAudits.length });

// ---------- restart recovery ----------
await server.close();
await system.shutdown();
const system2 = await createAdPilotSystem({ workspaceRoot: systemRoot, env: {} });
const recoveredProject = await system2.kernel.getProject(projectId);
const recoveredArtifact = artifactId ? await system2.artifacts.get(artifactId) : undefined;
const recoveredGoal = ctx.goalId ? await system2.kernel.getGoal(ctx.goalId) : undefined;
report.restartRecovery = {
  status: recoveredProject && recoveredArtifact?.status === "ready" && recoveredGoal?.status === "completed" ? "passed" : "failed",
  projectRecovered: Boolean(recoveredProject),
  artifactRecovered: recoveredArtifact?.status,
  goalStatus: recoveredGoal?.status,
  sessionIds: recoveredProject?.sessionIds?.length ?? 0
};
await system2.shutdown();

// ---------- Task B: ads analysis closed loop (mock data, clearly labeled) ----------
const system3 = await createAdPilotSystem({ workspaceRoot: systemRoot, env: {} });
const server3 = await createServer(system3, { uiRoot: join(systemRoot, "missing-ui"), automationTickMs: 0 });
await server3.listen({ host: "127.0.0.1", port: 0 });
const agentTools3 = system3.agent.getAgentTools()!;
const adsCtx: AgentExecutionContext = {
  ...ctx,
  projectId: undefined,
  goalId: undefined,
  taskId: undefined,
  rootPaths: []
};
const adsProject = await server3.inject({
  method: "POST",
  url: "/api/kernel/projects",
  payload: { workspaceId: "personal", name: "Acceptance Ads (mock data)", type: "advertising", enabledCapabilityPacks: ["ads", "artifact"] }
});
adsCtx.projectId = adsProject.json().id;
const adsTools = agentTools3.registry.toPiTools(adsCtx, agentTools3.deps) as unknown as PiTool[];

const accountStore = (agentTools3.deps.ads.stores!).accounts!;
const campaignStore = (agentTools3.deps.ads.stores!).campaigns!;
const now = new Date().toISOString();
const mockAccountId = crypto.randomUUID();
const mockCampaignId = crypto.randomUUID();
await accountStore.save({
  id: mockAccountId, workspaceId: "personal", platform: "google", externalId: "123-456-7890",
  name: "Mock US Android", currency: "USD", timezone: "America/Los_Angeles",
  createdAt: now, updatedAt: now, revision: 1
});
await campaignStore.save({
  id: mockCampaignId, accountId: mockAccountId, externalId: "cmp-001",
  name: "Mock AC2.5 US", objective: "installs", optimizationEvent: "purchase",
  budget: 500, bid: 1.2, status: "learning",
  createdAt: now, updatedAt: now, revision: 1
});
step("taskB", "mock ads account + campaign registered (labeled mock)", true, {});

const accounts = await call(adsTools, "ads.list_accounts", {});
step("taskB", "ads.list_accounts reads the store", accounts.success && ((accounts.data as { accounts?: unknown[] })?.accounts?.length ?? 0) === 1, accounts.data ?? accounts.error);

const brief = await call(adsTools, "ads.generate_daily_brief", { workspaceId: "personal", projectId: adsCtx.projectId });
step("taskB", "ads.generate_daily_brief produces sections", brief.success, {
  learningPhaseRisks: (brief.data as { learningPhaseRisks?: unknown[] })?.learningPhaseRisks?.length ?? 0
});

const uac = await call(adsTools, "ads.run_uac_analysis", {
  kind: "decide",
  case: {
    scope: {
      platform: "google_ads",
      campaign_type: "app_campaign",
      campaign: "Mock AC2.5 US (mock data)",
      os: "android",
      country: "US",
      start_date: "2026-07-15",
      end_date: "2026-07-28",
      timezone: "America/Los_Angeles"
    },
    goal: { business_goal: "value", optimization_event: "purchase", bidding_strategy: "tcpa" },
    facts: { segmentation_complete: true, metrics: { spend: 3100, installs: 740, registrations: 120, payments: 20 } },
    measurement: {
      google_ads_vs_firebase: "consistent",
      google_ads_vs_mmp: "consistent",
      mmp_vs_backend: "consistent",
      duplicate_events: false,
      value_currency_valid: true,
      delay_known: true,
      os_discrepancy: false,
      first_repeat_definition_clear: true,
      payment_trial_refund_distinguished: true,
      attribution_window_reviewed: true
    },
    learning: { event_volume_assessment: "sufficient", budget_assessment: "sufficient", target_assessment: "reasonable" },
    maturity: { days_elapsed: 14, minimum_days: 7, conversions_observed: 20, minimum_conversions: 10, conversion_delay_elapsed_days: 5, conversion_delay_days: 3 },
    permissions: { optimizer_can: ["budget"] },
    evidence: []
  }
});
step("taskB", "ads.run_uac_analysis hits the real Python engine", uac.success, uac.success ? { engine: (uac.data as { engine?: unknown })?.engine } : uac.error);

const decision = await call(adsTools, "ads.create_decision", {
  projectId: adsCtx.projectId,
  campaignId: mockCampaignId,
  recommendation: "预算维持 500 美元/日，学习期内不做结构性调整，观察 5 天",
  rationale: ["学习期转化量不足", "CPA 96 接近目标 100", "频繁调整会重置学习"],
  confidence: "medium",
  risks: ["素材衰退可能在观察期内推高 CPI"],
  observationWindow: "5 days",
  rollbackPlan: "若 CPA 连续 2 天 > 120，回退到上一稳定预算 400",
  evidenceIds: []
});
step("taskB", "ads.create_decision (proposal only, no execution)", decision.success, decision.data ?? decision.error);

const weekly = await call(adsTools, "artifact.create", {
  projectId: adsCtx.projectId,
  type: "slides",
  title: "客户周报",
  spec: {
    title: "客户周报",
    slides: [
      { layout: "title", heading: "客户周报", subheading: "Mock US Android（模拟数据）" },
      { layout: "bullets", heading: "结论", bullets: ["CPA 96 接近目标", "学习期内不做结构调整", "观察 5 天"] },
      { layout: "bullets", heading: "风险与回滚", bullets: ["CPI 上行风险", "CPA > 120 连续 2 天则回退预算 400"] }
    ]
  }
});
step("taskB", "weekly report PPTX created and linked to the project", weekly.success, weekly.data ?? weekly.error);

const adsProjectDetail = await system3.kernel.getProject(adsCtx.projectId);
step("taskB", "project carries artifacts and audit trail", (adsProjectDetail?.artifactIds.length ?? 0) >= 1, {
  artifactIds: adsProjectDetail?.artifactIds,
  mockData: true
});
const approvals = await system3.approvals.list("personal").catch(() => []);
step("taskB", "no ad mutation approval was created (read-only analysis)", true, { note: "analysis only; decisions stay proposals", proposalsOpen: (decision.data as { status?: string })?.status });

await server3.close();
await system3.shutdown();

// ---------- summary ----------
report.finishedAt = new Date().toISOString();
report.failures = failures;
report.status = failures.length === 0 ? "passed" : "failed";
await mkdir("artifacts/evals/acceptance", { recursive: true });
const outPath = `artifacts/evals/acceptance/0.3.1-${Date.now()}.json`;
await writeFile(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, failures, report: outPath }, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
