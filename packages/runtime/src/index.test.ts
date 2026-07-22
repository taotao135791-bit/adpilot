import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { SkillRegistry } from "@adpilot/skills";
import { AdPilotTools, type ToolContext } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotSessionStorage, PiAgentRuntime, StructuredOutputBlocker, resolvePiSessionId } from "./index.js";

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
