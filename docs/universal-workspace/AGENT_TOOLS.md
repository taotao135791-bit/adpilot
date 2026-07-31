# Agent Tool Registry

One registry (`packages/agent-tools`) through which the Pi agent drives every
0.3 capability. REST routes and desktop panels use the same service instances
the registry deps are built from, so UI and agent observe one state.

## Lifecycle (every call)

```text
Pi tool call
→ inject toolCallId + startedAt
→ permission re-check (second gate after registry filtering)
→ zod parameter parse
→ execute against the real service (Pi AbortSignal is propagated)
→ audit append (free-form text/command/content and credential values redacted)
→ task evidence write-back (code/git/artifact writes, when ctx.taskId exists)
→ unified AgentToolResult (success | coded error + recoverable flag)
```

A cancelled operation is non-retryable unless the user starts it again. If a
write succeeds but its audit record cannot persist, the result becomes
`AUDIT_OUTCOME_UNKNOWN` rather than claiming an unaudited success or inviting
an automatic retry.

## Visibility

`registry.list(ctx)` = always-on packs (`project`, `goal`, `task`) +
`ctx.enabledCapabilityPacks`, filtered by `ctx.permissions`
(write/destructive/computer-use). `toPiTools(ctx, deps)` projects the visible
set into pi-agent-core tools with JSON-Schema parameters.

## Tool groups (61 tools)

| Pack | Tools | Permission |
| --- | --- | --- |
| project | get_context, list, open, add_root | read/write |
| goal | create, get, update, set_progress, complete, block | read/write |
| task | create, create_many, list, start, block, complete, fail, add_dependency, attach_evidence | read/write |
| code (terminal) | create, execute, get_output, get_exit_status, interrupt, close — terminal ids are workspace/session-bound; execute uses the same classifier, scrubbed environment, capped output and fail-closed macOS Seatbelt sandbox as `bash`; repository writes checkpoint first | read/write (write-level commands additionally need `destructive`) |
| git | status, diff, log (read); create_branch, switch, stage, unstage, create_worktree, checkpoint, commit (write); restore_checkpoint, discard (destructive) — commits and destructive ops snapshot first | mixed |
| artifact | create (slides/document/spreadsheet), get, list, preview, revise, export, attach_to_task | read/write |
| ads | list_accounts, list_campaigns, run_uac_analysis (recoverable when the engine is unavailable), create_decision (duplicate-suppressed, proposal only), generate_daily_brief, record_observation | read/write |
| automation | create (daily-brief/create-task/notify only), list, pause, resume, run_now, get_runs | read/write |
| workflow | list, get, run (mutation workflows refuse when `write=false`) | read |
| computer | observe, close_window — exact PID/bundle/window/bounds observation lease; close is one-time and cross-session/replay safe | read/computer-use |

## Execution context

`AgentExecutionContext { workspaceId, projectId?, goalId?, taskId?, sessionId,
rootPaths[], enabledCapabilityPacks[], permissions, locale, createdAt }`

- `/api/messages` accepts `projectId/goalId/taskId`; the route validates the
  project, resolves the project session (find-or-create), and forwards the
  context to `agent.respond`.
- `POST /api/kernel/projects/:id/mission` classifies the ask: complex
  missions (length ≥ 80 or planning keywords) create a Goal plus an initial
  task; casual chat does not.
- Tool calls never infer ownership from global state; everything rides the
  context.
