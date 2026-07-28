import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AdPilotSystem } from "@adpilot/application";
import { KernelError } from "@adpilot/kernel";
import {
  DocumentRenderer,
  DocumentSpec,
  SlidesRenderer,
  SlidesSpec,
  SpreadsheetRenderer,
  WorkbookSpec
} from "@adpilot/artifacts";

const WorkspaceQuery = z.object({
  workspaceId: z.string().min(1).max(256),
  status: z.enum(["active", "archived"]).optional()
}).strict();

const ProjectCreateBody = z.object({
  workspaceId: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(256),
  description: z.string().max(4_000).optional(),
  type: z.enum(["general", "advertising", "development", "research", "creative"]).default("general"),
  rootPaths: z.array(z.string().min(1).max(1_024)).max(32).default([]),
  enabledCapabilityPacks: z.array(z.string().min(1).max(64)).max(16).default([])
}).strict();

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
    const project = await system.kernel.createProject({
      workspaceId: body.workspaceId,
      name: body.name,
      type: body.type,
      rootPaths: body.rootPaths,
      enabledCapabilityPacks: body.enabledCapabilityPacks,
      ...(body.description !== undefined ? { description: body.description } : {})
    });
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
