import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdPilotSystem } from "@adpilot/application";
import { CheckpointStore, GitRepository, WorktreeManager, type Checkpoint } from "@adpilot/git-tools";

const execFileAsync = promisify(execFile);

const RootQuery = z.object({
  root: z.string().min(1).max(4_096)
}).strict();

const DiffQuery = z.object({
  root: z.string().min(1).max(4_096),
  staged: z.enum(["true", "false"]).optional(),
  baseSha: z.string().min(1).max(128).optional(),
  paths: z.string().min(1).max(8_000).optional()
}).strict();

const LogQuery = z.object({
  root: z.string().min(1).max(4_096),
  limit: z.coerce.number().int().positive().max(1_000).optional()
}).strict();

const BranchBody = z.object({
  root: z.string().min(1).max(4_096),
  name: z.string().trim().min(1).max(256),
  startPoint: z.string().trim().min(1).max(256).optional()
}).strict();

const SwitchBody = z.object({
  root: z.string().min(1).max(4_096),
  name: z.string().trim().min(1).max(256)
}).strict();

const PathsBody = z.object({
  root: z.string().min(1).max(4_096),
  paths: z.array(z.string().min(1).max(1_024)).min(1).max(256)
}).strict();

const CommitBody = z.object({
  workspaceId: z.string().min(1).max(256),
  root: z.string().min(1).max(4_096),
  message: z.string().min(1).max(8_000)
}).strict();

const DiscardBody = z.object({
  workspaceId: z.string().min(1).max(256),
  root: z.string().min(1).max(4_096),
  paths: z.array(z.string().min(1).max(1_024)).min(1).max(256),
  confirm: z.literal(true)
}).strict();

const WorktreeAddBody = z.object({
  root: z.string().min(1).max(4_096),
  name: z.string().trim().min(1).max(128),
  branch: z.string().trim().min(1).max(256).optional(),
  baseSha: z.string().trim().min(1).max(128).optional()
}).strict();

const WorktreeRemoveQuery = z.object({
  workspaceId: z.string().min(1).max(256),
  root: z.string().min(1).max(4_096),
  force: z.enum(["true", "false"]).optional()
}).strict();

const WorktreeNameParams = z.object({ name: z.string().min(1).max(128) });

const CheckpointCreateBody = z.object({
  root: z.string().min(1).max(4_096),
  label: z.string().trim().min(1).max(256),
  taskId: z.string().trim().min(1).max(128).optional()
}).strict();

const CheckpointRestoreBody = z.object({
  workspaceId: z.string().min(1).max(256),
  confirm: z.literal(true),
  force: z.boolean().optional()
}).strict();

const CheckpointIdParams = z.object({ id: z.string().uuid() });

/** Routes-local error carrying the REST machine-readable code contract. */
class GitRouteError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "GitRouteError";
    this.code = code;
  }
}

/**
 * Universal Workspace git routes over @adpilot/git-tools. The `root` argument
 * must be an existing directory and the repository top level (GitRepository
 * pins it); checkpoint stores live under `<repoRoot>/.adpilot/checkpoints`,
 * which is added to `.git/info/exclude` on first use so snapshots never
 * capture the store itself. Destructive mutations (commit, discard,
 * checkpoint restore, worktree remove) require a valid workspaceId and are
 * written to the audit chain on success.
 */
