# Session design

Status: implementation contract

## Canonical entity

```ts
interface Session {
  schemaVersion: 1;
  id: string;                       // globally unique product ID
  runtimeConversationId: string;    // compatibility key for durable Pi storage
  title: string;
  clientId?: string;
  projectId?: string;
  advertisingWorkspaceId?: string;
  agentProfileId: string;
  modelBinding: {
    primary?: { providerId: string; modelId: string };
    fallback?: { providerId: string; modelId: string };
    roleOverrides: Record<string, { providerId: string; modelId: string }>;
    maxCostUsd?: number;
  };
  permissionProfile: SessionPermissionProfile;
  status: "idle" | "running" | "waiting_approval" | "paused" | "failed" | "completed";
  parentSessionId?: string;
  branchPointMessageId?: string;
  pinned: boolean;
  archivedAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  revision: number;
}
```

Legacy `clientId + conversationId` pairs are imported once into product Sessions. Their Pi JSONL remains the model-context source; `conversation.jsonl` remains a presentation projection until it is replaced by normalized message records.

## Required operations

- Create before first message.
- Get/list/search/filter by client/project/platform/status.
- Rename, pin/unpin, archive/unarchive.
- Soft delete, restore, and explicit permanent purge.
- Duplicate.
- Branch the complete session or branch from a globally unique message.
- Atomically touch `lastOpenedAt`.
- Update model binding and permission profile with optimistic revision checks.
- Report independent run, approval, Computer Use, usage, and cost state.

## Concurrency

- The daemon holds the workspace writer lease.
- A keyed session actor serializes transcript/app-state mutations.
- Separate actors can execute concurrently.
- UI request generations prevent a slow response from overwriting a newly selected session.
- Sending, stopping, steering, and follow-up queues are session-specific.
- Every append uses a monotonic sequence and survives a truncated final record by quarantining only the incomplete tail.

## Pi context

- A run opens `AdPilotSessionStorage` with `runtimeConversationId`.
- Completed Pi messages, tool calls/results, model changes, compaction, and branch summaries rebuild context.
- The run uses an immutable `RunModelBinding` resolved from the Session at start.
- A recovery checkpoint is read on daemon boot. `running`/`compacting` becomes a typed interrupted state; safe resumable work is queued, and ambiguous side effects require user review.
- Fork allocates new Pi entry/message/product IDs and records provenance rather than copying identity.

## UI behavior

- Creating a session persists immediately and selects it.
- Switching sessions never cancels another session.
- Status indicators update through session-scoped events.
- Empty sessions can be renamed, archived, or deleted.
- Search uses title plus a bounded local message index; sensitive artifacts are not silently indexed.

## Acceptance tests

- Three sessions use different providers concurrently without context, model, permission, account, or Computer Use leakage.
- Background work continues while another session is active.
- Renderer reload, app restart, daemon restart, and interrupted append recover deterministically.
- Branch and duplicate use new IDs while preserving model-visible history and provenance.
- Archive/delete/restore and every filter persist.
- A stale UI response cannot replace a later session selection.

