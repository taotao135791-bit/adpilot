import { z } from "zod";
import { bashVerdictToGateClass, classifyBashToolArgs } from "./bash-classifier.js";

export {
  bashVerdictToGateClass,
  classifyBashCommand,
  classifyBashToolArgs,
  isProtectedToken
} from "./bash-classifier.js";
export type {
  BashClassification,
  BashClassifierOptions,
  BashCommandVerdict,
  SimpleCommandVerdict
} from "./bash-classifier.js";

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
  /** Product Session this message belongs to; absent on rows that predate the Session authority. */
  sessionId: z.string().uuid().optional(),
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

/* ------------------------------------------------------------------------ */
/* Declarative tool permission gate (single source of truth)                */
/* ------------------------------------------------------------------------ */

/**
 * Side-effect class of one model-initiated tool call.
 * - read: observes or computes; persists only compliance/evidence records.
 * - write: persists operational state or exercises a previously granted
 *   approval; never touches the ad account directly.
 * - destructive: mutates the advertising account or executes an approved plan.
 */
export const ToolPermissionClass = z.enum(["read", "write", "destructive"]);
export type ToolPermissionClass = z.infer<typeof ToolPermissionClass>;

/**
 * How the runtime gate validates authority for a write/destructive call.
 * - approval_token: the call must carry `approvalId` + `approvalToken` bound to
 *   an approved, unexpired, single-use token (same semantics as
 *   ApprovalService.consume, minus the final consume).
 * - approval_reference: the call must carry `approvalId` pointing at an
 *   approval of the same client and task in one of `referenceStatuses`.
 * - self_gated: the tool is itself the authority-request pipeline; its internal
 *   deterministic guardrails are the gate (no token can exist yet).
 */
export const ToolGateAuthority = z.enum(["approval_token", "approval_reference", "self_gated"]);
export type ToolGateAuthority = z.infer<typeof ToolGateAuthority>;

export interface ToolGateRule {
  /** Fixed class, or an argument-aware classifier. */
  classify: ToolPermissionClass | ((args: unknown) => ToolPermissionClass);
  /** Authority check applied when the effective class is not read. */
  authority: ToolGateAuthority;
  /** Approval statuses that authorize an approval_reference call. */
  referenceStatuses?: readonly string[];
  /** Human- and auditor-facing rationale for the classification. */
  reason: string;
}

function recordAt(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Skills whose execution only reads or deterministically computes. */
const READ_SKILL_NAMES: readonly string[] = [
  "check-conversion-reliability",
  "evaluate-budget-change",
  "evaluate-bid-change",
  "detect-creative-fatigue",
  "assess-campaign-launch",
  "generate-client-report",
  "review-attribution-consistency",
  "daily-report",
  "weekly-report",
  "account-audit"
];

/** Read-only skills are the only ones plan mode keeps available. */
export const READ_ONLY_SKILL_NAMES: readonly string[] = READ_SKILL_NAMES;

/**
 * Tool names plan mode keeps for the main agent: the confined read-only set
 * plus the deterministic analysis tools and read-classified dispatches. Every
 * other tool (write, edit, bash, prepare_approval, commit_approved_action) is
 * removed, and the runtime gate additionally denies any non-read
 * classification while plan mode is on.
 */
export const PLAN_MODE_READ_TOOL_NAMES: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "read_workspace",
  "read_visual_table",
  "analyze_campaign_metrics",
  "evaluate_change_guardrail",
  "dispatch_specialist",
  "execute_skill"
];

function classifyExecuteSkill(args: unknown): ToolPermissionClass {
  const name = recordAt(args, "name");
  if (typeof name === "string" && READ_SKILL_NAMES.includes(name)) return "read";
  // Unknown skills and ledger-writing skills fail closed to write.
  return "write";
}

function classifyDispatchSpecialist(args: unknown): ToolPermissionClass {
  const permission = recordAt(recordAt(recordAt(args, "input"), "visualTask"), "permission");
  if (permission === "MUTATE" || permission === "DESTRUCTIVE") return "destructive";
  return "read";
}

/**
 * Every tool a model can invoke through PiAgentRuntime, classified.
 * Names must stay in sync with AdPilotTools.toPiTools (including the vendored
 * general read-only set read/grep/find/ls), the main-agent-only general
 * write/edit/bash set, the execute_skill tool, and the orchestrator tools;
 * unlisted names fall back to DEFAULT_TOOL_GATE_RULE.
 */
