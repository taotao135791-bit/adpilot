import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactRenderer } from "@adpilot/artifacts";
import type { Project } from "@adpilot/kernel";
import type { AgentExecutionContext } from "./context.js";
import type { AgentToolDeps } from "./deps.js";
import { buildAgentToolRegistry } from "./index.js";
import { runAgentToolCall } from "./lifecycle.js";
import type { AgentToolResult } from "./result.js";
import { makeCtx, makeTestDeps } from "./testing.js";

const registry = buildAgentToolRegistry();
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-kernel-ownership-"));
  const testDeps = makeTestDeps(root);
  terminals.push(testDeps.terminal);
  const projectA = await testDeps.kernel.createProject({ workspaceId: "workspace-a", name: "A" });
  const projectA2 = await testDeps.kernel.createProject({ workspaceId: "workspace-a", name: "A2" });
  const projectB = await testDeps.kernel.createProject({ workspaceId: "workspace-b", name: "B" });
  const goalA = await testDeps.kernel.createGoal({ projectId: projectA.id, title: "Goal A" });
  const goalA2 = await testDeps.kernel.createGoal({ projectId: projectA2.id, title: "Goal A2" });
  const goalB = await testDeps.kernel.createGoal({ projectId: projectB.id, title: "Goal B" });
  const taskA = await testDeps.kernel.createTask({ goalId: goalA.id, title: "Task A" });
  const taskA2 = await testDeps.kernel.createTask({ goalId: goalA2.id, title: "Task A2" });
  const taskB = await testDeps.kernel.createTask({ goalId: goalB.id, title: "Task B" });
  const rootlessTask = await testDeps.kernel.createTask({ title: "Unowned task" });
  const artifactA = await createArtifact(testDeps.deps, projectA, "Artifact A");
  const artifactA2 = await createArtifact(testDeps.deps, projectA2, "Artifact A2");
  const artifactB = await createArtifact(testDeps.deps, projectB, "Artifact B");
  return {
    ...testDeps,
    projectA,
    projectA2,
    projectB,
    goalA,
    goalA2,
    goalB,
    taskA,
    taskA2,
    taskB,
    rootlessTask,
    artifactA,
    artifactA2,
    artifactB
  };
}

async function createArtifact(deps: AgentToolDeps, project: Project, title: string) {
  const renderer: ArtifactRenderer<Record<string, never>> = {
    exportFormats: ["txt"],
    render: async () => ({ files: [] })
  };
  return deps.artifacts.createFromRenderer(project.id, "document", title, {}, renderer);
}

function expectNotFound(result: AgentToolResult, code: string): void {
  expect(result.success).toBe(false);
  expect(result.error).toMatchObject({ code, recoverable: true });
  expect(result.error?.message).not.toContain("/Users/");
}

describe("goal registry ownership", () => {
  it("hides foreign-workspace and same-workspace foreign-project goals from every entry point", async () => {
    const f = await fixture();
    const ctx = makeCtx({ workspaceId: "workspace-a", projectId: f.projectA.id });

    expectNotFound(await call("goal.create", {
      projectId: f.projectB.id,
      title: "foreign",
      objective: "foreign"
    }, ctx, f.deps), "PROJECT_NOT_FOUND");

    for (const [name, params] of [
      ["goal.get", { goalId: f.goalB.id }],
      ["goal.update", { goalId: f.goalB.id, title: "changed" }],
      ["goal.set_progress", { goalId: f.goalB.id, progress: 0.5 }],
      ["goal.complete", { goalId: f.goalB.id }],
      ["goal.block", { goalId: f.goalB.id }],
      ["goal.get", { goalId: f.goalA2.id }]
    ] as const) {
      expectNotFound(await call(name, params, ctx, f.deps), "GOAL_NOT_FOUND");
    }

    expect((await f.kernel.getGoal(f.goalB.id))?.title).toBe("Goal B");
    expect((await f.kernel.getGoal(f.goalA2.id))?.status).toBe("draft");
  });

  it("fails malformed ids and forged bound context with path-safe errors", async () => {
    const f = await fixture();
    const malformed = await call("goal.get", { goalId: "/workspace/private/customer.json" }, makeCtx({ workspaceId: "workspace-a" }), f.deps);
    expectNotFound(malformed, "GOAL_NOT_FOUND");
    expect(malformed.error?.message).not.toContain("customer.json");

    const forgedContext = makeCtx({ workspaceId: "workspace-a", projectId: f.projectB.id });
    expectNotFound(await call("goal.get", { goalId: f.goalA.id }, forgedContext, f.deps), "PROJECT_NOT_FOUND");
  });
});

