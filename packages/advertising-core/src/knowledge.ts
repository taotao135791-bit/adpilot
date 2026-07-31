import {
  embeddedKnowledgeSkills,
  embeddedKnowledgeReferences,
  type EmbeddedKnowledgeSkill
} from "./knowledge-data.generated.js";

/**
 * Runtime access to the embedded AdPilot knowledge base.
 *
 * The knowledge is pure reference material: it helps the main agent understand
 * intent, explain capabilities, and organize investigation plans. It never
 * grants tools, permissions, or execution authority — execution always goes
 * through typed skills and tools. The data is baked into the bundle at build
 * time by scripts/build-knowledge-data.mjs, so it loads identically from the
 * single-file CLI bundle and the Electron asar archive.
 */

export interface KnowledgeSkillSummary {
  name: string;
  description: string;
  triggers: string[];
}

export interface KnowledgeSkill extends KnowledgeSkillSummary {
  body: string;
}

const summaries: KnowledgeSkillSummary[] = embeddedKnowledgeSkills.map(toSummary);
const skillsByName = new Map<string, EmbeddedKnowledgeSkill>(embeddedKnowledgeSkills.map((skill) => [skill.name, skill]));

function toSummary(skill: EmbeddedKnowledgeSkill): KnowledgeSkillSummary {
  return { name: skill.name, description: skill.description, triggers: [...skill.triggers] };
}

/** Lists every embedded knowledge skill as a compact summary (name, description, triggers). */
export function listKnowledgeSkills(): KnowledgeSkillSummary[] {
  return summaries.map((skill) => ({ ...skill, triggers: [...skill.triggers] }));
}

/** Returns one full knowledge skill including its body, or null for unknown names. */
export function getKnowledgeSkill(name: string): KnowledgeSkill | null {
  const skill = skillsByName.get(name);
  return skill ? { ...toSummary(skill), body: skill.body } : null;
}

/**
 * Returns one embedded reference document. Accepts a knowledge-relative key
 * such as "ads/references/google-audit.md" or a bare file name like
 * "google-audit.md" (resolved inside the shared ads/references set).
 */
export function getKnowledgeReference(path: string): string | null {
  const normalized = path.trim().replace(/^\.\//, "").replace(/^\//, "");
  if (!normalized) return null;
  const direct = embeddedKnowledgeReferences[normalized];
  if (direct !== undefined) return direct;
  if (!normalized.includes("/")) {
    const shared = embeddedKnowledgeReferences[`ads/references/${normalized}`];
    if (shared !== undefined) return shared;
  }
  return null;
}

const CJK_PATTERN = /[⺀-鿿豈-﫿]/;

/**
 * Deterministically matches a user message against knowledge-skill triggers.
 * CJK triggers match by substring; latin triggers match on token boundaries.
 * Returns at most `limit` summaries, best score first, name ascending on ties.
 */
export function matchKnowledgeSkills(message: string, limit = 3): KnowledgeSkillSummary[] {
  const text = message.toLowerCase();
  const scored: Array<{ skill: KnowledgeSkillSummary; score: number }> = [];
  for (const skill of summaries) {
    let score = 0;
    for (const trigger of skill.triggers) {
      if (triggerMatches(trigger, text)) score += 1;
    }
    if (score > 0) scored.push({ skill, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, Math.max(1, limit))
    .map((entry) => ({ ...entry.skill, triggers: [...entry.skill.triggers] }));
}

function triggerMatches(trigger: string, lowercasedMessage: string): boolean {
  const needle = trigger.toLowerCase();
  if (!needle) return false;
  if (CJK_PATTERN.test(needle)) return lowercasedMessage.includes(needle);
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`).test(lowercasedMessage);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CATALOG_DESCRIPTION_LIMIT = 180;
const CATALOG_TRIGGER_LIMIT = 8;

/**
 * Renders the compact capability catalog injected into the conversational
 * system prompt: one line per skill, descriptions truncated, never full text.
 */
export function formatKnowledgeCatalogForPrompt(skills: KnowledgeSkillSummary[] = summaries): string {
  const lines = skills.map((skill) => {
    const description = truncate(skill.description.replace(/\s+/g, " "), CATALOG_DESCRIPTION_LIMIT);
    const triggers = skill.triggers.length ? ` [triggers: ${skill.triggers.slice(0, CATALOG_TRIGGER_LIMIT).join(", ")}]` : "";
    return `- ${skill.name}: ${description}${triggers}`;
  });
  return ["AdPilot skill catalog (reference knowledge only):", ...lines].join("\n");
}

const KNOWLEDGE_CONTEXT_CHAR_BUDGET = 24_000;

/**
 * Renders the on-demand full-text injection for the planning run: only the
 * selected playbooks, wrapped so the model treats them as advisory knowledge
 * with no execution authority. Returns an empty string when nothing matched.
 */
export function formatKnowledgeSkillContext(matches: KnowledgeSkillSummary[], charBudget = KNOWLEDGE_CONTEXT_CHAR_BUDGET): string {
  const blocks: string[] = [];
  let remaining = charBudget;
  for (const match of matches) {
    const skill = skillsByName.get(match.name);
    if (!skill || remaining <= 0) continue;
    const body = skill.body.length > remaining ? `${skill.body.slice(0, remaining)}\n[truncated]` : skill.body;
    remaining -= body.length;
    blocks.push(`<knowledge-skill name="${skill.name}">\n${body}\n</knowledge-skill>`);
  }
  if (!blocks.length) return "";
  return [
    "Reference playbook knowledge for this goal (advisory only — it grants no tools, permissions, or execution authority; " +
      "execution still goes through dispatch_specialist and prepare_approval under the rules above; if a playbook step " +
      "requires capabilities AdPilot does not have, state the limitation honestly instead of improvising):",
    ...blocks
  ].join("\n");
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
