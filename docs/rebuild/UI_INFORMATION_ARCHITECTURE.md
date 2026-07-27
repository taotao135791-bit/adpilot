# UI information architecture

Status: design and interaction contract

## Window

```text
┌──────────────── native titlebar-safe drag region ───────────────┐
├───────────────┬─────────────────────────────┬───────────────────┤
│ Session rail  │ Agent workspace             │ Inspector         │
│ New session   │ conversation                │ context/evidence  │
│ Search        │ progress/tool calls         │ metrics/files     │
│ Clients       │ approvals/results           │ computer/artifact │
│ Projects      │                             │ cost/history      │
│ Sessions      │                             │                   │
│ Automations   │                             │                   │
│ Plugins       │                             │                   │
│ Archive       │                             │                   │
│ Settings      │                             │                   │
├───────────────┴─────────────────────────────┴───────────────────┤
│ composer: attachments · references · model · permission · run  │
└─────────────────────────────────────────────────────────────────┘
```

The titlebar-safe region remains reserved in expanded and collapsed sidebar states. Controls are `no-drag`; blank titlebar regions are draggable. Windows/Linux use their native strategy rather than macOS coordinates.

## Session rail

- New session persists immediately.
- Search has keyboard focus and recent query history.
- Pinned and recent sessions show title, client/project, status, and unread completion.
- Clients/projects expand to their sessions.
- Archive and trash are recoverable views.
- Automations and Plugins are first-level destinations.
- Context menus expose rename, pin, duplicate, branch, archive, delete, and restore.

IDs never appear as normal titles. Auto-title uses the first meaningful user goal and remains editable.

## Main workspace

- Messages and results use readable line length.
- Tool calls collapse to a compact header and expand to input, output, timing, permission, and evidence.
- Long tasks expose ordered progress without turning the page into a permanent dashboard.
- Approval cards render exact account/Campaign/current/proposed values, risk, evidence, rollback, and post-change verification.
- Streaming, queued follow-ups, steering, stop, retry, and recovery have distinct states.
- Empty state asks “What do you want to work on?” and mixes advertising and general work starters.

## Inspector

Inspector content follows the current selection:

- Session context and model/permission/usage.
- Client, account, Campaign, metrics, attribution trust, creative, risk.
- Evidence and verified facts.
- Files, attachments, artifacts, and audit references.
- Computer Live View with screenshot, overlay, current window, cursor, and controls.
- Tool and run history.

The Inspector can collapse and must not be required to understand an approval.

## Composer

- Multiline text, paste, image/PDF/CSV/Excel/file/screenshot attachments.
- `@` references for files, clients, campaigns, sessions, and plugins.
- `/` commands and visible completion.
- Session-scoped model, thinking, permission profile, and Computer Use control.
- Stop while running; steer and follow-up queue while the current turn continues.
- Attachment and permission errors are inline and recoverable.

## Settings routes

- General
- Models and providers
- Permissions
- Computer Use
- Plugins
- Security and privacy
- Storage and audit
- About and updates

Settings is a real workspace/page on compact windows and may use a sheet on wide windows. It is not a stack of undifferentiated credential fields.

## Visual language

- Plus Jakarta Sans and JetBrains Mono already provide a usable typographic base.
- Keep one restrained chartreuse accent; reduce its area and reserve it for primary actions/status.
- Use surfaces and spacing instead of borders/shadows around every block.
- Tabular figures for metrics, cost, tokens, and timestamps.
- Motion only for panel transitions, streaming/progress, disclosure, and state changes.
- Every interactive item has hover, pressed, focus, disabled, loading, error, and empty states.

