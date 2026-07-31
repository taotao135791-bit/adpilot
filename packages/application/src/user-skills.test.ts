import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatKnowledgeCatalogForPrompt,
  formatKnowledgeSkillContext,
  listKnowledgeSkills,
  matchKnowledgeSkills
} from "@adpilot/advertising-core";
import {
  createMergedAgentKnowledge,
  parseSkillMarkdown,
  UserSkillStore
} from "./user-skills.js";

const VALID_BODY = "---\nname: my-skill\ndescription: Does a useful thing when asked.\n---\n\n# My Skill\n\nDo the thing.\n";

async function makeRoots() {
  const base = await mkdtemp(join(tmpdir(), "adpilot-user-skills-"));
  const user = join(base, "home", "skills");
  const workspace = join(base, "ws", ".adpilot", "skills");
  await mkdir(user, { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { base, user, workspace };
}

async function touch(path: string, content: string, mtime?: Date) {
  await writeFile(path, content);
  if (mtime) await utimes(path, mtime, mtime);
}

describe("parseSkillMarkdown", () => {
  it("parses frontmatter and defaults triggers to the skill name", () => {
    const skill = parseSkillMarkdown(VALID_BODY, "fallback");
    expect(skill.name).toBe("my-skill");
    expect(skill.description).toBe("Does a useful thing when asked.");
    expect(skill.triggers).toEqual(["my-skill"]);
    expect(skill.body).toBe("# My Skill\n\nDo the thing.");
  });

  it("honors custom triggers and the fallback name, and normalizes CRLF", () => {
    const skill = parseSkillMarkdown(
      "---\r\ndescription: Fallback named.\r\ntriggers: [日报, Report]\r\n---\r\n\r\nBody here.\r\n",
      "dir-name"
    );
    expect(skill.name).toBe("dir-name");
    expect(skill.triggers).toEqual(["日报", "Report"]);
    expect(skill.body).toBe("Body here.");
  });

  it("rejects invalid names per the Agent Skills standard", () => {
    for (const name of ["My-Skill", "-lead", "trail-", "double--hyphen", "has_underscore", "a".repeat(65)]) {
      expect(() => parseSkillMarkdown(`---\nname: ${name}\ndescription: x\n---\nbody\n`, "fallback"), name).toThrow("invalid skill name");
    }
    // An explicitly empty name and an invalid fallback name are rejected too.
    expect(() => parseSkillMarkdown('---\nname: ""\ndescription: x\n---\nbody\n', "fallback")).toThrow("invalid skill name");
    expect(() => parseSkillMarkdown("no frontmatter body\n", "Bad_Name")).toThrow("invalid skill name");
  });

  it("rejects missing or oversized descriptions and empty or oversized bodies", () => {
    expect(() => parseSkillMarkdown("---\nname: ok-name\n---\nbody\n", "fallback")).toThrow("missing required description");
    expect(() => parseSkillMarkdown(`---\nname: ok-name\ndescription: ${"d".repeat(1025)}\n---\nbody\n`, "fallback")).toThrow("exceeds 1024");
    expect(() => parseSkillMarkdown("---\nname: ok-name\ndescription: fine\n---\n   \n", "fallback")).toThrow("missing skill body");
    expect(() => parseSkillMarkdown(`---\nname: ok-name\ndescription: fine\n---\n${"b".repeat(64_001)}`, "fallback")).toThrow("exceeds 64000");
  });

  it("rejects broken YAML and non-mapping frontmatter", () => {
    expect(() => parseSkillMarkdown("---\nname: [unclosed\n---\nbody\n", "fallback")).toThrow("invalid frontmatter YAML");
    expect(() => parseSkillMarkdown("---\n- a\n- b\n---\nbody\n", "fallback")).toThrow("frontmatter must be a mapping");
  });
});

describe("UserSkillStore discovery", () => {
  it("discovers SKILL.md directories recursively and root-level markdown files", async () => {
    const { user } = await makeRoots();
    await mkdir(join(user, "alpha"), { recursive: true });
    await touch(join(user, "alpha", "SKILL.md"), VALID_BODY.replace("my-skill", "alpha-skill"));
    await mkdir(join(user, "nested", "beta"), { recursive: true });
    await touch(join(user, "nested", "beta", "SKILL.md"), VALID_BODY.replace("my-skill", "beta-skill"));
    await touch(join(user, "loose.md"), VALID_BODY.replace("my-skill", "loose-skill"));
    await mkdir(join(user, ".hidden"), { recursive: true });
    await touch(join(user, ".hidden", "SKILL.md"), VALID_BODY.replace("my-skill", "hidden-skill"));
    const store = new UserSkillStore([{ root: user, source: "user" }]);
    const names = (await store.list()).map((skill) => skill.name);
    expect(names).toEqual(["alpha-skill", "beta-skill", "loose-skill"]);
  });

  it("skips invalid skills and records precise warnings", async () => {
    const { user } = await makeRoots();
    await mkdir(join(user, "broken"), { recursive: true });
    await touch(join(user, "broken", "SKILL.md"), "---\nname: BadName\ndescription: x\n---\nbody\n");
    await touch(join(user, "good.md"), VALID_BODY);
    const store = new UserSkillStore([{ root: user, source: "user" }]);
    expect((await store.list()).map((skill) => skill.name)).toEqual(["my-skill"]);
    const warnings = await store.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ source: "user" });
    expect(warnings[0]!.reason).toContain("invalid skill name");
  });

  it("lets the later (workspace) source override the user-global one on name collision", async () => {
    const { user, workspace } = await makeRoots();
    await touch(join(user, "shared.md"), VALID_BODY.replace("my-skill", "shared").replace("Does a useful thing when asked.", "user version"));
    await touch(join(workspace, "shared.md"), VALID_BODY.replace("my-skill", "shared").replace("Does a useful thing when asked.", "workspace version"));
    const store = new UserSkillStore([
      { root: user, source: "user" },
      { root: workspace, source: "workspace" }
    ]);
    const skills = await store.list();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "shared", description: "workspace version", source: "workspace" });
    expect((await store.get("shared"))?.body).toContain("Do the thing.");
  });

  it("warns and keeps the first skill on duplicate names inside one source", async () => {
    const { user } = await makeRoots();
    await mkdir(join(user, "one"), { recursive: true });
    await mkdir(join(user, "two"), { recursive: true });
    await touch(join(user, "one", "SKILL.md"), VALID_BODY);
    await touch(join(user, "two", "SKILL.md"), VALID_BODY);
    const store = new UserSkillStore([{ root: user, source: "user" }]);
    expect(await store.list()).toHaveLength(1);
    expect((await store.warnings())[0]!.reason).toContain("duplicate skill name");
  });

  it("invalidates the cache on mtime change, and tracks added and deleted files", async () => {
    const { user } = await makeRoots();
    const path = join(user, "evolving.md");
    const store = new UserSkillStore([{ root: user, source: "user" }]);
    await touch(path, VALID_BODY, new Date("2024-01-01T00:00:00Z"));
    expect((await store.get("my-skill"))?.description).toBe("Does a useful thing when asked.");

    await touch(path, VALID_BODY.replace("Does a useful thing when asked.", "Edited description."), new Date("2024-02-01T00:00:00Z"));
    expect((await store.get("my-skill"))?.description).toBe("Edited description.");

    await touch(join(user, "second.md"), VALID_BODY.replace("my-skill", "second-skill"), new Date("2024-03-01T00:00:00Z"));
    expect((await store.list()).map((skill) => skill.name)).toEqual(["my-skill", "second-skill"]);

    await rm(path);
    expect((await store.list()).map((skill) => skill.name)).toEqual(["second-skill"]);
  });

  it("treats missing roots as empty", async () => {
    const store = new UserSkillStore([{ root: join(await mkdtemp(join(tmpdir(), "adpilot-skills-missing-")), "nope"), source: "user" }]);
    expect(await store.list()).toEqual([]);
    expect(await store.warnings()).toEqual([]);
  });
});

