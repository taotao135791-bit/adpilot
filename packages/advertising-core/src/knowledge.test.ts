import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  formatKnowledgeCatalogForPrompt,
  formatKnowledgeSkillContext,
  getKnowledgeReference,
  getKnowledgeSkill,
  listKnowledgeSkills,
  matchKnowledgeSkills
} from "./knowledge.js";
import { embeddedKnowledgeReferences } from "./knowledge-data.generated.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const knowledgeRoot = `${repoRoot}packages/advertising-core/knowledge`;

describe("embedded knowledge loader", () => {
  it("embeds every knowledge skill exactly once with metadata and triggers", () => {
    const skills = listKnowledgeSkills();
    expect(skills).toHaveLength(33);
    expect(new Set(skills.map((skill) => skill.name)).size).toBe(skills.length);
    for (const skill of skills) {
      expect(skill.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
    }
    for (const expected of ["ads", "ads-ops", "ads-report", "ads-audit", "ads-google-app", "ads-math"]) {
      expect(skills.map((skill) => skill.name)).toContain(expected);
    }
    expect(skills.find((skill) => skill.name === "ads-ops")?.triggers).toEqual(expect.arrayContaining(["patrol", "巡检"]));
    expect(skills.find((skill) => skill.name === "ads-report")?.triggers).toContain("日报");
    expect(skills.find((skill) => skill.name === "ads-audit")?.triggers).toEqual(expect.arrayContaining(["audit", "账户审计"]));
    expect(skills.find((skill) => skill.name === "ads-create")?.triggers).toEqual(expect.arrayContaining(["create campaign", "广告文案"]));
    expect(skills.find((skill) => skill.name === "ads-dna")?.triggers).toEqual(expect.arrayContaining(["brand DNA", "品牌画像"]));
    expect(skills.find((skill) => skill.name === "ads-generate")?.triggers).toEqual(expect.arrayContaining(["generate ads", "生成广告图片"]));
    expect(skills.find((skill) => skill.name === "ads-photoshoot")?.triggers).toEqual(expect.arrayContaining(["product photo", "产品摄影"]));
  });

  it("returns full skill text on demand and null for unknown names", () => {
    const skill = getKnowledgeSkill("ads-ops");
    expect(skill).not.toBeNull();
    expect(skill?.body).toContain("# Ads Ops: Daily Agency Operations");
    expect(skill?.triggers).toContain("patrol");
    expect(getKnowledgeSkill("does-not-exist")).toBeNull();
  });

  it("resolves embedded references by key or bare file name from the single deduplicated set", () => {
    const byKey = getKnowledgeReference("ads/references/google-audit.md");
    const byName = getKnowledgeReference("google-audit.md");
    expect(byKey).not.toBeNull();
    expect(byName).toBe(byKey);
    expect(getKnowledgeReference("ads-google-app/references/quick-ops.md")).toContain("Quick");
    expect(getKnowledgeReference("missing-file.md")).toBeNull();
  });

  it("keeps a single physical copy of the shared references on disk", async () => {
    expect(existsSync(`${knowledgeRoot}/references`)).toBe(false);
    expect(existsSync(`${knowledgeRoot}/skills/ads/references`)).toBe(true);
    const metadata = parse(await readFile(`${knowledgeRoot}/metadata.yaml`, "utf8")) as { entries: Array<{ paths: string[] }> };
    for (const entry of metadata.entries) {
      for (const path of entry.paths) expect(existsSync(`${knowledgeRoot}/${path}`), path).toBe(true);
    }
  });

  it("resolves every relative reference mention inside embedded skill bodies", () => {
    const skills = listKnowledgeSkills();
    for (const summary of skills) {
      const body = getKnowledgeSkill(summary.name)?.body ?? "";
      for (const match of body.matchAll(/`references\/([^`<>\s]+\.md)`/g)) {
        expect(getKnowledgeReference(`${summary.name}/references/${match[1]}`), `${summary.name} -> references/${match[1]}`).not.toBeNull();
      }
      for (const match of body.matchAll(/`\.\.\/([a-z0-9-]+)\/references\/([^`<>\s]+\.md)`/g)) {
        expect(getKnowledgeReference(`${match[1]}/references/${match[2]}`), `${summary.name} -> ../${match[1]}/references/${match[2]}`).not.toBeNull();
      }
      for (const match of body.matchAll(/`(?:\.\.\/)?(?:skills\/)?ads\/references\/([^`<>\s]+\.md)`/g)) {
        expect(getKnowledgeReference(`ads/references/${match[1]}`), `${summary.name} -> ads/references/${match[1]}`).not.toBeNull();
      }
    }
    // Cross-links rewritten during dedup must resolve to real embedded documents.
    for (const referenceName of ["thinking-framework.md", "scoring-system.md"]) {
      const reference = getKnowledgeReference(referenceName) ?? "";
      for (const match of reference.matchAll(/`([^`<>\s]+\.md)`/g)) {
        const mention = match[1] ?? "";
        if (mention.startsWith("../../")) {
          expect(listKnowledgeSkills().some((skill) => mention === `../../${skill.name}/SKILL.md`), mention).toBe(true);
        } else if (mention === "../SKILL.md") {
          expect(getKnowledgeSkill("ads"), mention).not.toBeNull();
        } else {
          expect(getKnowledgeReference(`ads/references/${mention}`), mention).not.toBeNull();
        }
      }
    }
  });

  it("matches Chinese and English routing triggers deterministically", () => {
    expect(matchKnowledgeSkills("帮我做一份今天的日报")[0]?.name).toBe("ads-report");
    expect(matchKnowledgeSkills("每天早上帮我巡检一下账户").map((skill) => skill.name)).toContain("ads-ops");
    expect(matchKnowledgeSkills("给我做一次账户审计")[0]?.name).toBe("ads-audit");
    expect(matchKnowledgeSkills("audit my ads account")[0]?.name).toBe("ads-audit");
    expect(matchKnowledgeSkills("看看竞对在投什么").map((skill) => skill.name)).toContain("ads-competitor");
    expect(matchKnowledgeSkills("落地页转化率很差帮我看看").map((skill) => skill.name)).toContain("ads-landing");
    expect(matchKnowledgeSkills("先提取品牌画像，再做广告文案").map((skill) => skill.name)).toEqual(expect.arrayContaining(["ads-dna", "ads-create"]));
    expect(matchKnowledgeSkills("给这个产品做一组产品棚拍").map((skill) => skill.name)).toContain("ads-photoshoot");
    expect(matchKnowledgeSkills("根据 brief 生成广告图片").map((skill) => skill.name)).toContain("ads-generate");
    expect(matchKnowledgeSkills("今天天气怎么样")).toEqual([]);
    // Latin triggers require token boundaries: "auditing" must not match "audit".
    expect(matchKnowledgeSkills("auditing")).toEqual([]);
  });

  it("formats a compact catalog without full bodies", () => {
    const catalog = formatKnowledgeCatalogForPrompt();
    expect(catalog).toContain("AdPilot skill catalog");
    expect(catalog).toContain("- ads-ops:");
    expect(catalog).toContain("[triggers:");
    expect(catalog).not.toContain("# Ads Ops: Daily Agency Operations");
    for (const line of catalog.split("\n")) expect(line.length).toBeLessThan(360);
    expect(catalog.length).toBeLessThan(12_000);
  });

  it("injects only the selected full playbooks with an explicit no-authority frame", () => {
    const context = formatKnowledgeSkillContext(matchKnowledgeSkills("帮我做一份日报"));
    expect(context).toContain("advisory only");
    expect(context).toContain('<knowledge-skill name="ads-report">');
    expect(context).toContain("# Ads Report");
    expect(matchKnowledgeSkills("帮我做一份日报")).toHaveLength(1);
    expect(formatKnowledgeSkillContext([])).toBe("");
  });

  it("keeps the embedded data module in sync with the knowledge sources", () => {
    expect(() =>
      execFileSync(process.execPath, [`${repoRoot}scripts/build-knowledge-data.mjs`, "--check"], { stdio: "pipe" })
    ).not.toThrow();
  });
});
