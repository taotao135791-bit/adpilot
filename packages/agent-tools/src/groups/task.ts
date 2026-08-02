import { z } from "zod";
import { addDependency, type TaskNode } from "@adpilot/kernel";
import type { AgentToolDefinition } from "../registry.js";
import { kernelStores, updateKernelTask } from "../kernel-internal.js";
import { succeed } from "../result.js";
import { toolError } from "../errors.js";
import {
  artifactNotFound,
  assertOwnedKernelContext,
  listOwnedProjects,
  requireOwnedArtifact,
  requireOwnedGoal,
  requireOwnedTask,
  taskDependencyNotFound,
  taskParentNotFound
} from "./kernel-ownership.js";

const TaskIdParams = z.object({ taskId: z.string().min(1) });
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

function requireTransitionable(task: TaskNode, action: string): void {
  if (TERMINAL_STATUSES.has(task.status)) {
    throw toolError("TASK_INVALID_TRANSITION", `cannot ${action} task in ${task.status} state`);
  }
}

/** Task tools: create and drive the kernel task graph (queued → running → terminal, with dependencies and evidence). */
export function createTaskTools(): AgentToolDefinition[] {
  return [
    {
      name: "task.create",
      description: "Queue one task, optionally under a goal with parent and dependency links. Dependencies must already exist.",
      capabilityPack: "task",
      permission: "write",
      parameters: z.object({
        goalId: z.string().min(1).optional(),
        parentId: z.string().min(1).optional(),
        title: z.string().min(1),
        description: z.string().optional(),
        dependencies: z.array(z.string().min(1)).optional()
      }),
      execute: async (raw, ctx, deps) => {
        await assertOwnedKernelContext(ctx, deps);
        const params = z.object({
          goalId: z.string().min(1).optional(),
          parentId: z.string().min(1).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
          dependencies: z.array(z.string().min(1)).optional()
        }).parse(raw);
        const goalId = params.goalId ?? ctx.goalId;
        if (!goalId) {
          throw toolError("GOAL_NOT_SELECTED", "task creation requires a goal so workspace and project ownership can be verified");
        }
        const ownedGoal = await requireOwnedGoal(goalId, ctx, deps);
        if (params.parentId !== undefined) {
          const parent = await requireOwnedTask(params.parentId, ctx, deps).catch(() => { throw taskParentNotFound(); });
          if (parent.task.goalId !== ownedGoal.goal.id) throw taskParentNotFound();
        }
        for (const dependencyId of params.dependencies ?? []) {
          const dependency = await requireOwnedTask(dependencyId, ctx, deps).catch(() => { throw taskDependencyNotFound(); });
          if (dependency.task.goalId !== ownedGoal.goal.id) throw taskDependencyNotFound();
        }
        const task = await deps.kernel.createTask({
          goalId,
          ...(params.parentId !== undefined ? { parentId: params.parentId } : {}),
          title: params.title,
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(params.dependencies !== undefined ? { dependencies: params.dependencies } : {})
        });
        return succeed("task.create", ctx, { task });
      }
    },
    {
      name: "task.create_many",
      description: "Queue a batch of tasks in one call; dependsOn holds zero-based indices of earlier items in the same batch, so dependencies are wired as the batch is created. Use to decompose a goal into an ordered plan.",
      capabilityPack: "task",
      permission: "write",
      parameters: z.object({
        goalId: z.string().min(1).optional(),
        items: z.array(z.object({
          title: z.string().min(1),
          description: z.string().optional(),
          dependsOn: z.array(z.number().int().nonnegative()).optional()
        })).min(1)
      }),
      execute: async (raw, ctx, deps) => {
        await assertOwnedKernelContext(ctx, deps);
        const params = z.object({
          goalId: z.string().min(1).optional(),
          items: z.array(z.object({
            title: z.string().min(1),
            description: z.string().optional(),
            dependsOn: z.array(z.number().int().nonnegative()).optional()
          })).min(1)
        }).parse(raw);
        const goalId = params.goalId ?? ctx.goalId;
        if (!goalId) {
          throw toolError("GOAL_NOT_SELECTED", "batch task creation requires a goal so workspace and project ownership can be verified");
        }
        await requireOwnedGoal(goalId, ctx, deps);
        const created: TaskNode[] = [];
        for (const [index, item] of params.items.entries()) {
          const dependencies = (item.dependsOn ?? []).map((dependencyIndex) => {
            const dependency = created[dependencyIndex];
            if (!dependency) {
              throw toolError("TASK_DEPENDENCY_NOT_FOUND", `item ${index} depends on batch index ${dependencyIndex}, which is not an earlier item`);
            }
            return dependency.id;
          });
          created.push(await deps.kernel.createTask({
            goalId,
            title: item.title,
            ...(item.description !== undefined ? { description: item.description } : {}),
            dependencies
          }));
        }
        return succeed("task.create_many", ctx, { tasks: created, count: created.length });
      }
    },
    {
      name: "task.list",
      description: "List tasks, optionally filtered by goal or status. Use to see the queue, what is running, and what is blocked.",
      capabilityPack: "task",
      permission: "read",
      parameters: z.object({
        goalId: z.string().min(1).optional(),
        status: z.enum(["queued", "running", "blocked", "waiting_approval", "completed", "failed"]).optional()
      }),
      execute: async (raw, ctx, deps) => {
        await assertOwnedKernelContext(ctx, deps);
        const params = z.object({
          goalId: z.string().min(1).optional(),
          status: z.enum(["queued", "running", "blocked", "waiting_approval", "completed", "failed"]).optional()
        }).parse(raw);
        const goalId = params.goalId ?? ctx.goalId;
        const tasks = goalId !== undefined
          ? await (async () => {
              await requireOwnedGoal(goalId, ctx, deps);
              return deps.kernel.listTasks({
                goalId,
                ...(params.status !== undefined ? { status: params.status } : {})
              });
            })()
          : (await Promise.all((await listOwnedProjects(ctx, deps)).map(async (project) => {
              const goals = await deps.kernel.listGoals(project.id);
              return (await Promise.all(goals.map((goal) => deps.kernel.listTasks({
                goalId: goal.id,
                ...(params.status !== undefined ? { status: params.status } : {})
              })))).flat();
            }))).flat();
        return succeed("task.list", ctx, { tasks, count: tasks.length });
      }
    },
    {
      name: "task.start",
      description: "Move a queued task to running. Use when beginning work on it; only queued tasks can start.",
      capabilityPack: "task",
      permission: "write",
      parameters: TaskIdParams,
      execute: async (raw, ctx, deps) => {
        await assertOwnedKernelContext(ctx, deps);
        const params = TaskIdParams.parse(raw);
        await requireOwnedTask(params.taskId, ctx, deps);
        // KernelService has no start transition; the store layer owns it.
        const task = await updateKernelTask(deps.kernel, params.taskId, deps.now(), (current) => {
          if (current.status !== "queued") {
            throw toolError("TASK_INVALID_TRANSITION", `cannot start task in ${current.status} state (only queued tasks can start)`);
          }
          return { status: "running" as const };
        });
        return succeed("task.start", ctx, { task });
      }
    },
    {
      name: "task.block",
      description: "Mark a non-terminal task blocked. Use when it cannot proceed without the user or an external dependency; say why in the reply.",
      capabilityPack: "task",
      permission: "write",
      parameters: TaskIdParams,
      execute: async (raw, ctx, deps) => {
        await assertOwnedKernelContext(ctx, deps);
        const params = TaskIdParams.parse(raw);
        await requireOwnedTask(params.taskId, ctx, deps);
        const task = await updateKernelTask(deps.kernel, params.taskId, deps.now(), (current) => {
          requireTransitionable(current, "block");
          return { status: "blocked" as const };
        });
        return succeed("task.block", ctx, { task });
      }
    },
    {
      name: "task.complete",
      description: "Complete a task and report which queued tasks the completion unlocked. Use when the task's work is verifiably done.",
      capabilityPack: "task",
      permission: "write",
      parameters: TaskIdParams,
      execute: async (raw, ctx, deps) => {
        await assertOwnedKernelContext(ctx, deps);
        const params = TaskIdParams.parse(raw);
        await requireOwnedTask(params.taskId, ctx, deps);
        const result = await deps.kernel.completeTask(params.taskId);
        return succeed("task.complete", ctx, result);
      }
    },
    {
      name: "task.fail",
      description: "Mark a non-terminal task failed. Use when the attempt is conclusively unsuccessful, not merely paused.",
      capabilityPack: "task",
      permission: "write",
      parameters: TaskIdParams,
      execute: async (raw, ctx, deps) => {
        await assertOwnedKernelContext(ctx, deps);
        const params = TaskIdParams.parse(raw);
        await requireOwnedTask(params.taskId, ctx, deps);
        const task = await updateKernelTask(deps.kernel, params.taskId, deps.now(), (current) => {
          requireTransitionable(current, "fail");
          return { status: "failed" as const };
        });
        return succeed("task.fail", ctx, { task });
      }
    },
    {
      name: "task.add_dependency",
      description: "Add a dependency edge between two existing tasks; rejected when it would close a dependency cycle.",
      capabilityPack: "task",
      permission: "write",
      parameters: z.object({ taskId: z.string().min(1), dependencyId: z.string().min(1) }),
      execute: async (raw, ctx, deps) => {
        await assertOwnedKernelContext(ctx, deps);
        const params = z.object({ taskId: z.string().min(1), dependencyId: z.string().min(1) }).parse(raw);
        const target = await requireOwnedTask(params.taskId, ctx, deps);
        const dependency = await requireOwnedTask(params.dependencyId, ctx, deps).catch(() => { throw taskDependencyNotFound(); });
        if (dependency.task.goalId !== target.task.goalId) throw taskDependencyNotFound();
        const store = kernelStores(deps.kernel).tasks;
        const all = await store.list({ goalId: target.task.goalId });
        const next = addDependency(all, params.taskId, params.dependencyId, deps.now());
        const changed = next.find((candidate) => candidate.id === params.taskId);
        if (!changed) throw toolError("TASK_NOT_FOUND", "task not found in this workspace and project");
        await store.save(changed);
        return succeed("task.add_dependency", ctx, { task: changed });
      }
    },
    {
      name: "task.attach_evidence",
      description: "Attach evidence ids (screenshot/action/artifact/agent-tool references) to a task's evidenceIds. Use to ground a task's outcome in the evidence trail.",
      capabilityPack: "task",
      permission: "write",
      parameters: z.object({
        taskId: z.string().min(1).optional(),
        evidenceIds: z.array(z.string().min(1)).min(1)
      }),
      execute: async (raw, ctx, deps) => {
        await assertOwnedKernelContext(ctx, deps);
        const params = z.object({
          taskId: z.string().min(1).optional(),
          evidenceIds: z.array(z.string().min(1)).min(1)
        }).parse(raw);
        const taskId = params.taskId ?? ctx.taskId;
        if (!taskId) {
          throw toolError("TASK_NOT_SELECTED", "no taskId was passed and the execution context has no current task");
        }
        const ownedTask = await requireOwnedTask(taskId, ctx, deps);
        for (const evidenceId of params.evidenceIds) {
          if (!evidenceId.startsWith("artifact:")) continue;
          const artifactId = evidenceId.slice("artifact:".length);
          const ownedArtifact = await requireOwnedArtifact(artifactId, ctx, deps);
          if (ownedArtifact.project.id !== ownedTask.project.id) throw artifactNotFound();
        }
        const task = await updateKernelTask(deps.kernel, taskId, deps.now(), (current) => ({
          evidenceIds: [...new Set([...current.evidenceIds, ...params.evidenceIds])]
        }));
        return succeed("task.attach_evidence", ctx, { task }, { evidenceIds: params.evidenceIds });
      }
    }
  ];
}
