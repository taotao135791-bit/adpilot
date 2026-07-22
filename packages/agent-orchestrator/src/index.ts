import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { ApprovalOperation } from "@adpilot/approvals";
import { PiAgentRuntime } from "@adpilot/runtime";
import { SpecialistCoordinator } from "@adpilot/specialist-agents";
import {
  Evidence,
  migrateLegacyFactDispatch,
  SharedFact,
  SharedFactPayload,
  SharedFactLedger,
  SpecialistRole,
  TaskState,
  type PermissionLevel,
  type SharedFact as SharedFactValue,
  type SharedFactRepository,
  type TaskState as Task
} from "@adpilot/shared";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotTools, VisualApprovalPlanInput } from "@adpilot/tools";

const InvestigationNode = z.object({ question: z.string().min(1), specialist: SpecialistRole, status: z.enum(["pending", "complete", "blocked"]), conclusion: z.string().optional() });
const MainAgentOutput = z.object({
  summary: z.string().min(1), investigationTree: z.array(InvestigationNode).min(1),
  evidence: z.array(Evidence).default([]), hypotheses: z.array(z.string().min(1)).default([]),
  nextStep: z.string().min(1), proposedApprovalIds: z.array(z.string().uuid()).default([]),
  reviewAt: z.string().datetime().nullable().default(null)
});
const LongTermMemory = z.object({
  taskId: z.string().uuid(), at: z.string().datetime(), goal: z.string().min(1), summary: z.string().min(1),
  nextStep: z.string().min(1), reviewAt: z.string().datetime().nullable(), proposedApprovalIds: z.array(z.string().uuid())
});
export type MainAgentOutput = z.infer<typeof MainAgentOutput>;
export interface AgentConversationContext extends Record<string, unknown> {
  conversationId?: string;
  interfaceLocale?: string;
}
const ConversationDecision = z.object({
  mode: z.enum(["answer", "investigate"]),
  reply: z.string().min(1),
  goal: z.string().min(1).nullable()
});

export class AdPilotAgent {
  readonly sharedFacts: SharedFactLedger;

  constructor(
    private readonly runtime: PiAgentRuntime,
    private readonly specialists: SpecialistCoordinator,
    private readonly workspace: WorkspaceStore,
    private readonly tools: AdPilotTools,
    private readonly onTaskState: (task: Task) => void | Promise<void> = () => undefined,
    sharedFacts?: SharedFactLedger
  ) {
    this.sharedFacts = sharedFacts ?? new SharedFactLedger(new WorkspaceSharedFactRepository(workspace));
  }

  async respond(clientId: string, message: string, context: AgentConversationContext = {}): Promise<{ reply: string; task: Task | null; result?: MainAgentOutput }> {
    const client = await this.workspace.readClient(clientId);
    const conversationId = typeof context.conversationId === "string" && context.conversationId.trim() ? context.conversationId.trim() : "primary";
    const verifiedFacts = await this.sharedFacts.usable(clientId);
    const decisionResult = await this.runtime.run({
      context: { clientId, taskId: crypto.randomUUID(), actor: "adpilot_agent", permission: "OBSERVE", sessionId: conversationId, conversationId, role: "adpilot_agent" },
      systemPrompt: [
        "You are AdPilot, the user's persistent advertising operator. Natural conversation is the primary interface.",
        "Choose answer for greetings, product usage, definitions, clarifying questions, and requests that do not require account evidence.",
        "Choose investigate for account-specific diagnosis, measurement review, optimization, creative analysis, or any request that should gather evidence or prepare an operation.",
        "Never claim you inspected an account in answer mode. Never mutate an account from this decision turn.",
        "Use context.interfaceLocale: Simplified Chinese for zh-CN and English for en. Keep the reply direct and useful.",
        'Return exactly one JSON object: {"mode":"answer"|"investigate","reply":"user-facing text","goal":"investigation goal"|null}. Do not rename these fields or wrap the object in markdown.'
      ].join("\n"),
      prompt: JSON.stringify({ message, client, context: sanitizeConversationContext(context), verifiedFacts }),
      signals: { task: "conversation" }
    });
    const decision = parseConversationDecision(decisionResult.text, message, context.interfaceLocale);
    if (decision.mode === "answer") return { reply: decision.reply, task: null };
    const investigation = await this.runTask(clientId, decision.goal ?? message, context);
    return { reply: investigation.result.summary, task: investigation.task, result: investigation.result };
  }

