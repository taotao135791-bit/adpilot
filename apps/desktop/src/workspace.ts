/**
 * Universal Workspace client module: wire types for the kernel / terminal /
 * git / fs REST payloads, URL builders, and the pure view logic (task
 * grouping, terminal chunk merging, diff line classification, root-path
 * parsing). React-free so every rule stays unit-testable under the desktop
 * vitest config (node environment), matching the plugins.ts / sessionList.ts
 * convention.
 */

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

export type SkillSummary = { name: string; description: string; triggers: string[]; source: string };
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

export function terminalOutputUrl(id: string, since: number): string {
  return `/api/terminals/${encodeURIComponent(id)}/output${query({ since })}`;
}

export function terminalActionUrl(id: string, action: "input" | "exec" | "interrupt"): string {
  return `/api/terminals/${encodeURIComponent(id)}/${action}`;
}

export function terminalUrl(id: string): string {
  return `/api/terminals/${encodeURIComponent(id)}`;
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
