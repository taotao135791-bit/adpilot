import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Artifact,
  FileArtifactStore,
  FileGoalStore,
  FileProjectStore,
  FileTaskGraphStore,
  Goal,
  KernelError,
  KernelService,
  Project,
  TaskNode,
  addDependency,
  completeTask,
  createTask,
  readyTasks,
  topologicalOrder,
  type KernelClock,
  type TaskNode as TaskNodeValue
} from "./index.js";

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const STAMP = new Date(BASE_TIME).toISOString();

function fixedClock(): KernelClock {
  let tick = 0;
  return { now: () => new Date(BASE_TIME + tick++ * 1000) };
}

function expectKernelThrow(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(KernelError);
  expect((caught as KernelError).code).toBe(code);
}

async function expectKernelReject(promise: Promise<unknown>, code: string): Promise<void> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error
  );
  expect(caught).toBeInstanceOf(KernelError);
  expect((caught as KernelError).code).toBe(code);
}

function projectFixture(overrides: Partial<Project> = {}): Project {
  return Project.parse({
    id: randomUUID(),
    workspaceId: "client-1",
    name: "Kernel Project",
    createdAt: STAMP,
    updatedAt: STAMP,
    revision: 1,
    ...overrides
  });
}

function goalFixture(projectId: string, overrides: Partial<Goal> = {}): Goal {
  return Goal.parse({
    id: randomUUID(),
    projectId,
    title: "Goal",
    objective: "Prove the kernel",
    createdAt: STAMP,
    updatedAt: STAMP,
    revision: 1,
    ...overrides
  });
}

function taskFixture(overrides: Partial<TaskNodeValue> = {}): TaskNodeValue {
  return TaskNode.parse({
    id: randomUUID(),
    title: "Task",
    createdAt: STAMP,
    updatedAt: STAMP,
    revision: 1,
    ...overrides
  });
}

function artifactFixture(projectId: string, overrides: Partial<Artifact> = {}): Artifact {
  return Artifact.parse({
    id: randomUUID(),
    projectId,
    type: "report",
    title: "Report",
    createdAt: STAMP,
    updatedAt: STAMP,
    revision: 1,
    ...overrides
  });
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "adpilot-kernel-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("entity schemas", () => {
  it("rejects invalid enum values", () => {
    expect(() => Project.parse({ ...projectFixture(), status: "bogus" })).toThrow();
    expect(() => Goal.parse({ ...goalFixture(randomUUID()), status: "nope" })).toThrow();
    expect(() => TaskNode.parse({ ...taskFixture(), status: "done" })).toThrow();
    expect(() => Artifact.parse({ ...artifactFixture(randomUUID()), type: "gif" })).toThrow();
  });

  it("rejects out-of-range progress and revision", () => {
    const base = goalFixture(randomUUID());
    expect(() => Goal.parse({ ...base, progress: 1.5 })).toThrow();
    expect(() => Goal.parse({ ...base, progress: -0.1 })).toThrow();
    expect(Goal.parse({ ...base, progress: 0 }).progress).toBe(0);
    expect(Goal.parse({ ...base, progress: 1 }).progress).toBe(1);
    expect(() => Goal.parse({ ...base, revision: 0 })).toThrow();
  });

  it("allows an empty success measure to persist as an empty objective", () => {
    expect(goalFixture(randomUUID(), { objective: "" }).objective).toBe("");
    const { objective: _objective, ...withoutObjective } = goalFixture(randomUUID());
    expect(Goal.parse(withoutObjective).objective).toBe("");
  });

  it("rejects malformed ids and empty required strings", () => {
    expect(() => Project.parse({ ...projectFixture(), id: "not-a-uuid" })).toThrow();
    expect(() => Project.parse({ ...projectFixture(), workspaceId: "" })).toThrow();
    expect(() => Artifact.parse({ ...artifactFixture(randomUUID()), version: 0 })).toThrow();
    expect(() => Artifact.parse({ ...artifactFixture(randomUUID()), version: 1.5 })).toThrow();
  });

  it("applies documented defaults", () => {
    const project = projectFixture();
    expect(project.type).toBe("general");
    expect(project.rootPaths).toEqual([]);
    expect(project.goalIds).toEqual([]);
    expect(project.status).toBe("active");
    const task = taskFixture();
    expect(task.status).toBe("queued");
    expect(task.dependencies).toEqual([]);
    const artifact = artifactFixture(randomUUID());
    expect(artifact.version).toBe(1);
    expect(artifact.status).toBe("draft");
  });
});

