/**
 * Managed git worktrees under `<repoRoot>/.adpilot-worktrees/<name>`.
 *
 * Names are confined to a single path segment (no "..", separators or
 * absolute paths), so a managed worktree can never escape its container.
 * The container is added to the repo's `.git/info/exclude` on first use —
 * otherwise every managed worktree would pollute the main worktree's
 * untracked-file listing. The main worktree is never removable through this
 * class, including via symlinks planted inside the container.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { GitToolError } from "./error.js";
import { runGit } from "./exec.js";
import { canonicalize } from "./paths.js";
import { assertSafeRevision, assertValidBranchName } from "./repository.js";

export const WORKTREE_CONTAINER_DIR = ".adpilot-worktrees";

export interface WorktreeAddInput {
  /** Single path segment; becomes the directory name and default branch name. */
  readonly name: string;
  /** Branch to check out; created from baseSha (or HEAD) when missing. */
  readonly branch?: string;
  readonly baseSha?: string;
}

export interface WorktreeAddResult {
  readonly name: string;
  readonly path: string;
  readonly branch: string;
  readonly headSha: string;
}

export interface WorktreeListEntry {
  /** Container-relative name for managed worktrees, null otherwise. */
  readonly name: string | null;
  readonly path: string;
  readonly headSha: string;
  /** Short branch name, or null when detached. */
  readonly branch: string | null;
  readonly isMain: boolean;
  readonly managed: boolean;
}

export function assertValidWorktreeName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    isAbsolute(name)
  ) {
    throw new GitToolError(
      "PATH_ESCAPE",
      `worktree name must be a single path segment inside ${WORKTREE_CONTAINER_DIR}: ${JSON.stringify(name)}`
    );
  }
}

export class WorktreeManager {
  readonly repoRoot: string;
  readonly container: string;

  constructor(repoRoot: string) {
    this.repoRoot = resolve(repoRoot);
    this.container = join(this.repoRoot, WORKTREE_CONTAINER_DIR);
  }

  async add(input: WorktreeAddInput): Promise<WorktreeAddResult> {
    assertValidWorktreeName(input.name);
    const branch = input.branch ?? input.name;
    await assertValidBranchName(this.repoRoot, branch);
    if (input.baseSha !== undefined) assertSafeRevision(input.baseSha);
    await mkdir(this.container, { recursive: true, mode: 0o700 });
    await this.ensureContainerExcluded();
    const target = join(this.container, input.name);
    const branchExists =
      (await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: this.repoRoot,
        allowExitCodes: [1]
      })).exitCode === 0;
    const args = branchExists
      ? ["worktree", "add", target, branch]
      : ["worktree", "add", "-b", branch, target, input.baseSha ?? "HEAD"];
    await runGit(args, { cwd: this.repoRoot });
    const headSha = (await runGit(["-C", target, "rev-parse", "HEAD"], { cwd: this.repoRoot })).stdout.trim();
    return { name: input.name, path: target, branch, headSha };
  }

  async list(): Promise<WorktreeListEntry[]> {
    const { stdout } = await runGit(["worktree", "list", "--porcelain"], { cwd: this.repoRoot });
    // git reports canonical paths; the container may not exist yet, so compare
    // on canonicalized forms (realpath where possible).
    const canonicalContainer = canonicalize(this.container);
    const entries: WorktreeListEntry[] = [];
    let current: { path?: string; headSha?: string; branch?: string | null } | null = null;
    const flush = () => {
      if (!current?.path) return;
      const path = current.path;
      const managed = canonicalize(path).startsWith(`${canonicalContainer}${sep}`);
      entries.push({
        name: managed ? basename(path) : null,
        path,
        headSha: current.headSha ?? "",
        branch: current.branch ?? null,
        isMain: entries.length === 0, // git always lists the main worktree first
        managed
      });
    };
    for (const line of stdout.split("\n")) {
      if (line === "") {
        flush();
        current = null;
        continue;
      }
      if (line.startsWith("worktree ")) {
        current = { path: line.slice("worktree ".length) };
        continue;
      }
      if (!current) continue;
      if (line.startsWith("HEAD ")) current.headSha = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "detached") current.branch = null;
    }
    flush();
    return entries;
  }

  /** Removing a dirty worktree requires { force: true }; the main worktree is never removable. */
  async remove(name: string, options?: { force?: boolean }): Promise<void> {
    assertValidWorktreeName(name);
    const target = join(this.container, name);
    const realTarget = canonicalize(target);
    if (realTarget === (await this.mainWorktreePath())) {
      throw new GitToolError("MAIN_WORKTREE", "refusing to remove the main worktree");
    }
    const args = ["worktree", "remove"];
    if (options?.force) args.push("--force");
    args.push(target);
    try {
      await runGit(args, { cwd: this.repoRoot });
    } catch (error) {
      if (
        error instanceof GitToolError &&
        error.code === "GIT_COMMAND_FAILED" &&
        /modified or untracked|is dirty/i.test(error.message)
      ) {
        throw new GitToolError(
          "DIRTY_WORKTREE",
          `worktree ${name} contains modified or untracked files; pass { force: true } to remove it anyway`,
          { cause: error }
        );
      }
      throw error;
    }
    await rm(target, { recursive: true, force: true });
  }

  async prune(): Promise<void> {
    await runGit(["worktree", "prune"], { cwd: this.repoRoot });
  }

  private async mainWorktreePath(): Promise<string> {
    const [main] = await this.list();
    if (!main) throw new GitToolError("NOT_A_REPOSITORY", `${this.repoRoot} has no git worktrees`);
    return canonicalize(main.path);
  }

  private async ensureContainerExcluded(): Promise<void> {
    const gitPath = (await runGit(["rev-parse", "--git-path", "info/exclude"], { cwd: this.repoRoot })).stdout.trim();
    const excludePath = isAbsolute(gitPath) ? gitPath : join(this.repoRoot, gitPath);
    await mkdir(dirname(excludePath), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(excludePath, "utf8");
    } catch {
      // missing exclude file: start fresh
    }
    if (existing.split(/\r?\n/).includes(`${WORKTREE_CONTAINER_DIR}/`)) return;
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(excludePath, `${existing}${prefix}# AdPilot managed worktrees\n${WORKTREE_CONTAINER_DIR}/\n`, "utf8");
  }
}
