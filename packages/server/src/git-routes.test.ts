import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "./index.js";

const execFileAsync = promisify(execFile);

type Server = Awaited<ReturnType<typeof createServer>>;

let roots: string[] = [];
let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("git REST routes", () => {
  it("runs the status → stage → commit → branch → switch flow with audit", async () => {
    const { server, system } = await boot();
    const root = await initRepo();

    const emptyLog = (await server.inject({ method: "GET", url: `/api/git/log?root=${enc(root)}` })).json();
    expect(emptyLog.entries).toHaveLength(0);

    const status = (await server.inject({ method: "GET", url: `/api/git/status?root=${enc(root)}` })).json();
    expect(status.untracked).toContain("a.txt");

    const staged = await server.inject({
      method: "POST",
      url: "/api/git/stage",
      payload: { root, paths: ["a.txt"] }
    });
    expect(staged.statusCode).toBe(200);
    const afterStage = (await server.inject({ method: "GET", url: `/api/git/status?root=${enc(root)}` })).json();
    expect(afterStage.staged).toEqual([{ path: "a.txt", status: "added" }]);

    const badWorkspace = await server.inject({
      method: "POST",
      url: "/api/git/commit",
      payload: { workspaceId: "missing-workspace", root, message: "nope" }
    });
    expect(badWorkspace.statusCode).toBe(400);

    const commit = await server.inject({
      method: "POST",
      url: "/api/git/commit",
      payload: { workspaceId: "personal", root, message: "initial commit" }
    });
    expect(commit.statusCode).toBe(200);
    const sha = commit.json().sha as string;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const audit = await system.audit.list("personal");
    expect(audit.some((event) => event.action === "git_commit" && event.details["sha"] === sha)).toBe(true);

    const log = (await server.inject({ method: "GET", url: `/api/git/log?root=${enc(root)}&limit=5` })).json();
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ sha, subject: "initial commit" });

    const branches = (await server.inject({ method: "GET", url: `/api/git/branches?root=${enc(root)}` })).json();
    expect(branches.branches).toEqual([{ name: "main", current: true, lastCommitSha: sha }]);

    const branch = await server.inject({
      method: "POST",
      url: "/api/git/branch",
      payload: { root, name: "feature" }
    });
    expect(branch.statusCode).toBe(201);

    const switched = await server.inject({
      method: "POST",
      url: "/api/git/switch",
      payload: { root, name: "feature" }
    });
    expect(switched.statusCode).toBe(200);
    const afterSwitch = (await server.inject({ method: "GET", url: `/api/git/status?root=${enc(root)}` })).json();
    expect(afterSwitch.branch).toBe("feature");
    const allBranches = (await server.inject({ method: "GET", url: `/api/git/branches?root=${enc(root)}` })).json();
    expect(allBranches.branches.map((entry: { name: string }) => entry.name)).toEqual(["feature", "main"]);
  });

  it("diffs, unstages and discards only with explicit confirmation", async () => {
    const { server, system } = await boot();
    const root = await initRepo();
    await commitAll(root, "initial");
    await writeFile(join(root, "a.txt"), "one\ntwo\n", "utf8");

    const unstaged = (
      await server.inject({ method: "GET", url: `/api/git/diff?root=${enc(root)}` })
    ).json();
    expect(unstaged.files).toEqual([{ path: "a.txt", additions: 1, deletions: 0, status: "modified" }]);
    expect(unstaged.raw).toContain("+two");

    const filtered = (
      await server.inject({ method: "GET", url: `/api/git/diff?root=${enc(root)}&paths=a.txt,other.txt` })
    ).json();
    expect(filtered.files.map((file: { path: string }) => file.path)).toEqual(["a.txt"]);

    await server.inject({ method: "POST", url: "/api/git/stage", payload: { root, paths: ["a.txt"] } });
    const stagedDiff = (
      await server.inject({ method: "GET", url: `/api/git/diff?root=${enc(root)}&staged=true` })
    ).json();
    expect(stagedDiff.files).toHaveLength(1);
    const worktreeDiff = (
      await server.inject({ method: "GET", url: `/api/git/diff?root=${enc(root)}` })
    ).json();
    expect(worktreeDiff.files).toHaveLength(0);

    const unstaged2 = await server.inject({
      method: "POST",
      url: "/api/git/unstage",
      payload: { root, paths: ["a.txt"] }
    });
    expect(unstaged2.statusCode).toBe(200);
    const status = (await server.inject({ method: "GET", url: `/api/git/status?root=${enc(root)}` })).json();
    expect(status.staged).toHaveLength(0);
    expect(status.unstaged).toEqual([{ path: "a.txt", status: "modified" }]);

    const denied = await server.inject({
      method: "POST",
      url: "/api/git/discard",
      payload: { workspaceId: "personal", root, paths: ["a.txt"], confirm: false }
    });
    expect(denied.statusCode).toBe(400);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\ntwo\n");

    const discarded = await server.inject({
      method: "POST",
      url: "/api/git/discard",
      payload: { workspaceId: "personal", root, paths: ["a.txt"], confirm: true }
    });
    expect(discarded.statusCode).toBe(200);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\n");
    const audit = await system.audit.list("personal");
    expect(audit.some((event) => event.action === "git_discard")).toBe(true);
  });

  it("adds, lists and removes managed worktrees (dirty removal needs force)", async () => {
    const { server, system } = await boot();
    const root = await initRepo();
    await commitAll(root, "initial");

    const added = await server.inject({
      method: "POST",
      url: "/api/git/worktrees",
      payload: { root, name: "wt1" }
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ name: "wt1", branch: "wt1" });
    expect(added.json().path).toContain(".adpilot-worktrees");

    const listed = (await server.inject({ method: "GET", url: `/api/git/worktrees?root=${enc(root)}` })).json();
    expect(listed.worktrees.some((entry: { isMain: boolean }) => entry.isMain)).toBe(true);
    expect(listed.worktrees.some((entry: { name: string | null; managed: boolean }) => entry.name === "wt1" && entry.managed)).toBe(true);

    // The managed container is excluded from the main worktree's status.
    const status = (await server.inject({ method: "GET", url: `/api/git/status?root=${enc(root)}` })).json();
    expect(status.untracked).toHaveLength(0);

    const badWorkspace = await server.inject({
      method: "DELETE",
      url: `/api/git/worktrees/wt1?root=${enc(root)}&workspaceId=missing-workspace`
    });
    expect(badWorkspace.statusCode).toBe(400);

    await writeFile(join(added.json().path, "dirty.txt"), "x\n", "utf8");
    const dirty = await server.inject({
      method: "DELETE",
      url: `/api/git/worktrees/wt1?root=${enc(root)}&workspaceId=personal`
    });
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json().code).toBe("DIRTY_WORKTREE");

    const forced = await server.inject({
      method: "DELETE",
      url: `/api/git/worktrees/wt1?root=${enc(root)}&workspaceId=personal&force=true`
    });
    expect(forced.statusCode).toBe(200);
    const after = (await server.inject({ method: "GET", url: `/api/git/worktrees?root=${enc(root)}` })).json();
    expect(after.worktrees.some((entry: { name: string | null }) => entry.name === "wt1")).toBe(false);
    const audit = await system.audit.list("personal");
    expect(audit.some((event) => event.action === "git_worktree_remove")).toBe(true);
  });

  it("creates and restores checkpoints, keeping the store out of git status", async () => {
    const { server, system } = await boot();
    const root = await initRepo();
    const sha = await commitAll(root, "initial");

    await writeFile(join(root, "a.txt"), "two\n", "utf8");
    await writeFile(join(root, "u.txt"), "untracked\n", "utf8");
    const created = await server.inject({
      method: "POST",
      url: "/api/git/checkpoints",
      payload: { root, label: "snapshot" }
    });
    expect(created.statusCode).toBe(201);
    const checkpoint = created.json();
    expect(checkpoint).toMatchObject({ label: "snapshot", headSha: sha });
    expect(checkpoint.diffStaged).toBeUndefined(); // summaries never leak snapshot payloads

    // The .adpilot checkpoint store must not pollute status or snapshots.
    const status = (await server.inject({ method: "GET", url: `/api/git/status?root=${enc(root)}` })).json();
    expect(status.untracked).toEqual(["u.txt"]);

    // Mutate further, then restore to the snapshot.
    await writeFile(join(root, "a.txt"), "three\n", "utf8");
    await rm(join(root, "u.txt"));

    const listed = (await server.inject({ method: "GET", url: `/api/git/checkpoints?root=${enc(root)}` })).json();
    expect(listed.checkpoints).toHaveLength(1);
    expect(listed.checkpoints[0]).toMatchObject({ id: checkpoint.id, label: "snapshot" });

    const denied = await server.inject({
      method: "POST",
      url: `/api/git/checkpoints/${checkpoint.id}/restore?root=${enc(root)}`,
      payload: { workspaceId: "personal", confirm: false }
    });
    expect(denied.statusCode).toBe(400);

    const restored = await server.inject({
      method: "POST",
      url: `/api/git/checkpoints/${checkpoint.id}/restore?root=${enc(root)}`,
      payload: { workspaceId: "personal", confirm: true }
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      id: checkpoint.id,
      headSha: sha,
      replayedUnstagedDiff: true,
      restoredUntrackedFiles: 1
    });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("two\n");
    expect(await readFile(join(root, "u.txt"), "utf8")).toBe("untracked\n");
    const audit = await system.audit.list("personal");
    expect(audit.some((event) => event.action === "git_checkpoint_restore")).toBe(true);
  });

  it("rejects missing roots and non-repositories with coded 400s", async () => {
    const { server } = await boot();
    const plain = await mkdtemp(join(tmpdir(), "adpilot-git-plain-"));
    roots.push(plain);

    const missing = await server.inject({
      method: "GET",
      url: `/api/git/status?root=${enc(join(plain, "missing"))}`
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("GIT_ROOT_INVALID");

    const notRepo = await server.inject({ method: "GET", url: `/api/git/status?root=${enc(plain)}` });
    expect(notRepo.statusCode).toBe(400);
    expect(notRepo.json().code).toBe("NOT_A_REPOSITORY");

    const fileRoot = await server.inject({
      method: "GET",
      url: `/api/git/status?root=${enc(join(plain, "x.txt"))}`
    });
    expect(fileRoot.statusCode).toBe(400);
    expect(fileRoot.json().code).toBe("GIT_ROOT_INVALID");
  });
});

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-git-routes-"));
  roots.push(root);
  const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
  const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
  servers.push(server);
  return { server, system };
}

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adpilot-git-repo-"));
  roots.push(root);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@adpilot.local"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "AdPilot Test"], { cwd: root });
  await writeFile(join(root, "a.txt"), "one\n", "utf8");
  return root;
}

async function commitAll(root: string, message: string): Promise<string> {
  await execFileAsync("git", ["add", "--", "a.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", message], { cwd: root });
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
