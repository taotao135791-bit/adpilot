import { Agent, DEFAULT_COMPACTION_SETTINGS, Session, estimateContextTokens, prepareCompaction, compact, shouldCompact, type AgentEvent, type AgentMessage, type AgentTool, type CompactionSettings } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";
import { ModelRouter, resolvePiModel, type ModelRef, type RoutingSignals } from "@adpilot/model-router";
import { SkillRegistry, formatSkillContract } from "@adpilot/skills";
import type { ToolContext, AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotSessionStorage, resolvePiSessionId } from "./session-storage.js";
import { ToolPermissionGate } from "./tool-gate.js";
import { conversationMessageLabel, duplicateConversationStorage, forkConversationStorage, forkConversationStorageInto, type ConversationDuplicateResult, type ConversationForkResult } from "./conversation-fork.js";
import { isPlanModeSkill, isPlanModeTool, PLAN_MODE_SYSTEM_PROMPT, PlanModeStore, type PlanModeProbe } from "./plan-mode.js";
import type { AutonomyProbe } from "./autonomy-mode.js";
import {
  RuntimeBudgetController,
  resolveRuntimeBudgetLimits,
  type RuntimeBudgetLimits,
  type RuntimeBudgetOverride
} from "./runtime-budget.js";

export { AdPilotSessionStorage, resolvePiSessionId } from "./session-storage.js";
export type { AdPilotSessionMetadata } from "./session-storage.js";
export { ToolPermissionGate } from "./tool-gate.js";
export { AuditRuntimeExtension, sanitizeForAudit } from "./audit-extension.js";
export { DUPLICATE_CUSTOM_ENTRY_TYPE, FORK_CUSTOM_ENTRY_TYPE, conversationMessageLabel, duplicateConversationStorage, forkConversationStorage, forkConversationStorageInto, resolveForkLeafId } from "./conversation-fork.js";
export type { ConversationDuplicateResult, ConversationForkResult } from "./conversation-fork.js";
export { PlanModeState, PlanModeStore, PLAN_MODE_SYSTEM_PROMPT, isPlanModeSkill, isPlanModeTool } from "./plan-mode.js";
export type { PlanModeProbe } from "./plan-mode.js";
export { AutonomyMode, AutonomyState, AutonomyStore } from "./autonomy-mode.js";
export type { AutonomyProbe } from "./autonomy-mode.js";
export {
  DEFAULT_RUNTIME_BUDGET,
  MAX_RUNTIME_BUDGET,
  RuntimeBudgetExceeded,
  resolveRuntimeBudgetLimits
} from "./runtime-budget.js";
export type { RuntimeBudgetExceededReason, RuntimeBudgetLimits, RuntimeBudgetOverride } from "./runtime-budget.js";

export interface RuntimeExtension {
  name: string;
  beforeRun?(context: RuntimeRunContext): Promise<void> | void;
  onEvent?(event: AgentEvent, context: RuntimeRunContext): Promise<void> | void;
  afterRun?(result: RuntimeResult, context: RuntimeRunContext): Promise<void> | void;
  onError?(error: Error, context: RuntimeRunContext): Promise<void> | void;
}

export interface RuntimeRunContext extends ToolContext {
  sessionId: string;
  conversationId?: string;
  role: string;
  /**
   * conversation.jsonl id of the user message that started this run. When
   * present, the run labels its user-message session entry so the message can
   * later serve as an exact conversation-fork point.
   */
  userMessageId?: string;
}

export interface RuntimeRequest {
  context: RuntimeRunContext;
  systemPrompt: string;
  prompt: string;
  signals: RoutingSignals;
  tools?: AgentTool[];
  allowedSkills?: string[];
  priorMessages?: AgentMessage[];
  /**
   * Session-level model binding resolved by the product Session authority.
   * A pinned `ref` replaces router routing for the run's primary model;
   * `route` forces a router route when nothing is pinned. Without it the
   * global router decides, exactly as before.
   */
  modelOverride?: SessionModelOverride;
  /**
   * Optional per-request budget tuning. Values are integer-normalized and
   * clamped to the runtime's hard safety envelope.
   */
  budget?: RuntimeBudgetOverride;
}

/**
 * Session-scoped model selection for one run. `ref` pins an exact
 * provider/model; `fallbackRoute` picks where the one-shot error escalation
 * goes afterwards (the strong route by default). `route` forces a router
 * route ("strong") or leaves default routing untouched ("fast").
 */
export interface SessionModelOverride {
  ref?: ModelRef;
  route?: "fast" | "strong";
  fallbackRoute?: "fast" | "strong";
}

export interface RuntimeResult {
  text: string;
  sessionId?: string;
  model: { provider: string; id: string; tier: string };
  messages: AgentMessage[];
  events: AgentEvent[];
  recovered: boolean;
  compacted?: boolean;
}