describe("file stores", () => {
  it("round-trips entities through private atomic files", async () => {
    const store = new FileProjectStore(root);
    const project = projectFixture();
    await store.save(project);
    expect(await store.get(project.id)).toEqual(project);

    const fileMode = (await stat(join(store.directory, `${project.id}.json`))).mode & 0o777;
    const dirMode = (await stat(store.directory)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it("returns undefined for missing records and tracks deletes", async () => {
    const store = new FileGoalStore(root);
    const missing = randomUUID();
    expect(await store.get(missing)).toBeUndefined();
    expect(await store.delete(missing)).toBe(false);
    const goal = goalFixture(randomUUID());
    await store.save(goal);
    expect(await store.delete(goal.id)).toBe(true);
    expect(await store.get(goal.id)).toBeUndefined();
  });

  it("filters list results per entity", async () => {
    const projectA = projectFixture({ workspaceId: "client-a" });
    const projectB = projectFixture({ workspaceId: "client-b" });
    const archived = projectFixture({ workspaceId: "client-a", status: "archived" });
    const projects = new FileProjectStore(root);
    await Promise.all([projectA, projectB, archived].map((project) => projects.save(project)));
    expect(await projects.list({ workspaceId: "client-a" })).toHaveLength(2);
    expect(await projects.list({ workspaceId: "client-a", status: "archived" })).toEqual([archived]);
    expect(await projects.list()).toHaveLength(3);

    const goals = new FileGoalStore(root);
    const goalA = goalFixture(projectA.id);
    const goalB = goalFixture(projectB.id);
    await Promise.all([goalA, goalB].map((goal) => goals.save(goal)));
    expect(await goals.list({ projectId: projectA.id })).toEqual([goalA]);

    const tasks = new FileTaskGraphStore(root);
    const taskA = taskFixture({ goalId: goalA.id });
    const taskB = taskFixture({ goalId: goalB.id });
    await Promise.all([taskA, taskB].map((task) => tasks.save(task)));
    expect(await tasks.list({ goalId: goalA.id })).toEqual([taskA]);

    const artifacts = new FileArtifactStore(root);
    const sessionId = randomUUID();
    const artifactA = artifactFixture(projectA.id, { sessionId, type: "report" });
    const artifactB = artifactFixture(projectA.id, { type: "slides" });
    await Promise.all([artifactA, artifactB].map((artifact) => artifacts.save(artifact)));
    expect(await artifacts.list({ projectId: projectA.id })).toHaveLength(2);
    expect(await artifacts.list({ sessionId })).toEqual([artifactA]);
    expect(await artifacts.list({ type: "slides" })).toEqual([artifactB]);
  });

  it("never corrupts data under concurrent saves of the same id", async () => {
    const store = new FileProjectStore(root);
    const id = randomUUID();
    // Last-writer-wins, whole-document: each save is an atomic rename replace,
    // so the surviving record must be one complete revision from the race.
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.save(projectFixture({ id, revision: index + 1 })))
    );
    const winner = await store.get(id);
    expect(winner).toBeDefined();
    expect(winner!.id).toBe(id);
    expect(winner!.revision).toBeGreaterThanOrEqual(1);
    expect(winner!.revision).toBeLessThanOrEqual(10);
    expect(await store.list()).toHaveLength(1);
  });

  it("keeps every record under concurrent saves of distinct ids", async () => {
    const store = new FileArtifactStore(root);
    const projectId = randomUUID();
    const fixtures = Array.from({ length: 10 }, () => artifactFixture(projectId));
    await Promise.all(fixtures.map((artifact) => store.save(artifact)));
    const stored = await store.list({ projectId });
    expect(stored).toHaveLength(10);
    expect(new Set(stored.map((artifact) => artifact.id)).size).toBe(10);
  });

  it("refuses symlinked roots, directories, and record targets", async () => {
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });

    const linkedRoot = join(root, "linked-root");
    await symlink(outside, linkedRoot, "dir");
    await expect(new FileProjectStore(linkedRoot).save(projectFixture())).rejects.toThrow("symlink");

    const entityLink = join(root, ".adpilot", "kernel", "projects");
    await mkdir(join(root, ".adpilot", "kernel"), { recursive: true });
    await symlink(outside, entityLink, "dir");
    await expect(new FileProjectStore(root).save(projectFixture())).rejects.toThrow("symlink");
    await rm(entityLink, { force: true });

    const store = new FileProjectStore(root);
    const project = projectFixture();
    await store.save(project);
    const target = join(store.directory, `${project.id}.json`);
    await rm(target);
    await symlink(join(outside, "stolen.json"), target);
    await expect(store.save(project)).rejects.toThrow("symlink");
    await expect(store.get(project.id)).rejects.toThrow("symlink");
  });
});

