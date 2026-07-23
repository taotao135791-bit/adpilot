/**
 * User skill discovery for AdPilot (Agent Skills standard, progressive disclosure).
 *
 * Skills are discovered from two markdown sources, in ascending precedence:
 * 1. the user-global directory `~/.adpilot/skills/` (ADPILOT_HOME overrides the home)
 * 2. the per-workspace directory `<workspace>/.adpilot/skills/`
 *
 * Each source mirrors pi's discovery convention (docs/skills.md in the pi
 * monorepo): directories containing a SKILL.md are discovered recursively
 * (depth-capped), and direct root-level `.md` files are individual skills.
 *
 * Override semantics — a later source replaces an earlier one with the same
 * name, and both user sources replace an embedded playbook with the same name.
 * Rationale: knowledge is advisory markdown only — it grants no tools,
 * permissions, or execution authority — so overriding cannot weaken any
 * guardrail; the ability to refine the shipped playbooks with agency-specific
 * practice is the point of the feature; and "more local wins" matches the
 * configuration hierarchy operators already know (workspace > user > default).
 *
 * Validation follows the Agent Skills standard: name 1-64 chars of lowercase
 * letters/numbers/hyphens (no leading, trailing, or consecutive hyphens),
 * description required and ≤1024 chars. Invalid skills are not loaded; the
 * reason is recorded and exposed via warnings(). Refresh is incremental:
 * files are re-parsed only when their mtime or size changes, so the per-turn
 * cost is a handful of stat calls.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  formatKnowledgeCatalogForPrompt,
  getKnowledgeSkill,
  listKnowledgeSkills,
  type KnowledgeSkillSummary
} from "@adpilot/advertising-core";
import type { AgentKnowledge } from "@adpilot/agent-orchestrator";

export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
/** Skills larger than this are rejected; the on-demand context budget is far smaller. */
export const SKILL_BODY_MAX_CHARS = 64_000;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_FILE_NAME = "SKILL.md";
const DISCOVERY_MAX_DEPTH = 4;

export interface UserSkillSource {
  /** Absolute directory scanned for skills. Missing directories are simply empty. */
  root: string;
  /** Short provenance label, for example "user" or "workspace". */
  source: string;
}

export interface UserSkill {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  source: string;
  path: string;
}

export interface UserSkillWarning {
  path: string;
  source: string;
  reason: string;
}

/* ------------------------------------------------------------------------ */
/* Frontmatter + validation (pure, exhaustively testable)                    */
/* ------------------------------------------------------------------------ */

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/** Mirrors pi's utils/frontmatter.ts extraction (MIT — licenses/pi-MIT.txt). */
function extractFrontmatter(content: string): { yamlString: string | null; body: string } {
  const normalized = normalizeNewlines(content);
  if (!normalized.startsWith("---")) return { yamlString: null, body: normalized };
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return { yamlString: null, body: normalized };
  return { yamlString: normalized.slice(4, endIndex), body: normalized.slice(endIndex + 4).trim() };
}

/**
 * Parses and validates one SKILL.md document. `fallbackName` is the directory
 * name for SKILL.md candidates or the file basename for root-level markdown.
 * Throws with a precise reason on the first validation failure.
 */
