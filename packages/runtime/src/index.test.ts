import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { SkillRegistry } from "@adpilot/skills";
import { AdPilotTools, type ToolContext } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotSessionStorage, PiAgentRuntime, RuntimeUserStopped, StructuredOutputBlocker, resolvePiSessionId } from "./index.js";

describe("PiAgentRuntime", () => {
  it("starts a Pi session, calls a skill through a tool, streams events, and returns structured output", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-runtime-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("execute_skill", { name: "detect-creative-fatigue", input: { currentCtr: 0.01, priorCtr: 0.02, frequency: 4, daysRunning: 10, spendShare: 0.5 } }), { stopReason: "toolUse" }),
      fauxAssistantMessage('{"finding":"fatigued","confidence":0.9}')
    ]);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const inputSessionId = crypto.randomUUID();
    const output = await runtime.runStructured({
      context: { clientId: "client-a", taskId: crypto.randomUUID(), actor: "creative_strategist", permission: "OBSERVE", sessionId: inputSessionId, role: "creative_strategist" },
      systemPrompt: "Analyze creative evidence.", prompt: "Review fatigue.", signals: { task: "classification" }, allowedSkills: ["detect-creative-fatigue"]
    }, z.object({ finding: z.string(), confidence: z.number() }));
    expect(output).toEqual({ finding: "fatigued", confidence: 0.9 });
    expect(faux.state.callCount).toBe(2);
    const session = await AdPilotSessionStorage.openOrCreate(workspace, "client-a", inputSessionId);
    const messageEntries = (await session.getEntries()).filter((entry) => entry.type === "message");
    expect(messageEntries.map((entry) => entry.message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("exposes skill input contracts in the execute_skill tool and system prompt without file references", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-runtime-contract-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    let requestPayload = "";
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([(context) => {
      requestPayload = JSON.stringify(context);
      return fauxAssistantMessage("done");
    }]);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const context: ToolContext = { clientId: "client-a", taskId: crypto.randomUUID(), actor: "creative_strategist", permission: "OBSERVE" };

    const tool = runtime.createSkillTool(context, ["detect-creative-fatigue"]);
    expect(tool.description).toContain("currentCtr: number >= 0 (required)");
    expect(tool.description).toContain("priorCtr: number > 0 (required)");
    expect(tool.description).toContain("Forbidden: Pausing solely from CTR");
    const parameters = tool.parameters as { properties: { name: { enum: string[] }, input: { type?: string, description?: string } } };
    expect(parameters.properties.name.enum).toEqual(["detect-creative-fatigue"]);
    expect(parameters.properties.input.type).toBe("object");
    expect(parameters.properties.input.description).toContain("contract");

    await runtime.run({
      context: { ...context, sessionId: crypto.randomUUID(), role: "creative_strategist" },
      systemPrompt: "Analyze creative evidence.", prompt: "Review fatigue.", signals: { task: "classification" }, allowedSkills: ["detect-creative-fatigue"]
    });
    expect(requestPayload).toContain("<available_skills>");
    expect(requestPayload).toContain("currentCtr: number >= 0 (required)");
    expect(requestPayload).not.toContain("detect-creative-fatigue.md");
  });

  it("shows captured pixels to the current model turn but never persists or returns them", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-runtime-image-privacy-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const encodedPixels = "U0NSRUVOU0hPVF9TRU5USU5FTF8=".repeat(128);
    let liveToolContext = "";
    let restoredContext = "";
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("computer.observe", {}), { stopReason: "toolUse" }),
      (context) => {
        liveToolContext = JSON.stringify(context.messages);
        return fauxAssistantMessage("I inspected the current window.");
      },
      (context) => {
        restoredContext = JSON.stringify(context.messages);
        return fauxAssistantMessage("The prior pixels are no longer available.");
      }
    ]);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const observe = {
      name: "computer.observe",
      label: "Observe exact window",
      description: "privacy test double",
      parameters: { type: "object", properties: {} },
      executionMode: "sequential",
      execute: async () => {
        const details = {
          data: { app: "AdPilot", window: { id: 42 } },
          image: { data: encodedPixels, mimeType: "image/jpeg" }
        };
        return {
          content: [
            { type: "text", text: JSON.stringify(details) },
            { type: "image", data: encodedPixels, mimeType: "image/jpeg" }
          ],
          details
        };
      }
    } as AgentTool;
    const conversationId = "image-private";
    const first = await runtime.run({
      context: { clientId: "client-a", conversationId, taskId: crypto.randomUUID(), actor: "adpilot_agent", permission: "OBSERVE", sessionId: crypto.randomUUID(), role: "adpilot_agent" },
      systemPrompt: "Inspect the image only for this turn.",
      prompt: "What is visible?",
      signals: { task: "conversation" },
      tools: [observe]
    });

    expect(liveToolContext).toContain(encodedPixels);
    expect(liveToolContext).toContain("\"type\":\"image\"");
    expect(JSON.stringify(first.messages)).not.toContain(encodedPixels);
    expect(JSON.stringify(first.events)).not.toContain(encodedPixels);
    expect(JSON.stringify(first.messages)).toContain("captured image omitted from persisted session");

    const sessionText = await workspace.readText("client-a", `sessions/${first.sessionId}.jsonl`);
    const traceText = await workspace.readText("client-a", `traces/${first.sessionId}.jsonl`);
    expect(sessionText).not.toContain(encodedPixels);
    expect(traceText).not.toContain(encodedPixels);
    expect(sessionText).toContain("captured image omitted from persisted session");

    await runtime.run({
      context: { clientId: "client-a", conversationId, taskId: crypto.randomUUID(), actor: "adpilot_agent", permission: "OBSERVE", sessionId: crypto.randomUUID(), role: "adpilot_agent" },
      systemPrompt: "Continue without stale pixels.",
      prompt: "Continue.",
      signals: { task: "conversation" }
    });
    expect(restoredContext).not.toContain(encodedPixels);
    expect(restoredContext).not.toContain("\"type\":\"image\"");
    expect(restoredContext).toContain("captured image omitted from persisted session");
  });

  it("reopens the same disk session for a stable client and conversation mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-runtime-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    let secondContext = "";
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage("first answer"),
      (context) => {
        secondContext = JSON.stringify(context.messages);
        return fauxAssistantMessage("second answer");
      }
    ]);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const base = { clientId: "client-a", taskId: crypto.randomUUID(), actor: "analyst", permission: "OBSERVE" as const, role: "analyst", conversationId: "conversation-42" };
    const [first, second] = await Promise.all([
      runtime.run({ context: { ...base, sessionId: crypto.randomUUID() }, systemPrompt: "Be concise.", prompt: "first question", signals: { task: "conversation" } }),
      runtime.run({ context: { ...base, sessionId: crypto.randomUUID() }, systemPrompt: "Be concise.", prompt: "second question", signals: { task: "conversation" } })
    ]);

    expect(first.sessionId).toBe(resolvePiSessionId("client-a", "conversation-42"));
    expect(second.sessionId).toBe(first.sessionId);
    expect(secondContext).toContain("first question");
    expect(secondContext).toContain("first answer");
    const storage = await AdPilotSessionStorage.openOrCreate(workspace, "client-a", "conversation-42");
    expect((await storage.getEntries()).filter((entry) => entry.type === "message")).toHaveLength(4);
  });

  it("runs real Pi compaction at the configured threshold and writes a recovery checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-runtime-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const faux = fauxProvider({ provider: "test", models: [
      { id: "fast", contextWindow: 160, maxTokens: 64 },
      { id: "strong", reasoning: true, contextWindow: 160, maxTokens: 64 }
    ] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage("campaign-42 analysis completed"),
      fauxAssistantMessage("Compacted campaign-42 history with its budget and approval state.")
    ]);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools, [], {
      compaction: { enabled: true, reserveTokens: 40, keepRecentTokens: 1 }
    });
    const result = await runtime.run({
      context: { clientId: "client-a", conversationId: "compact-me", taskId: crypto.randomUUID(), actor: "analyst", permission: "OBSERVE", sessionId: crypto.randomUUID(), role: "analyst" },
      systemPrompt: `Preserve advertising facts. ${"context ".repeat(100)}`,
      prompt: "Analyze campaign-42 without changing it.",
      signals: { task: "causal_analysis" }
    });

    expect(result.compacted).toBe(true);
    expect(faux.state.callCount).toBe(2);
    const storage = await AdPilotSessionStorage.openOrCreate(workspace, "client-a", "compact-me");
    const compactions = await storage.findEntries("compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.summary).toContain("Compacted campaign-42 history");
    const checkpoint = await workspace.readJson("client-a", `sessions/${result.sessionId}.recovery.json`, z.object({
      phase: z.literal("idle"), sessionId: z.string(), leafId: z.string(), entryCount: z.number(), compactionEntryId: z.string()
    }));
    expect(checkpoint.compactionEntryId).toBe(compactions[0]?.id);
  });

  it("repairs invalid structured output with the same model before escalating", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-structured-repair-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage('{"recommendation":"increase"}'),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("validationErrors");
        return fauxAssistantMessage('{"recommendation":"increase","confidence":0.84}');
      }
    ]);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const result = await runtime.runStructuredDetailed({
      context: { clientId: "client-a", conversationId: "repair", taskId: crypto.randomUUID(), actor: "media_buyer", permission: "OBSERVE", sessionId: "repair", role: "media_buyer" },
      systemPrompt: "Return a recommendation.", prompt: "Review the budget.", signals: { task: "classification" }
    }, z.object({ recommendation: z.enum(["increase", "hold"]), confidence: z.number().min(0).max(1) }));
    expect(result).toMatchObject({ output: { recommendation: "increase", confidence: 0.84 }, attempts: 2, repaired: true, runtime: { model: { tier: "fast" } } });
  });

  it("uses the strong model for final repair and returns a typed blocker after three failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-structured-blocker-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const request = {
      context: { clientId: "client-a", conversationId: "strong-repair", taskId: crypto.randomUUID(), actor: "reviewer", permission: "OBSERVE" as const, sessionId: "strong-repair", role: "reviewer" },
      systemPrompt: "Return a verdict.", prompt: "Review.", signals: { task: "classification" as const }
    };
    const schema = z.object({ approved: z.boolean(), reason: z.string().min(1) });
    faux.setResponses([fauxAssistantMessage("{}"), fauxAssistantMessage("{}"), fauxAssistantMessage('{"approved":false,"reason":"insufficient evidence"}')]);
    await expect(runtime.runStructuredDetailed(request, schema)).resolves.toMatchObject({ attempts: 3, repaired: true, output: { approved: false }, runtime: { model: { tier: "strong" } } });

    faux.setResponses([fauxAssistantMessage("{}"), fauxAssistantMessage("{}"), fauxAssistantMessage("{}")]);
    await expect(runtime.runStructuredDetailed({ ...request, context: { ...request.context, conversationId: "blocked-repair", sessionId: "blocked-repair" } }, schema)).rejects.toBeInstanceOf(StructuredOutputBlocker);
  });
});