describe("TaskGraph pure functions", () => {
  it("creates queued tasks and validates referenced dependencies", () => {
    const first = createTask({ title: "first" });
    expect(first.status).toBe("queued");
    expect(first.revision).toBe(1);
    expectKernelThrow(
      () => createTask({ title: "orphan", dependencies: [randomUUID()] }, [first]),
      "TASK_DEPENDENCY_NOT_FOUND"
    );
    const second = createTask({ title: "second", dependencies: [first.id, first.id] }, [first]);
    expect(second.dependencies).toEqual([first.id]);
  });

  it("detects direct, indirect, and self dependency cycles", () => {
    const a = createTask({ title: "a" });
    const b = createTask({ title: "b" });
    const c = createTask({ title: "c" });
    let graph = [a, b, c];
    graph = addDependency(graph, a.id, b.id);
    graph = addDependency(graph, b.id, c.id);
    expectKernelThrow(() => addDependency(graph, c.id, a.id), "TASK_CYCLE");
    expectKernelThrow(() => addDependency(graph, a.id, a.id), "TASK_CYCLE");
    // Idempotent re-add keeps a single edge and bumps nothing.
    const again = addDependency(graph, a.id, b.id);
    expect(again.find((task) => task.id === a.id)!.dependencies).toEqual([b.id]);
  });

  it("orders graphs topologically and reports cyclic remainders", () => {
    const a = createTask({ title: "a" });
    const b = createTask({ title: "b" });
    const c = createTask({ title: "c" });
    let graph = [c, b, a];
    graph = addDependency(graph, c.id, b.id);
    graph = addDependency(graph, b.id, a.id);
    expect(topologicalOrder(graph).map((task) => task.title)).toEqual(["a", "b", "c"]);

    const first = taskFixture();
    const second = taskFixture({ dependencies: [first.id] });
    const cyclic = [TaskNode.parse({ ...first, dependencies: [second.id] }), second];
    expectKernelThrow(() => topologicalOrder(cyclic), "TASK_CYCLE");
  });

  it("unlocks dependents exactly when their last dependency completes", () => {
    const a = createTask({ title: "a" });
    const b = createTask({ title: "b" });
    const c = createTask({ title: "c" });
    let graph = [a, b, c];
    graph = addDependency(graph, c.id, a.id);
    graph = addDependency(graph, c.id, b.id);

    expect(readyTasks(graph).map((task) => task.title).sort()).toEqual(["a", "b"]);

    const firstCompletion = completeTask(graph, a.id);
    expect(firstCompletion.unlocked).toEqual([]);
    expect(readyTasks(firstCompletion.tasks).map((task) => task.title)).toEqual(["b"]);

    const secondCompletion = completeTask(firstCompletion.tasks, b.id);
    expect(secondCompletion.unlocked.map((task) => task.title)).toEqual(["c"]);
    expect(secondCompletion.tasks.find((task) => task.id === b.id)!.status).toBe("completed");
    expect(secondCompletion.tasks.find((task) => task.id === b.id)!.revision).toBe(2);

    expectKernelThrow(() => completeTask(secondCompletion.tasks, b.id), "TASK_INVALID_TRANSITION");
    expectKernelThrow(() => completeTask(secondCompletion.tasks, randomUUID()), "TASK_NOT_FOUND");
  });
});

