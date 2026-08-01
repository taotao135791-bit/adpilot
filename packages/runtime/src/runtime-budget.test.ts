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
import { AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import {
  MAX_RUNTIME_BUDGET,
  PiAgentRuntime,
  RuntimeBudgetExceeded,
  resolvePiSessionId,
  resolveRuntimeBudgetLimits
} from "./index.js";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function setup(options: Parameters<typeof fauxProvider>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), "adpilot-runtime-budget-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({
    profile: { id: "client-a", name: "A" },
    kpi: { primary: "CPA", target: 10 }
  });
  const faux = fauxProvider({
    ...options,
    provider: "test",
    models: [{ id: "fast" }, { id: "strong", reasoning: true }]
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const router = new ModelRouter({
    fast: { provider: "test", model: "fast" },
    strong: { provider: "test", model: "strong" },
    gui: { provider: "test", model: "fast" }
  });
  const tools = new AdPilotTools(
    workspace,
    new AuditLog(workspace),
    new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"),
    new ExperimentStore(workspace)
  );
  const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
  return { faux, runtime, workspace };
}

function request(conversationId: string) {
  return {
    context: {
      clientId: "client-a",
      conversationId,
      taskId: crypto.randomUUID(),
      actor: "budget_test",
      permission: "OBSERVE" as const,
      sessionId: conversationId,
      role: "budget_test"
    },
    systemPrompt: "Use only the supplied evidence.",
    prompt: "Review the campaign.",
    signals: { task: "conversation" as const }
  };
}

async function capturedBudgetError(operation: Promise<unknown>): Promise<RuntimeBudgetExceeded> {
  try {
    await operation;
    throw new Error("expected runtime budget failure");
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeBudgetExceeded);
    return error as RuntimeBudgetExceeded;
  }
}

