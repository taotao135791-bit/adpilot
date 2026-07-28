export { GitToolError, type GitToolErrorCode } from "./error.js";
export { GIT_TIMEOUT_MS } from "./exec.js";
export {
  GitRepository,
  assertValidBranchName,
  type BranchInfo,
  type DiffFileStat,
  type DiffOptions,
  type DiffResult,
  type FileChange,
  type FileChangeStatus,
  type GitRepositoryOptions,
  type GitStatus,
  type LogEntry
} from "./repository.js";
export {
  WorktreeManager,
  WORKTREE_CONTAINER_DIR,
  type WorktreeAddInput,
  type WorktreeAddResult,
  type WorktreeListEntry
} from "./worktree.js";
export {
  CheckpointStore,
  MAX_UNTRACKED_FILE_BYTES,
  type Checkpoint,
  type CheckpointCreateInput,
  type CheckpointRestoreResult,
  type SkippedUntrackedFile,
  type UntrackedFileSnapshot
} from "./checkpoint.js";
