import { z } from "zod";
import { Project as ProjectSchema } from "@adpilot/kernel";
import type { AgentToolDefinition } from "../registry.js";
import { kernelStores } from "../kernel-internal.js";
import { succeed } from "../result.js";
import { toolError } from "../errors.js";

const ProjectIdParams = z.object({
  projectId: z.string().min(1).optional()
});

function requireProjectId(params: { projectId?: string | undefined }, ctx: { projectId?: string | undefined }): string {
  const projectId = params.projectId ?? ctx.projectId;
  if (!projectId) {
    throw toolError("PROJECT_NOT_SELECTED", "no projectId was passed and the execution context has no current project; pass projectId or open a project first");
  }
  return projectId;
}

/** Project tools: the current-project context view, listing, opening, and root management. */
export function createProjectTools(): AgentToolDefinition[] {
  return [
    {
      name: "project.get_context",
      description: "Read the full context of a project (record, goals with their tasks, artifacts, linked sessions). Use before planning project work or when the user asks where a project stands.",
      capabilityPack: "project",
      permission: "read",
      parameters: ProjectIdParams,
      execute: async (raw, ctx, deps) => {
        const params = ProjectIdParams.parse(raw);
        const projectId = requireProjectId(params, ctx);
        const project = await deps.kernel.getProject(projectId);
        if (!project || project.workspaceId !== ctx.workspaceId) {
          throw toolError("PROJECT_NOT_FOUND", `project not found in this workspace: ${projectId}`);
        }
        const goals = await deps.kernel.listGoals(projectId);
        const tasks = (await Promise.all(goals.map((goal) => deps.kernel.listTasks({ goalId: goal.id })))).flat();
        const artifacts = await kernelStores(deps.kernel).artifacts.list({ projectId });
        return succeed("project.get_context", ctx, { project, goals, tasks, artifacts, sessionIds: project.sessionIds });
      }
    },
    {
      name: "project.list",
      description: "List the workspace's projects, optionally filtered by status. Use to discover project ids before opening one.",
      capabilityPack: "project",
      permission: "read",
      parameters: z.object({ status: z.enum(["active", "archived"]).optional() }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({ status: z.enum(["active", "archived"]).optional() }).parse(raw);
        const projects = await deps.kernel.listProjects({
          workspaceId: ctx.workspaceId,
          ...(params.status !== undefined ? { status: params.status } : {})
        });
        return succeed("project.list", ctx, { projects, count: projects.length });
      }
    },
    {
      name: "project.open",
      description: "Open a project for this session: verifies it exists and links the current session to it. Use when the user picks a project to work on.",
      capabilityPack: "project",
      permission: "write",
      parameters: z.object({ projectId: z.string().min(1) }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({ projectId: z.string().min(1) }).parse(raw);
        const project = await deps.kernel.getProject(params.projectId);
        if (!project || project.workspaceId !== ctx.workspaceId) {
          throw toolError("PROJECT_NOT_FOUND", `project not found in this workspace: ${params.projectId}`);
        }
        // Project.sessionIds holds uuids; only uuid-shaped session ids can be linked.
        const opened = z.string().uuid().safeParse(ctx.sessionId).success
          ? await deps.kernel.linkSession(project.id, ctx.sessionId)
          : project;
        return succeed("project.open", ctx, { project: opened, sessionLinked: opened.sessionIds.includes(ctx.sessionId) });
      }
    },
    {
      name: "project.add_root",
      description: "Add a filesystem root path to a project (normalized and de-duplicated). Use when the project needs to work on an additional directory.",
      capabilityPack: "project",
      permission: "write",
      parameters: ProjectIdParams.extend({ path: z.string().min(1) }),
      execute: async (raw, ctx, deps) => {
        const params = ProjectIdParams.extend({ path: z.string().min(1) }).parse(raw);
        const projectId = requireProjectId(params, ctx);
        const store = kernelStores(deps.kernel).projects;
        const project = await store.get(projectId);
        if (!project || project.workspaceId !== ctx.workspaceId) {
          throw toolError("PROJECT_NOT_FOUND", `project not found in this workspace: ${projectId}`);
        }
        const path = params.path.trim();
        if (project.rootPaths.includes(path)) {
          return succeed("project.add_root", ctx, { project, added: false });
        }
        // KernelService has no root-path update; the store layer owns it with the same revision discipline.
        const next = ProjectSchema.parse({
          ...project,
          rootPaths: [...project.rootPaths, path],
          updatedAt: deps.now().toISOString(),
          revision: project.revision + 1
        });
        await store.save(next);
        return succeed("project.add_root", ctx, { project: next, added: true });
      }
    }
  ];
}
