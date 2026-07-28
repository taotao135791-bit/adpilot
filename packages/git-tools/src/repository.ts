/**
 * Structured access to a single git worktree.
 *
 * The constructor pins the instance to the repository top level: it probes
 * `git rev-parse --is-bare-repository` / `--show-toplevel` (synchronously,
 * still without a shell) and refuses bare repositories and subdirectory
 * paths, so every later command runs in exactly the tree the caller asked
 * for. Branch names and revisions are validated before use; anything
 * user-controlled that git would treat as an option (leading "-") is
 * rejected up front, and pathspecs always follow a literal `--` separator.
 *
 * Destructive primitives (discardChanges) require an explicit
 * `{ confirm: true }`; branch switches refuse a dirty worktree with
 * DIRTY_WORKTREE instead of auto-stashing.
 */
import { resolve } from "node:path";
import { GitToolError } from "./error.js";
import { runGit, runGitSync, type GitExecResult } from "./exec.js";
import { canonicalize } from "./paths.js";

export type FileChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "unmerged";

export interface FileChange {
  readonly path: string;
  readonly status: FileChangeStatus;
  /** Present on renames/copies: the path the file had before. */
  readonly oldPath?: string;
}

export interface GitStatus {
  readonly branch: string;
  readonly ahead: number;
  readonly behind: number;
  readonly staged: readonly FileChange[];
  readonly unstaged: readonly FileChange[];
  readonly untracked: readonly string[];
}

export interface BranchInfo {
  readonly name: string;
  readonly current: boolean;
  readonly lastCommitSha: string;
}

export interface DiffOptions {
  readonly staged?: boolean;
  readonly baseSha?: string;
  readonly paths?: readonly string[];
}

export interface DiffFileStat {
  readonly path: string;
  /** 0 for binary files (git reports them as "-"). */
  readonly additions: number;
  readonly deletions: number;
  readonly status: FileChangeStatus;
}

export interface DiffResult {
  /** Raw unified diff text (--binary, suitable for git apply). */
  readonly raw: string;
  readonly files: readonly DiffFileStat[];
}

export interface LogEntry {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  /** ISO 8601 author date. */
  readonly date: string;
}

export interface GitRepositoryOptions {
  /** Per-command timeout in ms; defaults to 30s. */
  readonly timeoutMs?: number;
}

/** Validates a branch name against git's own ref-format rules. */
export async function assertValidBranchName(cwd: string, name: string): Promise<void> {
  if (!name || name.startsWith("-") || name.includes("..")) {
    throw new GitToolError("INVALID_REF_NAME", `invalid branch name: ${JSON.stringify(name)}`);
  }
  const result = await runGit(["check-ref-format", "--branch", name], { cwd, allowExitCodes: [1, 128] });
  if (result.exitCode !== 0) {
    throw new GitToolError("INVALID_REF_NAME", `invalid branch name: ${JSON.stringify(name)}`);
  }
}

/** Rejects revisions that could be parsed as command options. */
export function assertSafeRevision(value: string): void {
  if (!value || value.startsWith("-") || /\s/.test(value) || value.includes("..")) {
    throw new GitToolError("INVALID_REVISION", `invalid revision: ${JSON.stringify(value)}`);
  }
}

function assertPaths(paths: readonly string[]): void {
  if (paths.length === 0) throw new GitToolError("INVALID_ARGUMENT", "at least one path is required");
  for (const path of paths) {
    if (!path || path.includes("\0")) {
      throw new GitToolError("INVALID_ARGUMENT", `invalid path: ${JSON.stringify(path)}`);
    }
  }
}

function statusLetter(letter: string): FileChangeStatus {
  switch (letter) {
    case "A": return "added";
    case "M": return "modified";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "typechange";
    case "U": return "unmerged";
    default: return "modified";
  }
}

function parseStatus(output: string): GitStatus {
  let branch = "(unknown)";
  let ahead = 0;
  let behind = 0;
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  const untracked: string[] = [];
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# branch.head ")) {
      branch = record.slice("# branch.head ".length);
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(record);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith("# ")) continue;
    if (record.startsWith("? ")) {
      untracked.push(record.slice(2));
      continue;
    }
    if (record.startsWith("! ")) continue;
    const tag = record.charAt(0);
    if (tag === "u") {
      // u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      unstaged.push({ path: record.split(" ").slice(10).join(" "), status: "unmerged" });
      continue;
    }
    if (tag === "1" || tag === "2") {
      const x = record.charAt(2);
      const y = record.charAt(3);
      // 1 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      const path = record.split(" ").slice(tag === "1" ? 8 : 9).join(" ");
      let oldPath: string | undefined;
      if (tag === "2") {
        index += 1;
        oldPath = records[index];
      }
      const rename = oldPath !== undefined ? { oldPath } : {};
      if (x !== ".") staged.push({ path, status: statusLetter(x), ...rename });
      if (y !== ".") unstaged.push({ path, status: statusLetter(y), ...rename });
    }
  }
  return { branch, ahead, behind, staged, unstaged, untracked };
}

