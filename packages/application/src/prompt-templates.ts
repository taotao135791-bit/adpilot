/**
 * User prompt templates (custom slash commands) for AdPilot.
 *
 * Discovery mirrors pi's prompt-template convention (docs/prompt-templates.md
 * in the pi monorepo): `*.md` files directly inside
 * `~/.adpilot/prompts/` (ADPILOT_HOME overrides the home) and
 * `<workspace>/.adpilot/prompts/`; discovery is non-recursive and the
 * filename becomes the command name. The argument tokenizer and substitution
 * engine below are vendored from pi's core/prompt-templates.ts @ 0.80.10
 * (MIT — licenses/pi-MIT.txt); the store adds validation, precedence and
 * incremental refresh.
 *
 * Precedence mirrors the user-skill layer: a template in the workspace
 * directory overrides one with the same name in the user-global directory.
 * Built-in product commands (/report, /audit, /approvals, /skills, /help)
 * always win over a same-named template — they are bound to typed, audited
 * pipelines, and silently shadowing one with advisory text would degrade a
 * deterministic command into plain prose.
 *
 * Templates stay advisory: the expanded text is injected into the normal
 * conversation pipeline wrapped in wording that repeats it grants no tools,
 * permissions, or execution authority.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const PROMPT_COMMAND_NAME_MAX_LENGTH = 64;
export const PROMPT_DESCRIPTION_MAX_LENGTH = 500;
export const PROMPT_ARGUMENT_HINT_MAX_LENGTH = 100;
export const PROMPT_BODY_MAX_CHARS = 32_000;
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface PromptTemplate {
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
  source: string;
  path: string;
}

export interface PromptTemplateSummary {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface PromptTemplateWarning {
  path: string;
  source: string;
  reason: string;
}

/* ------------------------------------------------------------------------ */
/* Frontmatter + validation (pure)                                           */
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
 * Parses and validates one prompt-template document. The command name comes
 * from the filename. Throws with a precise reason on the first validation
 * failure.
 */
export function parsePromptTemplate(fileName: string, content: string): Pick<PromptTemplate, "name" | "description" | "argumentHint" | "body"> {
  const name = fileName.replace(/\.md$/i, "");
  if (name.length === 0 || name.length > PROMPT_COMMAND_NAME_MAX_LENGTH || !COMMAND_NAME_PATTERN.test(name)) {
    throw new Error(`invalid command name ${JSON.stringify(name)}: use 1-${PROMPT_COMMAND_NAME_MAX_LENGTH} lowercase letters, numbers, and hyphens, starting with a letter or number`);
  }
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
  let description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!description) {
    // Upstream convention: the first non-empty body line is the description.
    const firstLine = body.split("\n").find((line) => line.trim());
    description = firstLine ? `${firstLine.trim().slice(0, 60)}${firstLine.trim().length > 60 ? "…" : ""}` : "";
  }
  if (!description) throw new Error("missing description and no usable first line");
  if (description.length > PROMPT_DESCRIPTION_MAX_LENGTH) {
    throw new Error(`description exceeds ${PROMPT_DESCRIPTION_MAX_LENGTH} characters`);
  }
  const argumentHint = frontmatter["argument-hint"];
  if (argumentHint !== undefined && (typeof argumentHint !== "string" || argumentHint.length > PROMPT_ARGUMENT_HINT_MAX_LENGTH)) {
    throw new Error(`argument-hint must be a string of at most ${PROMPT_ARGUMENT_HINT_MAX_LENGTH} characters`);
  }
  if (!body.trim()) throw new Error("missing template body");
  if (body.length > PROMPT_BODY_MAX_CHARS) throw new Error(`template body exceeds ${PROMPT_BODY_MAX_CHARS} characters`);
  return {
    name,
    description,
    ...(typeof argumentHint === "string" && argumentHint ? { argumentHint } : {}),
    body
  };
}

/* ------------------------------------------------------------------------ */
/* Argument handling, vendored from pi's core/prompt-templates.ts @ 0.80.10  */
/* (MIT — licenses/pi-MIT.txt), renamed to the AdPilot idiom.                */
/* ------------------------------------------------------------------------ */

/**
 * Parse command arguments respecting quoted strings (bash-style).
 * Returns array of arguments.
 */
export function tokenizePromptArguments(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i]!;

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

