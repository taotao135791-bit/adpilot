import { z } from "zod";
import type { AgentToolDefinition } from "../registry.js";
import { assertWithinRoots } from "../paths.js";
import { succeed } from "../result.js";

const RootParams = z.object({ root: z.string().min(1) });
const PathsParams = RootParams.extend({ paths: z.array(z.string().min(1)).min(1) });

/**
 * Git tools: structured access to repositories inside the execution context's
 * rootPaths. Reads (status/diff/log) are always available to the pack;
 * branch/stage/worktree/checkpoint/commit are writes; restore and discard are
 * destructive. Commit, restore, and discard always snapshot a checkpoint
 * first so every mutation is reversible.
 */
export function createGitTools(): AgentToolDefinition[] {
  return [
    {
      name: "git.status",
      description: "Read a repository's branch, ahead/behind counts, staged/unstaged changes, and untracked files. Use before and after any git mutation.",
      capabilityPack: "git",
      permission: "read",
      parameters: RootParams,
      execute: async (raw, ctx, deps) => {
        const root = await assertWithinRoots(RootParams.parse(raw).root, ctx.rootPaths);
        return succeed("git.status", ctx, { root, status: await deps.git.repository(root).status() });
      }
    },
    {
      name: "git.diff",
      description: "Read a repository's diff (raw unified diff plus per-file stats), optionally staged-only, against a base revision, or limited to paths.",
      capabilityPack: "git",
      permission: "read",
      parameters: RootParams.extend({
        staged: z.boolean().optional(),
        baseSha: z.string().min(1).optional(),
        paths: z.array(z.string().min(1)).optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = RootParams.extend({
          staged: z.boolean().optional(),
          baseSha: z.string().min(1).optional(),
          paths: z.array(z.string().min(1)).optional()
        }).parse(raw);
        const root = await assertWithinRoots(params.root, ctx.rootPaths);
        const diff = await deps.git.repository(root).diff({
          ...(params.staged !== undefined ? { staged: params.staged } : {}),
          ...(params.baseSha !== undefined ? { baseSha: params.baseSha } : {}),
          ...(params.paths !== undefined ? { paths: params.paths } : {})
        });
        return succeed("git.diff", ctx, { root, diff });
      }
    },
    {
      name: "git.log",
      description: "Read recent commits (sha, subject, author, date), newest first. Use to understand history before committing or restoring.",
      capabilityPack: "git",
      permission: "read",
      parameters: RootParams.extend({ limit: z.number().int().positive().max(1000).optional() }),
      execute: async (raw, ctx, deps) => {
        const params = RootParams.extend({ limit: z.number().int().positive().max(1000).optional() }).parse(raw);
        const root = await assertWithinRoots(params.root, ctx.rootPaths);
        const entries = await deps.git.repository(root).log(params.limit);
        return succeed("git.log", ctx, { root, entries });
      }
    },
    {
      name: "git.create_branch",
      description: "Create a branch (optionally from a start point) without switching to it.",
      capabilityPack: "git",
      permission: "write",
      parameters: RootParams.extend({ name: z.string().min(1), startPoint: z.string().min(1).optional() }),
      execute: async (raw, ctx, deps) => {
        const params = RootParams.extend({ name: z.string().min(1), startPoint: z.string().min(1).optional() }).parse(raw);
        const root = await assertWithinRoots(params.root, ctx.rootPaths);
        await deps.git.repository(root).createBranch(params.name, params.startPoint);
        return succeed("git.create_branch", ctx, { root, branch: params.name });
      }
    },
    {
      name: "git.switch",
      description: "Switch the worktree to an existing branch. Refuses a dirty worktree instead of auto-stashing — commit, discard, or checkpoint first.",
      capabilityPack: "git",
      permission: "write",
      parameters: RootParams.extend({ name: z.string().min(1) }),
      execute: async (raw, ctx, deps) => {
        const params = RootParams.extend({ name: z.string().min(1) }).parse(raw);
        const root = await assertWithinRoots(params.root, ctx.rootPaths);
        await deps.git.repository(root).switchBranch(params.name);
        return succeed("git.switch", ctx, { root, branch: params.name });
      }
    },
    {
      name: "git.stage",
      description: "Stage paths for the next commit.",
      capabilityPack: "git",
      permission: "write",
      parameters: PathsParams,
      execute: async (raw, ctx, deps) => {
        const params = PathsParams.parse(raw);
        const root = await assertWithinRoots(params.root, ctx.rootPaths);
        await deps.git.repository(root).stage(params.paths);
        return succeed("git.stage", ctx, { root, staged: params.paths });
      }
    },
    {
      name: "git.unstage",
      description: "Unstage paths without touching worktree contents.",
      capabilityPack: "git",
      permission: "write",
      parameters: PathsParams,
      execute: async (raw, ctx, deps) => {
        const params = PathsParams.parse(raw);
        const root = await assertWithinRoots(params.root, ctx.rootPaths);
        await deps.git.repository(root).unstage(params.paths);
        return succeed("git.unstage", ctx, { root, unstaged: params.paths });
      }
    },
    {
      name: "git.create_worktree",
      description: "Create a managed worktree under <repo>/.adpilot-worktrees/<name> with its own branch. Use to isolate risky or parallel work from the main checkout.",
      capabilityPack: "git",
      permission: "write",
      parameters: RootParams.extend({
        name: z.string().min(1),
        branch: z.string().min(1).optional(),
        baseSha: z.string().min(1).optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = RootParams.extend({
          name: z.string().min(1),
          branch: z.string().min(1).optional(),
          baseSha: z.string().min(1).optional()
        }).parse(raw);
        const root = await assertWithinRoots(params.root, ctx.rootPaths);
        const worktree = await deps.git.worktrees(root).add({
          name: params.name,
          ...(params.branch !== undefined ? { branch: params.branch } : {}),
          ...(params.baseSha !== undefined ? { baseSha: params.baseSha } : {})
        });
        return succeed("git.create_worktree", ctx, { root, worktree });
      }
    },
    {
      name: "git.checkpoint",
      description: "Snapshot the repository state (HEAD, staged/unstaged diffs, small untracked files) as a restorable checkpoint. Use before any edit you might need to roll back.",
      capabilityPack: "git",
      permission: "write",
      parameters: RootParams.extend({ label: z.string().min(1), taskId: z.string().min(1).optional() }),
      execute: async (raw, ctx, deps) => {
        const params = RootParams.extend({ label: z.string().min(1), taskId: z.string().min(1).optional() }).parse(raw);
        const root = await assertWithinRoots(params.root, ctx.rootPaths);
        const taskId = params.taskId ?? ctx.taskId;
        const checkpoint = await deps.git.checkpoints(root).create({
          repoRoot: root,
          label: params.label,
          ...(taskId !== undefined ? { taskId } : {})
        });
        return succeed("git.checkpoint", ctx, { root, checkpointId: checkpoint.id, headSha: checkpoint.headSha }, {
          evidenceIds: [`git-checkpoint:${checkpoint.id}`]
        });
      }
    },
    {
      name: "git.commit",
      description: "Commit staged changes with a required message; snapshots a checkpoint first so the commit is reversible. Returns the new commit sha and the safety checkpoint id.",
      capabilityPack: "git",
      permission: "write",
      parameters: RootParams.extend({ message: z.string().min(1), allowEmpty: z.boolean().optional() }),
      execute: async (raw, ctx, deps) => {
        const params = RootParams.extend({ message: z.string().min(1), allowEmpty: z.boolean().optional() }).parse(raw);
        const root = await assertWithinRoots(params.root, ctx.rootPaths);
        const checkpoint = await deps.git.checkpoints(root).create({
          repoRoot: root,
          label: `before-commit: ${params.message.slice(0, 72)}`,
          ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {})
        });
        const sha = await deps.git.repository(root).commit(params.message, {
          ...(params.allowEmpty !== undefined ? { allowEmpty: params.allowEmpty } : {})
        });
        return succeed("git.commit", ctx, { root, sha, checkpointId: checkpoint.id }, {
          evidenceIds: [`git-checkpoint:${checkpoint.id}`, `git-commit:${sha}`]
        });
      }
    },
    {
      name: "git.restore_checkpoint",
      description: "Destructively roll the repository back to a checkpoint (rewrites index, tracked files, and snapshotted untracked files). A fresh safety checkpoint of the current state is taken first.",
      capabilityPack: "git",
      permission: "destructive",
      parameters: RootParams.extend({ checkpointId: z.string().min(1), force: z.boolean().optional() }),
      execute: async (raw, ctx, deps) => {
        const params = RootParams.extend({ checkpointId: z.string().min(1), force: z.boolean().optional() }).parse(raw);
        const root = await assertWithinRoots(params.root, ctx.rootPaths);
        const safety = await deps.git.checkpoints(root).create({
          repoRoot: root,
          label: `before-restore: ${params.checkpointId}`,
          ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {})
        });
        const restored = await deps.git.checkpoints(root).restore(params.checkpointId, {
          confirm: true,
          ...(params.force !== undefined ? { force: params.force } : {})
        });
        return succeed("git.restore_checkpoint", ctx, { root, restored, safetyCheckpointId: safety.id }, {
          evidenceIds: [`git-checkpoint:${safety.id}`]
        });
      }
    },
    {
      name: "git.discard",
      description: "Destructively discard staged and worktree changes for the given paths (restores them from HEAD). A fresh safety checkpoint of the current state is taken first.",
      capabilityPack: "git",
      permission: "destructive",
      parameters: PathsParams,
      execute: async (raw, ctx, deps) => {
        const params = PathsParams.parse(raw);
        const root = await assertWithinRoots(params.root, ctx.rootPaths);
        const safety = await deps.git.checkpoints(root).create({
          repoRoot: root,
          label: `before-discard: ${params.paths.join(", ").slice(0, 64)}`,
          ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {})
        });
        await deps.git.repository(root).discardChanges(params.paths, { confirm: true });
        return succeed("git.discard", ctx, { root, discarded: params.paths, safetyCheckpointId: safety.id }, {
          evidenceIds: [`git-checkpoint:${safety.id}`]
        });
      }
    }
  ];
}
