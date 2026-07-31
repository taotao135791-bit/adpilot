import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AdPilotSystem } from "@adpilot/application";
import { KernelError } from "@adpilot/kernel";
import { ProjectExistsError } from "@adpilot/session-service";
import {
  DocumentRenderer,
  DocumentSpec,
  SlidesRenderer,
  SlidesSpec,
  SpreadsheetRenderer,
  WorkbookSpec
} from "@adpilot/artifacts";
import { ensureProjectSession, isComplexMission, MISSION_GOAL_TITLE_LENGTH } from "./session-binding.js";

const WorkspaceQuery = z.object({
  workspaceId: z.string().min(1).max(256),
  status: z.enum(["active", "archived"]).optional()
}).strict();

const ProjectType = z.enum(["general", "advertising", "development", "research", "creative"]);
const CapabilityPack = z.enum([
  "ads",
  "artifact",
  "automation",
  "code",
  "computer-use",
  "git",
  "workflow"
]);

const ProjectCreateBody = z.object({
  workspaceId: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(256),
  description: z.string().max(4_000).optional(),
  type: ProjectType.default("general"),
  rootPaths: z.array(z.string().min(1).max(1_024)).max(32).default([]),
  enabledCapabilityPacks: z.array(CapabilityPack).max(CapabilityPack.options.length).optional()
}).strict();

const DEFAULT_CAPABILITY_PACKS: Readonly<Record<z.infer<typeof ProjectType>, readonly z.infer<typeof CapabilityPack>[]>> = {
  general: [],
  advertising: ["ads", "artifact", "automation", "workflow", "computer-use"],
  development: ["code", "git"],
  research: [],
  creative: ["artifact"]
};

async function canonicalProjectRoots(inputs: readonly string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const input of inputs) {
    if (!isAbsolute(input)) {
      throw new KernelError(`project root must be an absolute path: ${input}`, "PROJECT_ROOT_INVALID");
    }
    const canonical = await realpath(input).catch(() => {
      throw new KernelError(`project root does not exist: ${input}`, "PROJECT_ROOT_INVALID");
    });
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) {
      throw new KernelError(`project root is not a directory: ${input}`, "PROJECT_ROOT_INVALID");
    }
    if (!roots.includes(canonical)) roots.push(canonical);
  }
  return roots;
}

const GoalCreateBody = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(512),
  objective: z.string().max(8_000).default(""),
  successCriteria: z.array(z.string().min(1).max(1_000)).max(32).default([]),
  constraints: z.array(z.string().min(1).max(1_000)).max(32).default([]),
  verificationPlan: z.array(z.string().min(1).max(1_000)).max(32).default([])
}).strict();

const GoalPatchBody = z.object({
  progress: z.number().finite().min(0).max(1).optional(),
  status: z.enum(["draft", "active", "blocked", "waiting_approval", "completed", "failed"]).optional()
}).strict().refine((value) => value.progress !== undefined || value.status !== undefined, {
  message: "goal patch must change progress or status"
});

const TaskCreateBody = z.object({
  goalId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(512),
  description: z.string().max(8_000).default(""),
  dependencies: z.array(z.string().uuid()).max(64).default([]),
  assignedAgentId: z.string().min(1).max(128).optional()
}).strict();

const ArtifactCreateBody = z.object({
  projectId: z.string().uuid(),
  sessionId: z.string().min(1).max(128).optional(),
  type: z.enum(["slides", "document", "spreadsheet"]),
  title: z.string().trim().min(1).max(512),
  spec: z.unknown()
}).strict();

const IdParams = z.object({ id: z.string().min(1).max(128) });

const ProjectSessionBody = z.object({
  workspaceId: z.string().min(1).max(256),
  title: z.string().trim().min(1).max(200).optional(),
  /** Create a fresh session even when an active one exists ("new session"). */
  force: z.boolean().default(false)
}).strict();

const ProjectMissionBody = z.object({
  workspaceId: z.string().min(1).max(256),
  message: z.string().trim().min(1).max(20_000)
}).strict();

const CONTENT_TYPES: Record<string, string> = {
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8"
};

/**
 * Universal Workspace kernel routes: projects, goals, task graphs, and the
 * unified artifact runtime. Everything is scoped by the existing workspace
 * (client) boundary — a project always belongs to exactly one workspace.
 */
