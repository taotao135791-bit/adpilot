import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GENERAL_AGENT_TOOL_NAMES, createGeneralAgentTools, workspaceReadPolicy, workspaceWritePolicy } from "./index.js";
import { createReadPathGuard } from "./path-guard.js";
import { createWriteTool } from "./write.js";
import { applyEdits, createEditTool } from "./edit.js";

/**
 * Tool-level contract for the vendored write/edit pair: workspace-confined
 * mutation semantics. The approval gate (executed reference, same client and
 * task) is enforced one layer up in the runtime tool gate and is covered by
 * packages/runtime/src/tool-gate.test.ts — these tests pin the confinement
 * and the edit semantics themselves.
 */
async function makeWorkspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adpilot-write-edit-")));
  await mkdir(join(root, "reports"), { recursive: true });
  await mkdir(join(root, ".adpilot"), { recursive: true });
  await writeFile(join(root, "reports", "daily.md"), "# Daily\nSpend: 120 USD\nCPA: 4.20\n");
  await writeFile(join(root, ".adpilot", "approval-secret"), "s3cr3t0123456789abcdef0123456789");
  const guard = createReadPathGuard(workspaceWritePolicy(root));
  return { root, guard, write: createWriteTool(guard), edit: createEditTool(guard) };
}

async function run(tool: unknown, params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }> {
  return (tool as { execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }> }).execute("call-1", params);
}

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

describe("write tool", () => {
  it("writes new files with parent directories and overwrites existing ones", async () => {
    const { root, write } = await makeWorkspace();
    const created = await run(write, { path: "reports/2024/weekly.md", content: "# Weekly\n" });
    expect(textOf(created)).toContain("reports/2024/weekly.md");
    expect(await readFile(join(root, "reports", "2024", "weekly.md"), "utf-8")).toBe("# Weekly\n");
    const overwritten = await run(write, { path: "reports/daily.md", content: "# Rewritten\n" });
    expect(overwritten.details).toMatchObject({ path: resolve(root, "reports", "daily.md") });
    expect(await readFile(join(root, "reports", "daily.md"), "utf-8")).toBe("# Rewritten\n");
  });

  it("refuses escapes, absolute paths outside the workspace and the private .adpilot subtree", async () => {
    const { root, write } = await makeWorkspace();
    await expect(run(write, { path: "../outside.md", content: "x" })).rejects.toThrow("outside the readable roots");
    await expect(run(write, { path: "/etc/adpilot-marker", content: "x" })).rejects.toThrow("outside the readable roots");
    await expect(run(write, { path: ".adpilot/forged.json", content: "x" })).rejects.toThrow("outside the readable roots");
    await expect(run(write, { path: ".adpilot/approval-secret", content: "forged" })).rejects.toThrow("outside the readable roots");
    await expect(run(write, { path: ".env", content: "KEY=x" })).rejects.toThrow("protected by AdPilot policy");
    expect(await readFile(join(root, ".adpilot", "approval-secret"), "utf-8")).toBe("s3cr3t0123456789abcdef0123456789");
  });

  it("rejects empty paths and aborted signals before touching the filesystem", async () => {
    const { write } = await makeWorkspace();
    await expect(run(write, { path: "", content: "x" })).rejects.toThrow();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      (write as { execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }).execute("c", { path: "reports/x.md", content: "x" }, aborted.signal)
    ).rejects.toThrow("aborted");
  });
});

