/** Shared path helpers (internal). */
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { GitToolError } from "./error.js";

/**
 * Canonicalizes a path for comparison. On macOS temp directories this resolves
 * the /var -> /private/var symlink, which matters because git reports the
 * resolved form while callers usually pass the unresolved one.
 */
export function canonicalize(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Fail-closed confinement: the resolved path must stay inside `root`. */
export function confinedPath(root: string, relativePath: string): string {
  const path = resolve(join(root, relativePath));
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new GitToolError("PATH_ESCAPE", `path ${JSON.stringify(relativePath)} escapes ${root}`);
  }
  return path;
}