/**
 * Steering semantics for session message injection, mapped one-to-one onto
 * pi-agent-core: "steer" injects at the next turn boundary (after the current
 * assistant turn and its tool calls finish), "followUp" runs the message once
 * the agent would otherwise stop. Neither interrupts in-flight tool execution.
 */
export type SessionInjectionMode = "steer" | "followUp";

export type SessionInjectionOutcome =
  | { status: "queued"; sessionId: string; mode: SessionInjectionMode }
  | { status: "started"; sessionId: string; result: RuntimeResult };

export interface ActiveSessionInfo {
  conversationId: string;
  sessionId: string;
  startedAt: string;
}

interface TrackedSession extends ActiveSessionInfo {
  agent: Agent;
  clientId: string;
  budget?: RuntimeBudgetController;
}

export class StructuredOutputBlocker extends Error {
  readonly code = "STRUCTURED_OUTPUT_INVALID";
  constructor(readonly attempts: number, readonly issues: string[]) {
    super(`structured output remained invalid after ${attempts} attempts`);
    this.name = "StructuredOutputBlocker";
  }
}

export interface StructuredRuntimeResult<S extends z.ZodTypeAny> {
  output: z.output<S>;
  runtime: RuntimeResult;
  attempts: number;
  repaired: boolean;
}

export interface PiAgentRuntimeOptions {
  compaction?: Partial<CompactionSettings>;
  compactionInstructions?: string;
  /**
   * Workspace-confined general read-only tools (AdPilotTools.generalReadTools).
   * They are appended to runs that carry executable skills — the specialist
   * runs — so bounded experts can ground themselves in workspace artifacts.
   * Runs with an explicit tool whitelist (including the empty repair-pass
   * whitelist) and skill-less conversational decision runs are untouched.
   */
  generalReadTools?: AgentTool[];
  /**
   * Conversation-level plan-mode probe. When present and enabled for the
   * run's conversation, the tool set shrinks to the read-only surface, the
   * plan-mode instructions are appended to the system prompt, and the tool
   * gate denies every non-read classification.
   */
  planMode?: PlanModeProbe;
  /**
   * Client-level autonomy probe. In `full_access` the tool gate waives the
   * executed-approval reference for the general local write surface
   * (write/edit, write-classified bash). Destructive classifications and
   * account mutations are never waived.
   */
  autonomy?: AutonomyProbe;
  /**
   * Reasoning (thinking) mode resolved from settings. Maps onto pi-ai's
   * SimpleStreamOptions.reasoning per run; models without reasoning support
   * receive nothing (pi-ai would silently drop the parameter anyway).
   */
  reasoning?: ReasoningPolicy;
  /**
   * Runtime-wide budget defaults. Per-request overrides may tune these values,
   * but neither layer can exceed MAX_RUNTIME_BUDGET.
   */
  budget?: RuntimeBudgetOverride;
}

/**
 * Settings-driven thinking policy. Scope "strong" sends the effort only on
 * strong-tier runs (session-pinned runs count as strong); scope "all" sends
 * it on every run whose model supports reasoning.
 */
export interface ReasoningPolicy {
  effort: ThinkingLevel;
  scope: "strong" | "all";
}

export interface RuntimeRecoveryCheckpoint {
  version: 1;
  clientId: string;
  conversationId: string;
  sessionId: string;
  phase: "running" | "compacting" | "compacted" | "idle" | "failed";
  leafId: string | null;
  entryCount: number;
  updatedAt: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  compactionEntryId?: string;
  error?: string;
}

type ResolvedRuntimeRequest = Omit<RuntimeRequest, "context"> & {
  context: RuntimeRunContext & { conversationId: string };
};

const DEFAULT_ADPILOT_COMPACTION_INSTRUCTIONS = [
  "Preserve client, advertising account, campaign, ad group, creative and experiment identifiers exactly.",
  "Preserve budget values, currencies, timezones, KPI targets, approval state, guardrail decisions and completed tool side effects.",
  "Never imply that an account mutation occurred unless a persisted tool result confirms it."
].join(" ");

export class PiAgentRuntime {
  private readonly compactionSettings: CompactionSettings;
  private readonly compactionInstructions: string;
  private readonly generalReadTools: AgentTool[];
  private readonly planMode: PlanModeProbe | undefined;
  private readonly reasoningPolicy: ReasoningPolicy | undefined;
  private readonly defaultBudgetLimits: RuntimeBudgetLimits;
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly activeSessions = new Map<string, TrackedSession>();
  private readonly toolGate: ToolPermissionGate;

