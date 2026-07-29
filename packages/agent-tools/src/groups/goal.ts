import { z } from "zod";
import { Goal as GoalSchema } from "@adpilot/kernel";
import type { AgentToolDefinition } from "../registry.js";
import { kernelStores } from "../kernel-internal.js";
import { succeed } from "../result.js";
import { toolError } from "../errors.js";

const GoalIdParams = z.object({ goalId: z.string().min(1) });

/** Goal tools: create/read/update the goal record and drive its status and progress. */
export function createGoalTools(): AgentToolDefinition[] {
  return [
    {
      name: "goal.create",
      description: "Create a draft goal under a project with title, objective, and optional success criteria, constraints and verification plan. Use to turn a user objective into a trackable goal.",
      capabilityPack: "goal",
      permission: "write",
      parameters: z.object({
        projectId: z.string().min(1).optional(),
        title: z.string().min(1),
        objective: z.string().min(1),
        successCriteria: z.array(z.string().min(1)).optional(),
        constraints: z.array(z.string().min(1)).optional(),
        verificationPlan: z.array(z.string().min(1)).optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({
          projectId: z.string().min(1).optional(),
          title: z.string().min(1),
          objective: z.string().min(1),
          successCriteria: z.array(z.string().min(1)).optional(),
          constraints: z.array(z.string().min(1)).optional(),
          verificationPlan: z.array(z.string().min(1)).optional()
        }).parse(raw);
        const projectId = params.projectId ?? ctx.projectId;
        if (!projectId) {
          throw toolError("PROJECT_NOT_SELECTED", "no projectId was passed and the execution context has no current project");
        }
        const goal = await deps.kernel.createGoal({
          projectId,
          title: params.title,
          objective: params.objective,
          ...(params.successCriteria !== undefined ? { successCriteria: params.successCriteria } : {}),
          ...(params.constraints !== undefined ? { constraints: params.constraints } : {}),
          ...(params.verificationPlan !== undefined ? { verificationPlan: params.verificationPlan } : {})
        });
        return succeed("goal.create", ctx, { goal });
      }
    },
    {
      name: "goal.get",
      description: "Read one goal by id. Use to check its objective, criteria, progress, and status before updating it.",
      capabilityPack: "goal",
      permission: "read",
      parameters: GoalIdParams,
      execute: async (raw, ctx, deps) => {
        const params = GoalIdParams.parse(raw);
        const goal = await deps.kernel.getGoal(params.goalId);
        if (!goal) throw toolError("GOAL_NOT_FOUND", `goal not found: ${params.goalId}`);
        return succeed("goal.get", ctx, { goal });
      }
    },
    {
      name: "goal.update",
      description: "Partially update a goal's title, objective, success criteria, constraints, or verification plan. Only the passed fields change.",
      capabilityPack: "goal",
      permission: "write",
      parameters: GoalIdParams.extend({
        title: z.string().min(1).optional(),
        objective: z.string().min(1).optional(),
        successCriteria: z.array(z.string().min(1)).optional(),
        constraints: z.array(z.string().min(1)).optional(),
        verificationPlan: z.array(z.string().min(1)).optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = GoalIdParams.extend({
          title: z.string().min(1).optional(),
          objective: z.string().min(1).optional(),
          successCriteria: z.array(z.string().min(1)).optional(),
          constraints: z.array(z.string().min(1)).optional(),
          verificationPlan: z.array(z.string().min(1)).optional()
        }).parse(raw);
        const store = kernelStores(deps.kernel).goals;
        const goal = await store.get(params.goalId);
        if (!goal) throw toolError("GOAL_NOT_FOUND", `goal not found: ${params.goalId}`);
        // KernelService has no field update; the store layer applies the patch with the same revision discipline.
        const next = GoalSchema.parse({
          ...goal,
          ...(params.title !== undefined ? { title: params.title } : {}),
          ...(params.objective !== undefined ? { objective: params.objective } : {}),
          ...(params.successCriteria !== undefined ? { successCriteria: params.successCriteria } : {}),
          ...(params.constraints !== undefined ? { constraints: params.constraints } : {}),
          ...(params.verificationPlan !== undefined ? { verificationPlan: params.verificationPlan } : {}),
          updatedAt: deps.now().toISOString(),
          revision: goal.revision + 1
        });
        await store.save(next);
        return succeed("goal.update", ctx, { goal: next });
      }
    },
    {
      name: "goal.set_progress",
      description: "Set a goal's progress as a 0..1 fraction (clamped). Use after completing a meaningful slice of the goal's tasks.",
      capabilityPack: "goal",
      permission: "write",
      parameters: GoalIdParams.extend({ progress: z.number().min(0).max(1) }),
      execute: async (raw, ctx, deps) => {
        const params = GoalIdParams.extend({ progress: z.number().min(0).max(1) }).parse(raw);
        const goal = await deps.kernel.updateGoalProgress(params.goalId, params.progress);
        return succeed("goal.set_progress", ctx, { goal });
      }
    },
    {
      name: "goal.complete",
      description: "Mark a goal completed. Use only when its success criteria are demonstrably met.",
      capabilityPack: "goal",
      permission: "write",
      parameters: GoalIdParams,
      execute: async (raw, ctx, deps) => {
        const params = GoalIdParams.parse(raw);
        const goal = await deps.kernel.updateGoalStatus(params.goalId, "completed");
        return succeed("goal.complete", ctx, { goal });
      }
    },
    {
      name: "goal.block",
      description: "Mark a goal blocked. Use when work cannot proceed without the user or an external dependency; say why in the reply.",
      capabilityPack: "goal",
      permission: "write",
      parameters: GoalIdParams,
      execute: async (raw, ctx, deps) => {
        const params = GoalIdParams.parse(raw);
        const goal = await deps.kernel.updateGoalStatus(params.goalId, "blocked");
        return succeed("goal.block", ctx, { goal });
      }
    }
  ];
}
