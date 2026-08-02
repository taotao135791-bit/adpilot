import { z } from "zod";
import type { ArtifactRecord } from "@adpilot/artifacts";
import type { Goal, Project, TaskNode } from "@adpilot/kernel";
import type { AgentExecutionContext } from "../context.js";
import type { AgentToolDeps } from "../deps.js";
import { toolError } from "../errors.js";
import { kernelStores } from "../kernel-internal.js";

const EntityId = z.string().uuid();

export type OwnedGoal = {
  goal: Goal;
  project: Project;
};

export type OwnedTask = OwnedGoal & {
  task: TaskNode & { goalId: string };
};

export type OwnedArtifact = {
  artifact: ArtifactRecord;
  project: Project;
};

/**
 * Kernel entities do not all carry workspaceId directly. Resolve every
 * caller-provided id through its owning relationship and collapse missing,
 * malformed, cross-workspace, and cross-project values into the same safe
 * entity-specific NOT_FOUND error. In particular, never echo a persisted
 * project id or a filesystem path from the backing stores.
 */
export async function requireOwnedProject(
  projectId: string,
  ctx: AgentExecutionContext,
  deps: AgentToolDeps
): Promise<Project> {
  if (!EntityId.safeParse(projectId).success || (ctx.projectId !== undefined && ctx.projectId !== projectId)) {
    throw projectNotFound();
  }
  const project = await deps.kernel.getProject(projectId);
  if (!project || project.workspaceId !== ctx.workspaceId) throw projectNotFound();
  return project;
}

export async function requireOwnedGoal(
  goalId: string,
  ctx: AgentExecutionContext,
  deps: AgentToolDeps
): Promise<OwnedGoal> {
  if (!EntityId.safeParse(goalId).success) throw goalNotFound();
  const goal = await deps.kernel.getGoal(goalId);
  if (!goal) throw goalNotFound();
  try {
    const project = await requireOwnedProject(goal.projectId, ctx, deps);
    return { goal, project };
  } catch {
    // A caller must not be able to distinguish a foreign goal from a missing
    // one, nor learn the foreign goal's owning project id.
    throw goalNotFound();
  }
}

export async function requireOwnedTask(
  taskId: string,
  ctx: AgentExecutionContext,
  deps: AgentToolDeps
): Promise<OwnedTask> {
  if (!EntityId.safeParse(taskId).success) throw taskNotFound();
  const task = await kernelStores(deps.kernel).tasks.get(taskId);
  // TaskNode has no workspaceId/projectId. A task without a goal cannot be
  // attributed to any workspace and is therefore inaccessible to the agent.
  if (!task?.goalId) throw taskNotFound();
  try {
    const ownedGoal = await requireOwnedGoal(task.goalId, ctx, deps);
    return { task: task as TaskNode & { goalId: string }, ...ownedGoal };
  } catch {
    throw taskNotFound();
  }
}

export async function requireOwnedArtifact(
  artifactId: string,
  ctx: AgentExecutionContext,
  deps: AgentToolDeps
): Promise<OwnedArtifact> {
  if (!EntityId.safeParse(artifactId).success) throw artifactNotFound();
  const artifact = await deps.artifacts.get(artifactId);
  if (!artifact) throw artifactNotFound();
  try {
    const project = await requireOwnedProject(artifact.projectId, ctx, deps);
    const kernelArtifact = await kernelStores(deps.kernel).artifacts.get(artifact.id);
    if (kernelArtifact && kernelArtifact.projectId !== artifact.projectId) throw artifactNotFound();
    return { artifact, project };
  } catch {
    throw artifactNotFound();
  }
}

/** Validate all kernel ids already bound into the execution context. */
export async function assertOwnedKernelContext(
  ctx: AgentExecutionContext,
  deps: AgentToolDeps
): Promise<void> {
  if (ctx.projectId !== undefined) await requireOwnedProject(ctx.projectId, ctx, deps);
  const ownedGoal = ctx.goalId !== undefined ? await requireOwnedGoal(ctx.goalId, ctx, deps) : undefined;
  const ownedTask = ctx.taskId !== undefined ? await requireOwnedTask(ctx.taskId, ctx, deps) : undefined;
  if (ownedGoal && ownedTask && ownedTask.task.goalId !== ownedGoal.goal.id) throw taskNotFound();
}

/** Projects visible to this context: one bound project, or this workspace only. */
export async function listOwnedProjects(
  ctx: AgentExecutionContext,
  deps: AgentToolDeps
): Promise<Project[]> {
  if (ctx.projectId !== undefined) return [await requireOwnedProject(ctx.projectId, ctx, deps)];
  return deps.kernel.listProjects({ workspaceId: ctx.workspaceId });
}

export function projectNotFound(): Error {
  return toolError("PROJECT_NOT_FOUND", "project not found in this workspace");
}

export function goalNotFound(): Error {
  return toolError("GOAL_NOT_FOUND", "goal not found in this workspace and project");
}

export function taskNotFound(): Error {
  return toolError("TASK_NOT_FOUND", "task not found in this workspace and project");
}

export function taskParentNotFound(): Error {
  return toolError("TASK_PARENT_NOT_FOUND", "parent task not found in this workspace, project, and goal");
}

export function taskDependencyNotFound(): Error {
  return toolError("TASK_DEPENDENCY_NOT_FOUND", "task dependency not found in this workspace, project, and goal");
}

export function artifactNotFound(): Error {
  return toolError("ARTIFACT_NOT_FOUND", "artifact not found in this workspace and project");
}