  constructor(
    private readonly models: Models,
    private readonly router: ModelRouter,
    private readonly workspace: WorkspaceStore,
    private readonly skills: SkillRegistry,
    private readonly tools: AdPilotTools,
    private readonly extensions: RuntimeExtension[] = [],
    options: PiAgentRuntimeOptions = {}
  ) {
    this.compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compaction };
    this.compactionInstructions = options.compactionInstructions ?? DEFAULT_ADPILOT_COMPACTION_INSTRUCTIONS;
    this.generalReadTools = options.generalReadTools ?? [];
    this.planMode = options.planMode;
    this.reasoningPolicy = options.reasoning;
    this.defaultBudgetLimits = resolveRuntimeBudgetLimits(options.budget);
    this.toolGate = new ToolPermissionGate(tools.approvals, tools.audit, this.planMode, options.autonomy);
  }

  /**
   * Resolve the pi-ai thinking level for one model call. Thinking is a
   * strong-role feature unless the policy scope is "all"; session-pinned runs
   * count as strong. Models without reasoning support get nothing, so the
   * setting degrades silently instead of erroring on unsupported providers.
   */
  private reasoningFor(tier: string, model: Model<Api>): ThinkingLevel | undefined {
    const policy = this.reasoningPolicy;
    if (!policy || !model.reasoning) return undefined;
    if (policy.scope !== "all" && tier !== "strong" && tier !== "session") return undefined;
    return policy.effort;
  }

  async run(request: RuntimeRequest): Promise<RuntimeResult> {
    const budget = this.createBudget(request);
    const operation = this.runWithBudget(request, budget);
    try {
      return await budget.enforceDeadline(operation);
    } finally {
      this.releaseActiveBudget(request, budget);
      budget.dispose();
    }
  }

  private async runWithBudget(request: RuntimeRequest, budget: RuntimeBudgetController): Promise<RuntimeResult> {
    const resolvedRequest = this.resolveRequest(request);
    return this.withSessionLock(resolvedRequest.context.sessionId, async () => {
      budget.throwIfExceeded();
      for (const extension of this.extensions) {
        budget.throwIfExceeded();
        await extension.beforeRun?.(resolvedRequest.context);
        budget.throwIfExceeded();
      }
      const override = resolvedRequest.modelOverride;
      const decision: { tier: string; ref: ModelRef; reasons: string[] } = override?.ref
        ? { tier: "session", ref: override.ref, reasons: ["session-pinned model binding"] }
        : override?.route === "strong"
          ? this.router.route({ ...resolvedRequest.signals, reviewerEscalated: true })
          : this.router.route(resolvedRequest.signals);
      let model = resolvePiModel(this.models, decision.ref);
      try {
        let result = await this.execute(resolvedRequest, model, decision.tier, false, budget);
        if (result.messages.some((message) => message.role === "assistant" && message.stopReason === "error") && decision.tier !== "strong") {
          const fallbackFast = override?.ref !== undefined && override.fallbackRoute === "fast";
          model = resolvePiModel(this.models, this.router.route(fallbackFast ? resolvedRequest.signals : { ...resolvedRequest.signals, reviewerEscalated: true }).ref);
          result = await this.execute({ ...resolvedRequest, priorMessages: result.messages }, model, fallbackFast ? "fast" : "strong", true, budget);
        }
        budget.throwIfExceeded();
        for (const extension of this.extensions) {
          budget.throwIfExceeded();
          await extension.afterRun?.(result, resolvedRequest.context);
          budget.throwIfExceeded();
        }
        return result;
      } catch (unknownError) {
        const error = unknownError instanceof Error ? unknownError : new Error(String(unknownError));
        for (const extension of this.extensions) await extension.onError?.(error, resolvedRequest.context);
        throw error;
      }
    });
  }

  async runStructured<S extends z.ZodTypeAny>(request: RuntimeRequest, schema: S): Promise<z.output<S>> {
    return (await this.runStructuredDetailed(request, schema)).output;
  }

  async runStructuredDetailed<S extends z.ZodTypeAny>(request: RuntimeRequest, schema: S): Promise<StructuredRuntimeResult<S>> {
    const budget = this.createBudget(request);
    const operation = this.runStructuredWithBudget(request, schema, budget);
    try {
      return await budget.enforceDeadline(operation);
    } finally {
      this.releaseActiveBudget(request, budget);
      budget.dispose();
    }
  }

  private async runStructuredWithBudget<S extends z.ZodTypeAny>(
    request: RuntimeRequest,
    schema: S,
    budget: RuntimeBudgetController
  ): Promise<StructuredRuntimeResult<S>> {
    const first = await this.runWithBudget({
      ...request,
      systemPrompt: `${request.systemPrompt}\nReturn the final answer as one JSON object matching the requested schema. Do not wrap it in markdown.`
    }, budget);
    budget.throwIfExceeded();
    const firstParsed = parseStructured(first.text, schema);
    if (firstParsed.success) return { output: firstParsed.data, runtime: first, attempts: 1, repaired: false };

    const sameModelRepair = await this.runWithBudget({
      ...request,
      systemPrompt: "You repair structured JSON. Return exactly one corrected JSON object and nothing else. Never call tools or add facts.",
      prompt: structuredRepairPrompt(first.text, firstParsed.issues),
      tools: [], allowedSkills: []
    }, budget);
    budget.throwIfExceeded();
    const secondParsed = parseStructured(sameModelRepair.text, schema);
    if (secondParsed.success) return { output: secondParsed.data, runtime: sameModelRepair, attempts: 2, repaired: true };

    const strongRepair = await this.runWithBudget({
      ...request,
      systemPrompt: "You are the final high-assurance JSON repair pass. Return exactly one corrected JSON object and nothing else. Never call tools or add facts.",
      prompt: structuredRepairPrompt(sameModelRepair.text, secondParsed.issues),
      signals: { ...request.signals, reviewerEscalated: true },
      tools: [], allowedSkills: []
    }, budget);
    budget.throwIfExceeded();
    const thirdParsed = parseStructured(strongRepair.text, schema);
    if (thirdParsed.success) return { output: thirdParsed.data, runtime: strongRepair, attempts: 3, repaired: true };
    throw new StructuredOutputBlocker(3, thirdParsed.issues);
  }

  /**
   * Attaches an additional extension after construction. The composition root
   * uses this for services that themselves depend on the runtime instance (for
   * example the alert monitor) and therefore cannot be constructor arguments.
   */
  registerExtension(extension: RuntimeExtension): void {
    this.extensions.push(extension);
  }

  /** Conversations with an in-flight run for one client, most recently started first. */
  activeConversations(clientId: string): ActiveSessionInfo[] {
    return [...this.activeSessions.values()]
      .filter((session) => session.clientId === clientId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(({ conversationId, sessionId, startedAt }) => ({ conversationId, sessionId, startedAt }));
  }

  isSessionActive(clientId: string, conversationId: string): boolean {
    return this.activeSessions.has(resolvePiSessionId(clientId, conversationId));
  }

  /**
   * Stops only the in-flight run owned by the exact client+conversation pair.
   * Pending steering and follow-up turns are discarded before aborting so a
   * stopped conversation cannot resume work from an already queued message.
   */
  stopConversation(clientId: string, conversationId: string): boolean {
    const active = this.activeSessions.get(resolvePiSessionId(clientId, conversationId));
    if (!active || active.clientId !== clientId || active.conversationId !== conversationId) return false;
    active.budget?.cancelForUserStop();
    active.agent.clearAllQueues();
    active.agent.abort();
    return true;
  }

  /**
   * Queues a user message into a running session through pi-agent-core
   * steering. The injected turn inherits the active run's system prompt,
   * tools, and tool-permission gate, and is persisted through the normal
   * message pipeline. Returns false when no run is active for the session;
   * the caller then decides whether to start a fresh turn or defer.
   */
  queueSessionMessage(clientId: string, conversationId: string, text: string, mode: SessionInjectionMode = "followUp"): boolean {
    const active = this.activeSessions.get(resolvePiSessionId(clientId, conversationId));
    if (!active) return false;
    const message: AgentMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    if (mode === "steer") active.agent.steer(message);
    else active.agent.followUp(message);
    return true;
  }

  /**
   * Full session-injection entry point. While a run is active for the
   * request's client+conversation the prompt text is queued with the given
   * steering semantics; an idle session starts a fresh turn through the
   * normal run pipeline with the request's own system prompt, signals, tools,
   * and guardrail context.
   */
  async injectUserMessage(request: RuntimeRequest, mode: SessionInjectionMode = "followUp"): Promise<SessionInjectionOutcome> {
    const resolved = this.resolveRequest(request);
    if (this.queueSessionMessage(resolved.context.clientId, resolved.context.conversationId, resolved.prompt, mode)) {
      return { status: "queued", sessionId: resolved.context.sessionId, mode };
    }
    const result = await this.run(request);
    return { status: "started", sessionId: result.sessionId ?? resolved.context.sessionId, result };
  }

  /**
   * Forks a conversation at one persisted conversation message. The new
   * conversation shares the session history and transcript up to the fork
   * point and evolves independently afterwards. The source session lock
   * serializes the copy against any in-flight run; the fork is chained into
   * the audit log and the new session receives an idle recovery checkpoint so
   * the existing restart/compaction machinery treats it like any other
   * session.
   */
  async forkConversation(
    clientId: string,
    conversationId: string,
    atMessageId: string,
    options: { actor?: string } = {}
  ): Promise<ConversationForkResult> {
    const actor = options.actor ?? "workspace-owner";
    return this.withSessionLock(resolvePiSessionId(clientId, conversationId), async () => {
      const result = await forkConversationStorage(this.workspace, clientId, conversationId, atMessageId);
      const targetSession = new Session(await AdPilotSessionStorage.openOrCreate(this.workspace, clientId, result.conversationId));
      await this.writeCheckpoint(targetSession, {
        clientId,
        conversationId: result.conversationId,
        sessionId: result.sessionId,
        taskId: crypto.randomUUID(),
        actor,
        permission: "OBSERVE",
        role: actor
      }, "idle");
      await this.tools.audit.append({
        clientId,
        actor,
        action: "fork_conversation",
        status: "succeeded",
        details: {
          sourceConversationId: result.sourceConversationId,
          sourceMessageId: result.sourceMessageId,
          sourceEntryId: result.sourceEntryId,
          newConversationId: result.conversationId,
          newSessionId: result.sessionId,
          copiedEntries: result.copiedEntries,
          copiedMessages: result.copiedMessages
        }
      });
      return result;
    });
  }

  /**
   * Same fork semantics as forkConversation, but the new conversation id is
   * supplied by the caller. The product Session layer passes a freshly created
   * Session's runtimeConversationId so the product identity and the durable Pi
   * context stay aligned; provenance rides the same custom entry and audit
   * record, and the target receives an idle recovery checkpoint.
   */
  async forkConversationInto(
    clientId: string,
    sourceConversationId: string,
    atMessageId: string,
    targetConversationId: string,
    options: { actor?: string } = {}
  ): Promise<ConversationForkResult> {
    const actor = options.actor ?? "workspace-owner";
    return this.withSessionLock(resolvePiSessionId(clientId, sourceConversationId), async () => {
      const result = await forkConversationStorageInto(this.workspace, clientId, sourceConversationId, atMessageId, targetConversationId);
      const targetSession = new Session(await AdPilotSessionStorage.openOrCreate(this.workspace, clientId, result.conversationId));
      await this.writeCheckpoint(targetSession, {
        clientId,
        conversationId: result.conversationId,
        sessionId: result.sessionId,
        taskId: crypto.randomUUID(),
        actor,
        permission: "OBSERVE",
        role: actor
      }, "idle");
      await this.tools.audit.append({
        clientId,
        actor,
        action: "fork_conversation",
        status: "succeeded",
        details: {
          sourceConversationId: result.sourceConversationId,
          sourceMessageId: result.sourceMessageId,
          sourceEntryId: result.sourceEntryId,
          newConversationId: result.conversationId,
          newSessionId: result.sessionId,
          copiedEntries: result.copiedEntries,
          copiedMessages: result.copiedMessages
        }
      });
      return result;
    });
  }

  /**
   * Duplicates the complete conversation (every session tree entry and every
   * transcript message) into a caller-supplied new conversation id — again the
   * freshly created duplicate Session's runtimeConversationId. The source
   * session lock serializes the copy against in-flight runs; provenance and
   * the idle recovery checkpoint match the fork path.
   */
  async duplicateConversationInto(
    clientId: string,
    sourceConversationId: string,
    targetConversationId: string,
    options: { actor?: string } = {}
  ): Promise<ConversationDuplicateResult> {
    const actor = options.actor ?? "workspace-owner";
    return this.withSessionLock(resolvePiSessionId(clientId, sourceConversationId), async () => {
      const result = await duplicateConversationStorage(this.workspace, clientId, sourceConversationId, targetConversationId);
      const targetSession = new Session(await AdPilotSessionStorage.openOrCreate(this.workspace, clientId, result.conversationId));
      await this.writeCheckpoint(targetSession, {
        clientId,
        conversationId: result.conversationId,
        sessionId: result.sessionId,
        taskId: crypto.randomUUID(),
        actor,
        permission: "OBSERVE",
        role: actor
      }, "idle");
      await this.tools.audit.append({
        clientId,
        actor,
        action: "duplicate_conversation",
        status: "succeeded",
        details: {
          sourceConversationId: result.sourceConversationId,
          newConversationId: result.conversationId,
          newSessionId: result.sessionId,
          copiedEntries: result.copiedEntries,
          copiedMessages: result.copiedMessages
        }
      });
      return result;
    });
  }

  /**
   * Binds this run's user-message session entry to its conversation.jsonl
   * message id through a Pi label entry, giving conversation forking an exact,
   * compaction-proof anchor. A missing entry (for example a run that failed
   * before persisting its prompt) is tolerated: the message then simply
   * cannot serve as a fork point.
   */
  private async labelConversationMessage(session: Session, prompt: string, messageId: string): Promise<void> {
    const entry = (await session.getEntries())
      .reverse()
      .find((candidate) => candidate.type === "message" && candidate.message.role === "user" && agentMessageText(candidate.message) === prompt);
    if (!entry) return;
    await session.appendLabel(entry.id, conversationMessageLabel(messageId));
  }

  createSkillTool(context: ToolContext, allowedSkills: string[]): AgentTool {
    const contracts = allowedSkills.map((name) => formatSkillContract(this.skills.get(name))).join("\n\n");
    return {
      name: "execute_skill",
      label: "Execute an advertising skill",
      description: `Run one validated advertising method. The input object must match the selected skill's input contract below; invalid input is rejected and audited.\n\n${contracts}`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", enum: allowedSkills, description: "One allowed skill name" },
          input: { type: "object", description: "Payload matching the selected skill's input contract in this tool's description" }
        },
        required: ["name", "input"],
        additionalProperties: false
      },
      executionMode: "sequential",
      execute: async (_toolCallId, raw) => {
        const params = z.object({ name: z.enum(allowedSkills as [string, ...string[]]), input: z.unknown() }).parse(raw);
        const details = await this.skills.execute(params.name, context, params.input, this.tools);
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      }
    } as AgentTool;
  }

  private async execute(
    request: ResolvedRuntimeRequest,
    model: Model<Api>,
    tier: string,
    recovered: boolean,
    budget: RuntimeBudgetController
  ): Promise<RuntimeResult> {
    budget.throwIfExceeded();
    // Plan mode is conversation-scoped: the read-only tool shrink and the
    // prompt instruction apply to every run of the conversation; the gate
    // backstop (ToolPermissionGate) independently denies non-read calls.
    const planModeOn = this.planMode
      ? await this.planMode.isEnabled(request.context.clientId, request.context.conversationId).catch(() => false)
      : false;
    budget.throwIfExceeded();
    const allowedSkills = planModeOn ? (request.allowedSkills ?? []).filter(isPlanModeSkill) : (request.allowedSkills ?? []);
    const skillsPrompt = this.buildSkillsPrompt(allowedSkills);
    const storage = await AdPilotSessionStorage.openOrCreate(this.workspace, request.context.clientId, request.context.conversationId);
    budget.throwIfExceeded();
    const session = new Session(storage);
    const existingEntries = await session.getEntries();
    budget.throwIfExceeded();
    if (existingEntries.length === 0 && request.priorMessages?.length) {
      for (const message of request.priorMessages) {
        budget.throwIfExceeded();
        await session.appendMessage(message);
        budget.throwIfExceeded();
      }
    }
    let lastCompactionEntryId = await this.compactAtThreshold(session, model, request.context, budget);
    budget.throwIfExceeded();
    let compacted = Boolean(lastCompactionEntryId);
    const persistedContext = await session.buildContext();
    budget.throwIfExceeded();
    const events: AgentEvent[] = [];
    const tools = planModeOn
      ? (request.tools ?? []).filter((tool) => isPlanModeTool(tool.name))
      : [...(request.tools ?? [])];
    if (allowedSkills.length > 0) {
      tools.push(this.createSkillTool(request.context, allowedSkills));
      // Skill-bearing runs (the specialists) also receive the confined general
      // read-only tools; explicit whitelists and skill-less runs never do.
      tools.push(...(planModeOn ? this.generalReadTools.filter((tool) => isPlanModeTool(tool.name)) : this.generalReadTools));
    }
    const agent = new Agent({
      initialState: {
        systemPrompt: `${request.systemPrompt}${planModeOn ? `\n\n${PLAN_MODE_SYSTEM_PROMPT}` : ""}\n\n${skillsPrompt}`,
        model,
        tools,
        messages: persistedContext.messages
      },
      convertToLlm: adpilotConvertToLlm,
      streamFn: (selectedModel, context, options) => {
        budget.claimTurn();
        const reasoning = this.reasoningFor(tier, selectedModel);
        return this.models.streamSimple(selectedModel, context, reasoning ? { ...options, reasoning } : options);
      },
      sessionId: request.context.sessionId,
      toolExecution: "sequential",
      maxRetryDelayMs: 30_000,
      beforeToolCall: async ({ toolCall, args }) => {
        if (toolCall.name === "commit_approved_action") return { block: true, reason: "Approval tokens are never exposed to the model; commit through the approval API." };
        const denial = await this.toolGate.check(toolCall.name, args, request.context);
        if (denial) return { block: true, reason: denial };
        budget.claimToolCall();
        return undefined;
      }
    });
    await this.writeCheckpoint(session, request.context, "running");
    budget.throwIfExceeded();
    this.activeSessions.set(request.context.sessionId, {
      agent,
      clientId: request.context.clientId,
      conversationId: request.context.conversationId,
      sessionId: request.context.sessionId,
      startedAt: new Date().toISOString(),
      budget
    });
    try {
      budget.bind(agent);
      agent.subscribe(async (event) => {
        budget.throwIfExceeded();
        events.push(event);
        for (const extension of this.extensions) {
          budget.throwIfExceeded();
          await extension.onEvent?.(event, request.context);
          budget.throwIfExceeded();
        }
        if (event.type === "message_end") {
          budget.throwIfExceeded();
          await session.appendMessage(event.message);
          budget.throwIfExceeded();
          await this.workspace.appendJsonl(request.context.clientId, `traces/${request.context.sessionId}.jsonl`, { type: "message", at: new Date().toISOString(), message: event.message });
          budget.throwIfExceeded();
        }
      });
      await agent.prompt(request.prompt);
      await agent.waitForIdle();
      budget.throwIfExceeded();
      const text = lastAssistantText(agent.state.messages);
      if (request.context.userMessageId) {
        await this.labelConversationMessage(session, request.prompt, request.context.userMessageId);
        budget.throwIfExceeded();
      }
      const compactionEntryId = await this.compactAtThreshold(session, model, request.context, budget);
      budget.throwIfExceeded();
      lastCompactionEntryId = compactionEntryId ?? lastCompactionEntryId;
      compacted = compacted || Boolean(compactionEntryId);
      await this.writeCheckpoint(session, request.context, "idle", lastCompactionEntryId ? { compactionEntryId: lastCompactionEntryId } : undefined);
      budget.throwIfExceeded();
      return { text, sessionId: request.context.sessionId, model: { provider: model.provider, id: model.id, tier }, messages: agent.state.messages.slice(), events, recovered, compacted };
    } catch (error) {
      await this.writeCheckpoint(session, request.context, "failed", { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      throw error;
    } finally {
      budget.unbind(agent);
      this.activeSessions.delete(request.context.sessionId);
    }
  }

  /**
   * Inline, model-readable skill contracts. Skills are validated code paths,
   * not files, so the prompt must never point the model at a skill file path.
   */
  private buildSkillsPrompt(names: string[]): string {
    if (names.length === 0) return "";
    const lines = [
      "The following validated advertising methods are available through the execute_skill tool.",
      "Call execute_skill with the skill name and an input object that matches its contract below; every input is validated against the contract before execution and recorded in the audit trail.",
      "",
      "<available_skills>"
    ];
    for (const name of names) {
      lines.push(
        "  <skill>",
        formatSkillContract(this.skills.get(name)).split("\n").map((line) => `    ${line}`).join("\n"),
        "  </skill>"
      );
    }
    lines.push("</available_skills>");
    return lines.join("\n");
  }

  async compactSession(session: Session, model: Model<Api>, customInstructions: string): Promise<boolean> {
    const entries = await session.getBranch();
    const preparation = prepareCompaction(entries, this.compactionSettings);
    if (!preparation.ok || !preparation.value) return false;
    const result = await compact(preparation.value, this.models, model, customInstructions);
    if (!result.ok) throw result.error;
    await session.appendCompaction(result.value.summary, result.value.firstKeptEntryId, result.value.tokensBefore, result.value.details);
    return true;
  }

  contextUsage(messages: AgentMessage[]) {
    return estimateContextTokens(messages);
  }

  private resolveRequest(request: RuntimeRequest): ResolvedRuntimeRequest {
    const conversationId = request.context.conversationId?.trim() || request.context.sessionId;
    const sessionId = resolvePiSessionId(request.context.clientId, conversationId);
    return { ...request, context: { ...request.context, conversationId, sessionId } };
  }

  private async compactAtThreshold(
    session: Session,
    model: Model<Api>,
    context: RuntimeRunContext & { conversationId: string },
    budget: RuntimeBudgetController
  ): Promise<string | undefined> {
    if (budget.wasStoppedByUser) return undefined;
    budget.throwIfExceeded();
    if (model.contextWindow <= 0) return undefined;
    const sessionContext = await session.buildContext();
    budget.throwIfExceeded();
    const usage = estimateContextTokens(sessionContext.messages);
    if (!shouldCompact(usage.tokens, model.contextWindow, this.compactionSettings)) return undefined;
    const entries = await session.getBranch();
    budget.throwIfExceeded();
    const preparation = prepareCompaction(entries, this.compactionSettings);
    if (!preparation.ok) throw preparation.error;
    if (!preparation.value) return undefined;
    await this.writeCheckpoint(session, context, "compacting", {
      firstKeptEntryId: preparation.value.firstKeptEntryId,
      tokensBefore: preparation.value.tokensBefore
    });
    budget.throwIfExceeded();
    if (budget.wasStoppedByUser) return undefined;
    const compacting = compact(preparation.value, this.budgetedModels(budget), model, this.compactionInstructions, budget.signal);
    const outcome = await budget.settleUntilAbort(compacting);
    budget.throwIfExceeded();
    if (budget.wasStoppedByUser || outcome.aborted) return undefined;
    const result = outcome.value;
    if (!result.ok) throw result.error;
    budget.throwIfExceeded();
    const compactionEntryId = await session.appendCompaction(
      result.value.summary,
      result.value.firstKeptEntryId,
      result.value.tokensBefore,
      result.value.details
    );
    budget.throwIfExceeded();
    await this.writeCheckpoint(session, context, "compacted", {
      firstKeptEntryId: result.value.firstKeptEntryId,
      tokensBefore: result.value.tokensBefore,
      compactionEntryId
    });
    budget.throwIfExceeded();
    return compactionEntryId;
  }

  /** Count every provider completion performed internally by Pi compaction. */
  private budgetedModels(budget: RuntimeBudgetController): Models {
    const models = this.models;
    return new Proxy(models, {
      get(target, property, receiver) {
        if (property === "completeSimple") {
          const completeSimple: Models["completeSimple"] = (...args) => {
            budget.claimTurn();
            return target.completeSimple(...args);
          };
          return completeSimple;
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }

  private createBudget(request: RuntimeRequest): RuntimeBudgetController {
    return new RuntimeBudgetController(resolveRuntimeBudgetLimits(request.budget, this.defaultBudgetLimits));
  }

  private releaseActiveBudget(request: RuntimeRequest, budget: RuntimeBudgetController): void {
    const conversationId = request.context.conversationId?.trim() || request.context.sessionId;
    const sessionId = resolvePiSessionId(request.context.clientId, conversationId);
    if (this.activeSessions.get(sessionId)?.budget === budget) this.activeSessions.delete(sessionId);
  }

  private async writeCheckpoint(
    session: Session,
    context: RuntimeRunContext & { conversationId: string },
    phase: RuntimeRecoveryCheckpoint["phase"],
    details: Partial<Pick<RuntimeRecoveryCheckpoint, "firstKeptEntryId" | "tokensBefore" | "compactionEntryId" | "error">> = {}
  ): Promise<void> {
    const [leafId, entries] = await Promise.all([session.getLeafId(), session.getEntries()]);
    const checkpoint: RuntimeRecoveryCheckpoint = {
      version: 1,
      clientId: context.clientId,
      conversationId: context.conversationId,
      sessionId: context.sessionId,
      phase,
      leafId,
      entryCount: entries.length,
      updatedAt: new Date().toISOString(),
      ...details
    };
    await this.workspace.writeJson(context.clientId, `sessions/${context.sessionId}.recovery.json`, checkpoint);
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.sessionLocks.set(sessionId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === queued) this.sessionLocks.delete(sessionId);
    }
  }
}

function lastAssistantText(messages: AgentMessage[]): string {
  const message = [...messages].reverse().find((item) => item.role === "assistant");
  if (!message || message.role !== "assistant") throw new Error("agent produced no assistant response");
  return message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
}

function agentMessageText(message: AgentMessage & { role: "user" }): string {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

// Mirrors pi-agent-core's harness convertToLlm prefixes (not re-exported by
// the published package) so compacted and branched history reaches the model.
const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n`;
const COMPACTION_SUMMARY_SUFFIX = `\n</summary>`;
const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n`;
const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * The plain Pi Agent's default LLM projection drops every message that is not
 * user/assistant/toolResult, which silently discards compaction and branch
 * summaries from the model context (the Pi AgentHarness wires its own
 * projection internally; AdPilot drives Agent directly). This mirrors
 * pi-agent-core's convertToLlm so summaries keep reaching the model as user
 * messages after a compaction — in the source conversation and in any fork
 * that carries the compaction entry.
 */
function adpilotConvertToLlm(messages: AgentMessage[]): Message[] {
  const projected: Message[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      projected.push(message as Message);
    } else if (message.role === "compactionSummary") {
      projected.push({
        role: "user",
        content: [{ type: "text", text: `${COMPACTION_SUMMARY_PREFIX}${message.summary}${COMPACTION_SUMMARY_SUFFIX}` }],
        timestamp: message.timestamp
      } as Message);
    } else if (message.role === "branchSummary") {
      projected.push({
        role: "user",
        content: [{ type: "text", text: `${BRANCH_SUMMARY_PREFIX}${message.summary}${BRANCH_SUMMARY_SUFFIX}` }],
        timestamp: message.timestamp
      } as Message);
    } else if (message.role === "custom") {
      const custom = message as AgentMessage & { role: "custom" };
      const content = typeof custom.content === "string" ? [{ type: "text" as const, text: custom.content }] : custom.content;
      projected.push({ role: "user", content, timestamp: custom.timestamp } as Message);
    }
  }
  return projected;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch {
    const start = trimmed.indexOf("{"); const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("structured agent output is not JSON");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function parseStructured<S extends z.ZodTypeAny>(text: string, schema: S): { success: true; data: z.output<S> } | { success: false; issues: string[] } {
  let value: unknown;
  try { value = parseJsonObject(text); }
  catch (error) { return { success: false, issues: [error instanceof Error ? error.message : String(error)] }; }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    issues: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.length ? issue.path.join(".") : "root"}: ${issue.message}`)
  };
}

function structuredRepairPrompt(invalidOutput: string, issues: string[]): string {
  return JSON.stringify({
    instruction: "Repair only the JSON shape and types. Preserve supported facts. Do not explain the repair.",
    validationErrors: issues,
    invalidOutput: invalidOutput.slice(0, 20_000)
  });
}
