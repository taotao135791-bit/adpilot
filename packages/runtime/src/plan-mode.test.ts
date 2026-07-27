import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { SkillRegistry, type SkillDefinition } from "@adpilot/skills";
import { AdPilotTools, type ToolContext } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { PiAgentRuntime, type RuntimeRunContext } from "./index.js";
import { isPlanModeSkill, isPlanModeTool, PlanModeStore, PLAN_MODE_SYSTEM_PROMPT } from "./plan-mode.js";
import { ToolPermissionGate } from "./tool-gate.js";

const SECRET = "0123456789abcdef0123456789abcdef";

const readSkill: SkillDefinition<unknown, unknown> = {
  name: "daily-report",
  description: "Read-classified report skill used by the plan-mode tests.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  prerequisites: [],
  requiredTools: [],
  failureConditions: [],
  forbidden: [],
  execute: async () => ({ ok: true })
};

const writeSkill: SkillDefinition<unknown, unknown> = {
  ...readSkill,
  name: "create-single-variable-experiment",
  description: "Write-classified skill that plan mode must remove."
};

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-plan-mode-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
  return { root, workspace };
}

describe("PlanModeStore", () => {
  it("defaults to disabled and persists every toggle with actor and timestamp", async () => {
    const { workspace } = await makeWorkspace();
    const store = new PlanModeStore(workspace, new AuditLog(workspace));
    expect(await store.get("client-a", "primary")).toMatchObject({ enabled: false });
    expect(await store.isEnabled("client-a", "primary")).toBe(false);

    const enabled = await store.set("client-a", "primary", true, "operator");
    expect(enabled.enabled).toBe(true);
    expect(Date.parse(enabled.updatedAt)).toBeGreaterThan(0);
    expect(enabled.actor).toBe("operator");
    expect(await store.isEnabled("client-a", "primary")).toBe(true);

    // State survives a fresh store over the same workspace (conversation metadata durability).
    const reopened = new PlanModeStore(workspace, new AuditLog(workspace));
    expect(await reopened.isEnabled("client-a", "primary")).toBe(true);
    // State is conversation-scoped: a different conversation stays disabled.
    expect(await reopened.isEnabled("client-a", "other-conversation")).toBe(false);

    await store.set("client-a", "primary", false, "operator");
    expect(await store.isEnabled("client-a", "primary")).toBe(false);
  });

  it("chains both directions of the toggle into the audit log", async () => {
    const { workspace } = await makeWorkspace();
    const audit = new AuditLog(workspace);
    const store = new PlanModeStore(workspace, audit);
    await store.set("client-a", "primary", true, "operator");
    await store.set("client-a", "primary", false, "operator");
    const events = await audit.list("client-a");
    expect(events.map((event) => event.action)).toEqual(["plan_mode_enabled", "plan_mode_disabled"]);
    expect(events[0]).toMatchObject({ actor: "operator", status: "succeeded", details: { conversationId: "primary", enabled: true } });
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("sanitizes hostile conversation ids into a deterministic hashed metadata path", async () => {
    const { workspace, root } = await makeWorkspace();
    const store = new PlanModeStore(workspace, new AuditLog(workspace));
    const hostile = "../../../etc/passwd";
    await store.set("client-a", hostile, true, "operator");
    expect(await store.isEnabled("client-a", hostile)).toBe(true);
    // The metadata stayed inside the client's conversations directory under a
    // hashed name — no traversal, no special characters.
    const { readdir } = await import("node:fs/promises");
    const conversations = await readdir(join(root, "clients", "client-a", "conversations"));
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatch(/^c-[0-9a-f]{16}$/);
  });

  it("fails closed to disabled on corrupt metadata", async () => {
    const { workspace, root } = await makeWorkspace();
    const store = new PlanModeStore(workspace, new AuditLog(workspace));
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(root, "clients", "client-a", "conversations", "primary"), { recursive: true });
    await writeFile(join(root, "clients", "client-a", "conversations", "primary", "plan-mode.json"), "{corrupt");
    expect(await store.isEnabled("client-a", "primary")).toBe(false);
  });
});

describe("plan-mode tool helpers", () => {
  it("keeps exactly the read-only surface", () => {
    for (const kept of ["read", "grep", "find", "ls", "read_workspace", "read_visual_table", "analyze_campaign_metrics", "evaluate_change_guardrail", "dispatch_specialist", "execute_skill"]) {
      expect(isPlanModeTool(kept), kept).toBe(true);
    }
    for (const removed of ["write", "edit", "bash", "prepare_approval", "commit_approved_action", "nuke_everything"]) {
      expect(isPlanModeTool(removed), removed).toBe(false);
    }
    expect(isPlanModeSkill("daily-report")).toBe(true);
    expect(isPlanModeSkill("create-single-variable-experiment")).toBe(false);
  });
});

describe("PiAgentRuntime plan mode", () => {
  function spyTool(name: string, onExecute: () => void): AgentTool {
    return {
      name,
      label: name,
      description: `test double for ${name}`,
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        onExecute();
        return { content: [{ type: "text" as const, text: "executed" }], details: {} };
      }
    } as AgentTool;
  }

  async function makeRuntime(planModeEnabled: boolean, captured: { context?: Context }) {
    const { workspace } = await makeWorkspace();
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const audit = new AuditLog(workspace);
    const tools = new AdPilotTools(workspace, audit, new ApprovalService(workspace, SECRET), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry([readSkill, writeSkill]), tools, [], {
      generalReadTools: [spyTool("grep", () => undefined)],
      planMode: { isEnabled: async () => planModeEnabled }
    });
    faux.setResponses([
      (context) => {
        captured.context = context;
        return fauxAssistantMessage("Plan:\n1. Inspect the workspace reports.");
      }
    ]);
    const context: RuntimeRunContext = {
      clientId: "client-a", taskId: crypto.randomUUID(), actor: "tester", permission: "OBSERVE",
      sessionId: crypto.randomUUID(), conversationId: "primary", role: "tester"
    };
    return { runtime, context, audit };
  }

  it("shrinks the tool set to the read-only surface and injects the plan instructions", async () => {
    const captured: { context?: Context } = {};
    const { runtime, context } = await makeRuntime(true, captured);
    const result = await runtime.run({
      context,
      systemPrompt: "You are AdPilot Agent.",
      prompt: "Investigate the account.",
      signals: { task: "planning" },
      tools: [spyTool("read", () => undefined), spyTool("write", () => undefined), spyTool("bash", () => undefined), spyTool("prepare_approval", () => undefined)],
      allowedSkills: ["daily-report", "create-single-variable-experiment"]
    });
    expect(result.text).toContain("Plan:");
    const offered = (captured.context?.tools ?? []).map((tool) => tool.name);
    expect(offered).toContain("read");
    expect(offered).toContain("grep"); // general read tools survive the shrink
    expect(offered).toContain("execute_skill"); // the read-classified skill survives
    for (const removed of ["write", "bash", "prepare_approval"]) {
      expect(offered, removed).not.toContain(removed);
    }
    expect(captured.context?.systemPrompt).toContain("[PLAN MODE ACTIVE]");
    expect(captured.context?.systemPrompt).toContain("Plan:");
  });

  it("restores the full tool set without the plan instructions when disabled (execute-plan path)", async () => {
    const captured: { context?: Context } = {};
    const { runtime, context } = await makeRuntime(false, captured);
    await runtime.run({
      context,
      systemPrompt: "You are AdPilot Agent.",
      prompt: "Execute the plan.",
      signals: { task: "planning" },
      tools: [spyTool("read", () => undefined), spyTool("write", () => undefined), spyTool("bash", () => undefined)],
      allowedSkills: ["daily-report", "create-single-variable-experiment"]
    });
    const offered = (captured.context?.tools ?? []).map((tool) => tool.name);
    expect(offered).toEqual(expect.arrayContaining(["read", "write", "bash", "execute_skill"]));
    expect(captured.context?.systemPrompt).not.toContain("[PLAN MODE ACTIVE]");
  });
});

