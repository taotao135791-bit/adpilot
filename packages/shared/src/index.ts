import { z } from "zod";

export const PermissionLevel = z.enum(["OBSERVE", "INTERACT", "MUTATE", "DESTRUCTIVE"]);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export const RiskLevel = z.enum(["observe", "interact", "mutate", "destructive"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const Platform = z.enum([
  "google_ads",
  "meta_ads",
  "tiktok_ads",
  "apple_ads",
  "microsoft_ads",
  "amazon_ads",
  "linkedin_ads",
  "youtube_ads",
  "other"
]);
export type Platform = z.infer<typeof Platform>;

export const Evidence = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  observedAt: z.string().datetime(),
  kind: z.enum(["screenshot", "export", "workspace", "calculation", "user", "system"]),
  summary: z.string().min(1),
  uri: z.string().optional(),
  facts: z.record(z.unknown()).default({})
});
export type Evidence = z.infer<typeof Evidence>;

export const TaskPhase = z.enum([
  "intake",
  "investigating",
  "analyzing",
  "reviewing_risk",
  "awaiting_approval",
  "executing",
  "verifying",
  "monitoring",
  "completed",
  "blocked",
  "cancelled"
]);

export const SpecialistRole = z.enum([
  "account_operator",
  "performance_analyst",
  "media_buyer",
  "measurement_reviewer",
  "creative_strategist",
  "risk_reviewer",
  "reporting_analyst"
]);
export type SpecialistRole = z.infer<typeof SpecialistRole>;

/** The only states accepted by the production fact pipeline. */
export const SharedFactStatus = z.enum([
  "hypothesis",
  "observed",
  "verified",
  "rejected",
  "stale",
  "superseded"
]);
export type SharedFactStatus = z.infer<typeof SharedFactStatus>;

export const EvidenceBoundingBox = z.tuple([
  z.number().finite().nonnegative(),
  z.number().finite().nonnegative(),
  z.number().finite().positive(),
  z.number().finite().positive()
]);
export type EvidenceBoundingBox = z.infer<typeof EvidenceBoundingBox>;

export const SharedFactSourceType = z.enum([
  "visual_table",
  "visual_verification",
  "specialist_output",
  "calculation",
  "workspace",
  "user",
  "system",
  "migration"
]);
export type SharedFactSourceType = z.infer<typeof SharedFactSourceType>;

export const SharedFactPayload = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.unknown())
]);
export type SharedFactPayload = z.infer<typeof SharedFactPayload>;

/**
 * Canonical, evidence-bearing fact exchanged by the root agent and specialists.
 * Legacy snake_case records are deliberately not accepted here; callers must
 * use `migrateLegacyFactDispatch`, whose output remains production-ineligible.
 */
export const SharedFact = z.object({
  factId: z.string().min(1),
  clientId: z.string().min(1),
  taskId: z.string().uuid(),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  value: SharedFactPayload,
  unit: z.string(),
  sourceType: SharedFactSourceType,
  sourceScreenshotId: z.string().min(1).nullable(),
  sourceBoundingBox: EvidenceBoundingBox.nullable(),
  evidenceIds: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1),
  status: SharedFactStatus,
  createdBy: z.string().min(1),
  verifiedBy: z.array(z.string().min(1)),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  verifiedAt: z.string().datetime().nullable().default(null),
  expiresAt: z.string().datetime().nullable(),
  statusReason: z.string().min(1).nullable().default(null),
  supersededByFactId: z.string().min(1).nullable().default(null),
  derivedFromFactId: z.string().min(1).nullable().default(null)
}).superRefine((fact, context) => {
  if (fact.status === "verified" && fact.verifiedBy.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verifiedBy"],
      message: "verified facts require at least one verifier"
    });
  }
  if (fact.status === "verified" && fact.confidence < 0.85) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["confidence"],
      message: "verified facts require confidence of at least 0.85"
    });
  }
  if ((fact.sourceType === "visual_table" || fact.sourceType === "visual_verification")
    && (!fact.sourceScreenshotId || !fact.sourceBoundingBox)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceScreenshotId"],
      message: "visual facts require screenshot and bounding-box evidence"
    });
  }
  if ((fact.sourceType === "visual_table" || fact.sourceType === "visual_verification")
    && fact.sourceScreenshotId
    && !fact.evidenceIds.includes(`screenshot:${fact.sourceScreenshotId}`)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceIds"],
      message: "visual facts must link their source screenshot as evidence"
    });
  }
  if (fact.status === "superseded" && !fact.supersededByFactId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supersededByFactId"],
      message: "superseded facts require the replacement fact id"
    });
  }
});
export type SharedFact = z.infer<typeof SharedFact>;

