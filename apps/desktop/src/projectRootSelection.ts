import { parseRootPathsInput } from "./workspace.js";

export type ProjectRootSelection =
  | { cancelled: true }
  | { cancelled: false; path: string };

/** Cancellation preserves the draft byte-for-byte; a real choice appends one de-duplicated root. */
export function projectRootsAfterSelection(current: string, selection: ProjectRootSelection): string {
  if (selection.cancelled) return current;
  const roots = parseRootPathsInput(current);
  if (roots.includes(selection.path)) return current;
  return [...roots, selection.path].join("\n");
}

export function offersNativeProjectRootPicker(nativeDesktop: boolean, projectType: string): boolean {
  return nativeDesktop && projectType === "development";
}
