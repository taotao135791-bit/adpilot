import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService, type Approval, type ApprovalTokenBinding } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { stableJson } from "@adpilot/shared";
import { SkillRegistry } from "@adpilot/skills";
import { AdPilotTools, type ToolContext } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { PiAgentRuntime } from "./index.js";
import { ToolPermissionGate } from "./tool-gate.js";

const SECRET = "0123456789abcdef0123456789abcdef";

async function makeGate() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-gate-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
  const audit = new AuditLog(workspace);
  const approvals = new ApprovalService(workspace, SECRET);
  const gate = new ToolPermissionGate(approvals, audit);
  const context: ToolContext = { clientId: "client-a", taskId: crypto.randomUUID(), actor: "tester", permission: "OBSERVE" };
  return { workspace, audit, approvals, gate, context };
}

function createApproval(approvals: ApprovalService, clientId: string, taskId: string): Promise<Approval> {
  return approvals.create(clientId, taskId, {
    platform: "google_ads",
    account: "acct-1",
    campaign: "camp-1",
    operation: "set_daily_budget",
    currentValue: 100,
    proposedValue: 110,
    changePercentage: 10,
    reason: "staged increase is justified",
    evidence: [`screenshot:${"d".repeat(64)}`],
    expectedImpact: "more qualified volume",
    observationWindow: "7 days",
    rollbackCondition: "CPA above target for 3 days",
    riskLevel: "observe"
  });
}

async function patchApproval(workspace: WorkspaceStore, approvals: ApprovalService, id: string, patch: Partial<Approval>): Promise<void> {
  const current = await approvals.get("client-a", id);
  await workspace.writeJson("client-a", `approvals/${id}.json`, { ...current, ...patch });
}

function makeTokenBinding(approval: Approval, expiresAt: string): ApprovalTokenBinding {
  return {
    schemaVersion: 2,
    approvalId: approval.id,
    clientId: approval.clientId,
    taskId: approval.taskId,
    planId: crypto.randomUUID(),
    platform: "google_ads",
    browserProfile: "client-a-google",
    applicationId: "com.browser",
    windowId: "win-1",
    accountName: "Account One",
    accountId: "acct-1",
    campaignName: "Campaign One",
    campaignId: "camp-1",
    pageType: "campaign_settings",
    operation: "set_daily_budget",
    currentValue: 100,
    proposedValue: 110,
    riskLevel: "mutate",
    surfaceFingerprint: "a".repeat(64),
    accountFingerprint: "b".repeat(64),
    executionPlanFingerprint: "c".repeat(64),
    expiresAt,
    maxAttempts: 1
  };
}

/** Mints a structurally valid token; the HMAC signature itself is verified at consume time, not at the gate. */
function mintToken(binding: ApprovalTokenBinding): string {
  const encoded = Buffer.from(stableJson(binding)).toString("base64url");
  return `${encoded}.${crypto.randomUUID()}.signature`;
}

