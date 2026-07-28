import { randomUUID } from "node:crypto";
import { TaskNode, type TaskNode as TaskNodeValue } from "./entities.js";
import { KernelError } from "./errors.js";

/**
 * Pure functions over arrays of TaskNode values. Nothing here touches disk;
 * callers (stores, services) persist whichever array a function returns.
 * Dependency edges point from a task to the tasks it depends on, so a
 * dependency must always order before its dependents.
 */

export interface CreateTaskInput {
  id?: string;
  goalId?: string;
  parentId?: string;
  title: string;
  description?: string;
  assignedAgentId?: string;
  dependencies?: readonly string[];
  evidenceIds?: readonly string[];
  now?: Date;
}

/**
 * Build a queued TaskNode. Every referenced dependency (and parent, when the
 * caller passes the graph) must already exist in `existing`.
 */
export function createTask(input: CreateTaskInput, existing: readonly TaskNodeValue[] = []): TaskNodeValue {
  const known = new Set(existing.map((task) => task.id));
  const dependencies = [...new Set(input.dependencies ?? [])];
  for (const dependencyId of dependencies) {
    if (!known.has(dependencyId)) {
      throw new KernelError(`task dependency not found: ${dependencyId}`, "TASK_DEPENDENCY_NOT_FOUND");
    }
  }
  if (input.parentId && !known.has(input.parentId)) {
    throw new KernelError(`parent task not found: ${input.parentId}`, "TASK_PARENT_NOT_FOUND");
  }
  const now = (input.now ?? new Date()).toISOString();
  return TaskNode.parse({
    id: input.id ?? randomUUID(),
    ...(input.goalId ? { goalId: input.goalId } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    title: input.title,
    description: input.description ?? "",
    ...(input.assignedAgentId ? { assignedAgentId: input.assignedAgentId } : {}),
    dependencies,
    status: "queued",
    evidenceIds: [...(input.evidenceIds ?? [])],
    createdAt: now,
    updatedAt: now,
    revision: 1
  });
}

/**
 * Return a new task array with `dependencyId` added to `taskId`'s dependencies.
 * Idempotent when the edge already exists. Throws a coded KernelError
 * (TASK_CYCLE) when the edge would close a dependency cycle — including the
 * trivial self-dependency cycle.
 */
export function addDependency(
  tasks: readonly TaskNodeValue[],
  taskId: string,
  dependencyId: string,
  now: Date = new Date()
): TaskNodeValue[] {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new KernelError(`task not found: ${taskId}`, "TASK_NOT_FOUND");
  if (!tasks.some((candidate) => candidate.id === dependencyId)) {
    throw new KernelError(`task dependency not found: ${dependencyId}`, "TASK_DEPENDENCY_NOT_FOUND");
  }
  if (taskId === dependencyId) {
    throw new KernelError(`task cannot depend on itself: ${taskId}`, "TASK_CYCLE");
  }
  if (task.dependencies.includes(dependencyId)) return [...tasks];
  if (reaches(tasks, dependencyId, taskId)) {
    throw new KernelError(
      `dependency ${dependencyId} -> ${taskId} would create a dependency cycle`,
      "TASK_CYCLE"
    );
  }
  const stamp = now.toISOString();
  return tasks.map((candidate) => candidate.id === taskId
    ? TaskNode.parse({
        ...candidate,
        dependencies: [...candidate.dependencies, dependencyId],
        updatedAt: stamp,
        revision: candidate.revision + 1
      })
    : candidate);
}

/** Queued tasks whose dependencies have all reached `completed`. */
export function readyTasks(tasks: readonly TaskNodeValue[]): TaskNodeValue[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter((task) => task.status === "queued"
    && task.dependencies.every((dependencyId) => byId.get(dependencyId)?.status === "completed"));
}

/**
 * Kahn's algorithm over the dependency edges (dependency before dependent),
 * stable in input order. Throws TASK_CYCLE naming the unresolvable task ids
 * when the graph cannot be fully ordered.
 */
export function topologicalOrder(tasks: readonly TaskNodeValue[]): TaskNodeValue[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    const dependencies = task.dependencies.filter((dependencyId) => byId.has(dependencyId));
    indegree.set(task.id, dependencies.length);
    for (const dependencyId of dependencies) {
      const edges = dependents.get(dependencyId) ?? [];
      edges.push(task.id);
      dependents.set(dependencyId, edges);
    }
  }
  const queue = tasks.filter((task) => (indegree.get(task.id) ?? 0) === 0).map((task) => task.id);
  const order: TaskNodeValue[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    order.push(byId.get(id)!);
    for (const dependentId of dependents.get(id) ?? []) {
      const remaining = indegree.get(dependentId)! - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) queue.push(dependentId);
    }
  }
  if (order.length !== tasks.length) {
    const ordered = new Set(order.map((task) => task.id));
    const stuck = tasks.filter((task) => !ordered.has(task.id)).map((task) => task.id);
    throw new KernelError(
      `task graph contains a dependency cycle involving: ${stuck.join(", ")}`,
      "TASK_CYCLE"
    );
  }
  return order;
}

export interface CompleteTaskResult {
  tasks: TaskNodeValue[];
  /** Tasks that became runnable only because of this completion. */
  unlocked: TaskNodeValue[];
}

/**
 * Mark a task completed and report which queued tasks the completion unlocks.
 * Completing an already-terminal task (completed/failed) is rejected with
 * TASK_INVALID_TRANSITION so stale workers cannot rewrite history.
 */
export function completeTask(
  tasks: readonly TaskNodeValue[],
  taskId: string,
  now: Date = new Date()
): CompleteTaskResult {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new KernelError(`task not found: ${taskId}`, "TASK_NOT_FOUND");
  if (task.status === "completed" || task.status === "failed") {
    throw new KernelError(`cannot complete task in ${task.status} state`, "TASK_INVALID_TRANSITION");
  }
  const readyBefore = new Set(readyTasks(tasks).map((candidate) => candidate.id));
  const stamp = now.toISOString();
  const next = tasks.map((candidate) => candidate.id === taskId
    ? TaskNode.parse({
        ...candidate,
        status: "completed",
        updatedAt: stamp,
        revision: candidate.revision + 1
      })
    : candidate);
  const unlocked = readyTasks(next).filter((candidate) => !readyBefore.has(candidate.id));
  return { tasks: next, unlocked };
}

/** Depth-first reachability over dependency edges: can `fromId` reach `toId`? */
function reaches(tasks: readonly TaskNodeValue[], fromId: string, toId: string): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const stack = [fromId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === toId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const dependencyId of byId.get(current)?.dependencies ?? []) {
      stack.push(dependencyId);
    }
  }
  return false;
}