describe("merged agent knowledge", () => {
  it("is isomorphic to the embedded knowledge base when no user skills exist", async () => {
    const store = new UserSkillStore([{ root: join(await mkdtemp(join(tmpdir(), "adpilot-skills-empty-")), "missing"), source: "user" }]);
    const knowledge = createMergedAgentKnowledge(store);
    const messages = ["帮我做一份今天的日报", "audit my ads account", "看看竞对在投什么", "今天天气怎么样", "auditing"];
    for (const message of messages) {
      expect(await knowledge.match(message), message).toEqual(matchKnowledgeSkills(message));
    }
    expect(await knowledge.list()).toEqual(listKnowledgeSkills());
    expect(await knowledge.catalog()).toBe(formatKnowledgeCatalogForPrompt());
    const matches = matchKnowledgeSkills("帮我做一份日报");
    expect(await knowledge.context(matches)).toBe(formatKnowledgeSkillContext(matches));
    expect(await knowledge.context([])).toBe("");
  });

  it("matches user skills through the same trigger pipeline and injects them with the advisory framing", async () => {
    const { user } = await makeRoots();
    await touch(join(user, "client-template.md"), [
      "---",
      "name: client-template",
      "description: 甲方周报模板,按客户品牌格式输出。",
      "triggers: [甲方模板]",
      "---",
      "",
      "# 甲方模板",
      "",
      "按客户字段顺序输出。",
      ""
    ].join("\n"));
    const store = new UserSkillStore([{ root: user, source: "user" }]);
    const knowledge = createMergedAgentKnowledge(store);
    // Embedded playbooks compete in the same ranking; the user skill must be among them.
    const matches = await knowledge.match("帮我套一下甲方模板出周报");
    expect(matches.map((skill) => skill.name)).toContain("client-template");
    const context = await knowledge.context(matches.filter((skill) => skill.name === "client-template"));
    expect(context).toContain("advisory only");
    expect(context).toContain("grants no tools, permissions, or execution authority");
    expect(context).toContain('<knowledge-skill name="client-template">');
    expect(context).toContain("按客户字段顺序输出。");
    const catalog = await knowledge.catalog();
    expect(catalog).toContain("client-template");
    expect(catalog).toContain("AdPilot skill catalog (reference knowledge only):");
  });

  it("user skills override embedded playbooks of the same name, body included", async () => {
    const { user } = await makeRoots();
    await touch(join(user, "ads-report.md"), [
      "---",
      "name: ads-report",
      "description: 覆盖内置报表手册的自定义版本。",
      "triggers: [日报]",
      "---",
      "",
      "自定义报表流程正文。",
      ""
    ].join("\n"));
    const store = new UserSkillStore([{ root: user, source: "user" }]);
    const knowledge = createMergedAgentKnowledge(store);
    const listed = await knowledge.list();
    const overridden = listed.filter((skill) => skill.name === "ads-report");
    expect(overridden).toHaveLength(1);
    expect(overridden[0]!.description).toBe("覆盖内置报表手册的自定义版本。");
    const context = await knowledge.context(await knowledge.match("帮我做一份日报"));
    expect(context).toContain("自定义报表流程正文。");
    expect(context).toContain('<knowledge-skill name="ads-report">');
  });
});
