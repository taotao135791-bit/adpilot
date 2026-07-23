import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { SkillRegistry, type SkillDefinition } from "@adpilot/skills";
import { AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { PiAgentRuntime } from "./index.js";

const SECRET = "0123456789abcdef0123456789abcdef";

const probeSkill: SkillDefinition<unknown, unknown> = {
  name: "probe-skill",
  description: "Structured probe used by the assembly tests.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  prerequisites: [],
  requiredTools: [],
  failureConditions: [],
  forbidden: [],
  execute: async () => ({ ok: true })
};

/**
 * The runtime appends the confined general read-only tools to skill-bearing
 * runs (the specialists) and only to those: explicit whitelists and
 * skill-less decision runs are left untouched.
 */
async function makeRuntime(generalReadTools: AgentTool[]) {
  const root = await mkdtemp(join(tmpdir(), "adpilot-runtime-general-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
  const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
  const audit = new AuditLog(workspace);
  const tools = new AdPilotTools(workspace, audit, new ApprovalService(workspace, SECRET), new ExperimentStore(workspace));
  const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry([probeSkill]), tools, [], { generalReadTools });
  const context = { clientId: "client-a", taskId: crypto.randomUUID(), actor: "tester", permission: "OBSERVE" as const, sessionId: crypto.randomUUID(), role: "tester" };
  return { faux, runtime, context };
}

function spyReadTool(onExecute: () => void): AgentTool {
  return {
    name: "read",
    label: "Read a file",
    description: "test double for the confined read tool",
    parameters: Type.Object({ path: Type.String() }),
    executionMode: "parallel",
    execute: async () => {
      onExecute();
      return { content: [{ type: "text" as const, text: "file contents" }], details: {} };
    }
  } as AgentTool;
}

describe("PiAgentRuntime general read tool assembly", () => {
  it("offers the general read tools to skill-bearing (specialist) runs", async () => {
    let executed = false;
    const { faux, runtime, context } = await makeRuntime([spyReadTool(() => { executed = true; })]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "reports/daily.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done reading.")
    ]);
    const result = await runtime.run({
      context,
      systemPrompt: "You are a specialist.",
      prompt: "Read the file.",
      signals: { task: "planning" },
      allowedSkills: ["probe-skill"]
    });
    expect(executed).toBe(true);
    expect(result.text).toContain("Done reading.");
  });

  it("does not offer them to skill-less decision runs", async () => {
    let executed = false;
    const { faux, runtime, context } = await makeRuntime([spyReadTool(() => { executed = true; })]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "reports/daily.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage('{"mode":"answer","reply":"No file access here.","goal":null}')
    ]);
    const result = await runtime.run({
      context,
      systemPrompt: "You are the conversational decision.",
      prompt: "Read the file.",
      signals: { task: "conversation" }
    });
    expect(executed).toBe(false);
    expect(result.text).toContain("No file access here.");
  });

  it("does not offer them to explicit-whitelist repair passes", async () => {
    let executed = false;
    const { faux, runtime, context } = await makeRuntime([spyReadTool(() => { executed = true; })]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "reports/daily.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Repaired.")
    ]);
    const result = await runtime.run({
      context,
      systemPrompt: "You repair JSON.",
      prompt: "Repair.",
      signals: { task: "conversation" },
      tools: [],
      allowedSkills: []
    });
    expect(executed).toBe(false);
    expect(result.text).toContain("Repaired.");
  });
});