function parseDiffFileStats(numstat: string, nameStatus: string): DiffFileStat[] {
  const byPath = new Map<string, { path: string; additions: number; deletions: number; status: FileChangeStatus }>();
  const order: string[] = [];
  const ensure = (path: string) => {
    let entry = byPath.get(path);
    if (!entry) {
      entry = { path, additions: 0, deletions: 0, status: "modified" };
      byPath.set(path, entry);
      order.push(path);
    }
    return entry;
  };

  // --numstat -z: "<add>\t<del>\t<path>" records; renames use an empty path
  // field followed by two extra records (old path, new path).
  const numTokens = numstat.split("\0");
  for (let index = 0; index < numTokens.length; index += 1) {
    const token = numTokens[index];
    if (!token) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token);
    if (!match) continue;
    let path = match[3] ?? "";
    if (path === "") {
      index += 2;
      path = numTokens[index] ?? "";
    }
    if (!path) continue;
    const entry = ensure(path);
    entry.additions = match[1] === "-" ? 0 : Number(match[1]);
    entry.deletions = match[2] === "-" ? 0 : Number(match[2]);
  }

  // --name-status -z: "<X>" "<path>" pairs; R/C use "<X><score>" old new.
  const statusTokens = nameStatus.split("\0");
  for (let index = 0; index < statusTokens.length; index += 1) {
    const token = statusTokens[index];
    if (!token) continue;
    const letter = token.charAt(0);
    if (letter === "R" || letter === "C") {
      const newPath = statusTokens[index + 2];
      index += 2;
      if (newPath) ensure(newPath).status = statusLetter(letter);
    } else {
      const path = statusTokens[index + 1];
      index += 1;
      if (path) ensure(path).status = statusLetter(letter);
    }
  }

  return order.map((path) => {
    const entry = byPath.get(path);
    return { path, additions: entry?.additions ?? 0, deletions: entry?.deletions ?? 0, status: entry?.status ?? "modified" };
  });
}

export class GitRepository {
  readonly root: string;
  private readonly timeoutMs: number | undefined;

  constructor(repoRoot: string, options?: GitRepositoryOptions) {
    const root = resolve(repoRoot);
    const bare = runGitSync(["rev-parse", "--is-bare-repository"], {
      cwd: root,
      timeoutMs: options?.timeoutMs,
      allowExitCodes: [128]
    });
    if (bare.exitCode !== 0) {
      throw new GitToolError("NOT_A_REPOSITORY", `${root} is not inside a git repository`);
    }
    if (bare.stdout.trim() === "true") {
      throw new GitToolError("BARE_REPOSITORY", `${root} is a bare repository; git-tools only operates on worktrees`);
    }
    const top = runGitSync(["rev-parse", "--show-toplevel"], {
      cwd: root,
      timeoutMs: options?.timeoutMs,
      allowExitCodes: [128]
    });
    if (top.exitCode !== 0) {
      // e.g. a path inside .git: in a repository, but not a worktree root
      throw new GitToolError("REPOSITORY_ROOT_MISMATCH", `${root} is not the worktree top level; pass the repository root`);
    }
    const canonicalTop = canonicalize(top.stdout.trim());
    if (canonicalTop !== canonicalize(root)) {
      throw new GitToolError(
        "REPOSITORY_ROOT_MISMATCH",
        `${root} is not the repository top level (${canonicalTop} is); pass the repository root`
      );
    }
    this.root = root;
    this.timeoutMs = options?.timeoutMs;
  }

  private git(args: string[], options?: { input?: string; allowExitCodes?: number[] }): Promise<GitExecResult> {
    return runGit(args, {
      cwd: this.root,
      timeoutMs: this.timeoutMs,
      input: options?.input,
      allowExitCodes: options?.allowExitCodes
    });
  }

  async status(): Promise<GitStatus> {
    const { stdout } = await this.git(["status", "--porcelain=v2", "--branch", "-z"]);
    return parseStatus(stdout);
  }

