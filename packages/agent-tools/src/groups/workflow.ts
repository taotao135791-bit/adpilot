import { z } from "zod";
import type { AgentToolDefinition } from "../registry.js";
import { succeed } from "../result.js";
import { toolError } from "../errors.js";

/**
 * Workflow tools: list/get published Record & Replay workflows and run them
 * through the real WorkflowRunner. workflow.run stays visible in read-only
 * contexts so it can refuse explicitly: a workflow with mutation steps
 * requires the write permission, and the runner itself enforces approvals.
 */
export function createWorkflowTools(): AgentToolDefinition[] {
  return [
    {
      name: "workflow.list",
      description: "List the workspace's workflows, optionally filtered by status (draft/published/archived). Use to discover reusable recorded workflows.",
      capabilityPack: "workflow",
      permission: "read",
      parameters: z.object({ status: z.enum(["draft", "published", "archived"]).optional() }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({ status: z.enum(["draft", "published", "archived"]).optional() }).parse(raw);
        const workflows = await deps.workflows.store.list({
          workspaceId: ctx.workspaceId,
          ...(params.status !== undefined ? { status: params.status } : {})
        });
        return succeed("workflow.list", ctx, { workflows, count: workflows.length });
      }
    },
    {
      name: "workflow.get",
      description: "Read one workflow: steps, parameters, permissions, and failure policy. Use before running it to know which parameters to pass.",
      capabilityPack: "workflow",
      permission: "read",
      parameters: z.object({ workflowId: z.string().min(1) }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({ workflowId: z.string().min(1) }).parse(raw);
        const workflow = await deps.workflows.store.get(params.workflowId);
        if (!workflow || workflow.workspaceId !== ctx.workspaceId) {
          throw toolError("WORKFLOW_NOT_FOUND", `workflow not found in this workspace: ${params.workflowId}`);
        }
        return succeed("workflow.get", ctx, { workflow });
      }
    },
    {
      name: "workflow.run",
      description: "Run a published workflow with its declared parameters and get the finished run record (per-step outcomes and evidence ids). Workflows with mutation steps need the write permission and an approvalId.",
      capabilityPack: "workflow",
      permission: "read",
      parameters: z.object({
        workflowId: z.string().min(1),
        parameters: z.record(z.string(), z.string()).optional(),
        approvalId: z.string().uuid().optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({
          workflowId: z.string().min(1),
          parameters: z.record(z.string(), z.string()).optional(),
          approvalId: z.string().uuid().optional()
        }).parse(raw);
        const workflow = await deps.workflows.store.get(params.workflowId);
        if (!workflow || workflow.workspaceId !== ctx.workspaceId) {
          throw toolError("WORKFLOW_NOT_FOUND", `workflow not found in this workspace: ${params.workflowId}`);
        }
        if (workflow.permissions.requiresMutation && !ctx.permissions.write) {
          throw toolError(
            "PERMISSION_DENIED",
            `workflow ${params.workflowId} has mutation steps and this context lacks the write permission; ask the user to grant it or run the workflow manually`
          );
        }
        const created = await deps.workflows.runner.createRun({
          workflowId: workflow.id,
          workspaceId: ctx.workspaceId,
          parameters: params.parameters ?? {},
          ...(params.approvalId !== undefined ? { approvalId: params.approvalId } : {})
        });
        const run = await deps.workflows.runner.execute(created.id);
        return succeed("workflow.run", ctx, { run }, { evidenceIds: run.evidenceIds });
      }
    }
  ];
}
