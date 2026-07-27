import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class UnsafeWorkspacePathError extends Error {
  constructor(
    readonly workspaceRoot: string,
    readonly targetPath: string,
    readonly reason: string
  ) {
    super(`unsafe workspace path (${reason}): ${targetPath}`);
    this.name = "UnsafeWorkspacePathError";
  }
}

export interface SafeWorkspacePathOptions {
  finalType?: "any" | "directory";
  requireExisting?: boolean;
}

/**
 * Verifies the exact workspace root and every existing descendant segment.
 *
 * Ancestors of the workspace may be platform symlinks (for example /var on
 * macOS), but the workspace entry itself and everything below it must be real
 * filesystem objects. This prevents an attacker from redirecting `.adpilot`
 * or one of its repository directories outside the workspace.
 */
export async function assertSafeWorkspacePath(
  workspaceRoot: string,
  targetPath: string,
  options: SafeWorkspacePathOptions = {}
): Promise<void> {
  const root = resolve(workspaceRoot);
  const target = resolve(targetPath);
  const relativeTarget = relative(root, target);
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new UnsafeWorkspacePathError(root, target, "outside-workspace");
  }

  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    throw new UnsafeWorkspacePathError(
      root,
      target,
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "workspace-missing"
        : "workspace-unverifiable"
    );
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new UnsafeWorkspacePathError(root, target, "workspace-not-real-directory");
  }
  const canonicalRoot = await realpath(root);
  if (relativeTarget === "") {
    if (options.finalType === "directory" && !rootStats.isDirectory()) {
      throw new UnsafeWorkspacePathError(root, target, "not-directory");
    }
    return;
  }

  const segments = relativeTarget.split(sep);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (options.requireExisting) {
          throw new UnsafeWorkspacePathError(root, target, "target-missing");
        }
        return;
      }
      throw new UnsafeWorkspacePathError(root, target, "segment-unverifiable");
    }
    if (stats.isSymbolicLink()) {
      throw new UnsafeWorkspacePathError(root, target, "symbolic-link");
    }
    const isFinal = index === segments.length - 1;
    if ((!isFinal || options.finalType === "directory") && !stats.isDirectory()) {
      throw new UnsafeWorkspacePathError(root, target, "non-directory-segment");
    }
    let canonicalCurrent: string;
    try {
      canonicalCurrent = await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (options.requireExisting) {
          throw new UnsafeWorkspacePathError(root, target, "target-missing");
        }
        return;
      }
      throw new UnsafeWorkspacePathError(root, target, "segment-unverifiable");
    }
    const canonicalRelative = relative(canonicalRoot, canonicalCurrent);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelative)
    ) {
      throw new UnsafeWorkspacePathError(root, target, "canonical-escape");
    }
  }
}
