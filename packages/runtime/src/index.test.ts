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
import { AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { PiAgentRuntime } from "./index.js";

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
    const output = await runtime.runStructured({
      context: { clientId: "client-a", taskId: crypto.randomUUID(), actor: "creative_strategist", permission: "OBSERVE", sessionId: crypto.randomUUID(), role: "creative_strategist" },
      systemPrompt: "Analyze creative evidence.", prompt: "Review fatigue.", signals: { task: "classification" }, allowedSkills: ["detect-creative-fatigue"]
    }, z.object({ finding: z.string(), confidence: z.number() }));
    expect(output).toEqual({ finding: "fatigued", confidence: 0.9 });
    expect(faux.state.callCount).toBe(2);
  });
});