/**
 * Substitute argument placeholders in template content.
 * Supports:
 * - $1, $2, ... for positional args
 * - $@ and $ARGUMENTS for all args
 * - ${N:-default} for positional arg N with default when missing/empty
 * - ${@:N} for args from Nth onwards (bash-style slicing)
 * - ${@:N:L} for L args starting from Nth
 *
 * Note: Replacement happens on the template string only. Argument and default values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export function expandPromptTemplateBody(content: string, args: string[]): string {
  const allArgs = args.join(" ");

  return content.replace(
    /\$\{(\d+):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultNum, defaultValue, sliceStart, sliceLength, simple) => {
      if (defaultNum) {
        const index = parseInt(defaultNum, 10) - 1;
        const value = args[index];
        return value ? value : defaultValue;
      }

      if (sliceStart) {
        let start = parseInt(sliceStart, 10) - 1; // Convert to 0-indexed (user provides 1-indexed)
        // Treat 0 as 1 (bash convention: args start at 1)
        if (start < 0) start = 0;

        if (sliceLength) {
          const length = parseInt(sliceLength, 10);
          return args.slice(start, start + length).join(" ");
        }
        return args.slice(start).join(" ");
      }

      if (simple === "ARGUMENTS" || simple === "@") {
        return allArgs;
      }

      const index = parseInt(simple, 10) - 1;
      return args[index] ?? "";
    },
  );
}

/* ------------------------------------------------------------------------ */
/* Discovery store with mtime-based incremental refresh                      */
/* ------------------------------------------------------------------------ */

interface CachedTemplateFile {
  mtimeMs: number;
  size: number;
  template: PromptTemplate | null;
  reason?: string;
}

export class PromptTemplateStore {
  private readonly cache = new Map<string, CachedTemplateFile>();
  private snapshot: PromptTemplate[] = [];
  private currentWarnings: PromptTemplateWarning[] = [];
  private refreshing: Promise<void> | undefined;

  /**
   * Directories in ascending precedence: a template in a later directory
   * overrides one with the same name in an earlier directory.
   */
  constructor(private readonly directories: readonly string[]) {}

  /** All valid templates, name ascending. */
  async list(): Promise<PromptTemplateSummary[]> {
    await this.refresh();
    return this.snapshot.map((template) => ({
      name: template.name,
      description: template.description,
      ...(template.argumentHint ? { argumentHint: template.argumentHint } : {})
    }));
  }

  async find(name: string): Promise<PromptTemplate | undefined> {
    await this.refresh();
    const found = this.snapshot.find((template) => template.name === name.toLowerCase());
    return found ? { ...found } : undefined;
  }

  /** Expands a template by name, or returns undefined when the name is unknown. */
  async expand(name: string, argsString: string): Promise<string | undefined> {
    const template = await this.find(name);
    if (!template) return undefined;
    return expandPromptTemplateBody(template.body, tokenizePromptArguments(argsString));
  }

  /** Validation and collision problems from the most recent refresh. */
  async warnings(): Promise<PromptTemplateWarning[]> {
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
    const warnings: PromptTemplateWarning[] = [];
    const byName = new Map<string, PromptTemplate>();
    for (const directory of this.directories) {
      const root = resolve(directory);
      const source = root;
      const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOTDIR") return [];
        throw error;
      });
      const namesInDirectory = new Set<string>();
      for (const entry of entries) {
        if (entry.name.startsWith(".") || !entry.name.toLowerCase().endsWith(".md")) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const path = join(root, entry.name);
        seen.add(path);
        const fileStat = await stat(path).catch(() => undefined);
        if (!fileStat?.isFile()) continue;
        let cached = this.cache.get(path);
        if (!cached || cached.mtimeMs !== fileStat.mtimeMs || cached.size !== fileStat.size) {
          cached = await this.load(path, entry.name, source, fileStat);
          this.cache.set(path, cached);
        }
        if (!cached.template) {
          if (cached.reason) warnings.push({ path, source, reason: cached.reason });
          continue;
        }
        if (namesInDirectory.has(cached.template.name)) {
          warnings.push({ path, source, reason: `duplicate command name "/${cached.template.name}" in ${root}; the first one found wins` });
          continue;
        }
        namesInDirectory.add(cached.template.name);
        // Later directories intentionally overwrite: workspace beats user-global.
        byName.set(cached.template.name, cached.template);
      }
    }
    for (const path of [...this.cache.keys()]) {
      if (!seen.has(path)) this.cache.delete(path);
    }
    this.snapshot = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
    this.currentWarnings = warnings;
  }

  private async load(path: string, fileName: string, source: string, fileStat: { mtimeMs: number; size: number }): Promise<CachedTemplateFile> {
    const base = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
    try {
      const content = await readFile(path, "utf8");
      const parsed = parsePromptTemplate(fileName, content);
      return { ...base, template: { ...parsed, source, path } };
    } catch (error) {
      return { ...base, template: null, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