describe("PiAgentRuntime hard budgets", () => {
  it("clamps per-run overrides to the hard safety envelope", () => {
    expect(resolveRuntimeBudgetLimits({
      maxTurns: Number.MAX_SAFE_INTEGER,
      maxToolCalls: Number.MAX_SAFE_INTEGER,
      wallClockMs: Number.MAX_SAFE_INTEGER
    })).toEqual(MAX_RUNTIME_BUDGET);
    expect(resolveRuntimeBudgetLimits({
      maxTurns: 0,
      maxToolCalls: -10,
      wallClockMs: 1
    })).toEqual({ maxTurns: 1, maxToolCalls: 1, wallClockMs: 10 });
  });

  it("never executes the N+1 tool body, clears queued messages, and releases the active session", async () => {
    const { faux, runtime, workspace } = await setup();
    const hold = deferred();
    let firstToolStarted = false;
    const execute = vi.fn(async (_toolCallId: string, _args: unknown, signal?: AbortSignal) => {
      firstToolStarted = true;
      await hold.promise;
      expect(signal?.aborted).toBe(false);
      return { content: [{ type: "text" as const, text: "first tool completed" }], details: {} };
    });
    const tool = {
      name: "analyze_campaign_metrics",
      label: "Analyze campaign metrics",
      description: "read-only test tool",
      parameters: { type: "object", properties: {} },
      executionMode: "sequential",
      execute
    } as AgentTool;
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("analyze_campaign_metrics", {}, { id: "tool-1" }),
        fauxToolCall("analyze_campaign_metrics", {}, { id: "tool-2" })
      ], { stopReason: "toolUse" })
    ]);

    const conversationId = "tool-budget";
    const running = runtime.run({
      ...request(conversationId),
      tools: [tool],
      budget: { maxTurns: 4, maxToolCalls: 1, wallClockMs: 5_000 }
    });
    await waitFor(() => firstToolStarted, "first tool body");
    expect(runtime.queueSessionMessage("client-a", conversationId, "queued steer", "steer")).toBe(true);
    expect(runtime.queueSessionMessage("client-a", conversationId, "queued follow-up", "followUp")).toBe(true);
    hold.release();

    const error = await capturedBudgetError(running);
    expect(error).toMatchObject({ reason: "maxToolCalls", turns: 1, toolCalls: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.isSessionActive("client-a", conversationId)).toBe(false);
    expect(runtime.queueSessionMessage("client-a", conversationId, "late message")).toBe(false);

    const storagePath = `sessions/${resolvePiSessionId("client-a", conversationId)}.jsonl`;
    const transcript = await workspace.readText("client-a", storagePath);
    expect(transcript).not.toContain("queued steer");
    expect(transcript).not.toContain("queued follow-up");
  });

  it("shares the turn counter with the automatic strong fallback", async () => {
    const { faux, runtime } = await setup();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "primary provider failed" }),
      fauxAssistantMessage("fallback must not run")
    ]);

    const error = await capturedBudgetError(runtime.run({
      ...request("fallback-turn-budget"),
      budget: { maxTurns: 1, maxToolCalls: 4, wallClockMs: 5_000 }
    }));
    expect(error).toMatchObject({ reason: "maxTurns", turns: 1, toolCalls: 0 });
    expect(faux.state.callCount).toBe(1);
    expect(runtime.isSessionActive("client-a", "fallback-turn-budget")).toBe(false);
  });

  it("shares one turn budget across structured primary, repair, and strong repair", async () => {
    const { faux, runtime } = await setup();
    faux.setResponses([
      fauxAssistantMessage("{}"),
      fauxAssistantMessage("{}"),
      fauxAssistantMessage('{"approved":false,"reason":"must not run"}')
    ]);

    const error = await capturedBudgetError(runtime.runStructuredDetailed({
      ...request("structured-turn-budget"),
      budget: { maxTurns: 2, maxToolCalls: 4, wallClockMs: 5_000 }
    }, z.object({ approved: z.boolean(), reason: z.string().min(1) })));
    expect(error).toMatchObject({ reason: "maxTurns", turns: 2, toolCalls: 0 });
    expect(faux.state.callCount).toBe(2);
    expect(runtime.isSessionActive("client-a", "structured-turn-budget")).toBe(false);
  });

  it("aborts the exact provider signal at the wall-clock deadline and throws a typed failure", async () => {
    const { faux, runtime } = await setup({
      tokensPerSecond: 4,
      tokenSize: { min: 1, max: 1 }
    });
    let providerSignal: AbortSignal | undefined;
    faux.setResponses([
      (_context, options) => {
        providerSignal = options?.signal;
        return fauxAssistantMessage("slow");
      }
    ]);

    const error = await capturedBudgetError(runtime.run({
      ...request("wall-clock-budget"),
      budget: { maxTurns: 4, maxToolCalls: 4, wallClockMs: 100 }
    }));
    expect(error.reason).toBe("wallClockMs");
    expect(error.turns).toBe(1);
    expect(error.toolCalls).toBe(0);
    expect(error.elapsedMs).toBeGreaterThanOrEqual(90);
    expect(faux.state.callCount).toBe(1);
    expect(providerSignal?.aborted).toBe(true);
    expect(runtime.isSessionActive("client-a", "wall-clock-budget")).toBe(false);
  });

  it("keeps explicit user Stop on the existing non-budget cancellation path", async () => {
    const { faux, runtime } = await setup();
    let toolStarted = false;
    const tool = {
      name: "analyze_campaign_metrics",
      label: "Analyze campaign metrics",
      description: "abort-aware read-only test tool",
      parameters: { type: "object", properties: {} },
      executionMode: "sequential",
      execute: async (_toolCallId: string, _args: unknown, signal?: AbortSignal) => {
        toolStarted = true;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("user stopped tool")), { once: true });
        });
        return { content: [{ type: "text" as const, text: "unreachable" }], details: {} };
      }
    } as AgentTool;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("analyze_campaign_metrics", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("must be aborted before streaming")
    ]);

    const conversationId = "user-stop-budget";
    const running = runtime.run({
      ...request(conversationId),
      tools: [tool],
      budget: { maxTurns: 4, maxToolCalls: 4, wallClockMs: 100 }
    });
    await waitFor(() => toolStarted, "abort-aware tool");
    expect(runtime.stopConversation("client-a", conversationId)).toBe(true);

    await expect(running).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "assistant", stopReason: "aborted" })
      ])
    });
    expect(runtime.isSessionActive("client-a", conversationId)).toBe(false);
  });
});
