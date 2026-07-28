import { randomUUID } from "node:crypto";
import { KernelError } from "./errors.js";
import {
  Artifact,
  Goal,
  Project,
  TaskNode,
  type Artifact as ArtifactValue,
  type ArtifactType,
  type Goal as GoalValue,
  type GoalStatus,
  type Project as ProjectValue,
  type ProjectType,
  type TaskNode as TaskNodeValue,
  type TaskNodeStatus
} from "./entities.js";
import { completeTask, createTask, readyTasks, type CreateTaskInput } from "./task-graph.js";
import {
  FileArtifactStore,
  FileGoalStore,
  FileProjectStore,
  FileTaskGraphStore,
  type ArtifactStore,
  type GoalStore,
  type ProjectStore,
  type TaskGraphStore
} from "./stores.js";

/** Injectable clock so tests can drive deterministic timestamps. */
export interface KernelClock {
  now(): Date;
}

const systemClock: KernelClock = { now: () => new Date() };

export interface KernelStores {
  projects: ProjectStore;
  goals: GoalStore;
  tasks: TaskGraphStore;
  artifacts: ArtifactStore;
}

export interface CreateProjectInput {
  workspaceId: string;
  name: string;
  description?: string;
  type?: ProjectType;
  rootPaths?: readonly string[];
  enabledCapabilityPacks?: readonly string[];
}

export interface CreateGoalInput {
  projectId: string;
  title: string;
  objective: string;
  successCriteria?: readonly string[];
  constraints?: readonly string[];
  verificationPlan?: readonly string[];
}

/**
 * Facade over the four entity stores: owns cross-entity invariants (project
 * id-list write-backs, progress clamping, archival rules) so callers never
 * juggle stores themselves. Write-backs are idempotent — re-linking an
 * already-linked id is a no-op that returns the untouched project.
 */
export class KernelService {
  constructor(
    private readonly stores: KernelStores,
    private readonly clock: KernelClock = systemClock
  ) {}

  /** Compose the service over the standard file-backed stores under `root`. */
  static fromRoot(root: string, clock: KernelClock = systemClock): KernelService {
    return new KernelService({
      projects: new FileProjectStore(root),
      goals: new FileGoalStore(root),
      tasks: new FileTaskGraphStore(root),
      artifacts: new FileArtifactStore(root)
    }, clock);
  }

