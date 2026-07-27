import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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

  it("full access waives the approval reference for write/edit and write-level bash, and audits the waiver", async () => {
    const { gate, audit, context } = await makeGate(probe("full_access"));
    expect(await gate.check("write", { path: "notes.md", content: "hi" }, context)).toBeNull();
    expect(await gate.check("edit", { path: "notes.md" }, context)).toBeNull();
    expect(await gate.check("bash", { command: "open https://www.baidu.com" }, context)).toBeNull();
    expect(await gate.check("bash", { command: "echo hi > notes.md" }, context)).toBeNull();
    // Read-level calls still flow without any audit record.
    expect(await gate.check("bash", { command: "ls -la" }, context)).toBeNull();
    const events = await audit.list("client-a");
    expect(events).toHaveLength(4);
    for (const event of events) {
      expect(event).toMatchObject({
        action: "tool_gate",
        status: "succeeded",
        details: { classification: "write", autonomy: "full_access", approvalReferenceWaived: true }
      });
    }
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("guarded mode keeps the approval chain and points at the autonomy switch", async () => {
    const { gate, audit, context } = await makeGate(probe("guarded"));
    const denial = await gate.check("bash", { command: "open https://www.baidu.com" }, context);
    expect(denial).toContain("approvalId");
    expect(denial).toContain("full access");
    const writeDenial = await gate.check("write", { path: "notes.md" }, context);
    expect(writeDenial).toContain("approvalId");
    const events = await audit.list("client-a");
    expect(events.map((event) => event.status)).toEqual(["denied", "denied"]);
  });

  it("no probe means guarded behavior (default posture)", async () => {
    const { gate, context } = await makeGate(undefined);
    expect(await gate.check("bash", { command: "echo hi > notes.md" }, context)).toContain("approvalId");
  });

  it("red line 1: deny-classified commands stay hard-denied at the gate in full access", async () => {
    const { gate, audit, context } = await makeGate(probe("full_access"));
    const curl = await gate.check("bash", { command: "curl https://ads.google.com" }, context);
    expect(curl).toContain("approvalId");
    const rmrf = await gate.check("bash", { command: "rm -rf /" }, context);
    expect(rmrf).toContain("approvalId");
    const profile = await gate.check("bash", { command: "open '/Users/x/Library/Application Support/Google/Chrome'" }, context);
    expect(profile).toContain("approvalId");
    const events = await audit.list("client-a");
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event).toMatchObject({ status: "denied", details: { classification: "destructive" } });
      expect(event.details).not.toMatchObject({ approvalReferenceWaived: true });
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
    // Ledger-writing skills are not part of the general local surface: still gated.
    expect(await gate.check("execute_skill", { name: "create-single-variable-experiment", input: {} }, context)).toContain("approvalId");
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
    const denial = await gate.check("bash", { command: "open https://www.baidu.com" }, context);
    expect(denial).toContain("Plan mode is active");
    const events = await audit.list("client-a");
    expect(events[0]).toMatchObject({ status: "denied", details: { planMode: true } });
    expect(events[0]?.details).not.toMatchObject({ approvalReferenceWaived: true });
  });
});

describe("PiAgentRuntime full-access execution", () => {
  it("runs a write-level bash command without an approval reference under full access, and only then", async () => {
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
    expect(guardedResult).toContain("approval-gated");
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
    expect(gateEvents.some((event) => event.status === "succeeded" && event.details.approvalReferenceWaived === true)).toBe(true);
  });
});
