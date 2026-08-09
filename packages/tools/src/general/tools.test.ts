import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalService } from "@adpilot/approvals";
import { AuditLog } from "@adpilot/audit";
import { ExperimentStore } from "@adpilot/experiments";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotTools } from "../index.js";
import { GENERAL_READ_TOOL_NAMES, createGeneralReadTools, createReadPathGuard, workspaceReadPolicy } from "./index.js";
import { GREP_MAX_MATCH_LINE_LENGTH, GREP_MAX_PATTERN_LENGTH } from "./grep.js";

const SECRET = "0123456789abcdef0123456789abcdef";

async function makeTools(extraRoots: readonly string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "adpilot-general-tools-"));
  await mkdir(join(root, "reports", "2024"), { recursive: true });
  await mkdir(join(root, "exports", "nested"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await mkdir(join(root, ".adpilot"), { recursive: true });
  await writeFile(join(root, "reports", "daily.md"), "# Daily report\nSpend: 120 USD\nCPA: 4.20\n");
  await writeFile(join(root, "reports", "2024", "weekly.md"), "# Weekly\nConversions: 42\nspend recap\n");
  await writeFile(join(root, "exports", "metrics.json"), '{"spend": 120, "cpa": 4.2}\n');
  await writeFile(join(root, "exports", "nested", "rows.csv"), "date,spend\n2024-01-01,120\n");
  await writeFile(join(root, ".git", "ignored.txt"), "cpa: 0.01\n");
  await writeFile(join(root, "node_modules", "dep", "index.js"), "// cpa inside dependency\n");
  await writeFile(join(root, ".adpilot", "approval-secret"), "s3cr3t0123456789abcdef0123456789");
  const tools = createGeneralReadTools({ policy: workspaceReadPolicy(root, extraRoots) });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { root, tools, byName };
}

async function execute(tool: unknown, params: Record<string, unknown>) {
  const typed = tool as { execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }> };
  return typed.execute("call-1", params);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

describe("vendored general read-only tools", () => {
  it("builds exactly read/grep/find/ls in the read-only factory order", async () => {
    const { tools } = await makeTools();
    expect(tools.map((tool) => tool.name)).toEqual([...GENERAL_READ_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.executionMode).toBe("parallel");
    }
  });

  it("AdPilotTools exposes the same set, confined to the workspace, and toPiTools carries it", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-tools-integration-"));
    const workspace = new WorkspaceStore(root);
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, SECRET), new ExperimentStore(workspace));
    const context = { clientId: "client-a", taskId: crypto.randomUUID(), actor: "tester", permission: "OBSERVE" as const };
    const general = tools.generalReadTools();
    expect(general.map((tool) => tool.name)).toEqual([...GENERAL_READ_TOOL_NAMES]);
    expect(tools.generalReadTools()).toBe(general); // memoized
    const piTools = tools.toPiTools(context);
    for (const name of GENERAL_READ_TOOL_NAMES) {
      expect(piTools.some((tool) => tool.name === name), name).toBe(true);
    }
    const read = general.find((tool) => tool.name === "read")!;
    await mkdir(join(root, "clients"), { recursive: true });
    await writeFile(join(root, "clients", "note.md"), "hello workspace\n");
    const result = await execute(read, { path: "clients/note.md" });
    expect(textOf(result)).toBe("hello workspace\n");
    await expect(execute(read, { path: "../escape.md" })).rejects.toThrow("outside the readable roots");
  });
});