  async branches(): Promise<BranchInfo[]> {
    const { stdout } = await this.git(["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(HEAD)", "refs/heads"]);
    const branches: BranchInfo[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, sha, head] = line.split("\0");
      if (!name || !sha) continue;
      branches.push({ name, current: head?.trim() === "*", lastCommitSha: sha });
    }
    return branches;
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    await assertValidBranchName(this.root, name);
    const args = ["branch", name];
    if (startPoint !== undefined) {
      assertSafeRevision(startPoint);
      args.push(startPoint);
    }
    await this.git(args);
  }

  /** Refuses to switch when tracked changes are pending; never auto-stashes. */
  async switchBranch(name: string): Promise<void> {
    await assertValidBranchName(this.root, name);
    const status = await this.status();
    if (status.staged.length > 0 || status.unstaged.length > 0) {
      throw new GitToolError(
        "DIRTY_WORKTREE",
        `refusing to switch to ${name}: the worktree has staged or unstaged changes (commit, discard or checkpoint them first); git-tools never auto-stashes`
      );
    }
    await this.git(["switch", name]);
  }

  async diff(options: DiffOptions = {}): Promise<DiffResult> {
    const scope: string[] = [];
    if (options.staged) scope.push("--cached");
    if (options.baseSha !== undefined) {
      assertSafeRevision(options.baseSha);
      scope.push(options.baseSha);
    }
    const pathspec = options.paths && options.paths.length > 0 ? ["--", ...options.paths] : [];
    const raw = (await this.git(["diff", "--binary", ...scope, ...pathspec])).stdout;
    const numstat = (await this.git(["diff", "--numstat", "-z", ...scope, ...pathspec])).stdout;
    const nameStatus = (await this.git(["diff", "--name-status", "-z", ...scope, ...pathspec])).stdout;
    return { raw, files: parseDiffFileStats(numstat, nameStatus) };
  }

  async log(limit = 20): Promise<LogEntry[]> {
    const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 20;
    const result = await this.git(["log", `-${count}`, "--format=%H%x00%an%x00%aI%x00%s"], { allowExitCodes: [128] });
    if (result.exitCode !== 0) return []; // unborn HEAD: no commits yet
    const entries: LogEntry[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      const [sha, author, date, subject] = line.split("\0");
      if (!sha) continue;
      entries.push({ sha, subject: subject ?? "", author: author ?? "", date: date ?? "" });
    }
    return entries;
  }

  async stage(paths: readonly string[]): Promise<void> {
    assertPaths(paths);
    await this.git(["add", "--", ...paths]);
  }

  async unstage(paths: readonly string[]): Promise<void> {
    assertPaths(paths);
    await this.git(["reset", "-q", "HEAD", "--", ...paths]);
  }

  /** Returns the new commit sha. */
  async commit(message: string, options?: { allowEmpty?: boolean }): Promise<string> {
    if (!message.trim()) throw new GitToolError("INVALID_ARGUMENT", "commit message must not be empty");
    const args = ["commit"];
    if (options?.allowEmpty) args.push("--allow-empty");
    args.push("-m", message);
    try {
      await this.git(args);
    } catch (error) {
      if (
        error instanceof GitToolError &&
        error.code === "GIT_COMMAND_FAILED" &&
        /nothing to commit|no changes added to commit/i.test(error.message)
      ) {
        throw new GitToolError("NOTHING_TO_COMMIT", "nothing to commit; stage changes first or pass allowEmpty", { cause: error });
      }
      throw error;
    }
    return (await this.git(["rev-parse", "HEAD"])).stdout.trim();
  }

  /** Destructive: restores both index and worktree for the given paths from HEAD. */
  async discardChanges(paths: readonly string[], options?: { confirm?: boolean }): Promise<void> {
    if (options?.confirm !== true) {
      throw new GitToolError(
        "CONFIRMATION_REQUIRED",
        "discardChanges permanently destroys staged and worktree edits; pass { confirm: true } to proceed"
      );
    }
    assertPaths(paths);
    await this.git(["restore", "--staged", "--worktree", "--", ...paths]);
  }

  /** HEAD sha, or null on an unborn branch (no commits yet). */
  async headSha(): Promise<string | null> {
    const result = await this.git(["rev-parse", "--verify", "-q", "HEAD"], { allowExitCodes: [1] });
    const sha = result.stdout.trim();
    return result.exitCode === 0 && sha.length > 0 ? sha : null;
  }
}
