import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdPilotSystem } from "@adpilot/application";
import { KernelError } from "@adpilot/kernel";
import {
  FileComputerActionRecordStore,
  type ComputerActionRecordStore
} from "@adpilot/computer-use";
import {
  FileWorkflowRunStore,
  FileWorkflowStore,
  UnavailableStepExecutor,
  VisualRuntimeStepExecutor,
  WorkflowError,
  WorkflowFailurePolicy,
  WorkflowParameter,
  WorkflowRecorder,
  WorkflowRunner,
  WorkflowStep,
  assertWorkflowConsistent,
  deriveWorkflowPermissions,
  publishAsSkill,
  type StepExecutor,
  type Workflow as WorkflowValue,
  type WorkflowRun as WorkflowRunValue,
  type WorkflowSkillRunner
} from "@adpilot/workflows";

const WorkspaceScoped = z.object({ workspaceId: z.string().min(1).max(256) }).strict();

const FromRunBody = WorkspaceScoped.extend({
  sessionId: z.string().uuid(),
  runId: z.string().min(1).max(256),
  title: z.string().trim().min(1).max(512),
  projectId: z.string().uuid().optional()
}).strict();

const ListQuery = z.object({
  workspaceId: z.string().min(1).max(256),
  status: z.enum(["draft", "published", "archived"]).optional()
}).strict();

const PatchBody = WorkspaceScoped.extend({
  title: z.string().trim().min(1).max(512).optional(),
  description: z.string().max(4_000).optional(),
  parameters: z.array(WorkflowParameter).max(64).optional(),
  steps: z.array(WorkflowStep).max(256).optional(),
  successCriteria: z.array(z.string().min(1).max(1_000)).max(32).optional(),
  failurePolicy: WorkflowFailurePolicy.optional()
}).strict().refine(
  (value) => ["title", "description", "parameters", "steps", "successCriteria", "failurePolicy"]
    .some((key) => value[key as keyof typeof value] !== undefined),
  { message: "workflow patch must change at least one field" }
);

const RunCreateBody = WorkspaceScoped.extend({
  parameters: z.record(z.string().max(16_384)).default({}),
  approvalId: z.string().uuid().optional()
}).strict();

const IdParams = z.object({ id: z.string().min(1).max(128) });

/**
 * Optional embedding seams: tests (or a future composition root) may attach a
 * StepExecutor and/or a ComputerActionRecordStore to the system object. The
 * production default fails closed unless a VisualComputerRuntime exists, and
 * even then no run executes until a live surface provider is wired — replay
 * never guesses a window.
 */
type WorkflowSystemSeams = {
  workflowExecutor?: StepExecutor;
  workflowActionRecords?: ComputerActionRecordStore;
};

export interface WorkflowRoutesOptions {
  executor?: StepExecutor;
  actionRecords?: ComputerActionRecordStore;
}

/**
 * Record & Replay workflow routes (Phase 5). Everything is scoped by the
 * workspace (client) boundary exactly like the kernel routes; publishes,
 * archives, runs, and skill registrations are written to the audit chain.
 */