  async startTask(clientId: string, goal: string): Promise<Task> {
    const now = new Date().toISOString();
    const task = TaskState.parse({ id: crypto.randomUUID(), clientId, goal, phase: "intake", createdAt: now, updatedAt: now, nextStep: "Build an evidence-driven investigation tree" });
    await this.persistTask(task);
    return task;
  }

  async runTask(clientId: string, goal: string, context: AgentConversationContext = {}): Promise<{
    task: Task;
    result: MainAgentOutput;
    specialistResults: Record<string, unknown>;
    sharedFacts: SharedFactValue[];
  }> {
    const [clientContext, memory] = await Promise.all([
      this.workspace.readClient(clientId),
      this.workspace.readJsonl(clientId, "memory/agent.jsonl", LongTermMemory)
    ]);
    let task = await this.startTask(clientId, goal);
    const inherited = await this.sharedFacts.usable(clientId);
    await this.sharedFacts.deriveForTask(clientId, task.id, inherited);
    let taskFacts = await this.sharedFacts.usable(clientId, { taskId: task.id });
    const projectContext = {
      client: clientContext,
      verifiedFacts: taskFacts,
      conversation: sanitizeConversationContext(context),
      recentDecisionMemory: memory.slice(-20)
    };
    const conversationId = typeof context.conversationId === "string" && context.conversationId.trim() ? context.conversationId.trim() : `task-${task.id}`;
    task = TaskState.parse({ ...task, phase: "investigating", owner: null, nextStep: "Dispatch specialists and collect evidence", updatedAt: new Date().toISOString() });
    await this.persistTask(task);
    const specialistResults: Record<string, unknown> = {};
    const createdApprovalIds: string[] = [];
    const dispatchTool: AgentTool = {
      name: "dispatch_specialist",
      label: "Dispatch an isolated specialist",
      description: "Run one specialist with an isolated context and structured input. The account operator can observe the managed browser, read a visible advertising table, or prepare a field without submitting it. Measurement should be reviewed before optimization changes.",
      parameters: Type.Object({ role: Type.Union(SpecialistRole.options.map((role) => Type.Literal(role))), input: Type.Unknown() }),
      executionMode: "sequential",
      execute: async (_id, raw) => {
        const params = z.object({ role: SpecialistRole, input: z.unknown() }).parse(raw);
        task = TaskState.parse({ ...task, owner: params.role, updatedAt: new Date().toISOString() });
        await this.persistTask(task);
        taskFacts = await this.sharedFacts.usable(clientId, { taskId: task.id });
        const output = await this.specialists.dispatch(params.role, {
          context: {
            clientId,
            taskId: task.id,
            actor: "adpilot_agent",
            permission: conversationSpecialistPermission(params.role, params.input)
          },
          input: params.input,
          sharedFacts: taskFacts
        });
        specialistResults[params.role] = output;
        await this.sharedFacts.create({
          clientId,
          taskId: task.id,
          subject: `specialist:${params.role}`,
          predicate: "conclusion",
          value: factPayloadFromUnknown(output),
          unit: "",
          sourceType: "specialist_output",
          sourceScreenshotId: null,
          sourceBoundingBox: null,
          evidenceIds: evidenceIdsFromUnknown(output),
          confidence: confidenceFromUnknown(output),
          createdBy: params.role,
          expiresAt: null,
          status: "hypothesis"
        });
        task = TaskState.parse({ ...task, owner: null, updatedAt: new Date().toISOString() });
        await this.persistTask(task);
        return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
      }
    };
    const prepareApprovalTool: AgentTool = {
      name: "prepare_approval",
      label: "Prepare an approval request",
      description: "Persist one exact, evidence-backed advertising operation and its visual execution plan. This does not approve or execute it.",
      parameters: Type.Object({ operation: Type.Unknown(), executionPlan: Type.Unknown() }),
      executionMode: "sequential",
      execute: async (_id, raw) => {
        const params = z.object({ operation: ApprovalOperation, executionPlan: VisualApprovalPlanInput }).parse(raw);
        const approval = await this.tools.createApproval({ clientId, taskId: task.id, actor: "adpilot_agent", permission: "OBSERVE" }, params.operation, params.executionPlan);
        createdApprovalIds.push(approval.id);
        return { content: [{ type: "text", text: JSON.stringify({ approvalId: approval.id, status: approval.status }) }], details: { approvalId: approval.id, status: approval.status } };
      }
    };
    let modelResult: MainAgentOutput;
    try {
      modelResult = await this.runtime.runStructured({
        context: { clientId, taskId: task.id, actor: "adpilot_agent", permission: "OBSERVE", sessionId: conversationId, conversationId, role: "adpilot_agent" },
        systemPrompt: [
          "You are AdPilot Agent, the single user-facing owner of an advertising account.",
          "Maintain the goal and investigation tree, proactively gather evidence, use specialists as bounded experts, and make the final synthesis yourself.",
          "Use projectContext.conversation.interfaceLocale for every user-facing summary, hypothesis, conclusion, blocker, and next step. Use Simplified Chinese for zh-CN and English for en.",
          "Treat projectContext.verifiedFacts as the only production account facts. Never convert ordinary context objects, historical prose, hypotheses, observations, stale facts, or specialist assertions into definite account claims.",
          "Every numerical account claim sent to a specialist must be supported by a matching verified fact with screenshot evidence that has not expired.",
          "When account evidence is missing, dispatch account_operator with visualTable. Supply platform and targetColumns (key, label, valueType, unit, critical), optional targetRows, and scrollDirection. Omit tableRoi unless the user has explicitly supplied exact screenshot-pixel coordinates; the product derives a safe live browser-content ROI. Use scrollDirection none for a visible page, or down/right only when reading additional rows or columns.",
          "For non-table visual observation or safe preparation, dispatch account_operator with one visualTask. It must request only OBSERVE or INTERACT. This conversational run can never dispatch MUTATE or DESTRUCTIVE actions and can never Save, Apply, Publish, confirm, or press Enter to submit.",
          "Review measurement reliability before optimization. Never mutate an account from this conversational run.",
          "For an executable operation, use prepare_approval exactly once per single-variable change. Never invent an approval id and never execute from this run.",
          "The prepare_approval executionPlan is intent, not guessed native state. Supply schemaVersion 1, platform, exact visible accountName/accountId/campaignName/campaignId/pageType, operation/currentValue/proposedValue, a precise instruction/target/expectedResult, allowedRegion in screenshot_pixels, riskLevel, and experiment. The product binds browser Profile, native application/window, live surface hash, live dual-reviewed account hash, timestamps, and plan id from the managed browser."
        ].join("\n"),
        prompt: JSON.stringify({ goal, projectContext, currentTask: task }),
        signals: { task: "planning" }, tools: [dispatchTool, prepareApprovalTool]
      }, MainAgentOutput);
    } catch (error) {
      const blocker = error instanceof Error ? error.message : String(error);
      task = TaskState.parse({ ...task, phase: "blocked", owner: null, blockers: [...task.blockers, blocker], nextStep: "Resolve the recorded blocker and retry", updatedAt: new Date().toISOString() });
      await this.persistTask(task);
      throw error;
    }
    const result = MainAgentOutput.parse({ ...modelResult, proposedApprovalIds: createdApprovalIds });
    task = TaskState.parse({
      ...task,
      phase: result.proposedApprovalIds.length ? "awaiting_approval" : "completed",
      completedSteps: result.investigationTree.filter((node) => node.status === "complete").map((node) => node.question),
      evidence: result.evidence,
      hypotheses: result.hypotheses,
      blockers: result.investigationTree.filter((node) => node.status === "blocked").map((node) => node.conclusion ?? node.question),
      nextStep: result.nextStep, reviewAt: result.reviewAt, updatedAt: new Date().toISOString()
    });
    await this.persistTask(task);
    await this.workspace.appendJsonl(clientId, "decisions.jsonl", { taskId: task.id, at: new Date().toISOString(), goal, result });
    await this.workspace.appendJsonl(clientId, "memory/agent.jsonl", LongTermMemory.parse({
      taskId: task.id, at: new Date().toISOString(), goal, summary: result.summary,
      nextStep: result.nextStep, reviewAt: result.reviewAt, proposedApprovalIds: result.proposedApprovalIds
    }));
    await this.sharedFacts.create({
      clientId,
      taskId: task.id,
      subject: `task:${task.id}`,
      predicate: "root_agent_synthesis",
      value: { summary: result.summary, nextStep: result.nextStep },
      unit: "",
      sourceType: "specialist_output",
      sourceScreenshotId: null,
      sourceBoundingBox: null,
      evidenceIds: result.evidence.map((item) => item.id),
      confidence: result.evidence.length ? Math.min(...result.evidence.map((item) => confidenceFromUnknown(item.facts))) : 0.5,
      createdBy: "adpilot_agent",
      expiresAt: result.reviewAt,
      status: "hypothesis"
    });
    return {
      task,
      result,
      specialistResults,
      sharedFacts: await this.sharedFacts.list(clientId, { taskId: task.id, includeTerminal: true })
    };
  }

