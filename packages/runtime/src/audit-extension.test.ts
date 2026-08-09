import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import { WorkspaceStore } from "@adpilot/workspace";
import { AuditRuntimeExtension, sanitizeForAudit, type RuntimeRunContext } from "./index.js";

function fingerprint(value: string): { length: number; sha256: string } {
  return {
    length: value.length,
    sha256: createHash("sha256").update(value).digest("hex")
  };
}

describe("AuditRuntimeExtension", () => {
  it("never persists raw tool payload strings while retaining auditable structure", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-runtime-audit-privacy-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({
      profile: { id: "client-a", name: "A" },
      kpi: { primary: "CPA", target: 10 }
    });
    const audit = new AuditLog(workspace);
    const extension = new AuditRuntimeExtension(audit);
    const context: RuntimeRunContext = {
      clientId: "client-a",
      taskId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      actor: "privacy_test",
      permission: "OBSERVE",
      role: "privacy_test"
    };
    const callCanary = `AUDIT_CALL_CANARY_${crypto.randomUUID()}`;
    const resultCanary = `AUDIT_RESULT_CANARY_${crypto.randomUUID()}`;
    const command = `printf '%s' '${callCanary}'`;
    const args = {
      command,
      text: callCanary,
      content: [{ type: "text", text: callCanary }],
      body: callCanary,
      query: callCanary,
      source: callCanary,
      arbitraryShortString: "ok",
      controls: { retries: 2, enabled: true, optional: null },
      values: [callCanary, 7, false, null]
    };
    const result = {
      stdout: resultCanary,
      stderr: resultCanary,
      text: resultCanary,
      content: [{ type: "text", text: resultCanary }],
      body: resultCanary,
      query: resultCanary,
      source: resultCanary,
      exitCode: 0,
      timedOut: false
    };

    await extension.onEvent(
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "terminal.execute", args },
      context
    );
    await extension.onEvent(
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "terminal.execute", result, isError: false },
      context
    );

    const events = await audit.list("client-a");
    expect(events).toHaveLength(2);
    expect(events.map((event) => [event.action, event.status])).toEqual([
      ["tool_call", "attempted"],
      ["tool_result", "succeeded"]
    ]);

    const projectedArgs = events[0]?.details.args as Record<string, unknown>;
    const projectedResult = events[1]?.details.result as Record<string, unknown>;
    expect(events[0]?.details.tool).toBe("terminal.execute");
    expect(events[1]?.details.tool).toBe("terminal.execute");
    expect(projectedArgs.command).toEqual(fingerprint(command));
    expect(projectedArgs.text).toEqual(fingerprint(callCanary));
    expect(projectedArgs.arbitraryShortString).toEqual(fingerprint("ok"));
    expect(projectedArgs.controls).toEqual({ retries: 2, enabled: true, optional: null });
    expect(projectedArgs.values).toEqual([fingerprint(callCanary), 7, false, null]);
    expect(projectedResult.stdout).toEqual(fingerprint(resultCanary));
    expect(projectedResult.stderr).toEqual(fingerprint(resultCanary));
    expect(projectedResult.exitCode).toBe(0);
    expect(projectedResult.timedOut).toBe(false);
    expect(events[1]?.details.isError).toBe(false);

    const jsonl = await workspace.readText("client-a", "audit.jsonl");
    for (const raw of [callCanary, resultCanary, command, "printf", '"ok"']) {
      expect(jsonl).not.toContain(raw);
    }
    expect(jsonl).toContain(fingerprint(callCanary).sha256);
    expect(jsonl).toContain(fingerprint(resultCanary).sha256);
    await expect(audit.verify("client-a")).resolves.toBe(true);
  });

  it("caps breadth and depth without introducing raw strings", () => {
    const privateValue = `AUDIT_NESTED_CANARY_${crypto.randomUUID()}`;
    const projected = sanitizeForAudit({
      nested: { one: { two: { three: { four: { five: privateValue } } } } },
      values: Array.from({ length: 24 }, (_, index) => (index === 0 ? privateValue : index))
    });
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain(privateValue);
    expect(serialized).toContain(fingerprint(privateValue).sha256);
    const projectedValues = (projected as { values: unknown[] }).values;
    expect(projectedValues.slice(0, 3)).toEqual([fingerprint(privateValue), 1, 2]);
    expect(serialized).toContain('"omittedItems":4');
  });

  it("fingerprints run errors because they can embed commands or private paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-runtime-audit-error-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({
      profile: { id: "client-a", name: "A" },
      kpi: { primary: "CPA", target: 10 }
    });
    const audit = new AuditLog(workspace);
    const extension = new AuditRuntimeExtension(audit);
    const context: RuntimeRunContext = {
      clientId: "client-a",
      taskId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      actor: "privacy_test",
      permission: "OBSERVE",
      role: "privacy_test"
    };
    const canary = `AUDIT_ERROR_CANARY_${crypto.randomUUID()}`;

    await extension.onError(new Error(`command failed in /private/customer/${canary}`), context);

    const event = (await audit.list("client-a"))[0];
    const message = `command failed in /private/customer/${canary}`;
    expect(event?.details.error).toEqual(fingerprint(message));
    expect(await workspace.readText("client-a", "audit.jsonl")).not.toContain(canary);
    await expect(audit.verify("client-a")).resolves.toBe(true);
  });
});