export type SharedFactDraft = Omit<SharedFact,
  "factId" | "status" | "verifiedBy" | "createdAt" | "updatedAt" | "verifiedAt" |
  "statusReason" | "supersededByFactId" | "derivedFromFactId"
> & {
  factId?: string;
  status?: "hypothesis" | "observed";
  createdAt?: string;
  derivedFromFactId?: string | null;
};

export interface SharedFactRepository {
  load(clientId: string): Promise<SharedFact[]>;
  save(clientId: string, facts: readonly SharedFact[]): Promise<void>;
}

export class InMemorySharedFactRepository implements SharedFactRepository {
  private readonly facts = new Map<string, SharedFact[]>();

  async load(clientId: string): Promise<SharedFact[]> {
    return structuredClone(this.facts.get(clientId) ?? []);
  }

  async save(clientId: string, facts: readonly SharedFact[]): Promise<void> {
    this.facts.set(clientId, structuredClone([...facts]));
  }
}

export interface SharedFactQuery {
  taskId?: string;
  includeTerminal?: boolean;
  now?: Date;
}

export interface SharedFactVerification {
  verifier: string;
  confidence: number;
  at?: string;
}

export interface VisualFactInvalidation {
  reason: string;
  taskId?: string;
  sourceScreenshotIds?: readonly string[];
}

/**
 * Serialized lifecycle manager for Shared Facts. Verification is the only
 * transition that makes a fact available to production specialists.
 */
