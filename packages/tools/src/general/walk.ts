/**
 * Vendored-tool filesystem walking and glob matching (AdPilot adaptation).
 *
 * Upstream pi delegates searching to external ripgrep/fd binaries (downloaded
 * on demand by its tools-manager). AdPilot deliberately walks the filesystem
 * in-process instead: no external binary dependency, no downloads, and the
 * read-path confinement policy is enforced on every visited entry rather than
 * delegated to a child process. Divergences from upstream behavior:
 * - Ignore rules are a fixed set (.git, node_modules) instead of full
 *   .gitignore support; dotfiles are included, matching upstream's --hidden.
 * - Glob support is the fd --glob subset documented at globToRegExp.
 * - Symlinked directories are never descended into; symlinked files are only
 *   read after the guard's realpath check.
 */
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import type { ReadPathGuard } from "./path-guard.js";

/** Directory names the walkers always skip (upstream relies on rg/fd ignore files for these). */
export const WALK_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

export interface WalkEntry {
  /** Absolute path. */
  path: string;
  /** Path relative to the walk root, POSIX separators, no leading "./". */
  relativePath: string;
  isDirectory: boolean;
  isFile: boolean;
  symbolicLink: boolean;
}

export interface WalkOptions {
  signal?: AbortSignal | undefined;
}

/**
 * Depth-first walk of a guard-confined root. Entries are yielded in
 * case-insensitive alphabetical order per directory so tool output is
 * deterministic. Symlinked directories are never descended into; every
 * yielded path passes the guard's lexical policy check.
 */
export async function* walkEntries(root: string, guard: ReadPathGuard, options: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  const stack: string[] = [""];
  while (stack.length) {
    if (options.signal?.aborted) throw new Error("Operation aborted");
    const relative = stack.pop()!;
    const absolute = relative ? join(root, relative) : root;
    const entries = await readdir(absolute, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM") return [];
      throw error;
    });
    entries.sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()));
    const directories: string[] = [];
    for (const entry of entries) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const absolutePath = join(root, ...relativePath.split("/"));
      if (!guard.isAllowed(absolutePath)) continue;
      if (entry.isSymbolicLink()) {
        yield { path: absolutePath, relativePath, isDirectory: false, isFile: false, symbolicLink: true };
        continue;
      }
      if (entry.isDirectory()) {
        if (WALK_IGNORED_DIRECTORIES.has(entry.name)) continue;
        directories.push(relativePath);
      }
      yield { path: absolutePath, relativePath, isDirectory: entry.isDirectory(), isFile: entry.isFile(), symbolicLink: false };
    }
    for (const directory of directories.reverse()) stack.push(directory);
  }
}

const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * Compiles the fd --glob subset used by the vendored find/grep tools:
 * - a leading or middle `**` path segment matches zero or more directories,
 *   a trailing `**` matches across separators, and `*` / `?` match within
 *   one path segment.
 * - A pattern containing `/` matches the full POSIX relative path; one
 *   without `/` matches the basename only (fd's default basename semantics).
 * - Brace expansion and character classes are not supported; those
 *   characters match literally (documented divergence from fd).
 */
export function globToRegExp(pattern: string): { regex: RegExp; matchBasename: boolean } {
  const matchBasename = !pattern.includes("/");
  let effective = pattern;
  if (!matchBasename && !pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
    // fd --full-path semantics: a path-containing pattern matches anywhere in
    // the tree, so a leading `**/` is implied.
    effective = `**/${pattern}`;
  }
  let source = "";
  let index = 0;
  while (index < effective.length) {
    if (effective.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (effective.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else {
      const char = effective[index]!;
      if (char === "*") source += "[^/]*";
      else if (char === "?") source += "[^/]";
      else source += char.replace(REGEXP_SPECIALS, "\\$&");
      index += 1;
    }
  }
  return { regex: new RegExp(`^${source}$`), matchBasename };
}

/** True when a walked path matches a compiled glob (basename or full-path mode). */
export function globMatches(compiled: { regex: RegExp; matchBasename: boolean }, relativePath: string): boolean {
  const candidate = compiled.matchBasename ? (relativePath.split("/").pop() ?? relativePath) : relativePath;
  return compiled.regex.test(candidate);
}

/** Converts a relative path to the POSIX form used in tool output. */
export function toPosixPath(relativePath: string): string {
  return relativePath.split(sep).join("/");
}