export const TOOL_GATE_RULES: Readonly<Record<string, ToolGateRule>> = {
  read_workspace: {
    classify: "read",
    authority: "self_gated",
    reason: "Reads the client workspace; persists only its compliance audit record."
  },
  read: {
    classify: "read",
    authority: "self_gated",
    reason: "Reads text files confined to the workspace and explicitly allowed roots; lexical and symlink escapes are rejected by the path guard before any byte is read."
  },
  grep: {
    classify: "read",
    authority: "self_gated",
    reason: "Searches file contents inside the same confined roots as read; no writes, no external processes."
  },
  find: {
    classify: "read",
    authority: "self_gated",
    reason: "Lists matching file paths inside the same confined roots as read; no writes, no external processes."
  },
  ls: {
    classify: "read",
    authority: "self_gated",
    reason: "Lists directory entries inside the same confined roots as read; no writes."
  },
  write: {
    classify: "write",
    authority: "approval_reference",
    referenceStatuses: ["executed"],
    reason: "Writes a file inside the workspace (never outside it, never into .adpilot, never onto a protected path). Persists operational state, so it must reference the executed approval of the same client and task, exactly like ledger-writing skills."
  },
  edit: {
    classify: "write",
    authority: "approval_reference",
    referenceStatuses: ["executed"],
    reason: "Targeted in-place rewrite of a workspace file under the same confinement and executed-approval semantics as write."
  },
  bash: {
    classify: (args: unknown): ToolPermissionClass => bashVerdictToGateClass(classifyBashToolArgs(args).verdict),
    authority: "approval_reference",
    referenceStatuses: ["executed"],
    reason: "Deterministic per-command classification: whitelisted read commands flow; writes (redirects, installs, unknown programs, unparseable input) require an executed approval reference; network egress, screen capture, credential/profile-store access, privilege/process control and rm -rf are mapped to destructive and additionally hard-denied inside the tool before any execution, with every decision audited."
  },
  analyze_campaign_metrics: {
    classify: "read",
    authority: "self_gated",
    reason: "Pure deterministic metric calculation."
  },
  evaluate_change_guardrail: {
    classify: "read",
    authority: "self_gated",
    reason: "Pure deterministic guardrail evaluation; the decision is advisory until an approval binds it."
  },
  read_visual_table: {
    classify: "read",
    authority: "self_gated",
    reason: "Managed observation of a visible table; scrolling is INTERACT-capped inside the tool and no account state changes."
  },
  dispatch_specialist: {
    classify: classifyDispatchSpecialist,
    authority: "approval_token",
    reason: "Specialists run OBSERVE/INTERACT-capped; a mutate or destructive visualTask is rejected at the gate before the orchestrator sees it."
  },
  prepare_approval: {
    classify: "write",
    authority: "self_gated",
    reason: "The authority-request path itself: persists a pending approval under deterministic guardrail binding. Risk review and user approval mint the token later, so no token can exist yet."
  },
  execute_skill: {
    classify: classifyExecuteSkill,
    authority: "approval_reference",
    referenceStatuses: ["executed"],
    reason: "Read skills are pure calculations. Ledger-writing skills (create-single-variable-experiment) must reference the executed approval of the same client and task they belong to."
  },
  commit_approved_action: {
    classify: "destructive",
    authority: "approval_token",
    reason: "Executes an approved account mutation; additionally hard-blocked for the model because tokens never enter the model context."
  }
};

/**
 * Fail-closed default: an unclassified tool has unknown side effects, so it is
 * treated as write requiring a valid approval token. Classifying it as read
 * would silently wave any future destructive tool through the gate.
 */
export const DEFAULT_TOOL_GATE_RULE: ToolGateRule = {
  classify: "write",
  authority: "approval_token",
  reason: "Unclassified tool; fail-closed default treats unknown side effects as an approval-gated write."
};

export interface ToolGateClassification {
  rule: ToolGateRule;
  class: ToolPermissionClass;
  defaulted: boolean;
}

export function classifyToolCall(toolName: string, args: unknown): ToolGateClassification {
  const rule = TOOL_GATE_RULES[toolName] ?? DEFAULT_TOOL_GATE_RULE;
  const classification = typeof rule.classify === "function" ? rule.classify(args) : rule.classify;
  return { rule, class: classification, defaulted: !(toolName in TOOL_GATE_RULES) };
}

export interface ApprovalCredentials {
  approvalId: string;
  approvalToken?: string;
}

/**
 * Extracts approval credentials from tool arguments, checking the top level
 * and one nested `input` object (the execute_skill payload shape).
 */
export function extractApprovalCredentials(args: unknown): ApprovalCredentials | null {
  const candidates = [args, recordAt(args, "input")];
  for (const candidate of candidates) {
    const approvalId = recordAt(candidate, "approvalId");
    if (typeof approvalId !== "string" || !z.string().uuid().safeParse(approvalId).success) continue;
    const token = recordAt(candidate, "approvalToken");
    return { approvalId, ...(typeof token === "string" && token ? { approvalToken: token } : {}) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Custom OpenAI/Anthropic-compatible providers (enterprise gateways, local inference)
// ---------------------------------------------------------------------------

/** Env var carrying the JSON-serialized CustomProviderConfig list from settings to the model layer. */
export const CUSTOM_PROVIDERS_ENV = "ADPILOT_CUSTOM_PROVIDERS";

/** Defaults applied to custom provider models; unknown until the endpoint reports them. */
export const CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW = 128_000;
export const CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS = 32_000;

/** Wire protocol spoken by a custom provider endpoint. */
export const CustomProviderApi = z.enum(["openai-completions", "anthropic-messages"]);
export type CustomProviderApi = z.infer<typeof CustomProviderApi>;

export const CustomProviderModel = z.object({
  id: z.string().min(1),
  /** True when this model accepts image inputs (screenshots); gates entry into vision routes. */
  vision: z.boolean().default(false)
});
export type CustomProviderModel = z.infer<typeof CustomProviderModel>;

/**
 * A user-defined OpenAI/Anthropic-compatible endpoint: an enterprise proxy/gateway or a
 * local inference server (llama.cpp, Ollama, vLLM). `apiKey` is a secret — it is persisted
 * only inside the 0600 settings file and is never exposed through public views. Keyless
 * local servers may omit it; the model layer then sends a placeholder bearer token.
 */
export const CustomProviderConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "custom provider id must be a lowercase slug (letters, numbers, hyphens)"),
  name: z.string().min(1),
  baseUrl: z.string().min(1).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "custom provider baseUrl must be a valid http(s) URL"),
  api: CustomProviderApi.default("openai-completions"),
  apiKey: z.string().min(1).optional(),
  models: z.array(CustomProviderModel).min(1)
});
export type CustomProviderConfig = z.infer<typeof CustomProviderConfig>;