  async createProject(input: CreateProjectInput): Promise<ProjectValue> {
    const name = input.name.trim();
    if (!name) throw new KernelError("project name must not be empty", "INVALID_PROJECT_NAME");
    const now = this.clock.now().toISOString();
    const project = Project.parse({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      type: input.type ?? "general",
      rootPaths: normalizeRootPaths(input.rootPaths ?? []),
      goalIds: [],
      sessionIds: [],
      artifactIds: [],
      enabledCapabilityPacks: [...new Set(input.enabledCapabilityPacks ?? [])],
      status: "active",
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    await this.stores.projects.save(project);
    return project;
  }

  /** Create a draft goal and write its id back into the owning project. */
  async createGoal(input: CreateGoalInput): Promise<GoalValue> {
    const project = await this.requireProject(input.projectId);
    if (project.status === "archived") {
      throw new KernelError(`cannot add a goal to archived project: ${project.id}`, "PROJECT_ARCHIVED");
    }
    const now = this.clock.now().toISOString();
    const goal = Goal.parse({
      id: randomUUID(),
      projectId: project.id,
      title: input.title,
      objective: input.objective,
      successCriteria: [...(input.successCriteria ?? [])],
      constraints: [...(input.constraints ?? [])],
      verificationPlan: [...(input.verificationPlan ?? [])],
      progress: 0,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    await this.stores.goals.save(goal);
    await this.appendProjectId(project, "goalIds", goal.id);
    return goal;
  }

  /** Idempotently link a session to a project. */
  async linkSession(projectId: string, sessionId: string): Promise<ProjectValue> {
    const project = await this.requireProject(projectId);
    return this.appendProjectId(project, "sessionIds", sessionId);
  }

  /**
   * Idempotently link an artifact to a project. The artifact must exist and
   * already belong to this project, so project id lists never dangle.
   */
  async linkArtifact(projectId: string, artifactId: string): Promise<ProjectValue> {
    const project = await this.requireProject(projectId);
    const artifact = await this.stores.artifacts.get(artifactId);
    if (!artifact) throw new KernelError(`artifact not found: ${artifactId}`, "ARTIFACT_NOT_FOUND");
    if (artifact.projectId !== project.id) {
      throw new KernelError(
        `artifact ${artifactId} belongs to project ${artifact.projectId}, not ${project.id}`,
        "ARTIFACT_PROJECT_MISMATCH"
      );
    }
    return this.appendProjectId(project, "artifactIds", artifact.id);
  }

  /** Clamp progress into [0, 1] and persist; a no-op when nothing changes. */
  async updateGoalProgress(goalId: string, progress: number): Promise<GoalValue> {
    if (!Number.isFinite(progress)) {
      throw new KernelError("goal progress must be a finite number", "INVALID_GOAL_PROGRESS");
    }
    const goal = await this.stores.goals.get(goalId);
    if (!goal) throw new KernelError(`goal not found: ${goalId}`, "GOAL_NOT_FOUND");
    const clamped = Math.min(1, Math.max(0, progress));
    if (clamped === goal.progress) return goal;
    const next = Goal.parse({
      ...goal,
      progress: clamped,
      updatedAt: this.clock.now().toISOString(),
      revision: goal.revision + 1
    });
    await this.stores.goals.save(next);
    return next;
  }

  /**
   * Register and link an externally produced artifact (e.g. the artifacts
   * package's rendered output). The kernel record shares the producer's id
   * so project artifact lists never dangle across the two stores.
   */
  async registerArtifact(input: {
    id: string;
    projectId: string;
    sessionId?: string;
    type: ArtifactType;
    title: string;
  }): Promise<ArtifactValue> {
    const project = await this.requireProject(input.projectId);
    const existing = await this.stores.artifacts.get(input.id);
    if (existing) {
      await this.linkArtifact(project.id, existing.id);
      return existing;
    }
    const now = this.clock.now().toISOString();
    const artifact = Artifact.parse({
      id: input.id,
      projectId: project.id,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      type: input.type,
      title: input.title,
      sourceFiles: [],
      exportFormats: [],
      version: 1,
      status: "ready",
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    await this.stores.artifacts.save(artifact);
    await this.linkArtifact(project.id, artifact.id);
    return artifact;
  }

  /**
   * Archive a project. Deliberately shallow: goals, tasks, and artifacts keep
   * their own status untouched — archival only removes the project from the
   * active working set, it must not rewrite execution history.
   */
  async archiveProject(projectId: string): Promise<ProjectValue> {
    const project = await this.requireProject(projectId);
    if (project.status === "archived") return project;
    const next = Project.parse({
      ...project,
      status: "archived",
      updatedAt: this.clock.now().toISOString(),
      revision: project.revision + 1
    });
    await this.stores.projects.save(next);
    return next;
  }

  async getProject(projectId: string): Promise<ProjectValue | undefined> {
    return this.stores.projects.get(projectId);
  }

  async listProjects(filter: { workspaceId?: string; status?: "active" | "archived" } = {}): Promise<ProjectValue[]> {
    return this.stores.projects.list(filter);
  }

  async getGoal(goalId: string): Promise<GoalValue | undefined> {
    return this.stores.goals.get(goalId);
  }

  async listGoals(projectId?: string): Promise<GoalValue[]> {
    return this.stores.goals.list(projectId ? { projectId } : {});
  }

  /** Move a goal to a new status; revision bumps only on real changes. */
  async updateGoalStatus(goalId: string, status: GoalStatus): Promise<GoalValue> {
    const goal = await this.stores.goals.get(goalId);
    if (!goal) throw new KernelError(`goal not found: ${goalId}`, "GOAL_NOT_FOUND");
    if (goal.status === status) return goal;
    const next = Goal.parse({
      ...goal,
      status,
      updatedAt: this.clock.now().toISOString(),
      revision: goal.revision + 1
    });
    await this.stores.goals.save(next);
    return next;
  }

  /** Queue a task. Dependency and parent references must already exist. */
  async createTask(input: CreateTaskInput): Promise<TaskNodeValue> {
    if (input.goalId) {
      const goal = await this.stores.goals.get(input.goalId);
      if (!goal) throw new KernelError(`goal not found: ${input.goalId}`, "GOAL_NOT_FOUND");
    }
    const existing = await this.stores.tasks.list(input.goalId ? { goalId: input.goalId } : {});
    const task = createTask(input, existing);
    await this.stores.tasks.save(task);
    return task;
  }

  async listTasks(filter: { goalId?: string; status?: TaskNodeStatus } = {}): Promise<TaskNodeValue[]> {
    return this.stores.tasks.list(filter);
  }

  /** Queued tasks whose dependencies are all completed. */
  async readyTasks(goalId?: string): Promise<TaskNodeValue[]> {
    const tasks = await this.listTasks(goalId ? { goalId } : {});
    return readyTasks(tasks);
  }

  /**
   * Complete a task and persist the graph transition. Returns the completed
   * task plus any queued tasks the completion unlocked.
   */
  async completeTask(taskId: string): Promise<{ task: TaskNodeValue; unlocked: TaskNodeValue[] }> {
    const current = await this.stores.tasks.get(taskId);
    if (!current) throw new KernelError(`task not found: ${taskId}`, "TASK_NOT_FOUND");
    const siblings = await this.stores.tasks.list(current.goalId ? { goalId: current.goalId } : {});
    const result = completeTask(siblings, taskId, this.clock.now());
    for (const task of result.tasks) {
      if (task.id === taskId) await this.stores.tasks.save(task);
    }
    const task = result.tasks.find((candidate) => candidate.id === taskId)!;
    return { task, unlocked: result.unlocked };
  }

  private async appendProjectId(
    project: ProjectValue,
    key: "goalIds" | "sessionIds" | "artifactIds",
    id: string
  ): Promise<ProjectValue> {
    if (project[key].includes(id)) return project;
    const next = Project.parse({
      ...project,
      [key]: [...project[key], id],
      updatedAt: this.clock.now().toISOString(),
      revision: project.revision + 1
    });
    await this.stores.projects.save(next);
    return next;
  }

  private async requireProject(projectId: string): Promise<ProjectValue> {
    const project = await this.stores.projects.get(projectId);
    if (!project) throw new KernelError(`project not found: ${projectId}`, "PROJECT_NOT_FOUND");
    return project;
  }
}

/** Trim, drop empties, and de-duplicate while preserving first-seen order. */
function normalizeRootPaths(rootPaths: readonly string[]): string[] {
  return [...new Set(rootPaths.map((path) => path.trim()).filter((path) => path.length > 0))];
}