describe("task registry ownership", () => {
  it("validates goal, parent, dependency and task ids before every mutation", async () => {
    const f = await fixture();
    const ctx = makeCtx({ workspaceId: "workspace-a", projectId: f.projectA.id, goalId: f.goalA.id });

    expectNotFound(await call("task.create", { goalId: f.goalB.id, title: "foreign" }, ctx, f.deps), "GOAL_NOT_FOUND");
    expectNotFound(await call("task.create_many", { goalId: f.goalA2.id, items: [{ title: "foreign project" }] }, ctx, f.deps), "GOAL_NOT_FOUND");
    expectNotFound(await call("task.create", { title: "bad parent", parentId: f.taskB.id }, ctx, f.deps), "TASK_PARENT_NOT_FOUND");
    expectNotFound(await call("task.create", { title: "bad dependency", dependencies: [f.taskA2.id] }, ctx, f.deps), "TASK_DEPENDENCY_NOT_FOUND");

    for (const name of ["task.start", "task.block", "task.complete", "task.fail"] as const) {
      expectNotFound(await call(name, { taskId: f.taskB.id }, ctx, f.deps), "TASK_NOT_FOUND");
    }
    expectNotFound(await call("task.add_dependency", {
      taskId: f.taskA.id,
      dependencyId: f.taskA2.id
    }, ctx, f.deps), "TASK_DEPENDENCY_NOT_FOUND");
    expectNotFound(await call("task.attach_evidence", {
      taskId: f.taskB.id,
      evidenceIds: ["screenshot:test"]
    }, ctx, f.deps), "TASK_NOT_FOUND");
    expectNotFound(await call("task.attach_evidence", {
      taskId: f.taskA.id,
      evidenceIds: [`artifact:${f.artifactB.id}`]
    }, ctx, f.deps), "ARTIFACT_NOT_FOUND");

    expect((await f.kernel.listTasks({ goalId: f.goalB.id }))[0]).toMatchObject({ id: f.taskB.id, status: "queued" });
  });

  it("lists only workspace-owned anchored tasks and hides rootless tasks", async () => {
    const f = await fixture();
    const listed = await call("task.list", {}, makeCtx({ workspaceId: "workspace-a" }), f.deps);
    const ids = (listed.data as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id);
    expect(ids).toEqual(expect.arrayContaining([f.taskA.id, f.taskA2.id]));
    expect(ids).not.toContain(f.taskB.id);
    expect(ids).not.toContain(f.rootlessTask.id);

    expectNotFound(await call("task.start", { taskId: f.rootlessTask.id }, makeCtx({ workspaceId: "workspace-a" }), f.deps), "TASK_NOT_FOUND");
    expectNotFound(await call("task.list", { goalId: f.goalB.id }, makeCtx({ workspaceId: "workspace-a" }), f.deps), "GOAL_NOT_FOUND");
  });
});

describe("artifact registry ownership", () => {
  it("hides foreign artifacts before reads, filesystem exports, revisions or task links", async () => {
    const f = await fixture();
    const ctx = makeCtx({ workspaceId: "workspace-a", projectId: f.projectA.id, goalId: f.goalA.id, taskId: f.taskA.id });

    for (const [name, params] of [
      ["artifact.get", { id: f.artifactB.id }],
      ["artifact.preview", { id: f.artifactB.id }],
      ["artifact.revise", { id: f.artifactB.id, spec: {} }],
      ["artifact.export", { id: f.artifactB.id }],
      ["artifact.get", { id: f.artifactA2.id }]
    ] as const) {
      expectNotFound(await call(name, params, ctx, f.deps), "ARTIFACT_NOT_FOUND");
    }
    expectNotFound(await call("artifact.list", { projectId: f.projectB.id }, ctx, f.deps), "PROJECT_NOT_FOUND");
    expectNotFound(await call("artifact.attach_to_task", { id: f.artifactB.id, taskId: f.taskA.id }, ctx, f.deps), "ARTIFACT_NOT_FOUND");

    const workspaceContext = makeCtx({ workspaceId: "workspace-a" });
    expectNotFound(await call("artifact.attach_to_task", {
      id: f.artifactA2.id,
      taskId: f.taskA.id
    }, workspaceContext, f.deps), "ARTIFACT_NOT_FOUND");

    const listed = await call("artifact.list", {}, workspaceContext, f.deps);
    const ids = (listed.data as { artifacts: Array<{ id: string }> }).artifacts.map((artifact) => artifact.id);
    expect(ids).toEqual(expect.arrayContaining([f.artifactA.id, f.artifactA2.id]));
    expect(ids).not.toContain(f.artifactB.id);
  });

  it("rejects a foreign project bound in context before rendering any artifact", async () => {
    const f = await fixture();
    const result = await call("artifact.create", {
      type: "document",
      title: "must not render",
      spec: { title: "must not render", blocks: [] }
    }, makeCtx({ workspaceId: "workspace-a", projectId: f.projectB.id }), f.deps);
    expectNotFound(result, "PROJECT_NOT_FOUND");
    expect((await f.deps.artifacts.list(f.projectB.id)).map((artifact) => artifact.title)).not.toContain("must not render");
  });
});
