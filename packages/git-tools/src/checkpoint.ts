/**
 * Checkpoint snapshots and rollback for agent task boundaries.
 *
 * A checkpoint captures, for one repository: HEAD sha, the structured status,
 * the staged and unstaged diffs (--binary, so they replay through git apply),
 * and the full content of untracked files below 256KB (larger or non-regular
 * files are recorded as skipped instead of silently snapshotted).
 *
 * Storage follows the AdPilot FileStore pattern: a private 0700 directory,
 * UUID file names, 0600 records written via a private temp file + rename,
 * and fail-closed symlink checks.
 *
 * Restore strategy — "reset to HEAD, then replay forward":
 *   1. `git reset --hard HEAD` returns tracked state (index + worktree) to
 *      the exact base the snapshot diffs were computed against.
 *   2. The staged diff replays with `git apply --index` (index AND worktree).
 *   3. The unstaged diff replays with plain `git apply` (worktree only).
 *   4. Untracked files are written back from their base64 snapshot.
 * Because both diffs were captured against the same HEAD, replay is exact;
 * reverse-applying against a mutated worktree would need three-way merges
 * that git apply cannot guarantee. Restore requires the current HEAD to
 * equal the snapshot HEAD (CHECKPOINT_DIVERGED otherwise, { force: true }
 * to override) and an explicit { confirm: true }.
 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GitToolError } from "./error.js";
import { runGit } from "./exec.js";
import { canonicalize, confinedPath } from "./paths.js";
import { GitRepository, type GitStatus } from "./repository.js";

/** Untracked files at or above this size are skipped (recorded, not snapshotted). */
export const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;

export interface UntrackedFileSnapshot {
  readonly path: string;
  readonly contentBase64: string;
}

export interface SkippedUntrackedFile {
  readonly path: string;
  readonly reason: "too-large" | "not-regular-file";
  readonly sizeBytes: number;
}

export interface Checkpoint {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly repoRoot: string;
  readonly label: string;
  readonly taskId?: string;
  /** null when the snapshot was taken on an unborn branch. */
  readonly headSha: string | null;
  readonly status: GitStatus;
  readonly diffStaged: string;
  readonly diffUnstaged: string;
  readonly untrackedFiles: readonly UntrackedFileSnapshot[];
  readonly skippedUntracked: readonly SkippedUntrackedFile[];
}

export interface CheckpointCreateInput {
  readonly repoRoot: string;
  readonly label: string;
  readonly taskId?: string;
}

export interface CheckpointRestoreResult {
  readonly id: string;
  readonly headSha: string;
  readonly replayedStagedDiff: boolean;
  readonly replayedUnstagedDiff: boolean;
  readonly restoredUntrackedFiles: number;
}

function assertCheckpointId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new GitToolError("INVALID_ARGUMENT", `invalid checkpoint id: ${JSON.stringify(id)}`);
  }
}

/** Paths of files the diff creates; used to clear leftovers before replaying. */
function newFilesInDiff(diff: string): string[] {
  const paths: string[] = [];
  for (const block of diff.split(/^diff --git /m).slice(1)) {
    if (!/^new file mode /m.test(block)) continue;
    const match = /^\+\+\+ b\/(.+)$/m.exec(block);
    if (match?.[1]) paths.push(match[1]);
  }
  return paths;
}

export class CheckpointStore {
  private readonly directory: string;

  constructor(directory: string) {
    if (!directory) throw new GitToolError("INVALID_ARGUMENT", "checkpoint directory is required");
    this.directory = resolve(directory);
  }

