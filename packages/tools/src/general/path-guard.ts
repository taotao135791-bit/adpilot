/**
 * Workspace confinement for the general read-only tools (AdPilot-specific).
 *
 * The model-facing read/grep/find/ls tools may only touch paths inside an
 * explicit policy: allowed roots (the client workspace plus directories the
 * operator explicitly allows, such as the user skill/prompt directories) minus
 * denied subtrees (the workspace-private `.adpilot` directory holding settings,
 * credentials and the approval secret). The resolution rule is
 * longest-match-wins, so an allowed subdirectory inside a denied parent stays
 * readable (`.adpilot/skills` inside denied `.adpilot`).
 *
 * Every candidate path is resolved against the primary root, canonicalized
 * with realpath (its nearest existing ancestor plus the missing tail), and
 * then checked against the canonical rules — a hardening of the WorkspaceStore
 * traversal pattern (resolveClientPath in @adpilot/workspace). Canonicalizing
 * both sides is what makes the check sound: a purely lexical comparison is
 * fooled by symlinks inside the tree AND by roots that themselves live behind
 * a symlink (macOS /var → /private/var is the everyday case).
 *
 * Anything outside the policy is rejected with an error before a single byte
 * is read; there is no fail-open path.
 */
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface ReadAccessPolicy {
  /** Readable roots. The first entry is the primary root: relative tool paths resolve against it. */
  allow: readonly string[];
  /** Unreadable subtrees. A longer matching allow rule still wins (see module docs). */
  deny?: readonly string[];
}

export interface ReadPathGuard {
  /** Primary root that relative paths resolve against (canonicalized). */
  readonly primaryRoot: string;
  /**
   * Resolves a model-supplied path to a confined absolute path. Throws when
   * the path escapes the policy lexically or through a symlink. The returned
   * path may not exist; existence errors surface as "Path not found".
   */
  resolve(input: string): Promise<string>;
  /**
   * Policy check for an already-canonical absolute path. Used by the
   * directory walkers, which start at a resolved root and never follow
   * symlinked directories, so a realpath per entry is unnecessary.
   */
  isAllowed(canonicalAbsolutePath: string): boolean;
  /** Human-readable root summary for tool descriptions and error messages. */
  describeRoots(): string;
}

interface CompiledRule {
  path: string;
  allow: boolean;
}

/** Error message prefix used for every policy rejection (asserted by tests). */
export const PATH_ESCAPE_MESSAGE = "path is outside the readable roots";

/** Canonical form of a rule path: realpath when it exists, lexical resolve otherwise. */
function canonicalize(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function createReadPathGuard(policy: ReadAccessPolicy): ReadPathGuard {
  if (policy.allow.length === 0) throw new Error("read access policy needs at least one allowed root");
  const rules: CompiledRule[] = [
    ...policy.allow.map((path) => ({ path: canonicalize(path), allow: true })),
    ...(policy.deny ?? []).map((path) => ({ path: canonicalize(path), allow: false }))
  ];
  const primaryRoot = rules[0]!.path;

  const evaluate = (absolutePath: string): boolean => {
    let decision: CompiledRule | undefined;
    for (const rule of rules) {
      if (absolutePath === rule.path || absolutePath.startsWith(`${rule.path}${sep}`)) {
        if (!decision || rule.path.length > decision.path.length) decision = rule;
      }
    }
    return decision?.allow ?? false;
  };

  /**
   * Realpath of the target, or of its nearest existing ancestor with the
   * missing tail re-attached. Walking up one component at a time keeps symlink
   * resolution exact for paths whose final components do not exist yet.
   */
  const realpathNearest = async (absolutePath: string): Promise<string> => {
    const tail: string[] = [];
    let current = absolutePath;
    for (;;) {
      try {
        const real = await realpath(current);
        return tail.length ? join(real, ...tail) : real;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(current);
        if (parent === current) return absolutePath;
        tail.unshift(basename(current));
        current = parent;
      }
    }
  };

  return {
    primaryRoot,
    describeRoots: () => rules.filter((rule) => rule.allow).map((rule) => rule.path).join(", "),
    isAllowed: evaluate,
    async resolve(input: string): Promise<string> {
      if (typeof input !== "string" || input.length === 0 || input.includes("\u0000")) {
        throw new Error("path must be a non-empty string");
      }
      const lexical = isAbsolute(input) ? resolve(input) : resolve(primaryRoot, input);
      // The canonical check is the only authoritative one: it catches `..`
      // escapes, absolute paths outside every root, and symlinks pointing out
      // of the policy, regardless of whether the roots themselves are behind
      // a symlink.
      const real = await realpathNearest(lexical);
      if (!evaluate(real)) {
        const via = real === lexical ? "" : ` (resolves to ${real})`;
        throw new Error(`${PATH_ESCAPE_MESSAGE}: ${input}${via} (readable roots: ${rules.filter((rule) => rule.allow).map((rule) => rule.path).join(", ")})`);
      }
      return real;
    }
  };
}

/**
 * Default policy for one AdPilot deployment: the whole workspace is readable
 * except its private `.adpilot` subtree (settings.json, pi-auth.json and the
 * approval secret live there); extra roots the operator explicitly allows
 * (for example the user and workspace skill/prompt directories) are appended
 * and win over the `.adpilot` denial when they sit inside it.
 */
export function workspaceReadPolicy(workspaceRoot: string, extraAllow: readonly string[] = []): ReadAccessPolicy {
  return {
    allow: [resolve(workspaceRoot), ...extraAllow.map((path) => resolve(path))],
    deny: [resolve(workspaceRoot, ".adpilot")]
  };
}