export function parseSkillMarkdown(content: string, fallbackName: string): Omit<UserSkill, "source" | "path"> {
  const { yamlString, body } = extractFrontmatter(content);
  let frontmatter: Record<string, unknown> = {};
  if (yamlString !== null) {
    let parsed: unknown;
    try {
      parsed = parseYaml(yamlString);
    } catch (error) {
      throw new Error(`invalid frontmatter YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("frontmatter must be a mapping");
      frontmatter = parsed as Record<string, unknown>;
    }
  }
  const rawName = frontmatter.name ?? fallbackName;
  if (typeof rawName !== "string" || rawName.length === 0 || rawName.length > SKILL_NAME_MAX_LENGTH || !SKILL_NAME_PATTERN.test(rawName)) {
    throw new Error(`invalid skill name ${JSON.stringify(rawName)}: use 1-${SKILL_NAME_MAX_LENGTH} lowercase letters, numbers, and hyphens without leading, trailing, or consecutive hyphens`);
  }
  const description = frontmatter.description;
  if (typeof description !== "string" || !description.trim()) throw new Error("missing required description");
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    throw new Error(`description exceeds ${SKILL_DESCRIPTION_MAX_LENGTH} characters`);
  }
  if (!body.trim()) throw new Error("missing skill body");
  if (body.length > SKILL_BODY_MAX_CHARS) throw new Error(`skill body exceeds ${SKILL_BODY_MAX_CHARS} characters`);
  const triggers = Array.isArray(frontmatter.triggers)
    ? frontmatter.triggers.filter((trigger): trigger is string => typeof trigger === "string" && trigger.trim().length > 0)
    : [];
  return { name: rawName, description: description.trim(), triggers: triggers.length ? triggers : [rawName], body };
}

/* ------------------------------------------------------------------------ */
/* Discovery store with mtime-based incremental refresh                      */
/* ------------------------------------------------------------------------ */

interface CachedSkillFile {
  mtimeMs: number;
  size: number;
  skill: UserSkill | null;
  reason?: string;
}

export class UserSkillStore {
  private readonly cache = new Map<string, CachedSkillFile>();
  private snapshot: UserSkill[] = [];
  private currentWarnings: UserSkillWarning[] = [];
  private refreshing: Promise<void> | undefined;

  constructor(private readonly sources: readonly UserSkillSource[]) {}

  /** All valid user skills, name ascending; later sources override earlier ones. */
  async list(): Promise<UserSkill[]> {
    await this.refresh();
    return this.snapshot.map((skill) => ({ ...skill, triggers: [...skill.triggers] }));
  }

  async get(name: string): Promise<UserSkill | undefined> {
    await this.refresh();
    const found = this.snapshot.find((skill) => skill.name === name);
    return found ? { ...found, triggers: [...found.triggers] } : undefined;
  }

  /** Validation and collision problems from the most recent refresh. */
  async warnings(): Promise<UserSkillWarning[]> {
    await this.refresh();
    return [...this.currentWarnings];
  }

  private async refresh(): Promise<void> {
    this.refreshing ??= this.refreshNow().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshNow(): Promise<void> {
    const seen = new Set<string>();
    const warnings: UserSkillWarning[] = [];
    const byName = new Map<string, UserSkill>();
    for (const source of this.sources) {
      const root = resolve(source.root);
      const candidates = await this.discover(root);
      const namesInSource = new Set<string>();
      for (const path of candidates) {
        seen.add(path);
        const fileStat = await stat(path).catch(() => undefined);
        if (!fileStat?.isFile()) continue;
        let entry = this.cache.get(path);
        if (!entry || entry.mtimeMs !== fileStat.mtimeMs || entry.size !== fileStat.size) {
          entry = await this.load(path, source, fileStat);
          this.cache.set(path, entry);
        }
        if (!entry.skill) {
          if (entry.reason) warnings.push({ path, source: source.source, reason: entry.reason });
          continue;
        }
        if (namesInSource.has(entry.skill.name)) {
          warnings.push({ path, source: source.source, reason: `duplicate skill name "${entry.skill.name}" under ${root}; the first one found wins` });
          continue;
        }
        namesInSource.add(entry.skill.name);
        // Later sources intentionally overwrite: workspace beats user-global.
        byName.set(entry.skill.name, entry.skill);
      }
    }
    for (const path of [...this.cache.keys()]) {
      if (!seen.has(path)) this.cache.delete(path);
    }
    this.snapshot = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
    this.currentWarnings = warnings;
  }

  private async load(path: string, source: UserSkillSource, fileStat: { mtimeMs: number; size: number }): Promise<CachedSkillFile> {
    const base = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
    try {
      const content = await readFile(path, "utf8");
      const fallbackName = basename(path) === SKILL_FILE_NAME ? basename(dirname(path)) : basename(path).replace(/\.md$/i, "");
      const parsed = parseSkillMarkdown(content, fallbackName);
      return { ...base, skill: { ...parsed, source: source.source, path } };
    } catch (error) {
      return { ...base, skill: null, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Root-level `.md` files are individual skills; any directory containing a
   * SKILL.md is one too (recursed to a bounded depth, hidden directories and
   * node_modules excluded).
   */
  private async discover(root: string, depth = 0): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOTDIR") return [];
      throw error;
    });
    const found: string[] = [];
    const directories: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(root, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && (depth === 0 ? entry.name.toLowerCase().endsWith(".md") : entry.name === SKILL_FILE_NAME)) found.push(path);
    }
    for (const directory of directories) {
      const skillFile = join(directory, SKILL_FILE_NAME);
      const hasSkillFile = await stat(skillFile).then((result) => result.isFile()).catch(() => false);
      if (hasSkillFile) found.push(skillFile);
      else if (depth < DISCOVERY_MAX_DEPTH) found.push(...await this.discover(directory, depth + 1));
    }
    return found.sort();
  }
}

/* ------------------------------------------------------------------------ */
/* Merged embedded + user knowledge catalog                                  */
/* ------------------------------------------------------------------------ */

// The matching semantics below mirror @adpilot/advertising-core's knowledge.ts
// exactly (CJK triggers match by substring, latin triggers on token
// boundaries; one point per matched trigger; score descending, name
// ascending on ties). The embedded matcher is bound to the embedded module
// state, so the merged catalog re-implements the same deterministic rule over
// the combined summary list; a test pins the two implementations to identical
// results when no user skills exist.
const CJK_PATTERN = /[⺀-鿿豈-﫿]/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function triggerMatches(trigger: string, lowercasedMessage: string): boolean {
  const needle = trigger.toLowerCase();
  if (!needle) return false;
  if (CJK_PATTERN.test(needle)) return lowercasedMessage.includes(needle);
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`).test(lowercasedMessage);
}

export function matchSkillSummaries(summaries: readonly KnowledgeSkillSummary[], message: string, limit = 3): KnowledgeSkillSummary[] {
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

const KNOWLEDGE_CONTEXT_CHAR_BUDGET = 24_000;

// Identical advisory framing as the embedded knowledge injection: reference
// markdown never grants tools, permissions, or execution authority.
const KNOWLEDGE_CONTEXT_PREAMBLE =
  "Reference playbook knowledge for this goal (advisory only — it grants no tools, permissions, or execution authority; " +
  "execution still goes through dispatch_specialist and prepare_approval under the rules above; if a playbook step " +
  "requires capabilities AdPilot does not have, state the limitation honestly instead of improvising):";

/**
 * The composition-root knowledge source: embedded playbooks plus every valid
 * user skill, with user sources overriding embedded entries of the same name
 * (see the module header for the override rationale).
 */
export function createMergedAgentKnowledge(store: UserSkillStore): AgentKnowledge {
  const merged = async (): Promise<{ summaries: KnowledgeSkillSummary[]; userByName: Map<string, UserSkill> }> => {
    const userSkills = await store.list();
    const userByName = new Map(userSkills.map((skill) => [skill.name, skill]));
    const summaries = listKnowledgeSkills().map((summary) => {
      const override = userByName.get(summary.name);
      return override ? { name: override.name, description: override.description, triggers: [...override.triggers] } : summary;
    });
    const embeddedNames = new Set(summaries.map((summary) => summary.name));
    for (const skill of userSkills) {
      if (!embeddedNames.has(skill.name)) {
        summaries.push({ name: skill.name, description: skill.description, triggers: [...skill.triggers] });
      }
    }
    return { summaries, userByName };
  };

  return {
    async list() {
      return (await merged()).summaries;
    },
    async match(message, limit = 3) {
      return matchSkillSummaries((await merged()).summaries, message, limit);
    },
    async catalog() {
      return formatKnowledgeCatalogForPrompt((await merged()).summaries);
    },
    async context(matches) {
      const { userByName } = await merged();
      const blocks: string[] = [];
      let remaining = KNOWLEDGE_CONTEXT_CHAR_BUDGET;
      for (const match of matches) {
        // A user override replaces the embedded body for the same name too.
        const body = userByName.get(match.name)?.body ?? getKnowledgeSkill(match.name)?.body;
        if (!body || remaining <= 0) continue;
        const clipped = body.length > remaining ? `${body.slice(0, remaining)}\n[truncated]` : body;
        remaining -= clipped.length;
        blocks.push(`<knowledge-skill name="${match.name}">\n${clipped}\n</knowledge-skill>`);
      }
      if (!blocks.length) return "";
      return [KNOWLEDGE_CONTEXT_PREAMBLE, ...blocks].join("\n");
    }
  };
}