  private async persistTask(task: Task): Promise<void> {
    await this.workspace.saveTask(task);
    await this.onTaskState(task);
  }
}

function parseConversationDecision(text: string, userMessage: string, locale: unknown): z.infer<typeof ConversationDecision> {
  const payload = parsePossibleJson(text);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const mode = normalizeDecisionMode(firstString(record.mode, record.action, record.intent, record.type));
    const reply = firstString(record.reply, record.message, record.answer, record.response, record.content, record.text, record.summary);
    const goal = firstString(record.goal, record.task, record.objective, record.instruction);
    const parsed = ConversationDecision.safeParse({ mode: mode ?? fallbackDecisionMode(userMessage), reply, goal: goal ?? (mode === "investigate" ? userMessage : null) });
    if (parsed.success) return parsed.data;
    throw new Error("model response did not contain a usable conversational reply");
  }

  if (typeof payload === "string" && payload.trim()) {
    const mode = fallbackDecisionMode(userMessage);
    return ConversationDecision.parse({ mode, reply: payload.trim(), goal: mode === "investigate" ? userMessage : null });
  }

  throw new Error(locale === "en" ? "model returned an empty conversational response" : "模型没有返回可用的对话内容");
}

function parsePossibleJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed) return "";
  try { return JSON.parse(trimmed); } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return trimmed; }
    }
    return trimmed;
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function normalizeDecisionMode(value: string | undefined): "answer" | "investigate" | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().trim();
  if (["answer", "reply", "respond", "chat", "回答", "回复"].includes(normalized)) return "answer";
  if (["investigate", "analyze", "analyse", "audit", "diagnose", "task", "调查", "分析", "诊断"].includes(normalized)) return "investigate";
  return undefined;
}

