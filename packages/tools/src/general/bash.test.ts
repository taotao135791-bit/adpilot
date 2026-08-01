import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASH_DENY_MESSAGE, createBashTool, type BashToolAuditEntry } from "./bash.js";
import { SANDBOX_UNAVAILABLE_MESSAGE } from "./sandbox.js";

/**
 * Tool-level contract for the vendored bash tool: deterministic deny,
 * fail-closed sandbox availability, and sandbox-exec execution semantics.
 * The approval gate for write-level commands lives one layer up (tool gate,
 * covered in packages/runtime/src/tool-gate.test.ts); this file pins what
 * the tool itself guarantees regardless of the gate.
 */

interface FakeSpawnCall {
  file: string;
  args: readonly string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean };
}

function fakeSpawn(script: (call: FakeSpawnCall, child: ReturnType<typeof makeChild>) => void) {
  const calls: FakeSpawnCall[] = [];
  const impl = ((file: string, args: readonly string[], options: FakeSpawnCall["options"]) => {
    const child = makeChild();
    const call: FakeSpawnCall = { file, args, options };
    calls.push(call);
    queueMicrotask(() => script(call, child));
    return child;
  }) as unknown as typeof spawn;
  return { impl, calls };
}

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: (signal?: string) => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // Far outside macOS's pid range: the tool's process-group kill is a
  // guaranteed ESRCH no-op in tests, so the fallback child.kill drives it.
  child.pid = 2 ** 30;
  child.kill = () => true;
  return child;
}

function finish(child: ReturnType<typeof makeChild>, opts: { stdout?: string; stderr?: string; code?: number | null }) {
  if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
  if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
  child.emit("close", opts.code ?? 0);
}

async function makeTool(overrides: { sandboxExecPath?: string | null; spawnImpl?: typeof spawn } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adpilot-bash-tool-")));
  const audit: BashToolAuditEntry[] = [];
  const tool = createBashTool({
    workspaceRoot: root,
    onClassified: (entry) => { audit.push(entry); },
    ...overrides
  });
  const run = (params: Record<string, unknown>, signal?: AbortSignal) =>
    (tool.execute as (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text?: string }>; details: Record<string, unknown> }>)("call-1", params, signal);
  return { root, tool, audit, run };
}

describe("bash tool: deterministic deny (no approval can authorize)", () => {
  it("refuses network egress, screen capture, credentials and rm -rf before any spawn", async () => {
    const { impl, calls } = fakeSpawn((_call, child) => finish(child, { stdout: "should never run" }));
    const { audit, run } = await makeTool({ spawnImpl: impl, sandboxExecPath: null });
    for (const command of [
      "curl https://ads.google.com/api",
      "screencapture /tmp/shot.png",
      "cat .adpilot/approval-secret",
      "sudo ls",
      "rm -rf /",
      "ls ~/Library/Cookies"
    ]) {
      await expect(run({ command }), command).rejects.toThrow(BASH_DENY_MESSAGE);
    }
    expect(calls).toHaveLength(0); // nothing was ever executed
    expect(audit).toHaveLength(6);
    for (const entry of audit) {
      expect(entry.executed).toBe(false);
      expect(entry.classification.verdict).toBe("deny");
    }
    expect(audit[0]?.classification.commands[0]?.rule).toBe("network_egress");
    expect(audit[2]?.classification.commands[0]?.rule).toBe("protected_path");
  });

  it("reports the denied segments with their rules in the error", async () => {
    const { run } = await makeTool({ sandboxExecPath: null });
    await expect(run({ command: "ls -la && curl https://x" })).rejects.toThrow(/curl https:\/\/x \[network_egress\]/);
  });
});

describe("bash tool: fail-closed sandbox availability", () => {
  it("refuses to execute anything when sandbox-exec is missing (never silently degrades)", async () => {
    const { impl, calls } = fakeSpawn((_call, child) => finish(child, { stdout: "unsandboxed" }));
    const { audit, run } = await makeTool({ spawnImpl: impl, sandboxExecPath: "/nonexistent/sandbox-exec" });
    await expect(run({ command: "ls -la" })).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE);
    await expect(run({ command: "echo hi > notes.md" })).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE);
    expect(calls).toHaveLength(0);
    expect(audit.map((entry) => entry.executed)).toEqual([false, false]);
    expect(audit[0]?.sandboxPath).toBeNull();
  });

  it("still reports hard denials (not the sandbox error) when the sandbox is missing", async () => {
    const { run } = await makeTool({ sandboxExecPath: null });
    await expect(run({ command: "curl https://x" })).rejects.toThrow(BASH_DENY_MESSAGE);
  });
});

