import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Automation,
  AutomationAction,
  AutomationTrigger,
  nextFireAt,
  type Automation as AutomationValue
} from "@adpilot/automations";
import type { AgentToolDefinition } from "../registry.js";
import type { AgentToolDeps } from "../deps.js";
import { automationSchedulerDeps } from "../kernel-internal.js";
import { succeed } from "../result.js";
import { toolError } from "../errors.js";

const IdParams = z.object({ automationId: z.string().min(1) });

const CreateParams = z.object({
  title: z.string().min(1).max(256),
  description: z.string().max(4000).optional(),
  projectId: z.string().uuid().optional(),
  trigger: AutomationTrigger,
  action: AutomationAction,
  maxRunsPerDay: z.number().int().min(1).max(1000).optional(),
  idempotencyWindowSeconds: z.number().int().min(1).max(31_536_000).optional()
});

/**
 * Automation tools: create, list, pause/resume, run now, and inspect runs.
 * Only the three sanctioned action kinds exist (daily-brief, create-task,
 * notify) — the AutomationAction schema enforces that. Creating and state
 * changes go through the automation store (the scheduler owns run dispatch;
 * it has no entity-CRUD surface), runs go through the real scheduler.
 */
export function createAutomationTools(): AgentToolDefinition[] {
  return [
    {
      name: "automation.create",
      description: "Create an active automation: a schedule (5-field UTC cron) or event trigger plus one action — daily-brief, create-task, or notify. Mutation actions are approval-gated by the built-in guard.",
      capabilityPack: "automation",
      permission: "write",
      parameters: CreateParams,
      execute: async (raw, ctx, deps) => {
        const params = CreateParams.parse(raw);
        const fireAt = params.trigger.kind === "schedule" ? nextFireAt(params.trigger.cron, deps.now()) : undefined;
        if (params.trigger.kind === "schedule" && !fireAt) {
          throw toolError("INVALID", "the cron schedule selects no future fire time");
        }
        const now = deps.now().toISOString();
        const automation = Automation.parse({
          id: randomUUID(),
          workspaceId: ctx.workspaceId,
          ...(params.projectId !== undefined ? { projectId: params.projectId } : {}),
          title: params.title,
          ...(params.description !== undefined ? { description: params.description } : {}),
          trigger: params.trigger,
          action: params.action,
          guards: {
            maxRunsPerDay: params.maxRunsPerDay ?? 10,
            requiresApprovalForMutation: true
          },
          state: "active",
          idempotencyWindowSeconds: params.idempotencyWindowSeconds ?? 3_600,
          ...(fireAt ? { nextFireAt: fireAt.toISOString() } : {}),
          runCount: 0,
          createdAt: now,
          updatedAt: now,
          revision: 1
        });
        await automationSchedulerDeps(deps.automations).automations.save(automation);
        return succeed("automation.create", ctx, { automation });
      }
    },
    {
      name: "automation.list",
      description: "List the workspace's automations, optionally filtered by state (active/paused) or project.",
      capabilityPack: "automation",
      permission: "read",
      parameters: z.object({
        state: z.enum(["active", "paused"]).optional(),
        projectId: z.string().uuid().optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({
          state: z.enum(["active", "paused"]).optional(),
          projectId: z.string().uuid().optional()
        }).parse(raw);
        const automations = await automationSchedulerDeps(deps.automations).automations.list({
          workspaceId: ctx.workspaceId,
          ...(params.state !== undefined ? { state: params.state } : {}),
          ...(params.projectId !== undefined ? { projectId: params.projectId } : {})
        });
        return succeed("automation.list", ctx, { automations, count: automations.length });
      }
    },
    {
      name: "automation.pause",
      description: "Pause an active automation; its schedule stops firing until resumed.",
      capabilityPack: "automation",
      permission: "write",
      parameters: IdParams,
      execute: async (raw, ctx, deps) => {
        const params = IdParams.parse(raw);
        const automation = await transition(params.automationId, "paused", deps);
        return succeed("automation.pause", ctx, { automation });
      }
    },
    {
      name: "automation.resume",
      description: "Resume a paused automation; schedule triggers get their next fire time recomputed from now.",
      capabilityPack: "automation",
      permission: "write",
      parameters: IdParams,
      execute: async (raw, ctx, deps) => {
        const params = IdParams.parse(raw);
        const automation = await transition(params.automationId, "active", deps);
        return succeed("automation.resume", ctx, { automation });
      }
    },
    {
      name: "automation.run_now",
      description: "Force an immediate run of an automation through the real scheduler — idempotency, daily run/cost caps, and the mutation approval gate all apply. Returns the run record.",
      capabilityPack: "automation",
      permission: "write",
      parameters: IdParams,
      execute: async (raw, ctx, deps) => {
        const params = IdParams.parse(raw);
        const run = await deps.automations.runNow(params.automationId);
        return succeed("automation.run_now", ctx, { run });
      }
    },
    {
      name: "automation.get_runs",
      description: "List an automation's runs, optionally filtered by status (running/succeeded/failed/skipped-duplicate/waiting-approval). Use to verify what an automation actually did.",
      capabilityPack: "automation",
      permission: "read",
      parameters: IdParams.extend({
        status: z.enum(["running", "succeeded", "failed", "skipped-duplicate", "waiting-approval"]).optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = IdParams.extend({
          status: z.enum(["running", "succeeded", "failed", "skipped-duplicate", "waiting-approval"]).optional()
        }).parse(raw);
        const runs = await automationSchedulerDeps(deps.automations).runs.list({
          automationId: params.automationId,
          ...(params.status !== undefined ? { status: params.status } : {})
        });
        return succeed("automation.get_runs", ctx, { runs, count: runs.length });
      }
    }
  ];
}

async function transition(
  automationId: string,
  state: "active" | "paused",
  deps: AgentToolDeps
): Promise<AutomationValue> {
  const store = automationSchedulerDeps(deps.automations).automations;
  const automation = await store.get(automationId);
  if (!automation) throw toolError("AUTOMATION_NOT_FOUND", `automation not found: ${automationId}`);
  if (automation.state === state) return automation;
  const nextFire = state === "active" && automation.trigger.kind === "schedule"
    ? nextFireAt(automation.trigger.cron, deps.now())
    : undefined;
  const next = Automation.parse({
    ...automation,
    state,
    nextFireAt: state === "active" ? nextFire?.toISOString() : automation.nextFireAt,
    updatedAt: deps.now().toISOString(),
    revision: automation.revision + 1
  });
  await store.save(next);
  return next;
}