describe("ToolPermissionGate plan-mode backstop", () => {
  it("denies every non-read classification while plan mode is on, even with a valid approval", async () => {
    const { workspace } = await makeWorkspace();
    const audit = new AuditLog(workspace);
    const approvals = new ApprovalService(workspace, SECRET);
    const gate = new ToolPermissionGate(approvals, audit, { isEnabled: async () => true });
    const context: ToolContext & { conversationId: string } = {
      clientId: "client-a", taskId: crypto.randomUUID(), actor: "tester", permission: "OBSERVE", conversationId: "primary"
    };
    // Read calls still flow without touching the audit chain.
    expect(await gate.check("read", { path: "reports/daily.md" }, context)).toBeNull();
    expect(await gate.check("bash", { command: "ls -la" }, context)).toBeNull();
    // Write/destructive calls are denied outright — no approval can lift plan mode.
    const writeDenial = await gate.check("write", { path: "x.md", approvalId: crypto.randomUUID() }, context);
    expect(writeDenial).toContain("Plan mode is active");
    const bashDenial = await gate.check("bash", { command: "npm install", approvalId: crypto.randomUUID() }, context);
    expect(bashDenial).toContain("Plan mode is active");
    const events = await audit.list("client-a");
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({ action: "tool_gate", status: "denied", details: { planMode: true } });
    }
  });

  it("lets the normal approval chain decide when plan mode is off", async () => {
    const { workspace } = await makeWorkspace();
    const audit = new AuditLog(workspace);
    const approvals = new ApprovalService(workspace, SECRET);
    const gate = new ToolPermissionGate(approvals, audit, { isEnabled: async () => false });
    const context: ToolContext & { conversationId: string } = {
      clientId: "client-a", taskId: crypto.randomUUID(), actor: "tester", permission: "OBSERVE", conversationId: "primary"
    };
    const denial = await gate.check("write", { path: "x.md" }, context);
    expect(denial).not.toContain("Plan mode is active");
    expect(denial).toContain("approvalId");
  });
});
