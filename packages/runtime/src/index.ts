import { Agent, DEFAULT_COMPACTION_SETTINGS, InMemorySessionStorage, Session, estimateContextTokens, formatSkillsForSystemPrompt, prepareCompaction, compact, type AgentEvent, type AgentMessage, type AgentTool, type SessionMetadata, type Skill as PiSkill } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { z } from "zod";
import { ModelRouter, resolvePiModel, type RoutingSignals } from "@adpilot/model-router";
import { SkillRegistry } from "@adpilot/skills";
import type { ToolContext, AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";

export interface RuntimeExtension {
  name: string;
  beforeRun?(context: RuntimeRunContext): Promise<void> | void;
  onEvent?(event: AgentEvent, context: RuntimeRunContext): Promise<void> | void;
  afterRun?(result: RuntimeResult, context: RuntimeRunContext): Promise<void> | void;
  onError?(error: Error, context: RuntimeRunContext): Promise<void> | void;
}

export interface RuntimeRunContext extends ToolContext {
  sessionId: string;
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
  model: { provider: string; id: string; tier: string };
  messages: AgentMessage[];
  events: AgentEvent[];
  recovered: boolean;
}

export class PiAgentRuntime {
  constructor(
    private readonly models: Models,
    private readonly router: ModelRouter,
    private readonly workspace: WorkspaceStore,
    private readonly skills: SkillRegistry,
    private readonly tools: AdPilotTools,
    private readonly extensions: RuntimeExtension[] = []
  ) {}

  async run(request: RuntimeRequest): Promise<RuntimeResult> {
    for (const extension of this.extensions) await extension.beforeRun?.(request.context);
    const decision = this.router.route(request.signals);
    let model = resolvePiModel(this.models, decision.ref);
    try {
      let result = await this.execute(request, model, decision.tier, false);
      if (result.messages.some((message) => message.role === "assistant" && message.stopReason === "error") && decision.tier !== "strong") {
        model = resolvePiModel(this.models, this.router.route({ ...request.signals, reviewerEscalated: true }).ref);
        result = await this.execute({ ...request, priorMessages: result.messages }, model, "strong", true);
      }
      for (const extension of this.extensions) await extension.afterRun?.(result, request.context);
      return result;
    } catch (unknownError) {
      const error = unknownError instanceof Error ? unknownError : new Error(String(unknownError));
      for (const extension of this.extensions) await extension.onError?.(error, request.context);
      throw error;
    }
  }

  async runStructured<S extends z.ZodTypeAny>(request: RuntimeRequest, schema: S): Promise<z.output<S>> {
    const result = await this.run({
      ...request,
      systemPrompt: `${request.systemPrompt}\nReturn the final answer as one JSON object matching the requested schema. Do not wrap it in markdown.`
    });
    return schema.parse(parseJsonObject(result.text));
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

  private async execute(request: RuntimeRequest, model: Model<Api>, tier: string, recovered: boolean): Promise<RuntimeResult> {
    const piSkills = this.buildPiSkills(request.allowedSkills ?? []);
    const skillsPrompt = formatSkillsForSystemPrompt(piSkills);
    const session = new Session(new InMemorySessionStorage<SessionMetadata>({ metadata: { id: request.context.sessionId, createdAt: new Date().toISOString() } }));
    const events: AgentEvent[] = [];
    const tools = [...(request.tools ?? [])];
    if ((request.allowedSkills?.length ?? 0) > 0) tools.push(this.createSkillTool(request.context, request.allowedSkills ?? []));
    const agent = new Agent({
      initialState: {
        systemPrompt: `${request.systemPrompt}\n\n${skillsPrompt}`,
        model,
        tools,
        messages: request.priorMessages ?? []
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
    return { text, model: { provider: model.provider, id: model.id, tier }, messages: agent.state.messages.slice(), events, recovered };
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
    const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
    if (!preparation.ok || !preparation.value) return false;
    const result = await compact(preparation.value, this.models, model, customInstructions);
    if (!result.ok) throw result.error;
    await session.appendCompaction(result.value.summary, result.value.firstKeptEntryId, result.value.tokensBefore, result.value.details);
    return true;
  }

  contextUsage(messages: AgentMessage[]) {
    return estimateContextTokens(messages);
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
