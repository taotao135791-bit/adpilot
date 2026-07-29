import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgentToolCall } from "./lifecycle.js";
import type { AgentToolDefinition } from "./registry.js";
import { succeed } from "./result.js";
import { toolError } from "./errors.js";
import { makeCtx, makeTestDeps } from "./testing.js";

function definition(overrides: Partial<AgentToolDefinition> = {}): AgentToolDefinition {
  const name = overrides.name ?? "git.dummy";
  return {
    name,
    description: `Test double for ${name}.`,
    capabilityPack: "git",
    permission: "read",
    parameters: z.object({
      value: z.string().optional(),
      text: z.string().optional(),
      password: z.string().optional(),
      nested: z.object({ token: z.string().optional() }).optional()
    }),
    execute: async (_params, ctx) => succeed(name, ctx, { ok: true }),
    ...overrides
  };
}

describe("agent tool lifecycle", () => {
  it("assembles the full result envelope and audits the call", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-lifecycle-"));
    const { deps, auditEvents } = makeTestDeps(root);
    const ctx = makeCtx({ projectId: "p-1", goalId: "g-1", taskId: "t-1" });
    const result = await runAgentToolCall(definition(), { value: "hello" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(result.tool).toBe("git.dummy");
    expect(result.toolCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.workspaceId).toBe("client-a");
    expect(result.projectId).toBe("p-1");
    expect(result.goalId).toBe("g-1");
    expect(result.taskId).toBe("t-1");
    expect(result.sessionId).toBe("session-1");
    expect(result.data).toEqual({ ok: true });
    expect(result.evidenceIds).toEqual([]);
    expect(result.artifactIds).toEqual([]);
    expect(result.startedAt).toBe("2026-07-29T00:00:00.000Z");
    expect(result.completedAt).toBe("2026-07-29T00:00:00.000Z");
    expect(result.auditEventId).toBe("audit-1");

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      clientId: "client-a",
      action: "agent_tool:git.dummy",
      details: {
        tool: "git.dummy",
        capabilityPack: "git",
        permission: "read",
        success: true,
        projectId: "p-1",
        goalId: "g-1",
        taskId: "t-1",
        sessionId: "session-1"
      }
    });
  });

  it("redacts text/password/token parameter values in the audit details", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-lifecycle-redact-"));
    const { deps, auditEvents } = makeTestDeps(root);
    await runAgentToolCall(
      definition(),
      { value: "visible", text: "free-form user content", password: "hunter2", nested: { token: "tok_secret" } },
      makeCtx(),
      deps
    );
    const params = auditEvents[0]!.details.params as Record<string, unknown>;
    expect(params.value).toBe("visible");
    expect(params.text).toBe("[redacted]");
    expect(params.password).toBe("[redacted]");
    expect((params.nested as Record<string, unknown>).token).toBe("[redacted]");
  });

  it("re-checks permission as a second gate and never calls execute on denial", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-lifecycle-deny-"));
    const { deps, auditEvents } = makeTestDeps(root);
    let executed = false;
    const result = await runAgentToolCall(
      definition({
        permission: "destructive",
        execute: async (_params, ctx) => {
          executed = true;
          return succeed("git.dummy", ctx, { ok: true });
        }
      }),
      {},
      makeCtx({ permissions: { read: true, write: true, destructive: false, computerUse: false, network: false } }),
      deps
    );
    expect(executed).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: "PERMISSION_DENIED", recoverable: false });
    // Denials are audited too.
    expect(auditEvents[0]).toMatchObject({ action: "agent_tool:git.dummy", details: { success: false } });
  });

  it("maps zod failures to a recoverable INVALID_PARAMS result", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-lifecycle-invalid-"));
    const { deps } = makeTestDeps(root);
    const result = await runAgentToolCall(
      definition({ parameters: z.object({ value: z.string().min(1) }) }),
      { value: 42 },
      makeCtx(),
      deps
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: "INVALID_PARAMS", recoverable: true });
    expect(result.error!.message).toContain("value");
  });

  it("maps thrown coded errors: NOT_FOUND recoverable, PERMISSION_DENIED not", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-lifecycle-errors-"));
    const { deps } = makeTestDeps(root);
    const ctx = makeCtx();

    const notFound = await runAgentToolCall(
      definition({ execute: async () => { throw toolError("GOAL_NOT_FOUND", "goal not found: g-1"); } }),
      {},
      ctx,
      deps
    );
    expect(notFound.error).toMatchObject({ code: "GOAL_NOT_FOUND", message: "goal not found: g-1", recoverable: true });

    const denied = await runAgentToolCall(
      definition({ execute: async () => { throw toolError("PERMISSION_DENIED", "outside roots"); } }),
      {},
      ctx,
      deps
    );
    expect(denied.error).toMatchObject({ code: "PERMISSION_DENIED", recoverable: false });

    const generic = await runAgentToolCall(
      definition({ execute: async () => { throw new Error("boom"); } }),
      {},
      ctx,
      deps
    );
    expect(generic.error).toMatchObject({ code: "EXECUTION_FAILED", message: "boom", recoverable: true });
  });

  it("writes terminal/git/artifact write successes back to the kernel task evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-lifecycle-writeback-"));
    const { deps, kernel } = makeTestDeps(root);
    const task = await kernel.createTask({ title: "ship it" });
    const ctx = makeCtx({ taskId: task.id });
    const result = await runAgentToolCall(
      definition({
        permission: "write",
        execute: async (_params, innerCtx) => succeed("git.dummy", innerCtx, { sha: "abc" }, { evidenceIds: ["git-commit:abc"] })
      }),
      {},
      ctx,
      deps
    );
    expect(result.success).toBe(true);
    const summaryId = `agent-tool:git.dummy:${result.toolCallId}`;
    expect(result.evidenceIds).toEqual([summaryId, "git-commit:abc"]);

    const persisted = await kernel.listTasks();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.evidenceIds).toEqual([summaryId, "git-commit:abc"]);
    expect(persisted[0]!.revision).toBe(2);
  });

  it("does not write back for read tools or non-writeback packs", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-lifecycle-nowriteback-"));
    const { deps, kernel } = makeTestDeps(root);
    const task = await kernel.createTask({ title: "observe" });
    const ctx = makeCtx({ taskId: task.id });
    await runAgentToolCall(definition({ permission: "read" }), {}, ctx, deps);
    await runAgentToolCall(definition({ capabilityPack: "ads", permission: "write" }), {}, ctx, deps);
    expect((await kernel.listTasks())[0]!.evidenceIds).toEqual([]);
  });

  it("tolerates an audit sink failure without breaking the tool call", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-lifecycle-auditfail-"));
    const { deps } = makeTestDeps(root);
    deps.audit = async () => {
      throw new Error("audit store full");
    };
    const result = await runAgentToolCall(definition(), {}, makeCtx(), deps);
    expect(result.success).toBe(true);
    expect(result.auditEventId).toBeUndefined();
  });
});