describe("read tool", () => {
  it("reads text files with offset and limit, and reports continuation offsets", async () => {
    const { byName } = await makeTools();
    const read = byName.get("read")!;
    const full = await execute(read, { path: "reports/daily.md" });
    expect(textOf(full)).toBe("# Daily report\nSpend: 120 USD\nCPA: 4.20\n");
    const slice = await execute(read, { path: "reports/daily.md", offset: 2, limit: 1 });
    expect(textOf(slice)).toContain("Spend: 120 USD");
    // The file ends with a trailing newline, so upstream counts 4 lines.
    expect(textOf(slice)).toContain("2 more lines in file. Use offset=3 to continue.");
    await expect(execute(read, { path: "reports/daily.md", offset: 99 })).rejects.toThrow("beyond end of file");
  });

  it("refuses directories, missing files, binary content, images, and escapes", async () => {
    const { root, byName } = await makeTools();
    const read = byName.get("read")!;
    await expect(execute(read, { path: "reports" })).rejects.toThrow("Not a file");
    await expect(execute(read, { path: "reports/missing.md" })).rejects.toThrow("Path not found");
    await writeFile(join(root, "exports", "blob.bin"), Buffer.from([0x50, 0x4b, 0x00, 0x4c]));
    await expect(execute(read, { path: "exports/blob.bin" })).rejects.toThrow("binary");
    await writeFile(join(root, "exports", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const image = await execute(read, { path: "exports/shot.png" });
    expect(textOf(image)).toContain("Image files are not supported");
    await expect(execute(read, { path: "../outside.md" })).rejects.toThrow("outside the readable roots");
    await expect(execute(read, { path: ".adpilot/approval-secret" })).rejects.toThrow("outside the readable roots");
    void root;
  });

  it("truncates long files at the byte limit with an actionable notice", async () => {
    const { root, byName } = await makeTools();
    const read = byName.get("read")!;
    const longLine = "x".repeat(4000);
    const content = Array.from({ length: 40 }, (_, index) => `line ${index} ${longLine}`).join("\n");
    await writeFile(join(root, "reports", "long.txt"), content);
    const result = await execute(read, { path: "reports/long.txt" });
    expect(textOf(result)).toContain("50.0KB limit");
    expect(textOf(result)).toContain("Use offset=");
  });
});

describe("grep tool", () => {
  it("finds matches with paths and line numbers in upstream output format", async () => {
    const { byName } = await makeTools();
    const grep = byName.get("grep")!;
    const result = await execute(grep, { pattern: "CPA" });
    expect(textOf(result)).toContain("reports/daily.md:3: CPA: 4.20");
    expect(textOf(result)).not.toContain("node_modules");
    expect(textOf(result)).not.toContain(".git");
  });

  it("supports literal, ignoreCase, glob filtering, and context lines", async () => {
    const { byName } = await makeTools();
    const grep = byName.get("grep")!;
    const literal = await execute(grep, { pattern: "spend", ignoreCase: true });
    expect(textOf(literal)).toContain("reports/2024/weekly.md:3: spend recap");
    const regex = await execute(grep, { pattern: "Spend: [0-9]+", glob: "*.md" });
    expect(textOf(regex)).toContain("reports/daily.md:2: Spend: 120 USD");
    expect(textOf(regex)).not.toContain("metrics.json");
    const globbed = await execute(grep, { pattern: "cpa", glob: "*.json" });
    expect(textOf(globbed)).toContain("exports/metrics.json:1:");
    const withContext = await execute(grep, { pattern: "CPA", context: 1 });
    expect(textOf(withContext)).toContain("reports/daily.md-2- Spend: 120 USD");
    expect(textOf(withContext)).toContain("reports/daily.md:3: CPA: 4.20");
    const noMatch = await execute(grep, { pattern: "definitely-absent-token" });
    expect(textOf(noMatch)).toBe("No matches found");
    await expect(execute(grep, { pattern: "([" })).rejects.toThrow("Invalid regular expression");
    const literalSpecial = await execute(grep, { pattern: "([", literal: true });
    expect(textOf(literalSpecial)).toBe("No matches found");
  });

  it("rejects regex structures with nested or ambiguous repetition but preserves literal matching", async () => {
    const { byName } = await makeTools();
    const grep = byName.get("grep")!;
    for (const pattern of ["(a+)+$", "(?:ab*)+$", "((ab){1,3})+$"]) {
      await expect(execute(grep, { pattern })).rejects.toThrow(/Unsafe regular expression: nested repetition/);
    }
    await expect(execute(grep, { pattern: "(?:a|aa)+$" })).rejects.toThrow(/Unsafe regular expression: repeated alternation/);
    const literal = await execute(grep, { pattern: "(a+)+$", literal: true, ignoreCase: true });
    expect(textOf(literal)).toBe("No matches found");
  });

  it("rejects overlong patterns before searching files", async () => {
    const { byName } = await makeTools();
    const grep = byName.get("grep")!;
    await expect(execute(grep, { pattern: "a".repeat(GREP_MAX_PATTERN_LENGTH + 1) }))
      .rejects.toThrow(`Search pattern exceeds the ${GREP_MAX_PATTERN_LENGTH} character safety limit`);
  });

  it("never evaluates regexes against overlong lines and continues with bounded lines", async () => {
    const { root, byName } = await makeTools();
    const grep = byName.get("grep")!;
    await writeFile(
      join(root, "reports", "long-line.txt"),
      `${"a".repeat(GREP_MAX_MATCH_LINE_LENGTH + 1)} NEEDLE\nshort NEEDLE\n`
    );
    const result = await execute(grep, { pattern: "NEEDLE", path: "reports/long-line.txt" });
    expect(textOf(result)).not.toContain("long-line.txt:1:");
    expect(textOf(result)).toContain("long-line.txt:2: short NEEDLE");
    expect(textOf(result)).toContain("Skipped 1 line(s)");
    expect(result.details).toMatchObject({ linesSkippedForSafety: 1 });
  });

  it("enforces the match limit with an actionable notice", async () => {
    const { root, byName } = await makeTools();
    const grep = byName.get("grep")!;
    await writeFile(join(root, "reports", "many.txt"), Array.from({ length: 30 }, (_, i) => `hit line ${i}`).join("\n"));
    const result = await execute(grep, { pattern: "hit line", limit: 5 });
    expect(textOf(result)).toContain("5 matches limit reached");
    expect((textOf(result).match(/many\.txt:\d+:/g) ?? []).length).toBe(5);
    void root;
  });

  it("skips binary files and keeps symlinked files confined", async () => {
    const { root, byName } = await makeTools();
    const grep = byName.get("grep")!;
    await writeFile(join(root, "exports", "binary.bin"), Buffer.from([0x63, 0x70, 0x61, 0x00, 0x63, 0x70, 0x61]));
    const result = await execute(grep, { pattern: "cpa", ignoreCase: true });
    expect(textOf(result)).not.toContain("binary.bin");
    const outside = await mkdtemp(join(tmpdir(), "adpilot-grep-outside-"));
    await writeFile(join(outside, "leak.txt"), "cpa: 0.01\n");
    await symlink(join(outside, "leak.txt"), join(root, "exports", "leak-link.txt"), "file");
    const confined = await execute(grep, { pattern: "cpa: 0.01" });
    expect(textOf(confined)).toBe("No matches found");
  });
});

describe("find tool", () => {
  it("matches basename globs, recursive globs, and path globs with fd semantics", async () => {
    const { byName } = await makeTools();
    const find = byName.get("find")!;
    const md = await execute(find, { pattern: "*.md" });
    expect(textOf(md)).toContain("reports/daily.md");
    expect(textOf(md)).toContain("reports/2024/weekly.md");
    const json = await execute(find, { pattern: "**/*.json" });
    expect(textOf(json)).toBe("exports/metrics.json");
    const nested = await execute(find, { pattern: "reports/**/*.md" });
    expect(textOf(nested)).toContain("reports/2024/weekly.md");
    expect(textOf(nested)).toContain("reports/daily.md");
    const none = await execute(find, { pattern: "*.ts" });
    expect(textOf(none)).toBe("No files found matching pattern");
  });

  it("skips .git and node_modules, lists matching directories, and honors limit", async () => {
    const { root, byName } = await makeTools();
    const find = byName.get("find")!;
    const all = await execute(find, { pattern: "**" });
    expect(textOf(all)).not.toContain(".git");
    expect(textOf(all)).not.toContain("node_modules");
    const dirs = await execute(find, { pattern: "2024" });
    expect(textOf(dirs)).toContain("reports/2024/");
    const limited = await execute(find, { pattern: "**", limit: 2 });
    expect(textOf(limited)).toContain("2 results limit reached");
    await expect(execute(find, { pattern: "**", path: "../" })).rejects.toThrow("outside the readable roots");
    void root;
  });
});

describe("ls tool", () => {
  it("lists entries sorted with directory suffixes, including dotfiles", async () => {
    const { byName } = await makeTools();
    const ls = byName.get("ls")!;
    const result = await execute(ls, {});
    const lines = textOf(result).split("\n");
    expect(lines).toContain("reports/");
    expect(lines).toContain("exports/");
    expect(lines).toContain(".adpilot/");
    expect(lines.indexOf(".adpilot/")).toBeLessThan(lines.indexOf("exports/"));
    const sub = await execute(ls, { path: "reports" });
    expect(textOf(sub)).toContain("2024/");
    expect(textOf(sub)).toContain("daily.md");
  });

  it("handles empty directories, entry limits, non-directories, and escapes", async () => {
    const { root, byName } = await makeTools();
    const ls = byName.get("ls")!;
    await mkdir(join(root, "empty"));
    expect(textOf(await execute(ls, { path: "empty" }))).toBe("(empty directory)");
    const limited = await execute(ls, { limit: 2 });
    expect(textOf(limited)).toContain("2 entries limit reached");
    await expect(execute(ls, { path: "reports/daily.md" })).rejects.toThrow("Not a directory");
    await expect(execute(ls, { path: "../" })).rejects.toThrow("outside the readable roots");
  });
});

describe("guard construction", () => {
  it("requires at least one allowed root", () => {
    expect(() => createReadPathGuard({ allow: [] })).toThrow("at least one allowed root");
  });

  it("resolves workspace policy roots once at construction", async () => {
    const root = resolve(await mkdtemp(join(tmpdir(), "adpilot-policy-")));
    const policy = workspaceReadPolicy(root);
    expect(policy.allow[0]).toBe(root);
    expect(policy.deny).toEqual([join(root, ".adpilot")]);
  });
});