describe("PiAgentRuntime session injection", () => {
  function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  async function waitFor(condition: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "adpilot-runtime-inject-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    return { workspace, faux, runtime };
  }

  /** Read-classified test double (TOOL_GATE_RULES passes it) that blocks mid-execution until released. */
  function slowMetricsTool(onStart: () => void, hold: Promise<void>): AgentTool {
    return {
      name: "analyze_campaign_metrics",
      label: "Analyze campaign metrics",
      description: "test double",
      parameters: { type: "object", properties: {} },
      executionMode: "sequential",
      execute: async () => {
        onStart();
        await hold;
        return { content: [{ type: "text", text: "metrics ok" }], details: { ok: true } };
      }
    } as AgentTool;
  }

  const baseContext = { clientId: "client-a", taskId: crypto.randomUUID(), actor: "adpilot_agent", permission: "OBSERVE" as const, role: "adpilot_agent" };

  async function messageRoles(workspace: WorkspaceStore, conversationId: string): Promise<string[]> {
    const storage = await AdPilotSessionStorage.openOrCreate(workspace, "client-a", conversationId);
    return (await storage.getEntries())
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message.role);
  }

  it("stops only an exact client and conversation match after clearing both message queues", async () => {
    const { runtime } = await setup();
    const firstAgent = {
      clearAllQueues: vi.fn(),
      abort: vi.fn()
    };
    const secondAgent = {
      clearAllQueues: vi.fn(),
      abort: vi.fn()
    };
    const activeSessions = (runtime as unknown as {
      activeSessions: Map<string, {
        agent: typeof firstAgent;
        clientId: string;
        conversationId: string;
        sessionId: string;
        startedAt: string;
      }>;
    }).activeSessions;
    activeSessions.set(resolvePiSessionId("client-a", "shared-conversation"), {
      agent: firstAgent,
      clientId: "client-a",
      conversationId: "shared-conversation",
      sessionId: resolvePiSessionId("client-a", "shared-conversation"),
      startedAt: new Date().toISOString()
    });
    activeSessions.set(resolvePiSessionId("client-b", "shared-conversation"), {
      agent: secondAgent,
      clientId: "client-b",
      conversationId: "shared-conversation",
      sessionId: resolvePiSessionId("client-b", "shared-conversation"),
      startedAt: new Date().toISOString()
    });

    expect(runtime.stopConversation("client-a", "other-conversation")).toBe(false);
    expect(runtime.stopConversation("client-c", "shared-conversation")).toBe(false);
    expect(firstAgent.abort).not.toHaveBeenCalled();
    expect(secondAgent.abort).not.toHaveBeenCalled();

    expect(runtime.stopConversation("client-a", "shared-conversation")).toBe(true);
    expect(firstAgent.clearAllQueues).toHaveBeenCalledOnce();
    expect(firstAgent.abort).toHaveBeenCalledOnce();
    expect(firstAgent.clearAllQueues.mock.invocationCallOrder[0]!).toBeLessThan(firstAgent.abort.mock.invocationCallOrder[0]!);
    expect(secondAgent.clearAllQueues).not.toHaveBeenCalled();
    expect(secondAgent.abort).not.toHaveBeenCalled();
  });

  it("propagates Stop through the active tool AbortSignal and reports an idle miss", async () => {
    const { faux, runtime } = await setup();
    let toolStarted = false;
    let toolSignal: AbortSignal | undefined;
    let signalAborted = false;
    const abortAwareTool = {
      name: "analyze_campaign_metrics",
      label: "Analyze campaign metrics",
      description: "test double",
      parameters: { type: "object", properties: {} },
      executionMode: "sequential",
      execute: async (_toolCallId: string, _args: unknown, signal?: AbortSignal) => {
        toolSignal = signal;
        toolStarted = true;
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            signalAborted = true;
            reject(new Error("tool aborted"));
            return;
          }
          signal?.addEventListener("abort", () => {
            signalAborted = true;
            reject(new Error("tool aborted"));
          }, { once: true });
        });
        return { content: [{ type: "text", text: "unreachable" }], details: {} };
      }
    } as AgentTool;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("analyze_campaign_metrics", {}), { stopReason: "toolUse" })
    ]);
    const conversationId = "abort-tool-conversation";
    const running = runtime.run({
      context: { ...baseContext, sessionId: crypto.randomUUID(), conversationId },
      systemPrompt: "You are AdPilot.",
      prompt: "Analyze until stopped.",
      signals: { task: "conversation" },
      tools: [abortAwareTool]
    });
    await waitFor(() => toolStarted, "abort-aware tool to start");

    expect(runtime.stopConversation("client-b", conversationId)).toBe(false);
    expect(toolSignal?.aborted).toBe(false);
    expect(runtime.queueSessionMessage("client-a", conversationId, "queued steer", "steer")).toBe(true);
    expect(runtime.queueSessionMessage("client-a", conversationId, "queued follow-up", "followUp")).toBe(true);
    expect(runtime.stopConversation("client-a", conversationId)).toBe(true);
    expect(signalAborted).toBe(true);
    expect(toolSignal?.aborted).toBe(true);

    await expect(running).rejects.toBeInstanceOf(RuntimeUserStopped);
    expect(runtime.isSessionActive("client-a", conversationId)).toBe(false);
    expect(runtime.stopConversation("client-a", conversationId)).toBe(false);
  });

  it("queues a follow-up message into a running session without interrupting tool execution", async () => {
    const { workspace, faux, runtime } = await setup();
    let toolStarted = false;
    const hold = deferred();
    let mainTurnContext = "";
    let alertTurnContext = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("analyze_campaign_metrics", {}), { stopReason: "toolUse" }),
      (context) => { mainTurnContext = JSON.stringify(context.messages); return fauxAssistantMessage("main answer"); },
      (context) => { alertTurnContext = JSON.stringify(context.messages); return fauxAssistantMessage("alert handled"); }
    ]);
    const conversationId = "live-conversation";
    const running = runtime.run({
      context: { ...baseContext, sessionId: crypto.randomUUID(), conversationId },
      systemPrompt: "You are AdPilot.", prompt: "Review my account.", signals: { task: "conversation" },
      tools: [slowMetricsTool(() => { toolStarted = true; }, hold.promise)]
    });
    await waitFor(() => toolStarted, "tool execution to be mid-flight");

    const outcome = await runtime.injectUserMessage({
      context: { ...baseContext, sessionId: crypto.randomUUID(), conversationId },
      systemPrompt: "unused while queued", prompt: "ALERT: budget overspend on campaign-42", signals: { task: "conversation" }
    }, "followUp");
    expect(outcome).toEqual({ status: "queued", sessionId: resolvePiSessionId("client-a", conversationId), mode: "followUp" });
    expect(runtime.isSessionActive("client-a", conversationId)).toBe(true);
    expect(runtime.activeConversations("client-a").map((session) => session.conversationId)).toEqual([conversationId]);

    hold.release();
    const result = await running;
    expect(result.text).toBe("alert handled");
    // followUp semantics: the main line completes first; the alert turn sees it.
    expect(mainTurnContext).not.toContain("ALERT: budget overspend");
    expect(alertTurnContext).toContain("ALERT: budget overspend");
    expect(alertTurnContext).toContain("main answer");
    // The tool ran to completion before the alert entered the transcript.
    expect(await messageRoles(workspace, conversationId)).toEqual(["user", "assistant", "toolResult", "assistant", "user", "assistant"]);
    expect(runtime.isSessionActive("client-a", conversationId)).toBe(false);
  });

  it("steers a message into the next turn boundary of a running session", async () => {
    const { workspace, faux, runtime } = await setup();
    let toolStarted = false;
    const hold = deferred();
    let nextTurnContext = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("analyze_campaign_metrics", {}), { stopReason: "toolUse" }),
      (context) => { nextTurnContext = JSON.stringify(context.messages); return fauxAssistantMessage("final answer"); }
    ]);
    const conversationId = "steer-conversation";
    const running = runtime.run({
      context: { ...baseContext, sessionId: crypto.randomUUID(), conversationId },
      systemPrompt: "You are AdPilot.", prompt: "Review my account.", signals: { task: "conversation" },
      tools: [slowMetricsTool(() => { toolStarted = true; }, hold.promise)]
    });
    await waitFor(() => toolStarted, "tool execution to be mid-flight");

    const outcome = await runtime.injectUserMessage({
      context: { ...baseContext, sessionId: crypto.randomUUID(), conversationId },
      systemPrompt: "unused while queued", prompt: "ALERT: learning phase complete", signals: { task: "conversation" }
    }, "steer");
    expect(outcome.status).toBe("queued");

    hold.release();
    const result = await running;
    expect(result.text).toBe("final answer");
    // steer semantics: the alert is injected before the very next assistant response.
    expect(nextTurnContext).toContain("ALERT: learning phase complete");
    expect(nextTurnContext).toContain("metrics ok");
    expect(faux.state.callCount).toBe(2);
    expect(await messageRoles(workspace, conversationId)).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
  });

  it("starts a fresh turn for an idle session under the same system prompt and guardrail context", async () => {
    const { workspace, faux, runtime } = await setup();
    let capturedSystemPrompt = "";
    faux.setResponses([(context) => { capturedSystemPrompt = context.systemPrompt ?? ""; return fauxAssistantMessage("idle answer"); }]);
    const outcome = await runtime.injectUserMessage({
      context: { ...baseContext, sessionId: crypto.randomUUID(), conversationId: "idle-conversation" },
      systemPrompt: "You are the AdPilot alert handler.", prompt: "ALERT: KPI anomaly on campaign-42", signals: { task: "conversation" }
    });
    expect(outcome.status).toBe("started");
    if (outcome.status === "started") expect(outcome.result.text).toBe("idle answer");
    expect(capturedSystemPrompt).toContain("You are the AdPilot alert handler.");
    expect(await messageRoles(workspace, "idle-conversation")).toEqual(["user", "assistant"]);

    // An alert-triggered turn carries no approval authority: commit_approved_action stays hard-blocked.
    let executed = false;
    const commitSpy = {
      name: "commit_approved_action",
      label: "Commit an approved action",
      description: "test double",
      parameters: { type: "object", properties: {} },
      executionMode: "sequential",
      execute: async () => {
        executed = true;
        return { content: [{ type: "text", text: "committed" }], details: {} };
      }
    } as AgentTool;
    let blockedContext = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("commit_approved_action", { approvalId: crypto.randomUUID(), approvalToken: "stolen" }), { stopReason: "toolUse" }),
      (context) => { blockedContext = JSON.stringify(context.messages); return fauxAssistantMessage("cannot commit without user approval"); }
    ]);
    const second = await runtime.injectUserMessage({
      context: { ...baseContext, sessionId: crypto.randomUUID(), conversationId: "idle-guardrail" },
      systemPrompt: "You are the AdPilot alert handler.", prompt: "ALERT: pause campaign-42 immediately", signals: { task: "conversation" },
      tools: [commitSpy]
    });
    expect(second.status).toBe("started");
    expect(executed).toBe(false);
    expect(blockedContext).toContain("Approval tokens are never exposed to the model");
    if (second.status === "started") expect(second.result.text).toBe("cannot commit without user approval");
  });
});
