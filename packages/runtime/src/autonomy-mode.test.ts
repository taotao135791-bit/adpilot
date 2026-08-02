import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { SkillRegistry } from "@adpilot/skills";
import { AdPilotTools, type ToolContext } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { PiAgentRuntime } from "./index.js";
import { AutonomyStore, type AutonomyProbe } from "./autonomy-mode.js";
import { ToolPermissionGate } from "./tool-gate.js";

const SECRET = "0123456789abcdef0123456789abcdef";

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-autonomy-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
  return { root, workspace };
}

function probe(mode: "guarded" | "full_access"): AutonomyProbe {
  return { mode: async () => mode };
}

describe("AutonomyStore", () => {
  it("defaults to guarded and persists every switch with actor and timestamp", async () => {
    const { workspace } = await makeWorkspace();
    const store = new AutonomyStore(workspace, new AuditLog(workspace));
    expect(await store.get("client-a")).toMatchObject({ mode: "guarded" });
    expect(await store.mode("client-a")).toBe("guarded");

    const full = await store.set("client-a", "full_access", "operator");
    expect(full.mode).toBe("full_access");
    expect(Date.parse(full.updatedAt)).toBeGreaterThan(0);
    expect(full.actor).toBe("operator");

    // State survives a fresh store over the same workspace.
    const reopened = new AutonomyStore(workspace, new AuditLog(workspace));
    expect(await reopened.mode("client-a")).toBe("full_access");

    await store.set("client-a", "guarded", "operator");
    expect(await store.mode("client-a")).toBe("guarded");
  });

  it("chains every mode switch into the audit log with the from/to transition", async () => {
    const { workspace } = await makeWorkspace();
    const audit = new AuditLog(workspace);
    const store = new AutonomyStore(workspace, audit);
    await store.set("client-a", "full_access", "operator");
    await store.set("client-a", "guarded", "operator");
    const events = await audit.list("client-a");
    expect(events.map((event) => event.action)).toEqual(["autonomy_mode_changed", "autonomy_mode_changed"]);
    expect(events[0]).toMatchObject({ actor: "operator", status: "succeeded", details: { from: "guarded", to: "full_access" } });
    expect(events[1]).toMatchObject({ details: { from: "full_access", to: "guarded" } });
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("fails closed to guarded on corrupt metadata", async () => {
    const { root, workspace } = await makeWorkspace();
    const store = new AutonomyStore(workspace, new AuditLog(workspace));
    await writeFile(join(root, "clients", "client-a", "autonomy.json"), "{corrupt");
    expect(await store.mode("client-a")).toBe("guarded");
  });
});

describe("ToolPermissionGate autonomy modes", () => {
  async function makeGate(autonomy?: AutonomyProbe) {
    const { workspace } = await makeWorkspace();
    const audit = new AuditLog(workspace);
    const approvals = new ApprovalService(workspace, SECRET);
    const gate = new ToolPermissionGate(approvals, audit, undefined, autonomy);
    const context: ToolContext & { conversationId: string } = {
      clientId: "client-a", taskId: crypto.randomUUID(), actor: "tester", permission: "OBSERVE", conversationId: "primary"
    };
    return { workspace, audit, approvals, gate, context };
  }

  it("full access admits routine local writes without pretending an approval reference authorized them", async () => {
    const { gate, audit, context } = await makeGate(probe("full_access"));
    expect(await gate.check("write", { path: "notes.md", content: "hi" }, context)).toBeNull();
    expect(await gate.check("edit", { path: "notes.md" }, context)).toBeNull();
    expect(await gate.check("bash", { command: "echo hi > notes.md" }, context)).toBeNull();
    expect(await gate.check("computer.close_window", { bundleId: "com.google.Chrome", windowId: 42 }, context)).toBeNull();
    expect(await gate.check("future.unreviewed_write", {}, context)).toContain("unclassified");
    // Read-level calls still flow without any audit record.
    expect(await gate.check("bash", { command: "ls -la" }, context)).toBeNull();
    const events = await audit.list("client-a");
    expect(events).toHaveLength(5);
    for (const event of events.slice(0, 4)) {
      expect(event).toMatchObject({
        action: "tool_gate",
        status: "succeeded",
        details: { classification: "write", authority: "full_access_only", autonomy: "full_access", fullAccessOnlyGranted: true }
      });
    }
    expect(events[4]).toMatchObject({ status: "denied", details: { defaulted: true } });
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("guarded mode rejects model-supplied references and points at the autonomy switch", async () => {
    const { gate, audit, context } = await makeGate(probe("guarded"));
    const denial = await gate.check("bash", { command: "echo hi > notes.md" }, context);
    expect(denial).toContain("action-bound approval token");
    expect(denial).toContain("Full Access");
    const writeDenial = await gate.check("write", { path: "notes.md", approvalId: crypto.randomUUID() }, context);
    expect(writeDenial).toContain("approvalId/reference is not authority");
    const events = await audit.list("client-a");
    expect(events.map((event) => event.status)).toEqual(["denied", "denied"]);
  });

  it("guarded mode fails every registry write without an action-bound token closed", async () => {
    const { gate, audit, context } = await makeGate(probe("guarded"));
    // Argument-aware terminal reads remain usable; only the side effect is gated.
    expect(await gate.check("terminal.execute", { command: "git status" }, context)).toBeNull();
    for (const [tool, args] of [
      ["terminal.create", { cwd: "/tmp/project" }],
      ["terminal.execute", { cwd: "/tmp/project", command: "npm test" }],
      ["terminal.interrupt", { terminalId: "term-1" }],
      ["terminal.close", { terminalId: "term-1" }],
      ["git.stage", { repoRoot: "/tmp/project", paths: ["src/index.ts"] }],
      ["artifact.create", { type: "document", title: "Report", spec: {} }],
      ["automation.create", { name: "daily report" }],
      ["automation.pause", { automationId: crypto.randomUUID() }],
      ["automation.resume", { automationId: crypto.randomUUID() }],
      ["automation.run_now", { automationId: crypto.randomUUID() }],
      ["workflow.run", { workflowId: crypto.randomUUID(), approvalId: crypto.randomUUID() }]
    ] as const) {
      const denial = await gate.check(tool, args, context);
      expect(denial, tool).toContain("action-bound approval token");
      expect(denial, tool).toContain("Guarded mode");
      expect(denial, tool).toContain("Full Access");
      expect(denial, tool).toContain("approvalId/reference is not authority");
    }
    const events = await audit.list("client-a");
    expect(events).toHaveLength(11);
    for (const event of events) {
      expect(event).toMatchObject({
        status: "denied",
        details: { classification: "write", authority: "full_access_only" }
      });
    }
  });

  it("full access admits registry writes, including automation and workflow, under one explicit authority", async () => {
    const { gate, audit, context } = await makeGate(probe("full_access"));
    for (const [tool, args] of [
      ["terminal.create", { cwd: "/tmp/project" }],
      ["terminal.execute", { cwd: "/tmp/project", command: "npm test" }],
      ["terminal.interrupt", { terminalId: "term-1" }],
      ["terminal.close", { terminalId: "term-1" }],
      ["git.commit", { repoRoot: "/tmp/project", message: "checkpoint" }],
      ["artifact.revise", { id: crypto.randomUUID(), spec: {} }],
      ["automation.create", { name: "daily report" }],
      ["automation.pause", { automationId: crypto.randomUUID() }],
      ["automation.resume", { automationId: crypto.randomUUID() }],
      ["automation.run_now", { automationId: crypto.randomUUID() }],
      ["workflow.run", { workflowId: crypto.randomUUID(), approvalId: crypto.randomUUID() }]
    ] as const) {
      expect(await gate.check(tool, args, context), tool).toBeNull();
    }
    const events = await audit.list("client-a");
    const registryGrants = events.filter((event) => event.details.fullAccessOnlyGranted === true);
    expect(registryGrants).toHaveLength(11);
    for (const event of registryGrants) {
      expect(event).toMatchObject({
        status: "succeeded",
        details: { classification: "write", authority: "full_access_only", autonomy: "full_access" }
      });
    }
    const workflowEvent = events.find((event) => event.details.tool === "workflow.run");
    expect(workflowEvent).toMatchObject({ status: "succeeded", details: { authority: "full_access_only", fullAccessOnlyGranted: true } });
  });

  it("no probe means guarded behavior (default posture)", async () => {
    const { gate, context } = await makeGate(undefined);
    expect(await gate.check("bash", { command: "echo hi > notes.md" }, context)).toContain("Full Access");
  });

  it("red line 1: deny-classified commands stay hard-denied at the gate in full access", async () => {
    const { gate, audit, context } = await makeGate(probe("full_access"));
    const curl = await gate.check("bash", { command: "curl https://ads.google.com" }, context);
    expect(curl).toContain("hard-denied");
    const rmrf = await gate.check("bash", { command: "rm -rf /" }, context);
    expect(rmrf).toContain("hard-denied");
    const profile = await gate.check("bash", { command: "open '/Users/x/Library/Application Support/Google/Chrome'" }, context);
    expect(profile).toContain("hard-denied");
    const registryShell = await gate.check("terminal.execute", { cwd: "/tmp/project", command: "curl https://ads.google.com" }, context);
    expect(registryShell).toContain("hard-denied");
    const events = await audit.list("client-a");
    expect(events).toHaveLength(4);
    for (const event of events) {
      expect(event).toMatchObject({ status: "denied", details: { classification: "destructive", authority: "approval_token" } });
      expect(event.details).not.toHaveProperty("fullAccessOnlyGranted");
    }
  });

  it("red line 2: account mutations keep their token authority in full access", async () => {
    const { gate, context } = await makeGate(probe("full_access"));
    // commit_approved_action: destructive + approval_token, never waived.
    expect(await gate.check("commit_approved_action", { approvalId: crypto.randomUUID(), approvalToken: "a.b.c" }, context)).toContain("does not exist");
    // MUTATE/DESTRUCTIVE visual dispatch: destructive + approval_token, never waived.
    const dispatch = await gate.check("dispatch_specialist", {
      role: "account_operator",
      input: { visualTask: { permission: "MUTATE", riskLevel: "mutate" } }
    }, context);
    expect(dispatch).toContain("approvalId");
    expect(dispatch).not.toContain("full access");
    // A non-destructive writing skill is a Full-Access-only call at this
    // boundary; the skill's own schema and ownership checks still run later.
    expect(await gate.check("execute_skill", { name: "create-single-variable-experiment", input: {} }, context)).toBeNull();
    // prepare_approval stays the self-gated authority-request path in both modes.
    expect(await gate.check("prepare_approval", { operation: {}, executionPlan: {}, guardrailEvidence: {} }, context)).toBeNull();
  });

  it("plan mode beats full access: non-read calls stay denied outright", async () => {
    const { workspace } = await makeWorkspace();
    const audit = new AuditLog(workspace);
    const gate = new ToolPermissionGate(new ApprovalService(workspace, SECRET), audit, { isEnabled: async () => true }, probe("full_access"));
    const context: ToolContext & { conversationId: string } = {
      clientId: "client-a", taskId: crypto.randomUUID(), actor: "tester", permission: "OBSERVE", conversationId: "primary"
    };
    const denial = await gate.check("bash", { command: "echo hi > notes.md" }, context);
    expect(denial).toContain("Plan mode is active");
    const events = await audit.list("client-a");
    expect(events[0]).toMatchObject({ status: "denied", details: { planMode: true } });
    expect(events[0]?.details).not.toHaveProperty("fullAccessOnlyGranted");
  });
});

describe("PiAgentRuntime full-access execution", () => {
  it("runs a write-level bash command only under explicit Full Access", async () => {
    const { root, workspace } = await makeWorkspace();
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const audit = new AuditLog(workspace);
    const tools = new AdPilotTools(workspace, audit, new ApprovalService(workspace, SECRET), new ExperimentStore(workspace));
    const makeRuntime = (autonomy?: AutonomyProbe) => new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools, [], autonomy ? { autonomy } : {});
    const runContext = () => ({
      clientId: "client-a", taskId: crypto.randomUUID(), actor: "tester", permission: "OBSERVE" as const,
      sessionId: crypto.randomUUID(), conversationId: "primary", role: "tester"
    });
    const general = (taskId: string) => tools.generalAgentTools({ clientId: "client-a", taskId, actor: "tester", permission: "OBSERVE" });

    // Guarded: the gate blocks the write-level command before the tool body runs.
    const guardedContext = runContext();
    let guardedResult = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hello > guarded-notes.md" }), { stopReason: "toolUse" }),
      async (context) => { guardedResult = JSON.stringify(context); return fauxAssistantMessage("guarded reply"); }
    ]);
    await makeRuntime(undefined).run({ context: guardedContext, systemPrompt: "You are a test agent.", prompt: "Write the file.", signals: { task: "conversation" }, tools: general(guardedContext.taskId) });
    expect(guardedResult).toContain("action-bound approval token");
    await expect(readFile(join(root, "guarded-notes.md"), "utf8")).rejects.toThrow();

    // Full access: the same command executes, sandboxed, inside the workspace.
    const fullContext = runContext();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hello > full-notes.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done")
    ]);
    await makeRuntime(probe("full_access")).run({ context: fullContext, systemPrompt: "You are a test agent.", prompt: "Write the file.", signals: { task: "conversation" }, tools: general(fullContext.taskId) });
    expect((await readFile(join(root, "full-notes.md"), "utf8")).trim()).toBe("hello");
    const gateEvents = (await audit.list("client-a")).filter((event) => event.action === "tool_gate");
    expect(gateEvents.some((event) => event.status === "succeeded" && event.details.fullAccessOnlyGranted === true)).toBe(true);
  });

  it("blocks a registry project write before execution in guarded mode and admits it only in full access", async () => {
    const { workspace } = await makeWorkspace();
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const audit = new AuditLog(workspace);
    const tools = new AdPilotTools(workspace, audit, new ApprovalService(workspace, SECRET), new ExperimentStore(workspace));
    const makeRuntime = (autonomy?: AutonomyProbe) => new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools, [], autonomy ? { autonomy } : {});
    const runContext = () => ({
      clientId: "client-a", taskId: crypto.randomUUID(), actor: "tester", permission: "OBSERVE" as const,
      sessionId: crypto.randomUUID(), conversationId: "primary", role: "tester"
    });
    let executions = 0;
    const registryWrite = {
      name: "terminal.execute",
      label: "terminal.execute",
      description: "registry write test double",
      parameters: Type.Object({ command: Type.String() }),
      executionMode: "sequential",
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text" as const, text: "executed" }], details: {} };
      }
    } as AgentTool;

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("terminal.execute", { command: "npm test" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("blocked in guarded mode")
    ]);
    await makeRuntime(probe("guarded")).run({
      context: runContext(), systemPrompt: "You are a test agent.", prompt: "Run tests.",
      signals: { task: "conversation" }, tools: [registryWrite]
    });
    expect(executions).toBe(0);

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("terminal.execute", { command: "npm test" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done")
    ]);
    await makeRuntime(probe("full_access")).run({
      context: runContext(), systemPrompt: "You are a test agent.", prompt: "Run tests.",
      signals: { task: "conversation" }, tools: [registryWrite]
    });
    expect(executions).toBe(1);
    const events = (await audit.list("client-a")).filter((event) => event.details.tool === "terminal.execute");
    expect(events.map((event) => event.status)).toEqual(["denied", "succeeded"]);
    expect(events[1]).toMatchObject({ details: { autonomy: "full_access", fullAccessOnlyGranted: true } });
  });
});
