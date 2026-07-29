import { z } from "zod";
import type { SkillDefinition, SkillRegistry } from "@adpilot/skills";
import {
  WorkflowRunStatus,
  type Workflow as WorkflowValue
} from "./model.js";

export const WorkflowSkillInput = z
  .object({
    /** The workflow this skill replays; part of the trigger payload. */
    workflowId: z.string().uuid(),
    workspaceId: z.string().min(1).max(256),
    parameters: z.record(z.string().max(16_384)).default({}),
    approvalId: z.string().uuid().optional()
  })
  .strict();
export type WorkflowSkillInput = z.infer<typeof WorkflowSkillInput>;

export const WorkflowSkillOutput = z
  .object({
    runId: z.string().uuid(),
    workflowId: z.string().uuid(),
    status: WorkflowRunStatus
  })
  .strict();
export type WorkflowSkillOutput = z.infer<typeof WorkflowSkillOutput>;

export interface WorkflowSkillRunner {
  runWorkflow(input: {
    workflowId: string;
    workspaceId: string;
    parameters: Record<string, string>;
    approvalId?: string;
  }): Promise<{ runId: string; status: z.infer<typeof WorkflowRunStatus> }>;
}

export interface PublishSkillResult {
  skillName: string;
  alreadyRegistered: boolean;
}

/** Deterministic skill name for one workflow: slugified title plus a short id suffix. */
export function workflowSkillName(workflow: WorkflowValue): string {
  const slug = workflow.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workflow";
  return `workflow-${slug}-${workflow.id.slice(0, 8)}`;
}

/**
 * Registers one published workflow as an executable Skill: the description
 * and step summary advertise it, and the skill's input payload carries the
 * workflowId so a trigger always resolves back to the exact workflow.
 * Registering twice is idempotent and reports `alreadyRegistered`.
 */
export function publishAsSkill(
  workflowInput: WorkflowValue,
  registry: SkillRegistry,
  runner: WorkflowSkillRunner
): PublishSkillResult {
  const skillName = workflowSkillName(workflowInput);
  if (registry.list().some((skill) => skill.name === skillName)) {
    return { skillName, alreadyRegistered: true };
  }
  const workflowId = workflowInput.id;
  const stepSummary = workflowInput.steps
    .map((step) => `${step.order}. ${step.title}`)
    .join("; ");
  const definition: SkillDefinition<z.input<typeof WorkflowSkillInput>, z.output<typeof WorkflowSkillOutput>> = {
    name: skillName,
    description: [
      `Replay the recorded Computer Use workflow "${workflowInput.title}".`,
      workflowInput.description || undefined,
      workflowInput.steps.length ? `Steps: ${stepSummary}.` : undefined
    ].filter((part): part is string => typeof part === "string").join(" "),
    input: WorkflowSkillInput,
    output: WorkflowSkillOutput,
    prerequisites: [
      "The workflow is published",
      "A live execution surface (managed browser window) is available for replay",
      ...(workflowInput.permissions.requiresApproval ? ["An approval id for the mutation steps"] : [])
    ],
    requiredTools: [],
    failureConditions: [
      "A step fails or its expected result does not verify",
      "The window or session identity changes during replay"
    ],
    forbidden: [
      "Replaying on a different window or account than the recorded demonstration",
      "Skipping mutation approval"
    ],
    execute: async (_context, raw) => {
      const input = WorkflowSkillInput.parse(raw);
      if (input.workflowId !== workflowId) {
        throw new Error(`skill ${skillName} is bound to workflow ${workflowId}, not ${input.workflowId}`);
      }
      const run = await runner.runWorkflow({
        workflowId: input.workflowId,
        workspaceId: input.workspaceId,
        parameters: input.parameters,
        ...(input.approvalId ? { approvalId: input.approvalId } : {})
      });
      return WorkflowSkillOutput.parse({ runId: run.runId, workflowId: input.workflowId, status: run.status });
    }
  };
  registry.register(definition as SkillDefinition<unknown, unknown>);
  return { skillName, alreadyRegistered: false };
}
