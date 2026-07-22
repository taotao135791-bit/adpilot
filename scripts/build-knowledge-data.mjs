/**
 * Build-time generator: embeds the advertising knowledge base
 * (packages/advertising-core/knowledge) into a TypeScript data module
 * (packages/advertising-core/src/knowledge-data.generated.ts).
 *
 * Why: the CLI ships as a single-file tsup bundle installed globally via npm,
 * and the desktop app ships as an asar archive. Markdown cannot be read from
 * source-relative paths at runtime, so the knowledge is baked into the bundle
 * here. The knowledge is reference-only: it never grants tools, permissions,
 * or execution authority.
 *
 * Usage:
 *   node scripts/build-knowledge-data.mjs          # regenerate the module
 *   node scripts/build-knowledge-data.mjs --check  # fail if the module is stale
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_TRIGGER_LENGTH = 40;
const MAX_TRIGGER_WORDS = 5;

/**
 * Chinese routing triggers the English-centric descriptions do not cover.
 * This is routing metadata only; it grants no capabilities.
 */
const CURATED_TRIGGERS = {
  "ads-ops": ["巡检", "每日巡检", "客户回复", "素材需求", "异常排查"],
  "ads-audit": ["账户审计", "广告审计", "全面审计"],
  "ads-report": ["周报", "月报", "报表"],
  "ads-budget": ["预算分配", "加预算", "减预算", "扩量"],
  "ads-competitor": ["竞品", "竞对", "竞争对手"],
  "ads-attribution": ["归因"],
  "ads-landing": ["落地页", "着陆页"],
  "ads-test": ["A/B测试", "实验设计"],
  "ads-creative": ["素材疲劳", "创意疲劳"],
  "ads-google-app": ["应用安装广告", "应用广告"],
  "ads-server-side-tracking": ["服务端回传", "服务端跟踪"],
  "ads-plan": ["投放计划", "投放策略"],
  "ads-levers": ["KPI受限"],
  "ads-math": ["盈亏平衡", "广告计算"]
};

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(repoRoot, "packages/advertising-core/knowledge/skills");
const outputFile = join(repoRoot, "packages/advertising-core/src/knowledge-data.generated.ts");

/** Reads every skill and reference document and returns normalized embedded data. */
export async function buildKnowledgeData() {
  const skillNames = (await readdir(skillsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const skills = [];
  const references = {};
  for (const skillName of skillNames) {
    const skillDir = join(skillsDir, skillName);
    skills.push(await readSkill(skillDir, skillName));
    const referencesDir = join(skillDir, "references");
    const referenceFiles = await readdir(referencesDir).catch(() => []);
    for (const fileName of referenceFiles.sort()) {
      if (!fileName.endsWith(".md")) continue;
      references[`${skillName}/references/${fileName}`] = await readFile(join(referencesDir, fileName), "utf8");
    }
  }
  return { skills, references };
}

/** Renders the embedded data as the deterministic TypeScript module source. */
export function renderKnowledgeDataModule({ skills, references }) {
  const orderedReferences = Object.fromEntries(Object.entries(references).sort(([a], [b]) => a.localeCompare(b)));
  return [
    "/* eslint-disable */",
    "// GENERATED FILE — do not edit by hand.",
    "// Regenerate with `node scripts/build-knowledge-data.mjs` (wired into `pnpm build`).",
    "// Source of truth: packages/advertising-core/knowledge (markdown reference knowledge).",
    "// The embedded text is reference knowledge for the model only; it grants no tools,",
    "// permissions, or execution authority.",
    "",
    "export interface EmbeddedKnowledgeSkill {",
    "  name: string;",
    "  description: string;",
    "  triggers: string[];",
    "  body: string;",
    "}",
    "",
    `export const embeddedKnowledgeSkills: EmbeddedKnowledgeSkill[] = ${JSON.stringify(skills, null, 2)};`,
    "",
    `export const embeddedKnowledgeReferences: Record<string, string> = ${JSON.stringify(orderedReferences, null, 2)};`,
    ""
  ].join("\n");
}

async function readSkill(skillDir, expectedName) {
  const filePath = join(skillDir, "SKILL.md");
  const content = await readFile(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(content, filePath);
  const name = frontmatter.name ?? expectedName;
  if (name !== expectedName) throw new Error(`${filePath}: name "${name}" does not match directory "${expectedName}"`);
  if (name.length > MAX_NAME_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`${filePath}: invalid skill name "${name}"`);
  }
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!description) throw new Error(`${filePath}: description is required`);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`${filePath}: description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  }
  const triggers = mergeTriggers(extractTriggers(description), CURATED_TRIGGERS[name] ?? []);
  return { name, description, triggers, body };
}

function parseFrontmatter(content, filePath) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) throw new Error(`${filePath}: missing frontmatter block`);
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) throw new Error(`${filePath}: unterminated frontmatter block`);
  const frontmatter = parse(normalized.slice(4, endIndex)) ?? {};
  return { frontmatter, body: normalized.slice(endIndex + 4).trim() };
}

/**
 * Derives routing trigger phrases from a description's explicit usage clauses
 * ("Use when user says ...", "Triggers on ...", "Use for ..." lists).
 */
function extractTriggers(description) {
  const triggers = [];
  const clauses = [
    /use when user says\s+([^.]+)\./gi,
    /triggers?\s+on\s+([^.]+)\./gi,
    /use for\s+([^.]+)\./gi
  ];
  for (const clause of clauses) {
    for (const match of description.matchAll(clause)) {
      const list = match[1];
      if (!list.includes(",") && !list.includes("，")) continue;
      for (const item of list.split(/[,，]/)) {
        const cleaned = item
          .replace(/^[\s]*(?:and|or)\s+/i, "")
          .replace(/^.*?\bsuch as\b\s*/i, "")
          .trim()
          .replace(/\.$/, "");
        if (isUsableTrigger(cleaned)) triggers.push(cleaned);
      }
    }
  }
  return triggers;
}

function isUsableTrigger(trigger) {
  if (trigger.length < 2 || trigger.length > MAX_TRIGGER_LENGTH) return false;
  const words = trigger.split(/\s+/);
  if (words.length > MAX_TRIGGER_WORDS) return false;
  return true;
}

function mergeTriggers(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const trigger of list) {
      const key = trigger.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(trigger);
    }
  }
  return merged;
}

async function main() {
  const check = process.argv.includes("--check");
  const rendered = renderKnowledgeDataModule(await buildKnowledgeData());
  if (check) {
    const current = await readFile(outputFile, "utf8").catch(() => "");
    if (current !== rendered) {
      console.error("packages/advertising-core/src/knowledge-data.generated.ts is stale; run `node scripts/build-knowledge-data.mjs`");
      process.exit(1);
    }
    return;
  }
  await writeFile(outputFile, rendered);
  console.log(`wrote ${outputFile} (${rendered.length} bytes)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