export class SharedFactLedger {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: SharedFactRepository = new InMemorySharedFactRepository(),
    private readonly clock: Clock = systemClock
  ) {}

  async observe(draft: SharedFactDraft): Promise<SharedFact> {
    return this.create({ ...draft, status: "observed" });
  }

  async create(draft: SharedFactDraft & { status: "hypothesis" | "observed" }): Promise<SharedFact> {
    return this.mutate(draft.clientId, (facts) => {
      const now = draft.createdAt ?? this.clock.now().toISOString();
      const fact = SharedFact.parse({
        ...draft,
        factId: draft.factId ?? crypto.randomUUID(),
        status: draft.status,
        verifiedBy: [],
        createdAt: now,
        updatedAt: now,
        verifiedAt: null,
        statusReason: null,
        supersededByFactId: null,
        derivedFromFactId: draft.derivedFromFactId ?? null
      });
      if (facts.some((candidate) => candidate.factId === fact.factId)) {
        throw new Error(`duplicate shared fact: ${fact.factId}`);
      }
      facts.push(fact);
      return fact;
    });
  }

  async verify(clientId: string, factId: string, verification: SharedFactVerification): Promise<SharedFact> {
    return this.mutate(clientId, (facts) => {
      const index = findFactIndex(facts, factId);
      const current = facts[index]!;
      if (current.sourceType === "migration") throw new Error("migrated facts cannot enter the production pipeline");
      if (current.status !== "observed") throw new Error(`cannot verify fact in ${current.status} state`);
      if (verification.confidence < 0.85) throw new Error("fact verification confidence is below 0.85");
      const now = verification.at ?? this.clock.now().toISOString();
      const replacement = SharedFact.parse({
        ...current,
        confidence: Math.min(current.confidence, verification.confidence),
        status: "verified",
        verifiedBy: [...new Set([...current.verifiedBy, verification.verifier])],
        verifiedAt: now,
        updatedAt: now,
        statusReason: null
      });
      facts[index] = replacement;
      for (let candidateIndex = 0; candidateIndex < facts.length; candidateIndex += 1) {
        const candidate = facts[candidateIndex]!;
        if (candidate.factId === replacement.factId || candidate.status !== "verified") continue;
        if (sameFactSlot(candidate, replacement)) {
          facts[candidateIndex] = SharedFact.parse({
            ...candidate,
            status: "superseded",
            supersededByFactId: replacement.factId,
            statusReason: "replaced by a newer verified observation",
            updatedAt: now
          });
        }
      }
      return replacement;
    });
  }

  async markStale(clientId: string, factId: string, reason: string): Promise<SharedFact> {
    return this.transitionTerminal(clientId, factId, "stale", reason);
  }

  async reject(clientId: string, factId: string, reason: string): Promise<SharedFact> {
    return this.transitionTerminal(clientId, factId, "rejected", reason);
  }

  /** Called by surface/page-change handlers to invalidate screenshot-derived data in one atomic write. */
  async invalidateVisualEvidence(clientId: string, invalidation: VisualFactInvalidation): Promise<SharedFact[]> {
    return this.mutate(clientId, (facts) => {
      const screenshotIds = invalidation.sourceScreenshotIds ? new Set(invalidation.sourceScreenshotIds) : undefined;
      const now = this.clock.now().toISOString();
      const invalidated: SharedFact[] = [];
      for (let index = 0; index < facts.length; index += 1) {
        const fact = facts[index]!;
        if (fact.sourceType !== "visual_table" && fact.sourceType !== "visual_verification") continue;
        if (invalidation.taskId && fact.taskId !== invalidation.taskId) continue;
        if (screenshotIds && (!fact.sourceScreenshotId || !screenshotIds.has(fact.sourceScreenshotId))) continue;
        if (fact.status !== "observed" && fact.status !== "verified") continue;
        const next = SharedFact.parse({
          ...fact,
          status: "stale",
          statusReason: z.string().min(1).parse(invalidation.reason),
          updatedAt: now
        });
        facts[index] = next;
        invalidated.push(next);
      }
      return invalidated;
    });
  }

  async supersede(clientId: string, factId: string, replacementFactId: string): Promise<SharedFact> {
    return this.mutate(clientId, (facts) => {
      const index = findFactIndex(facts, factId);
      const replacementIndex = findFactIndex(facts, replacementFactId);
      const current = facts[index]!;
      const replacement = facts[replacementIndex]!;
      if (!sameFactSlot(current, replacement)) throw new Error("replacement fact must address the same subject and predicate");
      if (replacement.status !== "verified") throw new Error("replacement fact must be verified before superseding production data");
      const next = SharedFact.parse({
        ...current,
        status: "superseded",
        supersededByFactId: replacement.factId,
        statusReason: "explicitly superseded",
        updatedAt: this.clock.now().toISOString()
      });
      facts[index] = next;
      return next;
    });
  }

  async expire(clientId: string, at = this.clock.now()): Promise<SharedFact[]> {
    return this.mutate(clientId, (facts) => {
      const now = at.toISOString();
      const expired: SharedFact[] = [];
      for (let index = 0; index < facts.length; index += 1) {
        const fact = facts[index]!;
        if (!fact.expiresAt || Date.parse(fact.expiresAt) > at.getTime()) continue;
        if (fact.status !== "observed" && fact.status !== "verified" && fact.status !== "hypothesis") continue;
        const next = SharedFact.parse({ ...fact, status: "stale", statusReason: "fact expired", updatedAt: now });
        facts[index] = next;
        expired.push(next);
      }
      return expired;
    });
  }

  async list(clientId: string, query: SharedFactQuery = {}): Promise<SharedFact[]> {
    await this.expire(clientId, query.now ?? this.clock.now());
    const facts = await this.repository.load(clientId);
    return facts.filter((fact) =>
      (!query.taskId || fact.taskId === query.taskId)
      && (query.includeTerminal || !["rejected", "stale", "superseded"].includes(fact.status))
    ).map((fact) => structuredClone(SharedFact.parse(fact)));
  }

  async usable(clientId: string, query: Omit<SharedFactQuery, "includeTerminal"> = {}): Promise<SharedFact[]> {
    const facts = await this.list(clientId, query);
    return facts.filter((fact) => fact.status === "verified" && fact.sourceType !== "migration");
  }

  async deriveForTask(clientId: string, taskId: string, sourceFacts: readonly SharedFact[]): Promise<SharedFact[]> {
    const derived: SharedFact[] = [];
    for (const source of sourceFacts) {
      if (source.clientId !== clientId || source.status !== "verified" || source.sourceType === "migration") continue;
      if (source.taskId === taskId) {
        derived.push(source);
        continue;
      }
      const observed = await this.observe({
        clientId,
        taskId,
        subject: source.subject,
        predicate: source.predicate,
        value: structuredClone(source.value),
        unit: source.unit,
        sourceType: source.sourceType,
        sourceScreenshotId: source.sourceScreenshotId,
        sourceBoundingBox: source.sourceBoundingBox,
        evidenceIds: [...new Set([...source.evidenceIds, `fact:${source.factId}`])],
        confidence: source.confidence,
        createdBy: "root_agent_fact_bridge",
        expiresAt: source.expiresAt,
        derivedFromFactId: source.factId
      });
      derived.push(await this.verify(clientId, observed.factId, {
        verifier: "inherited_verified_evidence",
        confidence: source.confidence
      }));
    }
    return derived;
  }

  private async transitionTerminal(clientId: string, factId: string, status: "stale" | "rejected", reason: string): Promise<SharedFact> {
    return this.mutate(clientId, (facts) => {
      const index = findFactIndex(facts, factId);
      const current = facts[index]!;
      if (current.status === "superseded") throw new Error("superseded fact cannot transition again");
      const next = SharedFact.parse({
        ...current,
        status,
        statusReason: z.string().min(1).parse(reason),
        updatedAt: this.clock.now().toISOString()
      });
      facts[index] = next;
      return next;
    });
  }

  private async mutate<T>(clientId: string, operation: (facts: SharedFact[]) => T): Promise<T> {
    assertSafeIdentifier(clientId, "client id");
    let release!: () => void;
    const predecessor = this.queues.get(clientId) ?? Promise.resolve();
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = predecessor.then(() => current);
    this.queues.set(clientId, queued);
    await predecessor;
    try {
      const facts = (await this.repository.load(clientId)).map((fact) => SharedFact.parse(fact));
      const result = operation(facts);
      await this.repository.save(clientId, facts);
      return structuredClone(result);
    } finally {
      release();
      if (this.queues.get(clientId) === queued) this.queues.delete(clientId);
    }
  }
}

