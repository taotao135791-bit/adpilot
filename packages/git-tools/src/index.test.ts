/**
 * Integration tests for @adpilot/git-tools. Every test runs against real git
 * repositories created in mkdtemp directories (git init -b main + local
 * user.email/user.name); nothing is mocked.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CheckpointStore,
  GitRepository,
  GitToolError,
  WorktreeManager,
  type Checkpoint
} from "./index.js";

const execFileAsync = promisify(execFile);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function createRepo(): Promise<string> {
  const root = await temporaryRoot("adpilot-git-tools-repo-");
  await git(root, "init", "-b", "main", "-q");
  await git(root, "config", "user.email", "git-tools@adpilot.test");
  await git(root, "config", "user.name", "AdPilot Git Tools Test");
  return root;
}

async function createStore(): Promise<CheckpointStore> {
  return new CheckpointStore(join(await temporaryRoot("adpilot-git-tools-store-"), "checkpoints"));
}

async function commitFile(root: string, name: string, content: string, message: string): Promise<void> {
  await writeFile(join(root, name), content);
  await git(root, "add", name);
  await git(root, "commit", "-qm", message);
}

describe("GitRepository construction", () => {
  it("rejects directories that are not git repositories", async () => {
    const root = await temporaryRoot("adpilot-git-tools-plain-");
    expect(() => new GitRepository(root)).toThrowError(expect.objectContaining({ code: "NOT_A_REPOSITORY" }));
  });

  it("rejects subdirectories of a repository", async () => {
    const root = await createRepo();
    await mkdir(join(root, "sub"));
    await commitFile(root, "a.txt", "one\n", "initial");
    expect(() => new GitRepository(join(root, "sub"))).toThrowError(
      expect.objectContaining({ code: "REPOSITORY_ROOT_MISMATCH" })
    );
    expect(() => new GitRepository(join(root, ".git"))).toThrowError(
      expect.objectContaining({ code: "REPOSITORY_ROOT_MISMATCH" })
    );
  });

  it("rejects bare repositories", async () => {
    const root = await temporaryRoot("adpilot-git-tools-bare-");
    await git(root, "init", "--bare", "-q", "repo.git");
    expect(() => new GitRepository(join(root, "repo.git"))).toThrowError(
      expect.objectContaining({ code: "BARE_REPOSITORY" })
    );
  });
});

describe("GitRepository.status", () => {
  it("parses staged, unstaged, untracked and renames", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "initial");
    await commitFile(root, "b.txt", "two\n", "second");
    const repo = new GitRepository(root);

    await git(root, "mv", "a.txt", "renamed.txt");
    await writeFile(join(root, "b.txt"), "two\nchanged\n");
    await writeFile(join(root, "new.txt"), "new\n");

    const status = await repo.status();
    expect(status.branch).toBe("main");
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.staged).toEqual([{ path: "renamed.txt", status: "renamed", oldPath: "a.txt" }]);
    expect(status.unstaged).toEqual([{ path: "b.txt", status: "modified" }]);
    expect(status.untracked).toEqual(["new.txt"]);
  });

  it("reports a clean tree right after a commit", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "initial");
    const status = await new GitRepository(root).status();
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
  });
});

describe("GitRepository branches", () => {
  it("creates, lists and switches branches", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "initial");
    const repo = new GitRepository(root);
    const headSha = await repo.headSha();

    await repo.createBranch("feature");
    const branches = await repo.branches();
    expect(branches).toEqual([
      { name: "feature", current: false, lastCommitSha: headSha },
      { name: "main", current: true, lastCommitSha: headSha }
    ]);

    await repo.switchBranch("feature");
    expect((await repo.status()).branch).toBe("feature");
  });

  it("refuses to switch with staged or unstaged changes (DIRTY_WORKTREE)", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "initial");
    const repo = new GitRepository(root);
    await repo.createBranch("feature");

    await writeFile(join(root, "a.txt"), "dirty\n");
    await expect(repo.switchBranch("feature")).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    expect((await repo.status()).branch).toBe("main");

    await git(root, "add", "a.txt");
    await expect(repo.switchBranch("feature")).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
  });

  it("allows switching when only untracked files are present", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "initial");
    const repo = new GitRepository(root);
    await repo.createBranch("feature");
    await writeFile(join(root, "scratch.txt"), "scratch\n");
    await repo.switchBranch("feature");
    expect((await repo.status()).branch).toBe("feature");
  });
});

describe("GitRepository.diff", () => {
  it("reports correct per-file additions/deletions for unstaged and staged diffs", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "l1\nl2\nl3\n", "initial");
    await commitFile(root, "b.txt", "keep\n", "second");
    const repo = new GitRepository(root);

    // one line changed (-1/+1), two lines appended (+2)
    await writeFile(join(root, "a.txt"), "l1\nl2-modified\nl3\nl4\nl5\n");

    const unstaged = await repo.diff();
    expect(unstaged.raw).toContain("diff --git a/a.txt b/a.txt");
    expect(unstaged.files).toEqual([{ path: "a.txt", additions: 3, deletions: 1, status: "modified" }]);

    const stagedEmpty = await repo.diff({ staged: true });
    expect(stagedEmpty.files).toEqual([]);

    await git(root, "add", "a.txt");
    const staged = await repo.diff({ staged: true });
    expect(staged.files).toEqual([{ path: "a.txt", additions: 3, deletions: 1, status: "modified" }]);

    const scoped = await repo.diff({ staged: true, paths: ["b.txt"] });
    expect(scoped.files).toEqual([]);
  });

  it("diffs against a base sha and reports renames with the new path", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "initial");
    const repo = new GitRepository(root);
    const baseSha = (await repo.headSha())!;
    await git(root, "mv", "a.txt", "renamed.txt");
    await git(root, "commit", "-qm", "rename");

    const diff = await repo.diff({ baseSha });
    expect(diff.files).toEqual([{ path: "renamed.txt", additions: 0, deletions: 0, status: "renamed" }]);
  });
});

describe("GitRepository staging and commit flow", () => {
  it("stages, commits, logs and unstages", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "initial");
    const repo = new GitRepository(root);

    await writeFile(join(root, "b.txt"), "two\n");
    await repo.stage(["b.txt"]);
    expect((await repo.status()).staged).toEqual([{ path: "b.txt", status: "added" }]);

    const sha = await repo.commit("add b.txt");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.headSha()).toBe(sha);
    expect((await repo.status()).staged).toEqual([]);

    const log = await repo.log(5);
    expect(log[0]).toMatchObject({ sha, subject: "add b.txt", author: "AdPilot Git Tools Test" });
    expect(log).toHaveLength(2);

    await writeFile(join(root, "c.txt"), "three\n");
    await repo.stage(["c.txt"]);
    await repo.unstage(["c.txt"]);
    const status = await repo.status();
    expect(status.staged).toEqual([]);
    expect(status.untracked).toEqual(["c.txt"]);
  });

  it("rejects empty commits without allowEmpty and supports allowEmpty", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "initial");
    const repo = new GitRepository(root);
    await expect(repo.commit("nothing")).rejects.toMatchObject({ code: "NOTHING_TO_COMMIT" });
    const sha = await repo.commit("empty ok", { allowEmpty: true });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("discardChanges requires confirmation and restores content", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "original\n", "initial");
    const repo = new GitRepository(root);

    await writeFile(join(root, "a.txt"), "mutated\n");
    await expect(repo.discardChanges(["a.txt"])).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    await repo.discardChanges(["a.txt"], { confirm: true });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("original\n");
  });
});

describe("WorktreeManager", () => {
  it("adds, lists, removes and prunes managed worktrees", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "initial");
    const repo = new GitRepository(root);
    const headSha = (await repo.headSha())!;
    const manager = new WorktreeManager(root);

    const added = await manager.add({ name: "exp" });
    expect(added).toEqual({
      name: "exp",
      path: join(root, ".adpilot-worktrees", "exp"),
      branch: "exp",
      headSha
    });
    expect(await readFile(join(added.path, "a.txt"), "utf8")).toBe("one\n");

    // the container is excluded, so the main worktree stays clean
    expect((await repo.status()).untracked).toEqual([]);

    const listed = await manager.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ path: expect.stringContaining("adpilot-git-tools-repo-"), isMain: true, managed: false, branch: "main" });
    expect(listed[1]).toMatchObject({ name: "exp", branch: "exp", isMain: false, managed: true, headSha });

    // a branch that already exists is checked out (not recreated) — but a
    // branch can only be checked out in one worktree, so free it up first
    await manager.remove("exp");
    const readded = await manager.add({ name: "exp2", branch: "exp" });
    expect(readded.branch).toBe("exp");
    expect(readded.headSha).toBe(headSha);

    await manager.remove("exp2");
    const afterRemove = await manager.list();
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0]?.isMain).toBe(true);

    // prune: delete a worktree directory out-of-band, then prune metadata
    const stale = await manager.add({ name: "stale" });
    await rm(stale.path, { recursive: true, force: true });
    await manager.prune();
    expect(await manager.list()).toHaveLength(1);
  });

  it("refuses to remove a dirty worktree without force", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "initial");
    const manager = new WorktreeManager(root);
    const added = await manager.add({ name: "dirty" });

    await writeFile(join(added.path, "a.txt"), "changed\n");
    await expect(manager.remove("dirty")).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    await manager.remove("dirty", { force: true });
    expect(await manager.list()).toHaveLength(1);
  });

  it("never removes the main worktree, even through a symlinked name", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "initial");
    const manager = new WorktreeManager(root);
    await manager.add({ name: "seed" }); // ensures the container exists
    await symlink(root, join(root, ".adpilot-worktrees", "main-link"));
    await expect(manager.remove("main-link", { force: true })).rejects.toMatchObject({ code: "MAIN_WORKTREE" });
    expect((await manager.list())[0]?.isMain).toBe(true);
  });

  it("rejects path escapes in worktree names", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "initial");
    const manager = new WorktreeManager(root);
    for (const name of ["../evil", "..", "/tmp/evil", "a/b", "a\\b"]) {
      await expect(manager.add({ name })).rejects.toMatchObject({ code: "PATH_ESCAPE" });
      await expect(manager.remove(name)).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    }
  });
});

describe("CheckpointStore", () => {
  async function snapshotFixture(): Promise<{ root: string; store: CheckpointStore; checkpoint: Checkpoint }> {
    const root = await createRepo();
    await commitFile(root, "a.txt", "v1\n", "initial");
    const store = await createStore();
    await writeFile(join(root, "a.txt"), "v2\n"); // unstaged edit
    await writeFile(join(root, "staged.txt"), "staged\n");
    await git(root, "add", "staged.txt"); // staged new file
    await writeFile(join(root, "untracked.txt"), "untracked-content\n");
    const checkpoint = await store.create({ repoRoot: root, label: "before-task", taskId: "task-1" });
    return { root, store, checkpoint };
  }

  it("creates, lists and gets checkpoints", async () => {
    const { root, store, checkpoint } = await snapshotFixture();
    expect(checkpoint.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(checkpoint.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(checkpoint.label).toBe("before-task");
    expect(checkpoint.taskId).toBe("task-1");
    expect(checkpoint.untrackedFiles).toHaveLength(1);
    expect(checkpoint.untrackedFiles[0]?.path).toBe("untracked.txt");
    expect(Buffer.from(checkpoint.untrackedFiles[0]?.contentBase64 ?? "", "base64").toString("utf8")).toBe("untracked-content\n");
    expect(checkpoint.diffStaged).toContain("staged.txt");
    expect(checkpoint.diffUnstaged).toContain("a.txt");
    expect(checkpoint.skippedUntracked).toEqual([]);

    expect(await store.list(root)).toEqual([checkpoint]);
    expect(await store.get(checkpoint.id)).toEqual(checkpoint);
    expect(await store.get("00000000-0000-4000-8000-000000000000")).toBeUndefined();
    // checkpoints of other repositories are filtered out
    const otherRoot = await createRepo();
    expect(await store.list(otherRoot)).toEqual([]);
  });

  it("restores tracked edits and untracked files to the snapshot state", async () => {
    const { root, store, checkpoint } = await snapshotFixture();

    // mutate everything after the snapshot
    await writeFile(join(root, "a.txt"), "v3\n");
    await rm(join(root, "staged.txt"));
    await rm(join(root, "untracked.txt"));
    await writeFile(join(root, "later.txt"), "created after checkpoint\n");

    await expect(store.restore(checkpoint.id, { confirm: false })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });

    const result = await store.restore(checkpoint.id, { confirm: true });
    expect(result).toMatchObject({ id: checkpoint.id, replayedStagedDiff: true, replayedUnstagedDiff: true, restoredUntrackedFiles: 1 });

    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("v2\n");
    expect(await readFile(join(root, "staged.txt"), "utf8")).toBe("staged\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("untracked-content\n");
    // files created after the checkpoint are left alone
    expect(await readFile(join(root, "later.txt"), "utf8")).toBe("created after checkpoint\n");

    const status = await new GitRepository(root).status();
    expect(status.staged).toEqual([{ path: "staged.txt", status: "added" }]);
    expect(status.unstaged).toEqual([{ path: "a.txt", status: "modified" }]);
    expect(status.untracked).toEqual(expect.arrayContaining(["untracked.txt", "later.txt"]));
  });

  it("refuses to restore after HEAD moved (CHECKPOINT_DIVERGED), unless forced", async () => {
    const { root, store, checkpoint } = await snapshotFixture();

    // move HEAD without changing the tree (an empty commit), then keep editing
    await git(root, "reset", "-q");
    await git(root, "commit", "--allow-empty", "-qm", "moved on");
    expect(await new GitRepository(root).headSha()).not.toBe(checkpoint.headSha);
    await writeFile(join(root, "a.txt"), "v3\n");

    await expect(store.restore(checkpoint.id, { confirm: true })).rejects.toMatchObject({ code: "CHECKPOINT_DIVERGED" });

    // forced restore replays the snapshot onto the new HEAD
    await store.restore(checkpoint.id, { confirm: true, force: true });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("v2\n");
    expect(await readFile(join(root, "staged.txt"), "utf8")).toBe("staged\n");
    const status = await new GitRepository(root).status();
    expect(status.staged).toEqual([{ path: "staged.txt", status: "added" }]);
    expect(status.unstaged).toEqual([{ path: "a.txt", status: "modified" }]);
  });

  it("fails closed when the store directory is a symlink", async () => {
    const root = await temporaryRoot("adpilot-git-tools-link-");
    // dangling symlink
    await symlink(join(root, "missing-target"), join(root, "dangling"));
    await expect(new CheckpointStore(join(root, "dangling")).list("/nonexistent")).rejects.toMatchObject({
      code: "UNSAFE_PATH"
    });
    // symlink to a real directory is refused too
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    await expect(new CheckpointStore(join(root, "link")).list("/nonexistent")).rejects.toMatchObject({
      code: "UNSAFE_PATH"
    });
  });

  it("records oversized untracked files as skipped instead of snapshotting them", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "v1\n", "initial");
    const store = await createStore();
    await writeFile(join(root, "big.bin"), Buffer.alloc(300 * 1024, 1));
    const checkpoint = await store.create({ repoRoot: root, label: "big-file" });
    expect(checkpoint.untrackedFiles).toEqual([]);
    expect(checkpoint.skippedUntracked).toEqual([{ path: "big.bin", reason: "too-large", sizeBytes: 300 * 1024 }]);
  });
});

describe("error shape", () => {
  it("GitToolError carries a code and remains an Error", () => {
    const error = new GitToolError("DIRTY_WORKTREE", "dirty");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GitToolError");
    expect(error.code).toBe("DIRTY_WORKTREE");
  });
});