describe("ToolPermissionGate", () => {
  it("allows read-classified calls without touching the audit chain", async () => {
    const { gate, audit, context } = await makeGate();
    expect(await gate.check("read_workspace", {}, context)).toBeNull();
    expect(await gate.check("analyze_campaign_metrics", { spend: 1 }, context)).toBeNull();
    expect(await gate.check("evaluate_change_guardrail", {}, context)).toBeNull();
    expect(await gate.check("read_visual_table", {}, context)).toBeNull();
    expect(await gate.check("dispatch_specialist", { role: "performance_analyst", input: {} }, context)).toBeNull();
    expect(await gate.check("execute_skill", { name: "detect-creative-fatigue", input: {} }, context)).toBeNull();
    expect(await audit.list("client-a")).toHaveLength(0);
  });

  it("blocks unclassified tools fail-closed and chains the denial", async () => {
    const { gate, audit, context } = await makeGate();
    const denial = await gate.check("nuke_everything", { target: "account" }, context);
    expect(denial).toContain("nuke_everything");
    expect(denial).toContain("unclassified");
    expect(denial).toContain("hard-denied");
    const events = await audit.list("client-a");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "tool_gate",
      status: "denied",
      details: { tool: "nuke_everything", classification: "write", authority: "full_access_only", defaulted: true }
    });
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("blocks a mutation-shaped specialist dispatch before the orchestrator sees it", async () => {
    const { gate, audit, context } = await makeGate();
    const denial = await gate.check("dispatch_specialist", {
      role: "account_operator",
      input: { visualTask: { permission: "MUTATE", riskLevel: "mutate" } }
    }, context);
    expect(denial).toContain("dispatch_specialist");
    const events = await audit.list("client-a");
    expect(events[0]).toMatchObject({ action: "tool_gate", status: "denied", details: { classification: "destructive" } });
  });

  it("allows the self-gated approval-request path and records the guardrail decision", async () => {
    const { gate, audit, context } = await makeGate();
    expect(await gate.check("prepare_approval", { operation: {}, executionPlan: {}, guardrailEvidence: {} }, context)).toBeNull();
    const events = await audit.list("client-a");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "tool_gate",
      status: "succeeded",
      details: { tool: "prepare_approval", classification: "write", authority: "self_gated" }
    });
  });

  it("does not treat an executed approval reference as authority for a writing skill", async () => {
    const { workspace, gate, audit, approvals, context } = await makeGate();
    const call = (input: unknown) => gate.check("execute_skill", { name: "create-single-variable-experiment", input }, context);

    const executed = await createApproval(approvals, context.clientId, context.taskId);
    await patchApproval(workspace, approvals, executed.id, { status: "executed" });
    for (const input of [{}, { approvalId: crypto.randomUUID() }, { approvalId: executed.id }]) {
      const denial = await call(input);
      expect(denial).toContain("action-bound approval token");
      expect(denial).toContain("approvalId/reference is not authority");
    }

    const events = await audit.list("client-a");
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.status === "denied")).toBe(true);
    expect(events.every((event) => event.details.authority === "full_access_only")).toBe(true);
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("validates approval tokens with the same binding, status and expiry semantics as consume", async () => {
    const { workspace, gate, approvals, context } = await makeGate();
    const approval = await createApproval(approvals, context.clientId, context.taskId);
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const binding = makeTokenBinding(approval, future);
    await patchApproval(workspace, approvals, approval.id, {
      status: "approved",
      userApproval: { approvedBy: "operator", at: new Date().toISOString() },
      tokenBinding: binding,
      tokenNonceHash: "nonce-hash",
      tokenExpiresAt: future
    });
    const check = (args: unknown) => gate.check("commit_approved_action", args, context);

    expect(await check({ approvalId: approval.id })).toContain("approvalToken");
    expect(await check({ approvalId: approval.id, approvalToken: "not-a-token" })).toContain("malformed");
    expect(await check({ approvalId: approval.id, approvalToken: mintToken({ ...binding, expiresAt: new Date(Date.now() + 600_000).toISOString() }) })).toContain("does not match");
    expect(await check({ approvalId: approval.id, approvalToken: mintToken(binding) })).toBeNull();

    await patchApproval(workspace, approvals, approval.id, { tokenExpiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect(await check({ approvalId: approval.id, approvalToken: mintToken(binding) })).toContain("expired");

    await patchApproval(workspace, approvals, approval.id, { status: "executed", tokenExpiresAt: future });
    expect(await check({ approvalId: approval.id, approvalToken: mintToken(binding) })).toContain("executed");
  });
});