function fallbackDecisionMode(message: string): "answer" | "investigate" {
  const investigationIntent = /(?:帮我|请|替我|我的|这个|当前).{0,12}(?:检查|查看|诊断|审计|分析|优化|调整|修改|暂停|开启)|(?:检查|查看|诊断|审计|优化|调整|修改|暂停|开启).{0,12}(?:账户|广告|系列|投放|预算|出价|素材|归因)|\b(?:diagnose|audit|inspect|optimi[sz]e|change|adjust|pause|enable|increase|decrease)\b.{0,40}\b(?:my|this|account|campaign|ads?|budget|bid|creative|attribution)\b/i;
  return investigationIntent.test(message) ? "investigate" : "answer";
}

/**
 * Derives the least privilege needed by a conversational specialist call.
 * Mutations are deliberately unavailable here; they can only run through the
 * independently approved execution path.
 */
export function conversationSpecialistPermission(role: z.infer<typeof SpecialistRole>, input: unknown): PermissionLevel {
  if (role !== "account_operator" || !input || typeof input !== "object" || Array.isArray(input)) return "OBSERVE";
  const record = input as Record<string, unknown>;
  const visualTask = record.visualTask;
  if (visualTask && typeof visualTask === "object" && !Array.isArray(visualTask)) {
    const permission = (visualTask as Record<string, unknown>).permission;
    if (permission === "INTERACT") return "INTERACT";
    if (permission === "MUTATE" || permission === "DESTRUCTIVE") {
      throw new Error("conversational account operator cannot execute approved mutations");
    }
    return "OBSERVE";
  }
  const visualTable = record.visualTable;
  if (visualTable && typeof visualTable === "object" && !Array.isArray(visualTable)) {
    const direction = (visualTable as Record<string, unknown>).scrollDirection;
    return direction === "down" || direction === "right" ? "INTERACT" : "OBSERVE";
  }
  return "OBSERVE";
}