/** Provider ids that run models on this machine even without a URL to classify. */
const LOCAL_PROVIDER_ID_PATTERN = /(?:^|[-_.])(ollama|lmstudio|llama\.cpp|local|mlx)(?:$|[-_.])/i;

/**
 * True when a hostname is loopback or a private/internal network address:
 * loopback (localhost, 127.0.0.0/8, ::1), RFC 1918 (10/8, 172.16/12, 192.168/16),
 * link-local (169.254/16, fe80::/10), IPv6 ULA (fc00::/7), and .local/.internal names.
 */
export function isLocalHostname(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // IPv6 literal from URL.hostname
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.startsWith("::ffff:")) host = host.slice("::ffff:".length); // IPv4-mapped IPv6
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("fe80:")) return true; // IPv6 link-local
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true; // IPv6 ULA fc00::/7
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const [a = 0, b = 0] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Decide whether traffic to a model stays on this machine or the internal network.
 * An explicit baseUrl is the authoritative evidence of where bytes actually go:
 * a local-sounding provider id pointing at a public host is remote. The provider-id
 * heuristic (ollama/lmstudio/llama.cpp are local, matching the computer-use
 * screenshot-side rule) only applies when no baseUrl is known. Loopback and
 * private/intranet addresses qualify, so custom on-prem gateways and LAN inference
 * servers pass. Anything unparseable or unknown is treated as remote.
 */
export function isLocalModelEndpoint(providerId: string, baseUrl?: string): boolean {
  if (baseUrl) {
    try {
      return isLocalHostname(new URL(baseUrl).hostname);
    } catch {
      return false;
    }
  }
  return LOCAL_PROVIDER_ID_PATTERN.test(providerId);
}

/* ------------------------------------------------------------------------ */
/* Monitoring alerts (proactive, advisory-only session injection)           */
/* ------------------------------------------------------------------------ */

/**
 * Extensible alert taxonomy. New kinds append to the enum; producers must
 * prefer a specific kind over "other" whenever one fits.
 */
export const MonitoringAlertKind = z.enum([
  "budget_overspend",
  "kpi_anomaly",
  "learning_phase_complete",
  "measurement_broken",
  "creative_fatigue",
  "pacing_anomaly",
  "tracking_outage",
  "other"
]);
export type MonitoringAlertKind = z.infer<typeof MonitoringAlertKind>;

export const MonitoringAlertSeverity = z.enum(["info", "warning", "critical"]);
export type MonitoringAlertSeverity = z.infer<typeof MonitoringAlertSeverity>;

/**
 * One numeric observation carried by an alert. The same binding discipline as
 * specialist numerical inputs applies: every number must name the verified
 * Shared Fact id it was read from, so the agent can cite and re-verify it
 * instead of trusting producer prose.
 */
export const MonitoringMetricSnapshot = z.object({
  metric: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().default(""),
  factId: z.string().min(1),
  observedAt: z.string().datetime().optional()
});
export type MonitoringMetricSnapshot = z.infer<typeof MonitoringMetricSnapshot>;

/**
 * A monitoring observation routed into a client's conversation. Alerts only
 * ever request analysis and recommendations: they carry no approval authority
 * and every account mutation must still traverse the standard approval chain.
 * `dedupeKey` scopes producer-side suppression (same key inside the dedupe
 * window is recorded once).
 */
export const MonitoringAlert = z.object({
  alertId: z.string().uuid(),
  clientId: z.string().min(1),
  kind: MonitoringAlertKind,
  severity: MonitoringAlertSeverity,
  metrics: z.array(MonitoringMetricSnapshot).default([]),
  message: z.string().min(1).max(2000),
  dedupeKey: z.string().min(1).max(200),
  createdAt: z.string().datetime()
});
export type MonitoringAlert = z.infer<typeof MonitoringAlert>;

/** Producer payload accepted by the alert endpoint; the server stamps identity and receipt time. */
export const MonitoringAlertInput = MonitoringAlert.omit({ alertId: true, clientId: true, createdAt: true });
export type MonitoringAlertInput = z.infer<typeof MonitoringAlertInput>;
