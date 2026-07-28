/**
 * Every failure raised by @adpilot/git-tools carries a stable, machine-readable
 * `code` so callers (and the approval layer) can branch on the failure class
 * instead of parsing message text.
 */
export type GitToolErrorCode =
  | "GIT_UNAVAILABLE"
  | "GIT_TIMEOUT"
  | "GIT_COMMAND_FAILED"
  | "NOT_A_REPOSITORY"
  | "REPOSITORY_ROOT_MISMATCH"
  | "BARE_REPOSITORY"
  | "INVALID_REF_NAME"
  | "INVALID_REVISION"
  | "INVALID_ARGUMENT"
  | "DIRTY_WORKTREE"
  | "NOTHING_TO_COMMIT"
  | "CONFIRMATION_REQUIRED"
  | "PATH_ESCAPE"
  | "MAIN_WORKTREE"
  | "CHECKPOINT_NOT_FOUND"
  | "CHECKPOINT_DIVERGED"
  | "UNBORN_HEAD"
  | "RESTORE_APPLY_FAILED"
  | "UNSAFE_PATH";

export class GitToolError extends Error {
  readonly code: GitToolErrorCode;

  constructor(code: GitToolErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "GitToolError";
    this.code = code;
    if (options && "cause" in options) this.cause = options.cause;
  }
}