/** Disk-backed canonical fact repository; legacy rows are quarantined as migration facts. */
export class WorkspaceSharedFactRepository implements SharedFactRepository {
  private readonly relativePath = "facts/shared-facts.json";

  constructor(private readonly workspace: WorkspaceStore) {}

  async load(clientId: string): Promise<SharedFactValue[]> {
    const content = await this.workspace.readText(clientId, this.relativePath);
    if (!content) return [];
    const raw: unknown = JSON.parse(content);
    const canonical = z.array(SharedFact).safeParse(raw);
    if (canonical.success) return canonical.data;
    if (!Array.isArray(raw)) throw new Error("shared fact repository is not an array");
    const migrated: SharedFactValue[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const taskId = (item as Record<string, unknown>).task_id;
      if (typeof taskId !== "string" || !z.string().uuid().safeParse(taskId).success) continue;
      try {
        migrated.push(...migrateLegacyFactDispatch([item], { clientId, taskId }));
      } catch {
        // Invalid legacy rows remain quarantined and never enter production.
      }
    }
    return migrated;
  }

  async save(clientId: string, facts: readonly SharedFactValue[]): Promise<void> {
    await this.workspace.writeJson(clientId, this.relativePath, z.array(SharedFact).parse(facts));
  }
}

function sanitizeConversationContext(context: AgentConversationContext): Record<string, string> {
  const sanitized: Record<string, string> = {};
  if (typeof context.conversationId === "string" && context.conversationId.trim()) sanitized.conversationId = context.conversationId.trim();
  if (typeof context.interfaceLocale === "string" && context.interfaceLocale.trim()) sanitized.interfaceLocale = context.interfaceLocale.trim();
  return sanitized;
}

function evidenceIdsFromUnknown(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 6 || item === null || item === undefined) return;
    if (typeof item === "string") {
      if (/^(?:screenshot|evidence|export|workspace|calculation):/.test(item)) ids.add(item);
      return;
    }
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry, depth + 1);
      return;
    }
    if (typeof item === "object") for (const entry of Object.values(item as Record<string, unknown>)) visit(entry, depth + 1);
  };
  visit(value, 0);
  return [...ids];
}

function confidenceFromUnknown(value: unknown): number {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const confidence = (value as Record<string, unknown>).confidence;
    if (typeof confidence === "number" && Number.isFinite(confidence)) return Math.max(0, Math.min(1, confidence));
  }
  return 0.5;
}

function factPayloadFromUnknown(value: unknown): z.infer<typeof SharedFactPayload> {
  const parsed = SharedFactPayload.safeParse(value);
  if (parsed.success) return structuredClone(parsed.data);
  return JSON.stringify(value ?? null);
}

export { MainAgentOutput };
