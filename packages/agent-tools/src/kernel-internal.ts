import type { KernelService, KernelStores, TaskNode } from "@adpilot/kernel";
import { TaskNode as TaskNodeSchema } from "@adpilot/kernel";
import type { AutomationScheduler, AutomationSchedulerDeps } from "@adpilot/automations";

/**
 * Store-layer access seams.
 *
 * KernelService and AutomationScheduler deliberately expose only their
 * cross-entity facades; several agent tools need single-entity updates those
 * facades do not offer (goal field updates, task status transitions beyond
 * completion, automation create/pause). The release discipline forbids
 * changing those packages' APIs, so agent-tools reaches their injected
 * stores — the same stores the composition root constructed them with —
 * through the private field. Every write still goes through the entity zod
 * schema and bumps `revision`, mirroring the services' own discipline.
 */
export function kernelStores(kernel: KernelService): KernelStores {
  const stores = (kernel as unknown as { stores?: KernelStores }).stores;
  if (!stores) {
    throw new Error("kernel service was not constructed with entity stores");
  }
  return stores;
}

export function automationSchedulerDeps(scheduler: AutomationScheduler): AutomationSchedulerDeps {
  const deps = (scheduler as unknown as { deps?: AutomationSchedulerDeps }).deps;
  if (!deps) {
    throw new Error("automation scheduler was not constructed with its deps");
  }
  return deps;
}

/**
 * Single-task update through the kernel task store: read, patch, re-parse,
 * bump revision, save. Returns the persisted task.
 */
export async function updateKernelTask(
  kernel: KernelService,
  taskId: string,
  now: Date,
  patch: (task: TaskNode) => Partial<TaskNode>
): Promise<TaskNode> {
  const store = kernelStores(kernel).tasks;
  const current = await store.get(taskId);
  if (!current) {
    const error = new Error(`task not found: ${taskId}`);
    (error as { code?: string }).code = "TASK_NOT_FOUND";
    throw error;
  }
  const next = TaskNodeSchema.parse({
    ...current,
    ...patch(current),
    id: current.id,
    updatedAt: now.toISOString(),
    revision: current.revision + 1
  });
  await store.save(next);
  return next;
}