describe("edit tool", () => {
  it("applies unique targeted replacements and reports the first changed line", async () => {
    const { root, edit } = await makeWorkspace();
    const result = await run(edit, {
      path: "reports/daily.md",
      edits: [{ oldText: "Spend: 120 USD", newText: "Spend: 140 USD" }, { oldText: "CPA: 4.20", newText: "CPA: 4.05" }]
    });
    expect(result.details).toMatchObject({ replacements: 2, firstChangedLine: 2 });
    expect(await readFile(join(root, "reports", "daily.md"), "utf-8")).toBe("# Daily\nSpend: 140 USD\nCPA: 4.05\n");
  });

  it("requires every oldText to occur exactly once in the original content", async () => {
    const { edit } = await makeWorkspace();
    await expect(run(edit, { path: "reports/daily.md", edits: [{ oldText: "missing", newText: "x" }] })).rejects.toThrow("was not found");
    // "0" occurs twice in the fixture ("120" and "4.20").
    await expect(run(edit, { path: "reports/daily.md", edits: [{ oldText: "0", newText: "x" }] })).rejects.toThrow("must be unique");
    await expect(run(edit, { path: "reports/daily.md", edits: [{ oldText: "", newText: "x" }] })).rejects.toThrow("must not be empty");
  });

  it("rejects overlapping edits and no-op edits", async () => {
    const { edit } = await makeWorkspace();
    await expect(run(edit, {
      path: "reports/daily.md",
      edits: [
        { oldText: "Spend: 120 USD", newText: "Spend: 140 USD" },
        { oldText: "120", newText: "140" }
      ]
    })).rejects.toThrow("overlaps");
    await expect(run(edit, { path: "reports/daily.md", edits: [{ oldText: "CPA: 4.20", newText: "CPA: 4.20" }] })).rejects.toThrow("no change");
  });

  it("round-trips CRLF files in CRLF and preserves a UTF-8 BOM", async () => {
    const { root, edit } = await makeWorkspace();
    await writeFile(join(root, "reports", "crlf.md"), "line one\r\nline two\r\n");
    await run(edit, { path: "reports/crlf.md", edits: [{ oldText: "line two", newText: "line 2" }] });
    expect(await readFile(join(root, "reports", "crlf.md"), "utf-8")).toBe("line one\r\nline 2\r\n");
    await writeFile(join(root, "reports", "bom.md"), "\uFEFFalpha\nbeta\n");
    await run(edit, { path: "reports/bom.md", edits: [{ oldText: "beta", newText: "gamma" }] });
    const bom = await readFile(join(root, "reports", "bom.md"), "utf-8");
    expect(bom.startsWith("\uFEFF")).toBe(true);
    expect(bom).toBe("\uFEFFalpha\ngamma\n");
  });

  it("refuses missing files, escapes and protected paths", async () => {
    const { edit } = await makeWorkspace();
    await expect(run(edit, { path: "reports/missing.md", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow("Path not found");
    await expect(run(edit, { path: "../outside.md", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow("outside the readable roots");
    await expect(run(edit, { path: ".adpilot/approval-secret", edits: [{ oldText: "s3cr3t", newText: "forged" }] })).rejects.toThrow("outside the readable roots");
  });
});

describe("applyEdits", () => {
  it("validates uniqueness against the original content, then applies edits sequentially", () => {
    const result = applyEdits("aaa bbb", [
      { oldText: "aaa", newText: "bbb" },
      { oldText: "bbb", newText: "ccc" }
    ]);
    // Uniqueness was validated against the ORIGINAL ("aaa bbb", where both
    // oldTexts are unique); replacements then run one after another, so the
    // second edit sees the first edit's output.
    expect(result).toBe("ccc bbb");
  });
});

describe("main-agent general tool factory", () => {
  it("builds read/grep/find/ls/write/edit/bash in factory order, bash last (main agent only)", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "adpilot-agent-tools-")));
    const tools = createGeneralAgentTools({
      workspaceRoot: root,
      readPolicy: workspaceReadPolicy(root),
      bash: { sandboxExecPath: null }
    });
    expect(tools.map((tool) => tool.name)).toEqual([...GENERAL_AGENT_TOOL_NAMES]);
    expect(GENERAL_AGENT_TOOL_NAMES).toEqual(["read", "grep", "find", "ls", "write", "edit", "bash"]);
    // Specialists keep the read-only subset: GENERAL_READ_TOOL_NAMES is a strict prefix.
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
    }
  });
});