describe("KernelService", () => {
  it("validates and normalizes project creation", async () => {
    const service = KernelService.fromRoot(root, fixedClock());
    await expectKernelReject(
      service.createProject({ workspaceId: "client-1", name: "   " }),
      "INVALID_PROJECT_NAME"
    );
    const project = await service.createProject({
      workspaceId: "client-1",
      name: "  Ad Campaign  ",
      rootPaths: [" /data/a ", "/data/a", "", "   ", "/data/b"],
      enabledCapabilityPacks: ["ads", "ads", "reports"]
    });
    expect(project.name).toBe("Ad Campaign");
    expect(project.rootPaths).toEqual(["/data/a", "/data/b"]);
    expect(project.enabledCapabilityPacks).toEqual(["ads", "reports"]);
    expect(project.revision).toBe(1);
    expect(project.status).toBe("active");
  });

  it("writes goal ids back to the project and rejects archived projects", async () => {
    const service = KernelService.fromRoot(root, fixedClock());
    await expectKernelReject(
      service.createGoal({ projectId: randomUUID(), title: "x", objective: "y" }),
      "PROJECT_NOT_FOUND"
    );

    const project = await service.createProject({ workspaceId: "client-1", name: "P" });
    const goal = await service.createGoal({
      projectId: project.id,
      title: "Ship it",
      successCriteria: ["tests pass"]
    });
    expect(goal.status).toBe("draft");
    expect(goal.progress).toBe(0);
    expect(goal.objective).toBe("");
    const goals = new FileGoalStore(root);
    expect(await goals.list({ projectId: project.id })).toEqual([goal]);

    const projects = new FileProjectStore(root);
    const reloaded = await projects.get(project.id);
    expect(reloaded!.goalIds).toEqual([goal.id]);
    expect(reloaded!.revision).toBe(2);

    await service.archiveProject(project.id);
    await expectKernelReject(
      service.createGoal({ projectId: project.id, title: "x", objective: "y" }),
      "PROJECT_ARCHIVED"
    );
  });

  it("links sessions and artifacts idempotently", async () => {
    const service = KernelService.fromRoot(root, fixedClock());
    const project = await service.createProject({ workspaceId: "client-1", name: "P" });

    const sessionId = randomUUID();
    const linked = await service.linkSession(project.id, sessionId);
    expect(linked.sessionIds).toEqual([sessionId]);
    expect(linked.revision).toBe(2);
    const relinked = await service.linkSession(project.id, sessionId);
    expect(relinked.revision).toBe(2);
    expect(relinked.sessionIds).toEqual([sessionId]);

    await expectKernelReject(service.linkArtifact(project.id, randomUUID()), "ARTIFACT_NOT_FOUND");
    const other = await service.createProject({ workspaceId: "client-1", name: "Other" });
    const artifacts = new FileArtifactStore(root);
    const foreign = artifactFixture(other.id);
    await artifacts.save(foreign);
    await expectKernelReject(service.linkArtifact(project.id, foreign.id), "ARTIFACT_PROJECT_MISMATCH");

    const artifact = artifactFixture(project.id);
    await artifacts.save(artifact);
    const withArtifact = await service.linkArtifact(project.id, artifact.id);
    expect(withArtifact.artifactIds).toEqual([artifact.id]);
    const again = await service.linkArtifact(project.id, artifact.id);
    expect(again.revision).toBe(withArtifact.revision);
  });

  it("clamps goal progress into [0, 1] and persists it", async () => {
    const service = KernelService.fromRoot(root, fixedClock());
    const project = await service.createProject({ workspaceId: "client-1", name: "P" });
    const goal = await service.createGoal({ projectId: project.id, title: "G", objective: "O" });

    expect((await service.updateGoalProgress(goal.id, 1.4)).progress).toBe(1);
    expect((await service.updateGoalProgress(goal.id, -0.2)).progress).toBe(0);
    const halfway = await service.updateGoalProgress(goal.id, 0.5);
    expect(halfway.progress).toBe(0.5);
    expect(halfway.revision).toBe(4);
    const stored = await new FileGoalStore(root).get(goal.id);
    expect(stored!.progress).toBe(0.5);

    await expectKernelReject(service.updateGoalProgress(goal.id, Number.NaN), "INVALID_GOAL_PROGRESS");
    await expectKernelReject(service.updateGoalProgress(randomUUID(), 0.5), "GOAL_NOT_FOUND");
  });

  it("archives projects without touching goal state", async () => {
    const service = KernelService.fromRoot(root, fixedClock());
    const project = await service.createProject({ workspaceId: "client-1", name: "P" });
    const goal = await service.createGoal({ projectId: project.id, title: "G", objective: "O" });
    await service.updateGoalProgress(goal.id, 0.25);

    const archived = await service.archiveProject(project.id);
    expect(archived.status).toBe("archived");
    const storedGoal = await new FileGoalStore(root).get(goal.id);
    expect(storedGoal!.status).toBe("draft");
    expect(storedGoal!.progress).toBe(0.25);

    const repeat = await service.archiveProject(project.id);
    expect(repeat.revision).toBe(archived.revision);
    await expectKernelReject(service.archiveProject(randomUUID()), "PROJECT_NOT_FOUND");
  });
});