export function registerWorkflowRoutes(
  app: FastifyInstance,
  system: AdPilotSystem,
  options: WorkflowRoutesOptions = {}
): void {
  const root = system.workspace.root;
  const workflows = new FileWorkflowStore(root);
  const runs = new FileWorkflowRunStore(root);
  const seams = system as AdPilotSystem & WorkflowSystemSeams;
  const executor = options.executor
    ?? seams.workflowExecutor
    ?? (system.computer
      ? new VisualRuntimeStepExecutor(system.computer, async () => undefined)
      : new UnavailableStepExecutor("Computer Use is unavailable on this system"));
  const runner = new WorkflowRunner({ workflows, runs, executor });
  const recorder = new WorkflowRecorder({
    records: options.actionRecords
      ?? seams.workflowActionRecords
      ?? new FileComputerActionRecordStore(join(root, ".adpilot", "computer-actions")),
    workflows
  });
  const skillRunner: WorkflowSkillRunner = {
    runWorkflow: async (input) => {
      const run = await runner.createRun(input);
      void runner.execute(run.id).catch(() => undefined);
      return { runId: run.id, status: run.status };
    }
  };

  async function requireWorkspace(workspaceId: string): Promise<void> {
    await system.workspace.readClient(workspaceId);
  }

  async function requireWorkflowInWorkspace(id: string, workspaceId: string): Promise<WorkflowValue> {
    const workflow = await workflows.get(id);
    if (!workflow || workflow.workspaceId !== workspaceId) {
      throw new WorkflowError(`workflow not found in this workspace: ${id}`, "WORKFLOW_NOT_FOUND");
    }
    return workflow;
  }

  async function requireRunInWorkspace(id: string, workspaceId: string): Promise<WorkflowRunValue> {
    const run = await runs.get(id);
    if (!run || run.workspaceId !== workspaceId) {
      throw new WorkflowError(`workflow run not found in this workspace: ${id}`, "WORKFLOW_RUN_NOT_FOUND");
    }
    return run;
  }

  async function audit(workspaceId: string, action: string, details: Record<string, unknown>): Promise<void> {
    await system.audit.append({
      clientId: workspaceId,
      actor: "workspace-owner",
      action,
      status: "succeeded",
      details
    });
  }

  app.post("/api/workflows/from-run", async (request, reply) => {
    const body = FromRunBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    if (body.projectId) {
      const project = await system.kernel.getProject(body.projectId);
      if (!project || project.workspaceId !== body.workspaceId) {
        throw new KernelError(`project not found in this workspace: ${body.projectId}`, "PROJECT_NOT_FOUND");
      }
    }
    const workflow = await recorder.createDraft({
      workspaceId: body.workspaceId,
      sessionId: body.sessionId,
      runId: body.runId,
      title: body.title,
      ...(body.projectId ? { projectId: body.projectId } : {})
    });
    await audit(body.workspaceId, "workflow_record", {
      workflowId: workflow.id,
      sessionId: body.sessionId,
      runId: body.runId,
      steps: workflow.steps.length
    });
    reply.code(201);
    return workflow;
  });

  app.get("/api/workflows", async (request) => {
    const query = ListQuery.parse(request.query);
    await requireWorkspace(query.workspaceId);
    return {
      workflows: await workflows.list({
        workspaceId: query.workspaceId,
        ...(query.status ? { status: query.status } : {})
      })
    };
  });

  app.get("/api/workflows/:id", async (request) => {
    const params = IdParams.parse(request.params);
    const query = WorkspaceScoped.parse(request.query);
    await requireWorkspace(query.workspaceId);
    return requireWorkflowInWorkspace(params.id, query.workspaceId);
  });

  app.patch("/api/workflows/:id", async (request) => {
    const params = IdParams.parse(request.params);
    const body = PatchBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const workflow = await requireWorkflowInWorkspace(params.id, body.workspaceId);
    if (workflow.status === "archived") {
      throw new WorkflowError(`archived workflow cannot be edited: ${workflow.id}`, "WORKFLOW_ARCHIVED");
    }
    if (workflow.status === "published") {
      const restricted = (["title", "parameters", "steps", "failurePolicy"] as const)
        .filter((key) => body[key] !== undefined);
      if (restricted.length > 0) {
        throw new WorkflowError(
          `a published workflow only accepts description/successCriteria edits: ${restricted.join(", ")}`,
          "WORKFLOW_PUBLISHED_READONLY"
        );
      }
      const next = {
        ...workflow,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.successCriteria !== undefined ? { successCriteria: body.successCriteria } : {})
      };
      return persistEdit(next);
    }
    const steps = body.steps ?? workflow.steps;
    const parameters = body.parameters ?? workflow.parameters;
    assertWorkflowConsistent({ parameters, steps });
    const next = {
      ...workflow,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      parameters,
      steps,
      permissions: deriveWorkflowPermissions(steps),
      ...(body.successCriteria !== undefined ? { successCriteria: body.successCriteria } : {}),
      ...(body.failurePolicy !== undefined ? { failurePolicy: body.failurePolicy } : {})
    };
    return persistEdit(next);

    async function persistEdit(value: WorkflowValue): Promise<WorkflowValue> {
      const parsed = {
        ...value,
        updatedAt: new Date().toISOString(),
        revision: workflow.revision + 1
      };
      await workflows.save(parsed);
      return parsed;
    }
  });

  app.post("/api/workflows/:id/publish", async (request) => {
    const params = IdParams.parse(request.params);
    const body = WorkspaceScoped.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const workflow = await requireWorkflowInWorkspace(params.id, body.workspaceId);
    if (workflow.status !== "draft") {
      throw new WorkflowError(`only a draft workflow can be published: ${workflow.id}`, "WORKFLOW_NOT_DRAFT");
    }
    if (workflow.steps.length === 0) {
      throw new WorkflowError("a workflow without steps cannot be published", "WORKFLOW_EMPTY");
    }
    assertWorkflowConsistent(workflow);
    const published: WorkflowValue = {
      ...workflow,
      status: "published",
      updatedAt: new Date().toISOString(),
      revision: workflow.revision + 1
    };
    await workflows.save(published);
    await audit(body.workspaceId, "workflow_publish", { workflowId: workflow.id, steps: workflow.steps.length });
    return published;
  });

  app.post("/api/workflows/:id/archive", async (request) => {
    const params = IdParams.parse(request.params);
    const body = WorkspaceScoped.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const workflow = await requireWorkflowInWorkspace(params.id, body.workspaceId);
    if (workflow.status === "archived") return workflow;
    const archived: WorkflowValue = {
      ...workflow,
      status: "archived",
      updatedAt: new Date().toISOString(),
      revision: workflow.revision + 1
    };
    await workflows.save(archived);
    await audit(body.workspaceId, "workflow_archive", { workflowId: workflow.id });
    return archived;
  });

  app.post("/api/workflows/:id/runs", async (request, reply) => {
    const params = IdParams.parse(request.params);
    const body = RunCreateBody.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const run = await runner.createRun({
      workflowId: params.id,
      workspaceId: body.workspaceId,
      parameters: body.parameters,
      ...(body.approvalId ? { approvalId: body.approvalId } : {})
    });
    await audit(body.workspaceId, "workflow_run_create", {
      workflowId: params.id,
      runId: run.id,
      approvalId: body.approvalId ?? null
    });
    void runner.execute(run.id).catch(() => undefined);
    reply.code(201);
    return run;
  });

  app.get("/api/workflow-runs/:id", async (request) => {
    const params = IdParams.parse(request.params);
    const query = WorkspaceScoped.parse(request.query);
    await requireWorkspace(query.workspaceId);
    return requireRunInWorkspace(params.id, query.workspaceId);
  });

  app.post("/api/workflow-runs/:id/resume", async (request) => {
    const params = IdParams.parse(request.params);
    const body = WorkspaceScoped.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const run = await requireRunInWorkspace(params.id, body.workspaceId);
    if (run.status !== "paused") {
      throw new WorkflowError(`workflow run is not paused: ${run.id}`, "RUN_NOT_PAUSED");
    }
    await audit(body.workspaceId, "workflow_run_resume", { runId: run.id, workflowId: run.workflowId });
    void runner.resume(run.id).catch(() => undefined);
    return { ...run, status: "running" };
  });

  app.post("/api/workflow-runs/:id/cancel", async (request) => {
    const params = IdParams.parse(request.params);
    const body = WorkspaceScoped.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const run = await requireRunInWorkspace(params.id, body.workspaceId);
    const cancelled = await runner.cancel(run.id);
    await audit(body.workspaceId, "workflow_run_cancel", { runId: run.id, workflowId: run.workflowId });
    return cancelled;
  });

  app.post("/api/workflows/:id/publish-skill", async (request, reply) => {
    const params = IdParams.parse(request.params);
    const body = WorkspaceScoped.parse(request.body);
    await requireWorkspace(body.workspaceId);
    const workflow = await requireWorkflowInWorkspace(params.id, body.workspaceId);
    if (workflow.status !== "published") {
      throw new WorkflowError(`only a published workflow can become a skill: ${workflow.id}`, "WORKFLOW_NOT_PUBLISHED");
    }
    const result = publishAsSkill(workflow, system.skills, skillRunner);
    await audit(body.workspaceId, "workflow_publish_skill", {
      workflowId: workflow.id,
      skillName: result.skillName,
      alreadyRegistered: result.alreadyRegistered
    });
    reply.code(result.alreadyRegistered ? 200 : 201);
    return result;
  });
}