const LegacySharedFact = z.object({
  fact_id: z.string().min(1),
  source: z.string().min(1),
  evidence: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1),
  status: z.string(),
  created_by: z.string().min(1),
  verified_by: z.array(z.string().min(1)).default([]),
  task_id: z.string().uuid(),
  expires_at: z.string().datetime().nullable(),
  value: SharedFactPayload
});

export interface LegacyFactMigrationContext {
  clientId: string;
  taskId: string;
  now?: string;
}

/**
 * Explicit one-way compatibility entrance. Its `migration` source and
 * `observed` status guarantee that converted records cannot reach specialists.
 */
export function migrateLegacyFactDispatch(
  input: readonly unknown[] | Record<string, unknown>,
  context: LegacyFactMigrationContext
): SharedFact[] {
  const now = context.now ?? new Date().toISOString();
  const legacyRecords = Array.isArray(input)
    ? input.map((item) => LegacySharedFact.parse(item))
    : Object.entries(input)
      .filter(([key]) => !new Set(["conversation", "conversations", "messages", "recentMemory", "transcript", "transcripts"]).has(key))
      .map(([key, value]) => ({
        fact_id: `legacy.${key}`,
        source: "legacy_dispatch",
        evidence: [`legacy-dispatch:${key}`],
        confidence: 0.5,
        status: "observed",
        created_by: "legacy_compatibility_adapter",
        verified_by: [],
        task_id: context.taskId,
        expires_at: null,
        value
      }));
  return legacyRecords.map((legacy) => SharedFact.parse({
    factId: legacy.fact_id,
    clientId: context.clientId,
    taskId: context.taskId,
    subject: legacy.source,
    predicate: "legacy_value",
    value: legacy.value,
    unit: "",
    sourceType: "migration",
    sourceScreenshotId: null,
    sourceBoundingBox: null,
    evidenceIds: legacy.evidence,
    confidence: legacy.confidence,
    status: "observed",
    createdBy: legacy.created_by,
    verifiedBy: [],
    createdAt: now,
    updatedAt: now,
    verifiedAt: null,
    expiresAt: legacy.expires_at,
    statusReason: `migrated from ${legacy.status}; independent verification required`,
    supersededByFactId: null,
    derivedFromFactId: null
  }));
}

function findFactIndex(facts: readonly SharedFact[], factId: string): number {
  const index = facts.findIndex((fact) => fact.factId === factId);
  if (index < 0) throw new Error(`shared fact not found: ${factId}`);
  return index;
}

function sameFactSlot(left: SharedFact, right: SharedFact): boolean {
  return left.clientId === right.clientId
    && left.taskId === right.taskId
    && left.subject === right.subject
    && left.predicate === right.predicate;
}

export const TaskState = z.object({
  id: z.string().uuid(),
  clientId: z.string().min(1),
  goal: z.string().min(1),
  phase: TaskPhase,
  completedSteps: z.array(z.string()).default([]),
  evidence: z.array(Evidence).default([]),
  hypotheses: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  nextStep: z.string().nullable().default(null),
  owner: SpecialistRole.nullable().default(null),
  reviewAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type TaskState = z.infer<typeof TaskState>;

export const ConversationMessage = z.object({
  id: z.string().uuid(),
  clientId: z.string().min(1),
  conversationId: z.string().min(1).default("primary"),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
  status: z.enum(["complete", "error"]).default("complete"),
  taskId: z.string().uuid().optional(),
  at: z.string().datetime()
});
export type ConversationMessage = z.infer<typeof ConversationMessage>;

export const ModelTier = z.enum(["fast", "gui", "strong"]);
export type ModelTier = z.infer<typeof ModelTier>;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function assertSafeIdentifier(value: string, label = "identifier"): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, underscores, or hyphens`);
  }
  return value;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
