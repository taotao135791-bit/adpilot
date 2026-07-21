import { z } from "zod";
import { WorkspaceStore } from "@adpilot/workspace";

export const Experiment = z.object({
  id: z.string().uuid(),
  clientId: z.string().min(1),
  taskId: z.string().uuid(),
  approvalId: z.string().uuid(),
  hypothesis: z.string().min(1),
  variable: z.string().min(1),
  baseline: z.record(z.number()),
  expected: z.string().min(1),
  successCriteria: z.string().min(1),
  failureCriteria: z.string().min(1),
  maturityWindowDays: z.number().int().positive(),
  rollbackCondition: z.string().min(1),
  reviewAt: z.string().datetime(),
  status: z.enum(["draft", "active", "waiting", "won", "lost", "inconclusive", "stopped", "invalidated"]),
  finalConclusion: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type Experiment = z.infer<typeof Experiment>;

export class ExperimentStore {
  constructor(private readonly workspace: WorkspaceStore) {}

  async create(input: Omit<Experiment, "id" | "status" | "finalConclusion" | "startedAt" | "completedAt" | "createdAt" | "updatedAt">): Promise<Experiment> {
    const active = (await this.list(input.clientId)).filter((item) => ["active", "waiting"].includes(item.status));
    if (active.length > 0) throw new Error("single-variable principle blocks a second unfinished experiment");
    const now = new Date().toISOString();
    const experiment = Experiment.parse({
      ...input, id: crypto.randomUUID(), status: "draft", finalConclusion: null,
      startedAt: null, completedAt: null, createdAt: now, updatedAt: now
    });
    await this.persist(experiment);
    return experiment;
  }

  async start(clientId: string, id: string): Promise<Experiment> {
    const current = await this.get(clientId, id);
    if (current.status !== "draft") throw new Error("only a draft experiment can start");
    return this.update(current, { status: "active", startedAt: new Date().toISOString() });
  }

  async conclude(clientId: string, id: string, outcome: "won" | "lost" | "inconclusive" | "stopped" | "invalidated", conclusion: string): Promise<Experiment> {
    const current = await this.get(clientId, id);
    if (!current.startedAt || !["active", "waiting"].includes(current.status)) throw new Error("experiment is not active");
    const now = new Date().toISOString();
    return this.update(current, { status: outcome, finalConclusion: conclusion, completedAt: now, updatedAt: now });
  }

  get(clientId: string, id: string): Promise<Experiment> {
    return this.workspace.readJson(clientId, `experiments/${id}.json`, Experiment);
  }

  async list(clientId: string): Promise<Experiment[]> {
    const index = await this.workspace.readJsonl(clientId, "experiments/index.jsonl", z.object({ id: z.string().uuid() }));
    return Promise.all(index.map(({ id }) => this.get(clientId, id)));
  }

  private async persist(experiment: Experiment): Promise<void> {
    await this.workspace.writeJson(experiment.clientId, `experiments/${experiment.id}.json`, experiment);
    const index = await this.workspace.readJsonl(experiment.clientId, "experiments/index.jsonl", z.object({ id: z.string().uuid() }));
    if (!index.some(({ id }) => id === experiment.id)) await this.workspace.appendJsonl(experiment.clientId, "experiments/index.jsonl", { id: experiment.id });
  }

  private async update(current: Experiment, patch: Partial<Experiment>): Promise<Experiment> {
    const next = Experiment.parse({ ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() });
    await this.persist(next);
    return next;
  }
}
