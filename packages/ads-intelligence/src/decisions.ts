import { createHash, randomUUID } from "node:crypto";
import {
  AdvertisingDecision,
  type AdvertisingDecision as AdvertisingDecisionValue,
  type DecisionConfidence,
  type DecisionStatus
} from "./entities.js";
import { AdsIntelligenceError } from "./errors.js";
import type { AdvertisingDecisionStore } from "./stores.js";

/** Decision lifecycle: proposed → approved → executed → observing → terminal; proposed may also be rejected (failed). */
const ALLOWED_TRANSITIONS: Readonly<Record<DecisionStatus, readonly DecisionStatus[]>> = {
  proposed: ["approved", "failed"],
  approved: ["executed", "failed"],
  executed: ["observing"],
  observing: ["successful", "failed", "reverted"],
  successful: [],
  failed: [],
  reverted: []
};

/** Statuses in which a decision still occupies its recommendation slot. */
const OPEN_STATUSES: readonly DecisionStatus[] = ["proposed", "approved", "observing"];

export function isOpenDecisionStatus(status: DecisionStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/** Stable content hash used to suppress duplicate recommendations. */
export function hashRecommendation(recommendation: string): string {
  return createHash("sha256").update(recommendation, "utf8").digest("hex");
}

export type CreateDecisionInput = {
  projectId: string;
  campaignId?: string;
  recommendation: string;
  rationale?: string[];
  evidenceIds?: string[];
  confidence: DecisionConfidence;
  risks?: string[];
  observationWindow?: string;
  rollbackPlan?: string;
};

/**
 * Injected kernel query — the service never touches the kernel file system
 * directly; the host wires this to `KernelService.getProject`.
 */
export type ProjectExistsQuery = (projectId: string) => Promise<boolean>;

export class DecisionService {
  constructor(
    private readonly store: AdvertisingDecisionStore,
    private readonly projectExists: ProjectExistsQuery,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async createDecision(input: CreateDecisionInput): Promise<AdvertisingDecisionValue> {
    if (!(await this.projectExists(input.projectId))) {
      throw new AdsIntelligenceError(`project not found: ${input.projectId}`, "PROJECT_NOT_FOUND");
    }
    const now = this.clock().toISOString();
    const decision = AdvertisingDecision.parse({
      id: randomUUID(),
      projectId: input.projectId,
      ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
      recommendation: input.recommendation,
      rationale: input.rationale ?? [],
      evidenceIds: input.evidenceIds ?? [],
      confidence: input.confidence,
      risks: input.risks ?? [],
      ...(input.observationWindow !== undefined ? { observationWindow: input.observationWindow } : {}),
      ...(input.rollbackPlan !== undefined ? { rollbackPlan: input.rollbackPlan } : {}),
      status: "proposed",
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    await this.store.save(decision);
    return decision;
  }

  async transitionStatus(id: string, status: DecisionStatus): Promise<AdvertisingDecisionValue> {
    const current = await this.store.get(id);
    if (!current) {
      throw new AdsIntelligenceError(`decision not found: ${id}`, "DECISION_NOT_FOUND");
    }
    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed.includes(status)) {
      throw new AdsIntelligenceError(
        `illegal decision transition: ${current.status} → ${status}`,
        "DECISION_INVALID_TRANSITION"
      );
    }
    const next = AdvertisingDecision.parse({
      ...current,
      status,
      updatedAt: this.clock().toISOString(),
      revision: current.revision + 1
    });
    await this.store.save(next);
    return next;
  }

  async getDecision(id: string): Promise<AdvertisingDecisionValue | undefined> {
    return this.store.get(id);
  }

  async listByProject(projectId: string): Promise<AdvertisingDecisionValue[]> {
    return this.store.list({ projectId });
  }

  async listByStatus(status: DecisionStatus): Promise<AdvertisingDecisionValue[]> {
    return this.store.list({ status });
  }

  /**
   * Duplicate-recommendation suppression: returns an existing open decision
   * (proposed/approved/observing) for the same project + campaign +
   * sha256(recommendation), so the caller can reject a duplicate proposal.
   */
  async findSimilarOpen(
    projectId: string,
    campaignId: string | undefined,
    recommendationHash: string
  ): Promise<AdvertisingDecisionValue | undefined> {
    const candidates = await this.store.list({ projectId });
    return candidates.find((candidate) =>
      candidate.campaignId === campaignId
      && isOpenDecisionStatus(candidate.status)
      && hashRecommendation(candidate.recommendation) === recommendationHash
    );
  }
}
