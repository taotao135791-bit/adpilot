/**
 * Universal Workspace client module: wire types for the kernel / terminal /
 * git / fs REST payloads, URL builders, and the pure view logic (task
 * grouping, terminal chunk merging, diff line classification, root-path
 * parsing). React-free so every rule stays unit-testable under the desktop
 * vitest config (node environment), matching the plugins.ts / sessionList.ts
 * convention.
 */
import type { ConversationMessage, ProductSession } from "./types.js";

/* ------------------------------------------------------------------ */
/* Wire types (mirror packages/kernel, packages/artifacts, terminal)   */
/* ------------------------------------------------------------------ */

export type KernelProject = {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  type: string;
  rootPaths: string[];
  enabledCapabilityPacks: string[];
  goalIds: string[];
  artifactIds: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type KernelGoal = {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  progress: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type KernelTask = {
  id: string;
  goalId?: string;
  parentId?: string;
  title: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type KernelArtifact = {
  id: string;
  projectId: string;
  sessionId?: string;
  type: string;
  title: string;
  previewUrl?: string;
  exportFormats: string[];
  version: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type ProjectDetail = KernelProject & {
  goals: KernelGoal[];
  tasks: KernelTask[];
  artifacts: KernelArtifact[];
};

export type FsTreeEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
  children?: FsTreeEntry[];
};

export type FsTreeResponse = { root: string; truncated: boolean; entries: FsTreeEntry[] };
export type FsFileResponse = { path: string; size: number; content: string };

export type SkillSummary = {
  name: string;
  description: string;
  triggers: string[];
  source: string;
  publisher?: string;
  license?: string;
};
export type SkillWarning = { path: string; source: string; reason: string };

export type TerminalSessionInfo = {
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  running: boolean;
  exitCode: number | null;
};

export type TerminalChunk = { seq: number; ts: number; stream: "stdout" | "stderr" | "meta"; data: string };

export type GitFileChange = { path: string; status: string; oldPath?: string };
export type GitStatusPayload = {
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
};
export type GitBranchInfo = { name: string; current: boolean; lastCommitSha: string };
export type CheckpointSummary = { id: string; createdAt: string; label: string; headSha: string; skippedUntracked: boolean };

export type CommandClassification = { verdict: string; reason: string };

/* ------------------------------------------------------------------ */
/* URL builders                                                        */
/* ------------------------------------------------------------------ */

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function kernelProjectsUrl(workspaceId: string): string {
  return `/api/kernel/projects${query({ workspaceId })}`;
}

export function kernelProjectUrl(projectId: string, workspaceId: string): string {
  return `/api/kernel/projects/${encodeURIComponent(projectId)}${query({ workspaceId })}`;
}

export function kernelArchiveProjectUrl(projectId: string): string {
  return `/api/kernel/projects/${encodeURIComponent(projectId)}/archive`;
}

export function kernelTasksUrl(workspaceId: string, filter: { goalId?: string; status?: string } = {}): string {
  return `/api/kernel/tasks${query({ workspaceId, goalId: filter.goalId, status: filter.status })}`;
}

export function kernelTaskCompleteUrl(taskId: string): string {
  return `/api/kernel/tasks/${encodeURIComponent(taskId)}/complete`;
}

export function kernelArtifactsUrl(workspaceId: string, projectId: string): string {
  return `/api/kernel/artifacts${query({ workspaceId, projectId })}`;
}

export function kernelArtifactUrl(artifactId: string, workspaceId: string): string {
  return `/api/kernel/artifacts/${encodeURIComponent(artifactId)}${query({ workspaceId })}`;
}

export function artifactOutputUrl(artifactId: string, outputPath: string, workspaceId: string): string {
  const encoded = outputPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `/api/kernel/artifacts/${encodeURIComponent(artifactId)}/output/${encoded}${query({ workspaceId })}`;
}

export function fsTreeUrl(root: string, depth = 2): string {
  return `/api/fs/tree${query({ root, depth })}`;
}

export function fsFileUrl(path: string): string {
  return `/api/fs/file${query({ path })}`;
}

export interface TerminalScope {
  clientId: string;
  projectId: string;
  root: string;
}

export function terminalOutputUrl(id: string, since: number, scope: TerminalScope): string {
  return `/api/terminals/${encodeURIComponent(id)}/output${query({ ...scope, since })}`;
}

export function terminalActionUrl(
  id: string,
  action: "input" | "exec" | "interrupt",
  scope: TerminalScope
): string {
  return `/api/terminals/${encodeURIComponent(id)}/${action}${query({
    clientId: scope.clientId,
    projectId: scope.projectId,
    root: scope.root
  })}`;
}

export function terminalUrl(id: string, scope: TerminalScope): string {
  return `/api/terminals/${encodeURIComponent(id)}${query({
    clientId: scope.clientId,
    projectId: scope.projectId,
    root: scope.root
  })}`;
}

export function gitGetUrl(action: string, params: Record<string, string | number | undefined>): string {
  return `/api/git/${action}${query(params)}`;
}

/* ------------------------------------------------------------------ */
/* Pure view logic                                                     */
/* ------------------------------------------------------------------ */

/** Parses the new-project rootPaths textarea: one path per line, trimmed, de-duplicated. */
export function parseRootPathsInput(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Timeline grouping for kernel tasks: running first, then queued, blocked
 * (waiting_approval folds in — it is blocked on a human), completed, and a
 * trailing failed group. Groups with no tasks are omitted by the view.
 */
export const TASK_GROUP_ORDER = ["running", "queued", "blocked", "completed", "failed"] as const;

export type TaskGroup = { status: (typeof TASK_GROUP_ORDER)[number]; tasks: KernelTask[] };

export function groupKernelTasks(tasks: readonly KernelTask[]): TaskGroup[] {
  const buckets = new Map<string, KernelTask[]>(TASK_GROUP_ORDER.map((status) => [status, []]));
  for (const task of tasks) {
    const key = task.status === "waiting_approval" ? "blocked" : task.status;
    const bucket = buckets.get(key) ?? buckets.get("queued");
    bucket?.push(task);
  }
  return TASK_GROUP_ORDER
    .map((status) => ({ status, tasks: buckets.get(status) ?? [] }))
    .filter((group) => group.tasks.length > 0);
}

/**
 * Incremental terminal polling: the server guarantees monotonically
 * increasing `seq` per session, so merging is "append chunks with seq greater
 * than the newest one we have" — duplicates from overlapping polls are
 * dropped, and output stays ordered even if a poll arrives late.
 */
export function mergeTerminalChunks(existing: readonly TerminalChunk[], incoming: readonly TerminalChunk[]): TerminalChunk[] {
  if (incoming.length === 0) return [...existing];
  const seen = new Set(existing.map((chunk) => chunk.seq));
  const additions = incoming.filter((chunk) => !seen.has(chunk.seq));
  if (additions.length === 0) return [...existing];
  return [...existing, ...additions].sort((left, right) => left.seq - right.seq);
}

export function terminalLastSeq(chunks: readonly TerminalChunk[]): number {
  let last = 0;
  for (const chunk of chunks) if (chunk.seq > last) last = chunk.seq;
  return last;
}

/** Local pseudo-chunk seq base: above anything a real session can emit (MAX_CHUNKS is 2000). */
export const LOCAL_CHUNK_BASE = 1_000_000;

export function localTerminalChunk(seq: number, data: string, stream: TerminalChunk["stream"] = "meta"): TerminalChunk {
  return { seq: LOCAL_CHUNK_BASE + seq, ts: Date.now(), stream, data };
}

/**
 * The `?since=` high-water mark for server polling. Local exec pseudo-chunks
 * live above LOCAL_CHUNK_BASE and must never raise the server watermark —
 * otherwise real shell output would be filtered out after the first exec.
 */
export function serverLastSeq(chunks: readonly TerminalChunk[]): number {
  let last = 0;
  for (const chunk of chunks) if (chunk.seq > last && chunk.seq < LOCAL_CHUNK_BASE) last = chunk.seq;
  return last;
}

/**
 * Strip ANSI escape sequences (CSI color/style, OSC titles, and the private
 * charset/ mode toggles interactive shells emit). The terminal view is a
 * plain-text log, not an emulator — raw codes would render as noise.
 */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][0-2]|\x1b[=>]/g;

export function stripAnsi(data: string): string {
  return data.replace(ANSI_PATTERN, "");
}

/** Diff line classification for the colored diff view. */
export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (/^(diff --git|index |new file|deleted file|old mode|new mode|similarity|rename |Binary )/.test(line)) return "meta";
  return "context";
}

/** Most-recently-updated artifacts first; the Home view caps the list. */
export function sortArtifactsRecent(artifacts: readonly KernelArtifact[], limit?: number): KernelArtifact[] {
  const sorted = [...artifacts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/** Active projects first by recency — the Home "active projects" cards. */
export function sortProjectsRecent(projects: readonly KernelProject[], limit?: number): KernelProject[] {
  const sorted = [...projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/** Time-of-day greeting bucket for the Home hero. */
export function homeGreetingKey(date: Date): "greetingMorning" | "greetingAfternoon" | "greetingEvening" {
  const hour = date.getHours();
  if (hour < 12) return "greetingMorning";
  if (hour < 18) return "greetingAfternoon";
  return "greetingEvening";
}

/** Replaces the `{token}` placeholders in copy strings (count, time, label…). */
export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** Short id fragment used wherever an entity id is surfaced (goal refs, tasks). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The default terminal/git root for a project: its first rootPath. */
export function projectDefaultRoot(project: Pick<KernelProject, "rootPaths"> | null | undefined): string {
  return project?.rootPaths[0] ?? "";
}

/** The original deliverable file an artifact offers for download, by extension. */
export function artifactDownloadFile(files: readonly string[]): string | undefined {
  const preferred = [".pptx", ".docx", ".xlsx", ".pdf", ".csv", ".html"];
  for (const extension of preferred) {
    const found = files.find((file) => file.toLowerCase().endsWith(extension));
    if (found) return found;
  }
  return undefined;
}

/** Slide thumbnails of one artifact version, carousel-ordered (thumb-01, thumb-02…). */
export function artifactThumbFiles(files: readonly string[]): string[] {
  return files.filter((file) => /^thumb-\d+\.svg$/.test(file)).sort();
}

export type ArtifactVersionFiles = { version: number; files: string[] };

/** Files of the artifact's current version from the detail payload's version list. */
export function currentVersionFiles(artifact: KernelArtifact, versions: readonly ArtifactVersionFiles[]): string[] {
  return versions.find((entry) => entry.version === artifact.version)?.files ?? [];
}


/* ------------------------------------------------------------------ */
/* Automations (packages/automations wire mirror)                      */
/* ------------------------------------------------------------------ */

export type CronSpecFields = { minute: string; hour: string; dom: string; month: string; dow: string };

export type AutomationTrigger =
  | { kind: "schedule"; cron: CronSpecFields }
  | { kind: "event"; event: string; condition?: string };

export type AutomationAction =
  | { kind: "daily-brief"; input: Record<string, unknown> }
  | { kind: "create-task"; task: { goalId?: string; title: string; description: string } }
  | { kind: "notify"; message: string };

export type AutomationRunStatus = "running" | "succeeded" | "failed" | "skipped-duplicate" | "waiting-approval";

export type Automation = {
  id: string;
  workspaceId: string;
  projectId?: string;
  title: string;
  description?: string;
  trigger: AutomationTrigger;
  action: AutomationAction;
  guards: { maxRunsPerDay: number; maxCostUsd?: number; requiresApprovalForMutation: true };
  state: "active" | "paused";
  idempotencyWindowSeconds: number;
  nextFireAt?: string;
  lastRunAt?: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type AutomationRun = {
  id: string;
  automationId: string;
  idempotencyKey: string;
  startedAt: string;
  finishedAt?: string;
  status: AutomationRunStatus;
  approvalId?: string;
  result?: unknown;
  error?: string;
  runLog: { ts: string; message: string }[];
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type AppNotification = {
  id: string;
  workspaceId: string;
  automationId?: string;
  runId?: string;
  message: string;
  read: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export function automationsUrl(workspaceId: string): string {
  return `/api/automations${query({ workspaceId })}`;
}

export function automationUrl(automationId: string, workspaceId: string): string {
  return `/api/automations/${encodeURIComponent(automationId)}${query({ workspaceId })}`;
}

export function automationActionUrl(automationId: string, action: "pause" | "resume" | "run-now"): string {
  return `/api/automations/${encodeURIComponent(automationId)}/${action}`;
}

export function automationRunsUrl(automationId: string, workspaceId: string): string {
  return `/api/automations/${encodeURIComponent(automationId)}/runs${query({ workspaceId })}`;
}

export function automationRunApproveUrl(runId: string): string {
  return `/api/automation-runs/${encodeURIComponent(runId)}/approve`;
}

export function notificationsUrl(workspaceId: string, unread?: boolean): string {
  return `/api/notifications${query({ workspaceId, unread: unread === undefined ? undefined : String(unread) })}`;
}

export function notificationReadUrl(notificationId: string): string {
  return `/api/notifications/${encodeURIComponent(notificationId)}/read`;
}

/* ------------------------------------------------------------------ */
/* Automation view logic (pure, unit-tested)                           */
/* ------------------------------------------------------------------ */

/** Create-dialog schedule presets; `custom` keeps whatever the user typed. */
export const CRON_PRESETS = ["daily-morning", "hourly", "weekly-monday", "custom"] as const;
export type CronPreset = (typeof CRON_PRESETS)[number];

export function cronPresetFields(preset: Exclude<CronPreset, "custom">): CronSpecFields {
  if (preset === "hourly") return { minute: "0", hour: "*", dom: "*", month: "*", dow: "*" };
  if (preset === "weekly-monday") return { minute: "0", hour: "9", dom: "*", month: "*", dow: "1" };
  return { minute: "0", hour: "9", dom: "*", month: "*", dow: "*" };
}

/**
 * Structured, locale-free reading of a cron spec. Recognizes the common
 * shapes exactly (single numeric fields + wildcards); anything richer falls
 * back to `raw` so the view prints the spec verbatim instead of guessing.
 */
export type CronDescription =
  | { kind: "every-minute" }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; dow: number; time: string }
  | { kind: "monthly"; dom: number; time: string }
  | { kind: "raw"; text: string };

function singleNumber(field: string): number | null {
  return /^\d{1,2}$/.test(field.trim()) ? Number(field.trim()) : null;
}

function clockTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function describeCron(spec: CronSpecFields): CronDescription {
  const minute = singleNumber(spec.minute);
  const hour = singleNumber(spec.hour);
  const dom = singleNumber(spec.dom);
  const dow = singleNumber(spec.dow);
  const anyRest = spec.dom.trim() === "*" && spec.month.trim() === "*" && spec.dow.trim() === "*";
  if (spec.minute.trim() === "*" && spec.hour.trim() === "*" && anyRest) return { kind: "every-minute" };
  if (minute !== null && spec.hour.trim() === "*" && anyRest) return { kind: "hourly", minute };
  if (minute !== null && hour !== null && anyRest) return { kind: "daily", time: clockTime(hour, minute) };
  if (minute !== null && hour !== null && spec.dom.trim() === "*" && spec.month.trim() === "*" && dow !== null) {
    return { kind: "weekly", dow: dow % 7, time: clockTime(hour, minute) };
  }
  if (minute !== null && hour !== null && dom !== null && spec.month.trim() === "*" && spec.dow.trim() === "*") {
    return { kind: "monthly", dom, time: clockTime(hour, minute) };
  }
  return { kind: "raw", text: `${spec.minute} ${spec.hour} ${spec.dom} ${spec.month} ${spec.dow}` };
}

/** True when every cron field is non-blank (client-side pre-validation only). */
export function cronFieldsComplete(spec: CronSpecFields): boolean {
  return [spec.minute, spec.hour, spec.dom, spec.month, spec.dow].every((field) => field.trim().length > 0);
}

/** One-line run summary for the runs list: the error, or a truncated JSON result. */
export function automationRunSummary(run: AutomationRun, maxLength = 96): string {
  const raw = run.error !== undefined
    ? run.error
    : run.result !== undefined
      ? JSON.stringify(run.result)
      : "";
  if (!raw) return "";
  return raw.length > maxLength ? `${raw.slice(0, maxLength - 1)}…` : raw;
}

/** Newest-started first; the runs panel caps the list. */
export function sortRunsRecent(runs: readonly AutomationRun[], limit?: number): AutomationRun[] {
  const sorted = [...runs].sort(
    (left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id)
  );
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

export function countUnread(notifications: readonly AppNotification[]): number {
  return notifications.filter((notification) => !notification.read).length;
}

/* ------------------------------------------------------------------ */
/* Ads intelligence (packages/ads-intelligence wire mirror)            */
/* ------------------------------------------------------------------ */

export type AdPlatform = "google" | "meta" | "tiktok" | "other";

export type AdAccount = {
  id: string;
  workspaceId: string;
  platform: AdPlatform;
  externalId?: string;
  name: string;
  currency?: string;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type AdCampaign = {
  id: string;
  accountId: string;
  externalId?: string;
  name: string;
  objective?: string;
  optimizationEvent?: string;
  budget?: number;
  bid?: number;
  status?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type CreativeLifecycle = "new" | "active" | "fatiguing" | "retired";

export type AdCreative = {
  id: string;
  accountId: string;
  name: string;
  platform: AdPlatform;
  campaignIds: string[];
  metrics?: { spend?: number; ctr?: number; cpi?: number; cpa?: number };
  lifecycle?: CreativeLifecycle;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type DecisionConfidence = "low" | "medium" | "high";

export type DecisionStatus =
  | "proposed"
  | "approved"
  | "executed"
  | "observing"
  | "successful"
  | "failed"
  | "reverted";

export type AdDecision = {
  id: string;
  projectId: string;
  campaignId?: string;
  recommendation: string;
  rationale: string[];
  evidenceIds: string[];
  confidence: DecisionConfidence;
  risks: string[];
  observationWindow?: string;
  rollbackPlan?: string;
  status: DecisionStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type BriefSeverity = "info" | "warning" | "critical";

export type BriefItem = {
  ruleId: string;
  severity: BriefSeverity;
  title: string;
  detail: string;
  entityRefs: {
    accountId?: string;
    campaignId?: string;
    creativeId?: string;
    decisionId?: string;
    experimentId?: string;
    reportId?: string;
  };
  evidenceIds: string[];
};

export const BRIEF_SECTION_KEYS = [
  "anomalyAccounts",
  "creativeFatigue",
  "learningPhaseRisks",
  "pendingObservations",
  "pendingApprovals",
  "pendingReports",
  "measurementIssues"
] as const;
export type BriefSectionKey = (typeof BRIEF_SECTION_KEYS)[number];

export type DailyBrief = {
  schemaVersion: string;
  generatedAt: string;
  workspaceId: string;
  projectId?: string;
  sections: Record<BriefSectionKey, BriefItem[]>;
  summary: { totalFindings: number; criticalCount: number; warningCount: number; infoCount: number };
};

/**
 * Caller-assembled facts for POST /api/ads/daily-brief. The desktop has no
 * metrics pipeline of its own, so rows carry only what the registries know —
 * entity ids as evidence refs, plus the campaign status string the
 * learning-phase rules read. No spend/CPA numbers are ever fabricated.
 */
export type BriefFacts = {
  metrics: {
    accounts: { accountId: string; evidenceIds: string[] }[];
    campaigns: { campaignId: string; learningStatus?: string; evidenceIds: string[] }[];
    creatives: { creativeId: string; evidenceIds: string[] }[];
  };
};

export function adsAccountsUrl(workspaceId: string): string {
  return `/api/ads/accounts${query({ workspaceId })}`;
}

export function adsCampaignsUrl(workspaceId: string, accountId?: string): string {
  return `/api/ads/campaigns${query({ workspaceId, accountId })}`;
}

export function adsCreativesUrl(workspaceId: string, accountId?: string): string {
  return `/api/ads/creatives${query({ workspaceId, accountId })}`;
}

export function adsDecisionsUrl(workspaceId: string, projectId: string, status?: string): string {
  return `/api/ads/decisions${query({ workspaceId, projectId, status })}`;
}

export function adsDecisionTransitionUrl(decisionId: string): string {
  return `/api/ads/decisions/${encodeURIComponent(decisionId)}/transition`;
}

export function adsDailyBriefUrl(): string {
  return "/api/ads/daily-brief";
}

/* ------------------------------------------------------------------ */
/* Ads view logic (pure, unit-tested)                                  */
/* ------------------------------------------------------------------ */

/** Minimal facts assembly from the account/campaign/creative registries. */
export function buildBriefFacts(input: {
  accounts: readonly AdAccount[];
  campaigns: readonly AdCampaign[];
  creatives: readonly AdCreative[];
}): BriefFacts {
  return {
    metrics: {
      accounts: input.accounts.map((account) => ({ accountId: account.id, evidenceIds: [`account:${account.id}`] })),
      campaigns: input.campaigns.map((campaign) => ({
        campaignId: campaign.id,
        ...(campaign.status !== undefined ? { learningStatus: campaign.status } : {}),
        evidenceIds: [`campaign:${campaign.id}`]
      })),
      creatives: input.creatives.map((creative) => ({ creativeId: creative.id, evidenceIds: [`creative:${creative.id}`] }))
    }
  };
}

export type BriefSection = { key: BriefSectionKey; items: BriefItem[] };

/**
 * The seven brief sections in their canonical display order. Missing keys in
 * a partial payload normalize to empty lists; the view hides empty sections.
 */
export function briefSections(brief: DailyBrief): BriefSection[] {
  return BRIEF_SECTION_KEYS.map((key) => ({ key, items: brief.sections?.[key] ?? [] }));
}

/** Worst severity inside a section — drives the count badge tone. */
export function briefSectionSeverity(items: readonly BriefItem[]): BriefSeverity | null {
  if (items.some((item) => item.severity === "critical")) return "critical";
  if (items.some((item) => item.severity === "warning")) return "warning";
  if (items.length > 0) return "info";
  return null;
}

/**
 * Desktop decision records are deliberately read-only until a Decision is
 * durably linked to the real Approval → Computer Action →
 * Experiment chain. The legacy transition endpoint remains server-compatible,
 * but no persisted status is sufficient evidence for this UI to expose an
 * execution, observation, outcome, or rollback action.
 */
export function decisionTransitionActions(_status: DecisionStatus): readonly never[] {
  return [];
}

/** Most-recently-updated decisions first; the decision ledger caps the list. */
export function sortDecisionsRecent(decisions: readonly AdDecision[], limit?: number): AdDecision[] {
  const sorted = [...decisions].sort(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)
  );
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Project session binding (Project → Session → Message chain)         */
/* ------------------------------------------------------------------ */

/**
 * The Project workbench chat is backed by a durable product Session bound to
 * the kernel project. The server owns session selection (most recent active,
 * lazy creation, kernel linkSession); these builders only shape the request
 * payloads so the view layer carries no string concatenation.
 */

export function kernelProjectSessionUrl(projectId: string): string {
  return `/api/kernel/projects/${encodeURIComponent(projectId)}/session`;
}

export function kernelProjectMissionUrl(projectId: string): string {
  return `/api/kernel/projects/${encodeURIComponent(projectId)}/mission`;
}

export type ProjectSessionRequest = { workspaceId: string; force?: boolean };

/** Body for POST /api/kernel/projects/:id/session; `force` asks for a fresh session. */
export function buildProjectSessionRequest(workspaceId: string, force = false): ProjectSessionRequest {
  return force ? { workspaceId, force: true } : { workspaceId };
}

export type ProjectMissionRequest = { workspaceId: string; message: string };

/** Body for POST /api/kernel/projects/:id/mission (complexity triage). */
export function buildMissionRequest(workspaceId: string, message: string): ProjectMissionRequest {
  return { workspaceId, message };
}

export type ProjectMessageRequest = {
  clientId: string;
  sessionId: string;
  projectId: string;
  goalId?: string;
  taskId?: string;
  message: string;
  locale: string;
};

/**
 * Body for POST /api/messages on the project path. goal/task ids come from the
 * mission triage and are omitted entirely when the mission stayed small talk —
 * the server treats absent ids as "plain conversation turn".
 */
export function buildProjectMessageRequest(input: {
  clientId: string;
  sessionId: string;
  projectId: string;
  goalId?: string | undefined;
  taskId?: string | undefined;
  message: string;
  locale: string;
}): ProjectMessageRequest {
  return {
    clientId: input.clientId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    ...(input.goalId ? { goalId: input.goalId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    message: input.message,
    locale: input.locale
  };
}

/** Optimistic user bubble, mirroring the App chat path's `local-*` id convention. */
export function localProjectUserMessage(clientId: string, conversationId: string, content: string): ConversationMessage {
  return {
    id: `local-${Date.now()}`,
    clientId,
    conversationId,
    role: "user",
    content,
    status: "complete",
    at: new Date().toISOString()
  };
}

/** A project folder (or the ungrouped bucket) with its sessions, sidebar order. */
export type SessionGroup = {
  project: KernelProject | null;
  sessions: ProductSession[];
};

/**
 * Group sessions under their bound kernel project, Codex-style: one folder
 * per project ordered by the freshest session inside, ungrouped sessions
 * last under the workspace bucket. Projects without sessions still appear
 * so the folder tree stays stable.
 */
export function groupSessionsByProject(
  sessions: readonly ProductSession[],
  projects: readonly KernelProject[]
): SessionGroup[] {
  const byProject = new Map<string, ProductSession[]>();
  const ungrouped: ProductSession[] = [];
  for (const session of sessions) {
    if (session.projectId && projects.some((project) => project.id === session.projectId)) {
      const bucket = byProject.get(session.projectId) ?? [];
      bucket.push(session);
      byProject.set(session.projectId, bucket);
    } else {
      ungrouped.push(session);
    }
  }
  const activeProjects = projects.filter((project) => project.status !== "archived");
  const groups: SessionGroup[] = activeProjects
    .map((project) => ({
      project,
      sessions: (byProject.get(project.id) ?? []).sort((left, right) =>
        right.lastActivityAt.localeCompare(left.lastActivityAt))
    }))
    .filter((group) => group.sessions.length > 0)
    .sort((left, right) =>
      right.sessions[0]!.lastActivityAt.localeCompare(left.sessions[0]!.lastActivityAt));
  ungrouped.sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  if (ungrouped.length > 0) groups.push({ project: null, sessions: ungrouped });
  return groups;
}