export function registerGitRoutes(app: FastifyInstance, system: AdPilotSystem): void {
  async function requireWorkspace(workspaceId: string): Promise<void> {
    await system.workspace.readClient(workspaceId);
  }

  async function auditGit(workspaceId: string, action: string, details: Record<string, unknown>): Promise<void> {
    await system.audit.append({
      clientId: workspaceId,
      actor: "workspace-owner",
      action,
      status: "succeeded",
      details
    });
  }

  app.get("/api/git/status", async (request) => {
    const query = RootQuery.parse(request.query);
    return (await repoFor(query.root)).status();
  });

  app.get("/api/git/branches", async (request) => {
    const query = RootQuery.parse(request.query);
    return { branches: await (await repoFor(query.root)).branches() };
  });

  app.post("/api/git/branch", async (request, reply) => {
    const body = BranchBody.parse(request.body);
    const repo = await repoFor(body.root);
    await repo.createBranch(body.name, body.startPoint);
    reply.code(201);
    return { name: body.name };
  });

  app.post("/api/git/switch", async (request) => {
    const body = SwitchBody.parse(request.body);
    const repo = await repoFor(body.root);
    await repo.switchBranch(body.name);
    return { ok: true, branch: body.name };
  });

  app.get("/api/git/diff", async (request) => {
    const query = DiffQuery.parse(request.query);
    const repo = await repoFor(query.root);
    const paths = query.paths
      ?.split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return repo.diff({
      ...(query.staged !== undefined ? { staged: query.staged === "true" } : {}),
      ...(query.baseSha !== undefined ? { baseSha: query.baseSha } : {}),
      ...(paths && paths.length > 0 ? { paths } : {})
    });
  });

  app.get("/api/git/log", async (request) => {
    const query = LogQuery.parse(request.query);
    const repo = await repoFor(query.root);
    return { entries: await repo.log(query.limit ?? 20) };
  });

  app.post("/api/git/stage", async (request) => {
    const body = PathsBody.parse(request.body);
    const repo = await repoFor(body.root);
    await repo.stage(body.paths);
    return { ok: true };
  });

  app.post("/api/git/unstage", async (request) => {
    const body = PathsBody.parse(request.body);
    const repo = await repoFor(body.root);
    await repo.unstage(body.paths);
    return { ok: true };
  });

  app.post("/api/git/commit", async (request) => {
    const body = CommitBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const repo = await repoFor(body.root);
    const sha = await repo.commit(body.message);
    await auditGit(body.workspaceId, "git_commit", { root: repo.root, sha, message: body.message });
    return { sha };
  });

  app.post("/api/git/discard", async (request) => {
    const body = DiscardBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const repo = await repoFor(body.root);
    await repo.discardChanges(body.paths, { confirm: body.confirm });
    await auditGit(body.workspaceId, "git_discard", { root: repo.root, paths: body.paths });
    return { ok: true };
  });

  app.get("/api/git/worktrees", async (request) => {
    const query = RootQuery.parse(request.query);
    const repo = await repoFor(query.root);
    return { worktrees: await new WorktreeManager(repo.root).list() };
  });

  app.post("/api/git/worktrees", async (request, reply) => {
    const body = WorktreeAddBody.parse(request.body);
    const repo = await repoFor(body.root);
    const result = await new WorktreeManager(repo.root).add({
      name: body.name,
      ...(body.branch !== undefined ? { branch: body.branch } : {}),
      ...(body.baseSha !== undefined ? { baseSha: body.baseSha } : {})
    });
    reply.code(201);
    return result;
  });

  app.delete("/api/git/worktrees/:name", async (request) => {
    const params = WorktreeNameParams.parse(request.params);
    const query = WorktreeRemoveQuery.parse(request.query);
    await requireWorkspace(query.workspaceId);
    const repo = await repoFor(query.root);
    const force = query.force === "true";
    await new WorktreeManager(repo.root).remove(params.name, { force });
    await auditGit(query.workspaceId, "git_worktree_remove", { root: repo.root, name: params.name, force });
    return { ok: true };
  });

  app.get("/api/git/checkpoints", async (request) => {
    const query = RootQuery.parse(request.query);
    const { store, root } = await checkpointsFor(query.root);
    return { checkpoints: (await store.list(root)).map(checkpointSummary) };
  });

  app.post("/api/git/checkpoints", async (request, reply) => {
    const body = CheckpointCreateBody.parse(request.body);
    const { store, root } = await checkpointsFor(body.root);
    const checkpoint = await store.create({
      repoRoot: root,
      label: body.label,
      ...(body.taskId !== undefined ? { taskId: body.taskId } : {})
    });
    reply.code(201);
    return checkpointSummary(checkpoint);
  });

  app.post("/api/git/checkpoints/:id/restore", async (request) => {
    const params = CheckpointIdParams.parse(request.params);
    const query = RootQuery.parse(request.query);
    const body = CheckpointRestoreBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const { store, root } = await checkpointsFor(query.root);
    const result = await store.restore(params.id, {
      confirm: body.confirm,
      ...(body.force !== undefined ? { force: body.force } : {})
    });
    await auditGit(body.workspaceId, "git_checkpoint_restore", {
      root,
      checkpointId: params.id,
      headSha: result.headSha
    });
    return result;
  });
}

async function resolveRoot(root: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(root);
  } catch (error) {
    throw new GitRouteError(`git root does not exist: ${root}`, "GIT_ROOT_INVALID");
  }
  const metadata = await stat(canonical).catch(() => null);
  if (!metadata?.isDirectory()) {
    throw new GitRouteError(`git root is not a directory: ${root}`, "GIT_ROOT_INVALID");
  }
  return canonical;
}

async function repoFor(root: string): Promise<GitRepository> {
  return new GitRepository(await resolveRoot(root));
}

async function checkpointsFor(rootInput: string): Promise<{ store: CheckpointStore; root: string }> {
  const repo = await repoFor(rootInput);
  await ensurePrivateDirExcluded(repo.root);
  return { store: new CheckpointStore(join(repo.root, ".adpilot", "checkpoints")), root: repo.root };
}

/**
 * Keeps `<repoRoot>/.adpilot/` out of git status (and therefore out of
 * checkpoint snapshots) by adding it to `.git/info/exclude`, mirroring how
 * WorktreeManager confines its container directory.
 */
async function ensurePrivateDirExcluded(repoRoot: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repoRoot });
  const gitPath = stdout.trim();
  const excludePath = isAbsolute(gitPath) ? gitPath : join(repoRoot, gitPath);
  await mkdir(dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    // A missing exclude file starts fresh.
  }
  if (existing.split(/\r?\n/).includes(".adpilot/")) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(excludePath, `${existing}${prefix}# AdPilot private data\n.adpilot/\n`, "utf8");
}

/** Listings and creates never leak snapshot payloads (diffs, untracked contents) into REST responses. */
function checkpointSummary(checkpoint: Checkpoint) {
  return {
    id: checkpoint.id,
    createdAt: checkpoint.createdAt,
    label: checkpoint.label,
    ...(checkpoint.taskId !== undefined ? { taskId: checkpoint.taskId } : {}),
    headSha: checkpoint.headSha,
    skippedUntracked: checkpoint.skippedUntracked
  };
}