  async create(input: CheckpointCreateInput): Promise<Checkpoint> {
    if (!input.label) throw new GitToolError("INVALID_ARGUMENT", "checkpoint label is required");
    const repo = new GitRepository(input.repoRoot);
    const root = canonicalize(repo.root);
    const status = await repo.status();
    const untrackedFiles: UntrackedFileSnapshot[] = [];
    const skippedUntracked: SkippedUntrackedFile[] = [];
    for (const relativePath of status.untracked) {
      const absolutePath = confinedPath(root, relativePath);
      const metadata = await lstat(absolutePath).catch(() => null);
      if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) {
        skippedUntracked.push({ path: relativePath, reason: "not-regular-file", sizeBytes: metadata?.size ?? 0 });
        continue;
      }
      if (metadata.size > MAX_UNTRACKED_FILE_BYTES) {
        skippedUntracked.push({ path: relativePath, reason: "too-large", sizeBytes: metadata.size });
        continue;
      }
      const content = await readFile(absolutePath);
      untrackedFiles.push({ path: relativePath, contentBase64: content.toString("base64") });
    }
    const checkpoint: Checkpoint = {
      version: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      repoRoot: root,
      label: input.label,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      headSha: await repo.headSha(),
      status,
      diffStaged: (await repo.diff({ staged: true })).raw,
      diffUnstaged: (await repo.diff()).raw,
      untrackedFiles,
      skippedUntracked
    };
    await this.persist(checkpoint);
    return checkpoint;
  }

  async get(id: string): Promise<Checkpoint | undefined> {
    assertCheckpointId(id);
    await this.ensureSafeDirectory();
    const target = this.pathFor(id);
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new GitToolError("UNSAFE_PATH", `checkpoint ${id} is not a regular file`);
      }
      const raw = await readFile(target);
      if (raw.byteLength > MAX_CHECKPOINT_BYTES) {
        throw new GitToolError("INVALID_ARGUMENT", `checkpoint ${id} exceeds the size limit`);
      }
      const parsed = JSON.parse(raw.toString("utf8")) as Checkpoint;
      if (parsed.version !== 1 || parsed.id !== id) {
        throw new GitToolError("INVALID_ARGUMENT", `checkpoint ${id} is malformed`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** All checkpoints for one repository, oldest first. */
  async list(repoRoot: string): Promise<Checkpoint[]> {
    await this.ensureSafeDirectory();
    const canonicalRoot = canonicalize(repoRoot);
    const checkpoints: Checkpoint[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      try {
        const checkpoint = await this.get(name.slice(0, -".json".length));
        if (checkpoint && checkpoint.repoRoot === canonicalRoot) checkpoints.push(checkpoint);
      } catch {
        // a malformed record must not break listings of the others
      }
    }
    return checkpoints.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async restore(id: string, options: { confirm: boolean; force?: boolean }): Promise<CheckpointRestoreResult> {
    if (options.confirm !== true) {
      throw new GitToolError(
        "CONFIRMATION_REQUIRED",
        "restore rewrites the index and tracked files and overwrites untracked files; pass { confirm: true } to proceed"
      );
    }
    const checkpoint = await this.get(id);
    if (!checkpoint) throw new GitToolError("CHECKPOINT_NOT_FOUND", `no checkpoint with id ${id}`);
    if (checkpoint.headSha === null) {
      throw new GitToolError("UNBORN_HEAD", `checkpoint ${id} was taken before the first commit and cannot be restored`);
    }
    const repo = new GitRepository(checkpoint.repoRoot);
    const root = canonicalize(repo.root);
    const currentHead = await repo.headSha();
    if (currentHead !== checkpoint.headSha && options.force !== true) {
      throw new GitToolError(
        "CHECKPOINT_DIVERGED",
        `HEAD moved since checkpoint ${id} (was ${checkpoint.headSha}, now ${currentHead ?? "unborn"}); pass { force: true } to restore anyway`
      );
    }

    // 1. Tracked state back to the base the diffs were computed against.
    await runGit(["reset", "--hard", "HEAD"], { cwd: root });

    // 2. Files the staged diff creates must not pre-exist in the index or the
    //    worktree, or git apply --index refuses ("already exists"). They can
    //    be tracked after a forced restore onto a diverged HEAD, so unstage
    //    them first (a no-op when they are untracked).
    const recreated = newFilesInDiff(checkpoint.diffStaged);
    if (recreated.length > 0) {
      await runGit(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...recreated], { cwd: root });
      for (const path of recreated) {
        await rm(confinedPath(root, path), { force: true });
      }
    }

    // 3+4. Replay staged (index+worktree), then unstaged (worktree only).
    const replayedStagedDiff = checkpoint.diffStaged.trim().length > 0;
    const replayedUnstagedDiff = checkpoint.diffUnstaged.trim().length > 0;
    if (replayedStagedDiff) await this.replayDiff(root, checkpoint.diffStaged, ["--index"]);
    if (replayedUnstagedDiff) await this.replayDiff(root, checkpoint.diffUnstaged, []);

    // 5. Write untracked file contents back.
    for (const file of checkpoint.untrackedFiles) {
      const absolutePath = confinedPath(root, file.path);
      const existing = await lstat(absolutePath).catch(() => null);
      if (existing?.isSymbolicLink()) {
        throw new GitToolError("UNSAFE_PATH", `refusing to overwrite symlink ${file.path} during checkpoint restore`);
      }
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, Buffer.from(file.contentBase64, "base64"));
    }

    return {
      id: checkpoint.id,
      headSha: checkpoint.headSha,
      replayedStagedDiff,
      replayedUnstagedDiff,
      restoredUntrackedFiles: checkpoint.untrackedFiles.length
    };
  }

  private async replayDiff(root: string, diff: string, extraArgs: string[]): Promise<void> {
    try {
      await runGit(["apply", "--whitespace=nowarn", ...extraArgs], { cwd: root, input: diff });
    } catch (error) {
      throw new GitToolError(
        "RESTORE_APPLY_FAILED",
        `failed to replay a checkpoint diff: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  private async persist(checkpoint: Checkpoint): Promise<void> {
    await this.ensureSafeDirectory();
    const target = this.pathFor(checkpoint.id);
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw new GitToolError("UNSAFE_PATH", `checkpoint path ${target} must not be a symlink`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = join(this.directory, `.${checkpoint.id}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async ensureSafeDirectory(): Promise<void> {
    // lstat before mkdir: a dangling symlink would make mkdir throw ENOENT and
    // hide the real problem — the store path must never be a symlink.
    const existing = await lstat(this.directory).catch(() => null);
    if (!existing) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new GitToolError("UNSAFE_PATH", "checkpoint directory must be a real private directory");
    }
    await chmod(this.directory, 0o700);
  }

  private pathFor(id: string): string {
    assertCheckpointId(id);
    return confinedPath(this.directory, `${id}.json`);
  }
}
