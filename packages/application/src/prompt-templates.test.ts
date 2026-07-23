import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandPromptTemplateBody,
  parsePromptTemplate,
  PromptTemplateStore,
  tokenizePromptArguments
} from "./prompt-templates.js";

async function makeDirs() {
  const base = await mkdtemp(join(tmpdir(), "adpilot-prompts-"));
  const user = join(base, "home", "prompts");
  const workspace = join(base, "ws", ".adpilot", "prompts");
  await mkdir(user, { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { base, user, workspace };
}

async function touch(path: string, content: string, mtime?: Date) {
  await writeFile(path, content);
  if (mtime) await utimes(path, mtime, mtime);
}

describe("tokenizePromptArguments", () => {
  it("splits on whitespace and groups single and double quotes", () => {
    expect(tokenizePromptArguments("")).toEqual([]);
    expect(tokenizePromptArguments("daily")).toEqual(["daily"]);
    expect(tokenizePromptArguments('Button "click handler" \'disabled support\'')).toEqual(["Button", "click handler", "disabled support"]);
    expect(tokenizePromptArguments("  a   b\tc ")).toEqual(["a", "b", "c"]);
    expect(tokenizePromptArguments('"unterminated')).toEqual(["unterminated"]);
  });
});

describe("expandPromptTemplateBody", () => {
  it("expands positional args, $@, and $ARGUMENTS", () => {
    expect(expandPromptTemplateBody("Create $1 with features: $2", ["Button", "ripple"])).toBe("Create Button with features: ripple");
    expect(expandPromptTemplateBody("all: $@", ["a", "b c"])).toBe("all: a b c");
    expect(expandPromptTemplateBody("all: $ARGUMENTS", ["a", "b"])).toBe("all: a b");
    expect(expandPromptTemplateBody("missing $2 stays empty", ["only"])).toBe("missing  stays empty");
    expect(expandPromptTemplateBody("ten: $10", ["1", "2", "3", "4", "5", "6", "7", "8", "9", "ten"])).toBe("ten: ten");
  });

  it("expands ${N:-default} only when the arg is missing or empty", () => {
    expect(expandPromptTemplateBody("in ${1:-7} bullets", [])).toBe("in 7 bullets");
    expect(expandPromptTemplateBody("in ${1:-7} bullets", ["5"])).toBe("in 5 bullets");
    expect(expandPromptTemplateBody("in ${2:-7} bullets", ["", "3"])).toBe("in 3 bullets");
  });

  it("expands bash-style slices ${@:N} and ${@:N:L}", () => {
    expect(expandPromptTemplateBody("rest: ${@:2}", ["a", "b", "c"])).toBe("rest: b c");
    expect(expandPromptTemplateBody("rest: ${@:2:1}", ["a", "b", "c"])).toBe("rest: b");
    expect(expandPromptTemplateBody("rest: ${@:5}", ["a"])).toBe("rest: ");
    expect(expandPromptTemplateBody("rest: ${@:0}", ["a", "b"])).toBe("rest: a b");
  });

  it("does not recursively substitute placeholders inside argument values", () => {
    expect(expandPromptTemplateBody("show $1", ["$@"])).toBe("show $@");
    expect(expandPromptTemplateBody("in ${1:-$@} bullets", [])).toBe("in $@ bullets");
  });
});

describe("parsePromptTemplate", () => {
  it("parses frontmatter description and argument-hint", () => {
    const template = parsePromptTemplate("review.md", "---\ndescription: Review staged changes\nargument-hint: \"<path>\"\n---\nReview $1 carefully.\n");
    expect(template).toMatchObject({ name: "review", description: "Review staged changes", argumentHint: "<path>", body: "Review $1 carefully." });
  });

  it("falls back to the first non-empty line for the description", () => {
    const template = parsePromptTemplate("plain.md", "\nAudit the changelog entries before release.\nMore detail.\n");
    expect(template.description).toBe("Audit the changelog entries before release.");
    const long = parsePromptTemplate("plain.md", `${"x".repeat(80)}\n`);
    expect(long.description).toHaveLength(61);
    expect(long.description.endsWith("…")).toBe(true);
  });

  it("rejects invalid command names, empty bodies, and bloated fields", () => {
    expect(() => parsePromptTemplate("Bad Name.md", "body\n")).toThrow("invalid command name");
    expect(() => parsePromptTemplate("UPPER.md", "body\n")).toThrow("invalid command name");
    expect(() => parsePromptTemplate("ok.md", "---\ndescription: x\n---\n  \n")).toThrow("missing template body");
    expect(() => parsePromptTemplate("ok.md", `---\ndescription: ${"d".repeat(501)}\n---\nbody\n`)).toThrow("exceeds 500");
    expect(() => parsePromptTemplate("ok.md", `---\nargument-hint: ${"h".repeat(101)}\n---\nbody\n`)).toThrow("argument-hint");
    expect(() => parsePromptTemplate("ok.md", "---\nname: [broken\n---\nbody\n")).toThrow("invalid frontmatter YAML");
  });
});

describe("PromptTemplateStore", () => {
  it("discovers top-level markdown only, lists summaries, finds and expands by name", async () => {
    const { user } = await makeDirs();
    await touch(join(user, "review.md"), "---\ndescription: Review a report\nargument-hint: \"<name>\"\n---\nReview $1 with rigor.\n");
    await mkdir(join(user, "nested"), { recursive: true });
    await touch(join(user, "nested", "ignored.md"), "---\ndescription: nested\n---\nbody\n");
    const store = new PromptTemplateStore([user]);
    expect(await store.list()).toEqual([{ name: "review", description: "Review a report", argumentHint: "<name>" }]);
    expect((await store.find("review"))?.body).toBe("Review $1 with rigor.");
    expect(await store.expand("review", '"weekly report"')).toBe("Review weekly report with rigor.");
    expect(await store.find("ignored")).toBeUndefined();
    expect(await store.expand("unknown", "")).toBeUndefined();
  });

  it("skips invalid templates with warnings and lets later directories override", async () => {
    const { user, workspace } = await makeDirs();
    await touch(join(user, "broken.md"), "---\ndescription: x\n---\n");
    await touch(join(user, "shared.md"), "---\ndescription: user version\n---\nuser body $1\n");
    await touch(join(workspace, "shared.md"), "---\ndescription: workspace version\n---\nworkspace body $1\n");
    const store = new PromptTemplateStore([user, workspace]);
    expect(await store.list()).toEqual([{ name: "shared", description: "workspace version" }]);
    expect(await store.expand("shared", "x")).toBe("workspace body x");
    const warnings = await store.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.reason).toContain("missing template body");
  });

  it("invalidates on mtime change and tracks deleted files", async () => {
    const { user } = await makeDirs();
    const path = join(user, "note.md");
    const store = new PromptTemplateStore([user]);
    await touch(path, "---\ndescription: v1\n---\nfirst $1\n", new Date("2024-01-01T00:00:00Z"));
    expect(await store.expand("note", "a")).toBe("first a");
    await touch(path, "---\ndescription: v2\n---\nsecond $1\n", new Date("2024-02-01T00:00:00Z"));
    expect(await store.expand("note", "a")).toBe("second a");
    expect((await store.list())[0]!.description).toBe("v2");
    await rm(path);
    expect(await store.list()).toEqual([]);
  });
});
