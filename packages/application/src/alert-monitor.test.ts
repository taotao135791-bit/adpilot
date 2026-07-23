import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { AuditRuntimeExtension, PiAgentRuntime, type RuntimeRequest } from "@adpilot/runtime";
import { SkillRegistry } from "@adpilot/skills";
import { MonitoringAlert, type Clock } from "@adpilot/shared";
import { AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { AlertMonitor, type AlertMonitorOptions } from "./alert-monitor.js";
import { ProductEventBus, createAdPilotSystem, type ProductEvent } from "./index.js";

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

function fakeClock(start = Date.parse("2026-07-23T08:00:00.000Z")) {
  let now = start;
  const clock: Clock = { now: () => new Date(now) };
  return { clock, advance: (ms: number) => { now += ms; } };
}

function alert(overrides: Partial<MonitoringAlert> = {}): MonitoringAlert {
  return MonitoringAlert.parse({
    alertId: crypto.randomUUID(),
    clientId: "client-a",
    kind: "budget_overspend",
    severity: "critical",
    metrics: [{ metric: "spend", value: 123.45, unit: "USD", factId: "fact-spend-1" }],
    message: "Daily budget exceeded by 23%.",
    dedupeKey: "budget:campaign-42:2026-07-23",
    createdAt: new Date().toISOString(),
    ...overrides
  });
}

function runRequest(conversationId: string, tools: AgentTool[] = []): RuntimeRequest {
  return {
    context: {
      clientId: "client-a", taskId: crypto.randomUUID(), actor: "adpilot_agent",
      permission: "OBSERVE", sessionId: crypto.randomUUID(), conversationId, role: "adpilot_agent"
    },
    systemPrompt: "You are AdPilot, the user's persistent advertising operator.",
    prompt: "How is my account doing?",
    signals: { task: "conversation" },
    tools
  };
}

async function makeHarness(options: AlertMonitorOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "adpilot-alerts-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
  const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
  const models = createModels(); models.setProvider(faux.provider);
  const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
  const audit = new AuditLog(workspace);
  const tools = new AdPilotTools(workspace, audit, new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
  const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools, [new AuditRuntimeExtension(audit)]);
  const events = new ProductEventBus();
  const monitor = new AlertMonitor({ workspace, runtime, audit, events, options });
  runtime.registerExtension(monitor.extension);
  const published: ProductEvent[] = [];
  events.subscribe((event) => published.push(event));
  const outcomes = async () => (await audit.list("client-a"))
    .filter((event) => event.action === "monitoring_alert")
    .map((event) => event.details.outcome);
  const alertEvents = () => published.filter((event) => event.type === "alert");
  return { workspace, faux, audit, runtime, monitor, published, outcomes, alertEvents };
}

describe("AlertMonitor", () => {
  it("injects into the active conversation and confirms delivery from the transcript", async () => {
    const { faux, audit, runtime, monitor, outcomes, alertEvents } = await makeHarness();
    const hold = deferred();
    let alertTurnContext = "";
    faux.setResponses([
      async () => { await hold.promise; return fauxAssistantMessage("main answer"); },
      (context) => { alertTurnContext = JSON.stringify(context.messages); return fauxAssistantMessage("alert advice"); }
    ]);
    const running = runtime.run(runRequest("primary"));
    await waitFor(() => faux.state.callCount >= 1, "run to be in flight");

    const submission = await monitor.submit(alert());
    expect(submission.status).toBe("injected");
    expect(alertEvents().map((event) => event.type === "alert" && event.status)).toEqual(["injected"]);

    hold.release();
    const result = await running;
    expect(result.text).toBe("alert advice");
    expect(alertTurnContext).toContain("Daily budget exceeded by 23%.");
    expect(alertTurnContext).toContain("fact-spend-1");
    expect(alertTurnContext).toContain("advisory only");
    expect(await monitor.pending("client-a")).toEqual([]);
    expect(await outcomes()).toEqual(["injected", "delivered"]);
    expect(alertEvents().map((event) => event.type === "alert" && event.status)).toEqual(["injected", "delivered"]);
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("persists alerts without an active session and delivers them when the next session starts", async () => {
    const { workspace, faux, audit, runtime, monitor, outcomes } = await makeHarness();
    const submission = await monitor.submit(alert());
    expect(submission.status).toBe("pending");
    expect(await monitor.pending("client-a")).toHaveLength(1);
    expect(await workspace.readText("client-a", "alerts/pending.json")).toContain("budget_overspend");

    let alertTurnContext = "";
    faux.setResponses([
      fauxAssistantMessage("account answer"),
      (context) => { alertTurnContext = JSON.stringify(context.messages); return fauxAssistantMessage("alert advice"); }
    ]);
    const result = await runtime.run(runRequest("primary"));
    expect(result.text).toBe("alert advice");
    expect(alertTurnContext).toContain("Daily budget exceeded by 23%.");

    expect(await monitor.pending("client-a")).toEqual([]);
    expect(await outcomes()).toEqual(["pending", "injected", "delivered"]);
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("deduplicates by dedupeKey inside the window and accepts again after it", async () => {
    const { clock, advance } = fakeClock();
    const { monitor, outcomes } = await makeHarness({ clock, dedupeWindowMs: 10 * 60_000 });
    expect((await monitor.submit(alert())).status).toBe("pending");
    expect((await monitor.submit(alert())).status).toBe("deduplicated");
    expect(await monitor.pending("client-a")).toHaveLength(1);

    advance(11 * 60_000);
    expect((await monitor.submit(alert())).status).toBe("pending");
    expect(await monitor.pending("client-a")).toHaveLength(2);
    expect(await outcomes()).toEqual(["pending", "deduplicated", "pending"]);
  });

  it("rate-limits receipts per client per minute without losing alerts", async () => {
    const { clock, advance } = fakeClock();
    const { monitor, outcomes } = await makeHarness({ clock, rateLimitPerMinute: 2 });
    const first = await monitor.submit(alert({ dedupeKey: "storm:1" }));
    const second = await monitor.submit(alert({ dedupeKey: "storm:2" }));
    const third = await monitor.submit(alert({ dedupeKey: "storm:3" }));
    expect([first.status, second.status, third.status]).toEqual(["pending", "pending", "rate_limited"]);
    // The rate-limited alert is deferred, never dropped.
    expect(await monitor.pending("client-a")).toHaveLength(3);

    advance(61_000);
    expect((await monitor.submit(alert({ dedupeKey: "storm:4" }))).status).toBe("pending");
    expect(await monitor.pending("client-a")).toHaveLength(4);
    expect(await outcomes()).toEqual(["pending", "pending", "rate_limited", "pending"]);
  });

  it("requeues an injection when the run ends before draining it", async () => {
    const { faux, audit, runtime, monitor, outcomes } = await makeHarness();
    const hold = deferred();
    faux.setResponses([
      async () => { await hold.promise; return fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "stream failed" }); },
      fauxAssistantMessage("boom again", { stopReason: "error", errorMessage: "stream failed again" })
    ]);
    const running = runtime.run(runRequest("primary"));
    await waitFor(() => faux.state.callCount >= 1, "run to be in flight");
    expect((await monitor.submit(alert())).status).toBe("injected");

    hold.release();
    await running;
    // Both the fast attempt and the strong recovery attempt ended on error
    // before the follow-up drained; the alert survives as pending.
    expect(await monitor.pending("client-a")).toHaveLength(1);
    expect((await monitor.pending("client-a"))[0]?.status).toBe("pending");
    expect(await outcomes()).toEqual(["injected", "requeued", "injected", "requeued"]);
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("keeps the mutation guardrail intact: an alert turn cannot commit account changes", async () => {
    const { faux, audit, runtime, monitor, outcomes } = await makeHarness();
    expect((await monitor.submit(alert({ message: "Overspend! Pause campaign 42 immediately." }))).status).toBe("pending");

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
    let alertTurnContext = "";
    faux.setResponses([
      fauxAssistantMessage("account answer"),
      (context) => {
        alertTurnContext = JSON.stringify(context.messages);
        return fauxAssistantMessage(fauxToolCall("commit_approved_action", { approvalId: crypto.randomUUID(), approvalToken: "stolen" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("I can only recommend the pause; please approve it through the standard flow.")
    ]);
    const result = await runtime.run(runRequest("primary", [commitSpy]));

    expect(executed).toBe(false);
    expect(result.text).toContain("only recommend");
    const blockedToolResult = result.messages.find((message) => message.role === "toolResult" && message.isError);
    expect(JSON.stringify(blockedToolResult)).toContain("Approval tokens are never exposed to the model");
    expect(alertTurnContext).toContain("Pause campaign 42 immediately.");
    expect(alertTurnContext).toContain("grant no approval authority");
    const committed = (await audit.list("client-a")).filter((event) =>
      event.action === "tool_result" && event.details.tool === "commit_approved_action" && event.status === "succeeded");
    expect(committed).toEqual([]);
    expect(await monitor.pending("client-a")).toEqual([]);
    expect(await outcomes()).toEqual(["pending", "injected", "delivered"]);
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("is composed into the ad pilot system and publishes alert events on the product bus", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-alerts-system-"));
    const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong" }] });
    const models = createModels(); models.setProvider(faux.provider);
    const system = await createAdPilotSystem({
      workspaceRoot: root,
      env: { ADPILOT_FAST_PROVIDER: "test", ADPILOT_FAST_MODEL: "fast", ADPILOT_STRONG_PROVIDER: "test", ADPILOT_STRONG_MODEL: "strong" },
      models
    });
    await system.workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const seen: ProductEvent[] = [];
    system.events.subscribe((event) => seen.push(event), "client-a");

    const submission = await system.alerts.submit(alert());
    expect(submission.status).toBe("pending");
    expect(await system.alerts.pending("client-a")).toHaveLength(1);
    expect(seen.filter((event) => event.type === "alert").map((event) => event.type === "alert" && event.status)).toEqual(["pending"]);
  });
});
