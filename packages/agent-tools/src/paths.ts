import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * Path confinement against the execution context's rootPaths. A candidate is
 * allowed when it is one of the roots or lives underneath one. Both sides are
 * canonicalized (realpath where the entry exists) so symlink tricks and
 * `..` segments cannot escape.
 */
export async function assertWithinRoots(candidate: string, rootPaths: readonly string[]): Promise<string> {
  const canonical = await canonicalize(candidate);
  for (const root of rootPaths) {
    const canonicalRoot = await canonicalize(root);
    if (canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}${sep}`)) {
      return canonical;
    }
  }
  const error = new Error(
    `path is outside the execution context rootPaths: ${candidate} (roots: ${rootPaths.join(", ") || "none"})`
  );
  (error as { code?: string }).code = "PERMISSION_DENIED";
  throw error;
}

export function hasRoots(rootPaths: readonly string[]): boolean {
  return rootPaths.length > 0;
}

async function canonicalize(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}
