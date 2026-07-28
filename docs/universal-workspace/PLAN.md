# AdPilot 0.3 — Universal Workspace implementation plan

Working contract: one general Agent Kernel + first-party advertising system.
No separate chat products per domain. Pi stays the runtime; pure-vision
Computer Use stays the execution path for ads; approvals/audit stay
non-negotiable for mutations.

## Mapping onto the current architecture

- Existing `client` (WorkspaceStore) **is** the Workspace; it gains `type`
  and `enabledCapabilityPacks`.
- New `packages/kernel`: Project, Goal, TaskNode, Artifact domain objects,
  durable file stores, events. References existing sessions/approvals/audit
  by id only.
- New `packages/git-tools`: real git status/branch/diff/commit/worktree +
  checkpoints (snapshots) over spawned `git` (no new dependency).
- New `packages/artifacts`: unified Artifact store + real PPTX/DOCX/XLSX
  renderers (pptxgenjs, docx, xlsx) + website preview registry.
- Server: versioned `/api/v1/kernel/*` routes; old routes keep working.
- Desktop: left nav Home / Projects / Automations / Skills (+ Settings);
  Project view = sessions+goals+files | conversation+task timeline | dynamic
  right panel (files, diff, terminal, browser, computer, slides, evidence).

## Phase order and exit criteria

1. **Foundation** — kernel package + stores + tests green; routes mounted.
2. **Coding Agent** — git tools + terminal service + checkpoints, E2E flow A.
3. **Artifact Runtime** — renderers + canvas, E2E flow D.
4. **Ads Integration** — Python UAC engine wired, decisions/action queue,
   daily brief, E2E flow B (read-only).
5. **Computer Use** — recoverable runs + Record&Replay into workflows.
6. **Automations** — scheduler, idempotency, approval-gated, flow F.
7. **UI Polish** — Home, Project layout, progressive disclosure.

Every phase: typecheck + package tests + root suite green, commit.
External blockers (no live ad account, no model key) are recorded as
blocked/not-run, never faked.
