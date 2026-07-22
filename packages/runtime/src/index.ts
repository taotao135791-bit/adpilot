import { Agent, DEFAULT_COMPACTION_SETTINGS, Session, estimateContextTokens, formatSkillsForSystemPrompt, prepareCompaction, compact, shouldCompact, type AgentEvent, type AgentMessage, type AgentTool, type CompactionSettings, type Skill as PiSkill } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { z } from "zod";
import { ModelRouter, resolvePiModel, type RoutingSignals } from "@adpilot/model-router";
import { SkillRegistry } from "@adpilot/skills";
import type { ToolContext, AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotSessionStorage, resolvePiSessionId } from "./session-storage.js";

export { AdPilotSessionStorage, resolvePiSessionId } from "./session-storage.js";
export type { AdPilotSessionMetadata } from "./session-storage.js";

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

  createSkillTool(context: ToolContext, allowedSkills: string[]): AgentTool {
    return {
      name: "execute_skill",
      label: "Execute an advertising skill",
      description: `Run one validated advertising method. Allowed skills: ${allowedSkills.join(", ")}`,
      parameters: { type: "object", properties: { name: { type: "string", enum: allowedSkills }, input: {} }, required: ["name", "input"], additionalProperties: false },
      executionMode: "sequential",
      execute: async (_toolCallId, raw) => {
        const params = z.object({ name: z.enum(allowedSkills as [string, ...string[]]), input: z.unknown() }).parse(raw);
        const details = await this.skills.execute(params.name, context, params.input, this.tools);
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      }
    } as AgentTool;
  }

  private async execute(request: ResolvedRuntimeRequest, model: Model<Api>, tier: string, recovered: boolean): Promise<RuntimeResult> {
    const piSkills = this.buildPiSkills(request.allowedSkills ?? []);
    const skillsPrompt = formatSkillsForSystemPrompt(piSkills);
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
      streamFn: (selectedModel, context, options) => this.models.streamSimple(selectedModel, context, options),
      sessionId: request.context.sessionId,
      toolExecution: "sequential",
      maxRetryDelayMs: 30_000,
      beforeToolCall: async ({ toolCall }) => {
        if (toolCall.name === "commit_approved_action") return { block: true, reason: "Approval tokens are never exposed to the model; commit through the approval API." };
        return undefined;
      }
    });
    await this.writeCheckpoint(session, request.context, "running");
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
      const compactionEntryId = await this.compactAtThreshold(session, model, request.context);
      lastCompactionEntryId = compactionEntryId ?? lastCompactionEntryId;
      compacted = compacted || Boolean(compactionEntryId);
      await this.writeCheckpoint(session, request.context, "idle", lastCompactionEntryId ? { compactionEntryId: lastCompactionEntryId } : undefined);
      return { text, sessionId: request.context.sessionId, model: { provider: model.provider, id: model.id, tier }, messages: agent.state.messages.slice(), events, recovered, compacted };
    } catch (error) {
      await this.writeCheckpoint(session, request.context, "failed", { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      throw error;
    }
  }

  private buildPiSkills(names: string[]): PiSkill[] {
    return names.map((name) => {
      const skill = this.skills.get(name);
      return {
        name: skill.name,
        description: skill.description,
        filePath: new URL(`../../skills/${skill.name}.md`, import.meta.url).pathname,
        content: [
          `Prerequisites: ${skill.prerequisites.join("; ")}`,
          `Required tools: ${skill.requiredTools.join("; ") || "none"}`,
          `Failure conditions: ${skill.failureConditions.join("; ")}`,
          `Forbidden: ${skill.forbidden.join("; ")}`
        ].join("\n")
      };
    });
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
