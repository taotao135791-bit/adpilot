import { Agent, DEFAULT_COMPACTION_SETTINGS, Session, estimateContextTokens, prepareCompaction, compact, shouldCompact, type AgentEvent, type AgentMessage, type AgentTool, type CompactionSettings } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, Models } from "@earendil-works/pi-ai";
import { z } from "zod";
import { ModelRouter, resolvePiModel, type RoutingSignals } from "@adpilot/model-router";
import { SkillRegistry, formatSkillContract } from "@adpilot/skills";
import type { ToolContext, AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotSessionStorage, resolvePiSessionId } from "./session-storage.js";
import { ToolPermissionGate } from "./tool-gate.js";
import { conversationMessageLabel, forkConversationStorage, type ConversationForkResult } from "./conversation-fork.js";

export { AdPilotSessionStorage, resolvePiSessionId } from "./session-storage.js";
export type { AdPilotSessionMetadata } from "./session-storage.js";
export { ToolPermissionGate } from "./tool-gate.js";
export { AuditRuntimeExtension, sanitizeForAudit } from "./audit-extension.js";
export { FORK_CUSTOM_ENTRY_TYPE, conversationMessageLabel, forkConversationStorage, resolveForkLeafId } from "./conversation-fork.js";
export type { ConversationForkResult } from "./conversation-fork.js";

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
    this.toolGate = new ToolPermissionGate(tools.approvals, tools.audit);
  }

  async run(request: RuntimeRequest): Promise<RuntimeResult> {
    const resolvedRequest = this.resolveRequest(request);
    return this.withSessionLock(resolvedRequest.context.sessionId, async () => {
      for (const extension of this.extensions) await extension.beforeRun?.(resolvedRequest.context);
      const decision = this.router.route(resolvedRequest.signals);
      let model = resolvePiModel(this.models, decision.ref);
      try {
        let result = await this.execute(resolvedRequest, model, decision.tier, false);
        if (result.messages.some((message) => message.role === "assistant" && message.stopReason === "error") && decision.tier !== "strong") {
          model = resolvePiModel(this.models, this.router.route({ ...resolvedRequest.signals, reviewerEscalated: true }).ref);
          result = await this.execute({ ...resolvedRequest, priorMessages: result.messages }, model, "strong", true);
        }
        for (const extension of this.extensions) await extension.afterRun?.(result, resolvedRequest.context);
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
    const first = await this.run({
      ...request,
      systemPrompt: `${request.systemPrompt}\nReturn the final answer as one JSON object matching the requested schema. Do not wrap it in markdown.`
    });
    const firstParsed = parseStructured(first.text, schema);
    if (firstParsed.success) return { output: firstParsed.data, runtime: first, attempts: 1, repaired: false };

    const sameModelRepair = await this.run({
      ...request,
      systemPrompt: "You repair structured JSON. Return exactly one corrected JSON object and nothing else. Never call tools or add facts.",
      prompt: structuredRepairPrompt(first.text, firstParsed.issues),
      tools: [], allowedSkills: []
    });
    const secondParsed = parseStructured(sameModelRepair.text, schema);
    if (secondParsed.success) return { output: secondParsed.data, runtime: sameModelRepair, attempts: 2, repaired: true };

    const strongRepair = await this.run({
      ...request,
      systemPrompt: "You are the final high-assurance JSON repair pass. Return exactly one corrected JSON object and nothing else. Never call tools or add facts.",
      prompt: structuredRepairPrompt(sameModelRepair.text, secondParsed.issues),
      signals: { ...request.signals, reviewerEscalated: true },
      tools: [], allowedSkills: []
    });
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

  private async execute(request: ResolvedRuntimeRequest, model: Model<Api>, tier: string, recovered: boolean): Promise<RuntimeResult> {
    const skillsPrompt = this.buildSkillsPrompt(request.allowedSkills ?? []);
    const storage = await AdPilotSessionStorage.openOrCreate(this.workspace, request.context.clientId, request.context.conversationId);
    const session = new Session(storage);
    if ((await session.getEntries()).length === 0 && request.priorMessages?.length) {
      for (const message of request.priorMessages) await session.appendMessage(message);
    }
    let lastCompactionEntryId = await this.compactAtThreshold(session, model, request.context);
    let compacted = Boolean(lastCompactionEntryId);
    const persistedContext = await session.buildContext();
    const events: AgentEvent[] = [];
    const tools = [...(request.tools ?? [])];
    if ((request.allowedSkills?.length ?? 0) > 0) tools.push(this.createSkillTool(request.context, request.allowedSkills ?? []));
    const agent = new Agent({
      initialState: {
        systemPrompt: `${request.systemPrompt}\n\n${skillsPrompt}`,
        model,
        tools,
        messages: persistedContext.messages
      },
      convertToLlm: adpilotConvertToLlm,
      streamFn: (selectedModel, context, options) => this.models.streamSimple(selectedModel, context, options),
      sessionId: request.context.sessionId,
      toolExecution: "sequential",
      maxRetryDelayMs: 30_000,
      beforeToolCall: async ({ toolCall, args }) => {
        if (toolCall.name === "commit_approved_action") return { block: true, reason: "Approval tokens are never exposed to the model; commit through the approval API." };
        const denial = await this.toolGate.check(toolCall.name, args, request.context);
        if (denial) return { block: true, reason: denial };
        return undefined;
      }
    });
    await this.writeCheckpoint(session, request.context, "running");
    this.activeSessions.set(request.context.sessionId, {
      agent,
      clientId: request.context.clientId,
      conversationId: request.context.conversationId,
      sessionId: request.context.sessionId,
      startedAt: new Date().toISOString()
    });
    try {
      agent.subscribe(async (event) => {
        events.push(event);
        for (const extension of this.extensions) await extension.onEvent?.(event, request.context);
        if (event.type === "message_end") {
          await session.appendMessage(event.message);
          await this.workspace.appendJsonl(request.context.clientId, `traces/${request.context.sessionId}.jsonl`, { type: "message", at: new Date().toISOString(), message: event.message });
        }
      });
      await agent.prompt(request.prompt);
      await agent.waitForIdle();
      const text = lastAssistantText(agent.state.messages);
      if (request.context.userMessageId) {
        await this.labelConversationMessage(session, request.prompt, request.context.userMessageId);
      }
      const compactionEntryId = await this.compactAtThreshold(session, model, request.context);
      lastCompactionEntryId = compactionEntryId ?? lastCompactionEntryId;
      compacted = compacted || Boolean(compactionEntryId);
      await this.writeCheckpoint(session, request.context, "idle", lastCompactionEntryId ? { compactionEntryId: lastCompactionEntryId } : undefined);
      return { text, sessionId: request.context.sessionId, model: { provider: model.provider, id: model.id, tier }, messages: agent.state.messages.slice(), events, recovered, compacted };
    } catch (error) {
      await this.writeCheckpoint(session, request.context, "failed", { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      throw error;
    } finally {
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
    context: RuntimeRunContext & { conversationId: string }
  ): Promise<string | undefined> {
    if (model.contextWindow <= 0) return undefined;
    const sessionContext = await session.buildContext();
    const usage = estimateContextTokens(sessionContext.messages);
    if (!shouldCompact(usage.tokens, model.contextWindow, this.compactionSettings)) return undefined;
    const entries = await session.getBranch();
    const preparation = prepareCompaction(entries, this.compactionSettings);
    if (!preparation.ok) throw preparation.error;
    if (!preparation.value) return undefined;
    await this.writeCheckpoint(session, context, "compacting", {
      firstKeptEntryId: preparation.value.firstKeptEntryId,
      tokensBefore: preparation.value.tokensBefore
    });
    const result = await compact(preparation.value, this.models, model, this.compactionInstructions);
    if (!result.ok) throw result.error;
    const compactionEntryId = await session.appendCompaction(
      result.value.summary,
      result.value.firstKeptEntryId,
      result.value.tokensBefore,
      result.value.details
    );
    await this.writeCheckpoint(session, context, "compacted", {
      firstKeptEntryId: result.value.firstKeptEntryId,
      tokensBefore: result.value.tokensBefore,
      compactionEntryId
    });
    return compactionEntryId;
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