export function registerKernelRoutes(app: FastifyInstance, system: AdPilotSystem): void {
  async function requireWorkspace(workspaceId: string): Promise<void> {
    await system.workspace.readClient(workspaceId);
  }

  async function requireProjectInWorkspace(projectId: string, workspaceId: string) {
    const project = await system.kernel.getProject(projectId);
    if (!project || project.workspaceId !== workspaceId) {
      throw new KernelError(`project not found in this workspace: ${projectId}`, "PROJECT_NOT_FOUND");
    }
    return project;
  }

  app.get("/api/kernel/projects", async (request) => {
    const query = WorkspaceQuery.parse(request.query);
    await requireWorkspace(query.workspaceId);
    const projects = await system.kernel.listProjects({
      workspaceId: query.workspaceId,
      ...(query.status ? { status: query.status } : {})
    });
    return { projects };
  });

  app.post("/api/kernel/projects", async (request, reply) => {
    const body = ProjectCreateBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const rootPaths = await canonicalProjectRoots(body.rootPaths);
    if (body.type === "development" && rootPaths.length === 0) {
      throw new KernelError(
        "development projects require at least one existing absolute project root",
        "PROJECT_ROOT_REQUIRED"
      );
    }
    const enabledCapabilityPacks = body.enabledCapabilityPacks?.length
      ? [...new Set(body.enabledCapabilityPacks)]
      : [...DEFAULT_CAPABILITY_PACKS[body.type]];
    const project = await system.kernel.createProject({
      workspaceId: body.workspaceId,
      name: body.name,
      type: body.type,
      rootPaths,
      enabledCapabilityPacks,
      ...(body.description !== undefined ? { description: body.description } : {})
    });
    // Shadow the kernel project into the session-service under the same id so
    // project-bound sessions pass the same-client project check. Idempotent:
    // an existing shadow (replay, retry, or a race) is left untouched.
    if (!(await system.sessions.getProject(project.id))) {
      try {
        await system.sessions.createProject({
          id: project.id,
          clientId: body.workspaceId,
          name: project.name
        });
      } catch (error) {
        if (!(error instanceof ProjectExistsError)) throw error;
      }
    }
    await system.audit.append({
      clientId: body.workspaceId,
      actor: "workspace-owner",
      action: "kernel_project_create",
      status: "succeeded",
      details: { projectId: project.id, name: project.name, type: project.type }
    });
    reply.code(201);
    return project;
  });

  app.get("/api/kernel/projects/:id", async (request) => {
    const params = IdParams.parse(request.params);
    const query = z.object({ workspaceId: z.string().min(1).max(256) }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    const project = await requireProjectInWorkspace(params.id, query.workspaceId);
    const [goals, artifacts] = await Promise.all([
      system.kernel.listGoals(project.id),
      system.artifacts.list(project.id)
    ]);
    const tasks = await system.kernel.listTasks({});
    const goalIds = new Set(goals.map((goal) => goal.id));
    return {
      ...project,
      goals,
      tasks: tasks.filter((task) => task.goalId && goalIds.has(task.goalId)),
      artifacts
    };
  });

  app.post("/api/kernel/projects/:id/archive", async (request) => {
    const params = IdParams.parse(request.params);
    const body = z.object({ workspaceId: z.string().min(1).max(256) }).strict().parse(request.body);
    await requireWorkspace(body.workspaceId);
    await requireProjectInWorkspace(params.id, body.workspaceId);
    return system.kernel.archiveProject(params.id);
  });

  /**
   * Resolve the project's durable chat session: the most recent active one,
   * or a freshly created one linked into the kernel project. `force: true`
   * always creates — the workbench "new session" action.
   */
  app.post("/api/kernel/projects/:id/session", async (request, reply) => {
    const params = IdParams.parse(request.params);
    const body = ProjectSessionBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const project = await requireProjectInWorkspace(params.id, body.workspaceId);
    const result = await ensureProjectSession(system, {
      workspaceId: body.workspaceId,
      projectId: project.id,
      title: body.title ?? project.name,
      force: body.force
    });
    if (result.created) {
      await system.audit.append({
        clientId: body.workspaceId,
        actor: "workspace-owner",
        action: "kernel_project_session_create",
        status: "succeeded",
        details: { projectId: project.id, sessionId: result.session.id }
      });
    }
    reply.code(result.created ? 201 : 200);
    return result;
  });

  /**
   * Mission triage before the workbench posts to /api/messages: complex
   * missions (long, or naming success criteria) become a kernel goal plus an
   * initial planning task; short small-talk returns an empty payload and
   * stays a plain conversation turn.
   */
  app.post("/api/kernel/projects/:id/mission", async (request, reply) => {
    const params = IdParams.parse(request.params);
    const body = ProjectMissionBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const project = await requireProjectInWorkspace(params.id, body.workspaceId);
    if (!isComplexMission(body.message)) return {};
    const goal = await system.kernel.createGoal({
      projectId: project.id,
      title: body.message.slice(0, MISSION_GOAL_TITLE_LENGTH),
      objective: body.message
    });
    const task = await system.kernel.createTask({
      goalId: goal.id,
      title: "规划执行路径",
      description: body.message
    });
    await system.audit.append({
      clientId: body.workspaceId,
      actor: "workspace-owner",
      action: "kernel_mission_goal_create",
      status: "succeeded",
      details: { projectId: project.id, goalId: goal.id, taskId: task.id }
    });
    reply.code(201);
    return { goalId: goal.id, taskId: task.id };
  });

  app.get("/api/kernel/goals", async (request) => {
    const query = z.object({
      workspaceId: z.string().min(1).max(256),
      projectId: z.string().uuid()
    }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    await requireProjectInWorkspace(query.projectId, query.workspaceId);
    return { goals: await system.kernel.listGoals(query.projectId) };
  });

  app.post("/api/kernel/goals", async (request, reply) => {
    const body = GoalCreateBody.parse(request.body);
    const project = await system.kernel.getProject(body.projectId);
    if (!project) throw new KernelError(`project not found: ${body.projectId}`, "PROJECT_NOT_FOUND");
    await requireWorkspace(project.workspaceId);
    const goal = await system.kernel.createGoal(body);
    await system.audit.append({
      clientId: project.workspaceId,
      actor: "workspace-owner",
      action: "kernel_goal_create",
      status: "succeeded",
      details: { projectId: project.id, goalId: goal.id, title: goal.title }
    });
    reply.code(201);
    return goal;
  });

  app.patch("/api/kernel/goals/:id", async (request) => {
    const params = IdParams.parse(request.params);
    const body = GoalPatchBody.parse(request.body);
    const goal = await system.kernel.getGoal(params.id);
    if (!goal) throw new KernelError(`goal not found: ${params.id}`, "GOAL_NOT_FOUND");
    const project = await system.kernel.getProject(goal.projectId);
    if (!project) throw new KernelError(`project not found: ${goal.projectId}`, "PROJECT_NOT_FOUND");
    await requireWorkspace(project.workspaceId);
    if (body.progress !== undefined) await system.kernel.updateGoalProgress(goal.id, body.progress);
    if (body.status) return system.kernel.updateGoalStatus(goal.id, body.status);
    return system.kernel.getGoal(goal.id);
  });

  app.get("/api/kernel/tasks", async (request) => {
    const query = z.object({
      workspaceId: z.string().min(1).max(256),
      goalId: z.string().uuid().optional(),
      status: z.enum(["queued", "running", "blocked", "waiting_approval", "completed", "failed"]).optional(),
      ready: z.coerce.boolean().optional()
    }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    if (query.goalId) {
      const goal = await system.kernel.getGoal(query.goalId);
      if (!goal) throw new KernelError(`goal not found: ${query.goalId}`, "GOAL_NOT_FOUND");
      await requireProjectInWorkspace(goal.projectId, query.workspaceId);
    }
    if (query.ready) return { tasks: await system.kernel.readyTasks(query.goalId) };
    return {
      tasks: await system.kernel.listTasks({
        ...(query.goalId ? { goalId: query.goalId } : {}),
        ...(query.status ? { status: query.status } : {})
      })
    };
  });

  app.post("/api/kernel/tasks", async (request, reply) => {
    const body = TaskCreateBody.parse(request.body);
    if (body.goalId) {
      const goal = await system.kernel.getGoal(body.goalId);
      if (!goal) throw new KernelError(`goal not found: ${body.goalId}`, "GOAL_NOT_FOUND");
      const project = await system.kernel.getProject(goal.projectId);
      if (project) await requireWorkspace(project.workspaceId);
    }
    const task = await system.kernel.createTask({
      title: body.title,
      description: body.description,
      dependencies: body.dependencies,
      ...(body.goalId ? { goalId: body.goalId } : {}),
      ...(body.parentId ? { parentId: body.parentId } : {}),
      ...(body.assignedAgentId ? { assignedAgentId: body.assignedAgentId } : {})
    });
    reply.code(201);
    return task;
  });

  app.post("/api/kernel/tasks/:id/complete", async (request) => {
    const params = IdParams.parse(request.params);
    const result = await system.kernel.completeTask(params.id);
    return result;
  });

  app.get("/api/kernel/artifacts", async (request) => {
    const query = z.object({
      workspaceId: z.string().min(1).max(256),
      projectId: z.string().uuid()
    }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    await requireProjectInWorkspace(query.projectId, query.workspaceId);
    return { artifacts: await system.artifacts.list(query.projectId) };
  });

  app.post("/api/kernel/artifacts", async (request, reply) => {
    const body = ArtifactCreateBody.parse(request.body);
    const project = await system.kernel.getProject(body.projectId);
    if (!project) throw new KernelError(`project not found: ${body.projectId}`, "PROJECT_NOT_FOUND");
    await requireWorkspace(project.workspaceId);
    const options = body.sessionId ? { sessionId: body.sessionId } : {};
    let record;
    if (body.type === "slides") {
      record = await system.artifacts.createFromRenderer(project.id, body.type, body.title, SlidesSpec.parse(body.spec), new SlidesRenderer(), options);
    } else if (body.type === "document") {
      record = await system.artifacts.createFromRenderer(project.id, body.type, body.title, DocumentSpec.parse(body.spec), new DocumentRenderer(), options);
    } else {
      record = await system.artifacts.createFromRenderer(project.id, body.type, body.title, WorkbookSpec.parse(body.spec), new SpreadsheetRenderer(), options);
    }
    await system.kernel.registerArtifact({
      id: record.id,
      projectId: project.id,
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      type: body.type,
      title: record.title
    });
    await system.audit.append({
      clientId: project.workspaceId,
      actor: "workspace-owner",
      action: "kernel_artifact_render",
      status: "succeeded",
      details: { projectId: project.id, artifactId: record.id, type: body.type, version: record.version }
    });
    reply.code(201);
    return record;
  });

  app.get("/api/kernel/artifacts/:id", async (request) => {
    const params = IdParams.parse(request.params);
    const query = z.object({ workspaceId: z.string().min(1).max(256) }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    const record = await system.artifacts.get(params.id);
    if (!record) throw new KernelError(`artifact not found: ${params.id}`, "ARTIFACT_NOT_FOUND");
    await requireProjectInWorkspace(record.projectId, query.workspaceId);
    const versions = await system.artifacts.listVersions(record.id);
    return { ...record, versions };
  });

  app.get("/api/kernel/artifacts/:id/output/*", async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(128), "*": z.string().min(1).max(512) }).parse(request.params);
    const query = z.object({ workspaceId: z.string().min(1).max(256) }).strict().parse(request.query);
    await requireWorkspace(query.workspaceId);
    const record = await system.artifacts.get(params.id);
    if (!record) throw new KernelError(`artifact not found: ${params.id}`, "ARTIFACT_NOT_FOUND");
    await requireProjectInWorkspace(record.projectId, query.workspaceId);
    const filename = params["*"];
    const buffer = await system.artifacts.readOutput(record.id, filename);
    if (!buffer) throw new KernelError(`artifact output not found: ${filename}`, "ARTIFACT_NOT_FOUND");
    const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    reply.headers({
      "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "etag": `"${createHash("sha256").update(buffer).digest("hex").slice(0, 32)}"`
    });
    return sendBuffer(reply, buffer);
  });
}

function sendBuffer(reply: FastifyReply, buffer: Buffer) {
  return reply.send(buffer);
}