describe.runIf(process.platform === "darwin")("bash tool: sandbox-exec execution", () => {
  it("executes through sandbox-exec with the generated profile, workspace cwd and a scrubbed environment", async () => {
    let isolatedHome = "";
    const { impl, calls } = fakeSpawn((call, child) => {
      expect(call.file).toBe("/usr/bin/sandbox-exec");
      expect(call.args[0]).toBe("-p");
      const profile = call.args[1]!;
      expect(profile).toContain("(deny network*)");
      expect(profile).toContain("(deny default)");
      expect(call.args[2]).toBe("/bin/bash");
      expect(call.args[3]).toBe("-c");
      expect(call.options.detached).toBe(true);
      expect(call.options.env?.OPENAI_API_KEY).toBeUndefined();
      isolatedHome = call.options.env?.HOME ?? "";
      expect(isolatedHome).toMatch(/adpilot-private-/);
      expect(call.options.env?.TMPDIR).toBe(isolatedHome);
      expect(profile).toContain(`(subpath "${isolatedHome}")`);
      expect(profile).not.toContain('(subpath "/tmp")');
      expect(profile).not.toContain('(subpath "/private/tmp")');
      finish(child, { stdout: "daily.md\n" });
    });
    process.env.OPENAI_API_KEY = "sk-test-should-not-leak";
    try {
      const { root, audit, run } = await makeTool({ spawnImpl: impl });
      const result = await run({ command: "ls reports" });
      expect(calls[0]?.options.cwd).toBe(root);
      expect(calls[0]?.args[4]).toBe("ls reports");
      expect(result.content.map((item) => item.text ?? "").join("\n")).toBe("daily.md\n");
      expect(result.details).toMatchObject({ exitCode: 0, classification: { verdict: "read", parseable: true } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ executed: true, sandboxPath: "/usr/bin/sandbox-exec" });
      expect(existsSync(isolatedHome)).toBe(false);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("runs write-level commands through the same sandbox (approval is the gate's layer)", async () => {
    const { impl, calls } = fakeSpawn((_call, child) => finish(child, { code: 0 }));
    const { audit, run } = await makeTool({ spawnImpl: impl });
    await run({ command: "echo hi > notes.md" });
    expect(calls).toHaveLength(1);
    expect(audit[0]?.classification.verdict).toBe("write");
    expect(audit[0]?.executed).toBe(true);
  });

  it("fails the call with the output and exit code on non-zero exits", async () => {
    const { impl } = fakeSpawn((_call, child) => finish(child, { stdout: "partial\n", stderr: "boom\n", code: 3 }));
    const { run } = await makeTool({ spawnImpl: impl });
    await expect(run({ command: "grep x f" })).rejects.toThrow(/exited with code 3/);
    await expect(run({ command: "grep x f" })).rejects.toThrow(/boom/);
  });

  it("truncates oversized output with the tail-truncation notice", async () => {
    const big = Array.from({ length: 4000 }, (_, index) => `line ${index}`).join("\n");
    const { impl } = fakeSpawn((_call, child) => finish(child, { stdout: big }));
    const { run } = await makeTool({ spawnImpl: impl });
    const result = await run({ command: "cat big.txt" });
    const text = result.content.map((item) => item.text ?? "").join("\n");
    expect(result.details.truncated).toBe(true);
    expect(text).toContain("Showing lines");
    expect(text).toContain("line 3999");
    expect(text).not.toContain("line 0\n");
  });

  it("validates timeout bounds and kills the process group on expiry", async () => {
    const { impl } = fakeSpawn((_call, child) => {
      // Never finishes on its own; the tool's timeout must kill it. The fake
      // kill closes the child so the tool can settle (pid is out of range, so
      // the process-group kill is a guaranteed ESRCH no-op in tests).
      child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
    });
    const { run } = await makeTool({ spawnImpl: impl });
    await expect(run({ command: "sleep 60", timeout: 0 })).rejects.toThrow();
    await expect(run({ command: "sleep 60", timeout: 3601 })).rejects.toThrow();
    await expect(run({ command: "sleep 60", timeout: 1 })).rejects.toThrow("timed out after 1 seconds");
  }, 10_000);

  it("honors an already-aborted signal before classification", async () => {
    const { impl, calls } = fakeSpawn((_call, child) => finish(child, {}));
    const { run } = await makeTool({ spawnImpl: impl });
    const controller = new AbortController();
    controller.abort();
    await expect(run({ command: "ls" }, controller.signal)).rejects.toThrow("aborted");
    expect(calls).toHaveLength(0);
  });
});

describe.runIf(process.platform === "darwin")("bash tool: real sandbox smoke test (macOS only)", () => {
  it("executes a whitelisted command under the real seatbelt sandbox", async () => {
    const { root, run } = await makeTool();
    await writeFile(join(root, "note.md"), "hello sandbox\n");
    const result = await run({ command: "cat note.md" });
    expect(result.content.map((item) => item.text ?? "").join("\n")).toBe("hello sandbox\n");
    void root;
  }, 20_000);

  it("holds the OS floor where the classifier cannot: each invocation gets an isolated, cleaned temp home", async () => {
    const { root, run } = await makeTool();
    const homeResult = await run({ command: "printf '%s' \"$HOME\"" });
    const privateHome = homeResult.content.map((item) => item.text ?? "").join("").trim();
    expect(privateHome).toMatch(/adpilot-private-/);
    expect(privateHome).not.toBe(process.env.HOME);
    expect(existsSync(privateHome)).toBe(false);

    const otherTemp = await realpath(await mkdtemp(join(tmpdir(), "adpilot-other-client-")));
    const sentinel = join(otherTemp, "sentinel.txt");
    await writeFile(sentinel, "other-client-secret\n");
    try {
      await expect(run({ command: `cat '${sentinel}'` })).rejects.toThrow(/Operation not permitted|exited with code/);
    } finally {
      await rm(otherTemp, { recursive: true, force: true });
    }
    // Read confinement holds at the OS floor too: /Users is not a readable root.
    await expect(run({ command: "ls /Users" })).rejects.toThrow(/exited with code/);
    void root;
  }, 20_000);
});