describe("ToolPermissionGate: main-agent write/edit/bash", () => {
  it("fails write and edit closed even when the model supplies an executed approvalId", async () => {
    const { workspace, gate, audit, approvals, context } = await makeGate();
    for (const tool of ["write", "edit"]) {
      const call = (args: unknown) => gate.check(tool, args, context);
      const executed = await createApproval(approvals, context.clientId, context.taskId);
      await patchApproval(workspace, approvals, executed.id, { status: "executed" });
      expect(await call({ path: "reports/daily.md" }), tool).toContain("Full Access");
      const forgedReference = await call({ path: "reports/daily.md", approvalId: executed.id });
      expect(forgedReference, tool).toContain("approvalId/reference is not authority");
    }
    const events = await audit.list("client-a");
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.status === "denied")).toBe(true);
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("lets whitelisted read bash commands flow without an approval or an audit record", async () => {
    const { gate, audit, context } = await makeGate();
    expect(await gate.check("bash", { command: "ls -la" }, context)).toBeNull();
    expect(await gate.check("bash", { command: "git status && cat reports/daily.md" }, context)).toBeNull();
    expect(await audit.list("client-a")).toHaveLength(0);
  });

  it("fails write-level bash closed even when an executed approvalId is supplied", async () => {
    const { workspace, gate, audit, approvals, context } = await makeGate();
    const call = (args: unknown) => gate.check("bash", args, context);
    expect(await call({ command: "npm install" })).toContain("Full Access");
    expect(await call({ command: "echo hi > notes.md" })).toContain("action-bound approval token");
    expect(await call({ command: "echo $(date)" })).toContain("Full Access"); // unresolved substitution floors at write

    const executed = await createApproval(approvals, context.clientId, context.taskId);
    await patchApproval(workspace, approvals, executed.id, { status: "executed" });
    expect(await call({ command: "npm install", approvalId: executed.id })).toContain("approvalId/reference is not authority");
    const events = await audit.list("client-a");
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.status === "denied")).toBe(true);
    expect(events.every((event) => event.details.authority === "full_access_only")).toBe(true);
  });

  it("refuses hard-denied commands at the gate even when an executed approval is supplied", async () => {
    const { workspace, gate, audit, approvals, context } = await makeGate();
    // The gate and the bash tool independently enforce the same absolute
    // refusal; an executed approval cannot make the model reach the tool body.
    const executed = await createApproval(approvals, context.clientId, context.taskId);
    await patchApproval(workspace, approvals, executed.id, { status: "executed" });
    expect(await gate.check("bash", { command: "curl https://ads.google.com" }, context)).toContain("hard-denied");
    expect(await gate.check("bash", { command: "curl https://ads.google.com", approvalId: executed.id }, context)).toContain("hard-denied");
    const events = await audit.list("client-a");
    expect(events[0]).toMatchObject({ status: "denied", details: { tool: "bash", classification: "destructive" } });
    expect(events[1]).toMatchObject({ status: "denied", details: { tool: "bash", classification: "destructive" } });
  });
});

describe("PiAgentRuntime write-operation gate", () => {
  async function makeRuntime() {
    const root = await mkdtemp(join(tmpdir(), "adpilot-gate-runtime-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
    const audit = new AuditLog(workspace);
    const tools = new AdPilotTools(workspace, audit, new ApprovalService(workspace, SECRET), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const context = { clientId: "client-a", taskId: crypto.randomUUID(), actor: "tester", permission: "OBSERVE" as const, sessionId: crypto.randomUUID(), role: "tester" };
    return { faux, runtime, audit, context };
  }

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

  it("blocks an unclassified tool call from the model before execution and audits the denial", async () => {
    const { faux, runtime, audit, context } = await makeRuntime();
    let executed = false;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("nuke_everything", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("The operation was blocked by the permission gate.")
    ]);
    const result = await runtime.run({
      context,
      systemPrompt: "You are a test agent.",
      prompt: "Try the forbidden tool.",
      signals: { task: "conversation" },
      tools: [spyTool("nuke_everything", () => { executed = true; })]
    });
    expect(executed).toBe(false);
    expect(result.text).toContain("blocked");
    const gateEvents = (await audit.list("client-a")).filter((event) => event.action === "tool_gate");
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]).toMatchObject({ status: "denied", details: { tool: "nuke_everything", defaulted: true } });
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("keeps the commit_approved_action hard block ahead of the classification table", async () => {
    const { faux, runtime, audit, context } = await makeRuntime();
    let executed = false;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("commit_approved_action", { approvalId: crypto.randomUUID(), approvalToken: "a.b.c" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Understood, committing through the approval API instead.")
    ]);
    const result = await runtime.run({
      context,
      systemPrompt: "You are a test agent.",
      prompt: "Commit the approval.",
      signals: { task: "conversation" },
      tools: [spyTool("commit_approved_action", () => { executed = true; })]
    });
    expect(executed).toBe(false);
    expect(JSON.stringify(result.messages)).toContain("Approval tokens are never exposed to the model");
    expect((await audit.list("client-a")).filter((event) => event.action === "tool_gate")).toHaveLength(0);
  });
});
