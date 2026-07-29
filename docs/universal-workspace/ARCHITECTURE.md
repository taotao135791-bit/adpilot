# AdPilot 0.3 — Universal Workspace architecture

One general Agent Kernel plus a first-party advertising system. Pi remains the
agent runtime; pure-vision Computer Use remains the execution path for ads;
approvals and audit remain non-negotiable for mutations.

## Domain model (`packages/kernel`)

- **Workspace** = the existing client (WorkspaceStore). Projects carry the
  workspace id; every route re-checks it.
- **Project** — name, type (`general|advertising|development|research|creative`),
  rootPaths, capability packs, id lists for goals/sessions/artifacts.
- **Goal** — objective, success criteria, constraints, verification plan,
  progress, lifecycle status.
- **TaskNode** — dependency DAG with cycle detection, `readyTasks`,
  topological order, completion unlock cascade.
- **Artifact** — typed output (slides/document/spreadsheet/pdf/website/…),
  versioned, with a sibling registry record in the kernel.

All stores are file-backed with private dirs (0o700/0o600), atomic
temp+rename writes, symlink fail-closed, and schema re-parse on read.

## Execution surfaces

- **Coding** (`packages/git-tools`, `/api/git/*`): real git status/branches/
  guarded switch/diff/stage/commit/discard, worktrees under
  `.adpilot-worktrees`, checkpoints with reset+replay restore and divergence
  detection. `/api/terminals/*`: interactive zsh sessions over process
  groups, incremental output, stdin, interrupt, one-shot exec with a
  classifier-gated approval requirement for destructive commands.
- **Artifacts** (`packages/artifacts`, `/api/kernel/artifacts*`):
  pptxgenjs/docx/xlsx renderers from versioned specs; previews (SVG
  thumbnails, preview.txt, preview.json) and binary output with version
  history.
- **Ads intelligence** (`packages/ads-intelligence`, `/api/ads/*`):
  AdAccount/CampaignEntity/AdvertisingDecision/CreativeAsset, a strict
  decision state machine (proposed → approved → executed → observing →
  successful|failed|reverted, plus rejection to failed), duplicate-proposal
  suppression, deterministic DailyBrief rules, and the Python UAC engine via
  a JSON stdio bridge (honest unavailable/failed errors, never faked).
- **Workflows** (`packages/workflows`, `/api/workflows/*`): record-and-replay
  — draft workflows from Computer Action records (no fabricated anchors),
  publish/edit, fail-closed runner with pause/resume, mutation approval
  gating, idempotent resume, publish as a Skill.
- **Automations** (`packages/automations`, `/api/automations/*`):
  controlled cron subset (UTC, Vixie OR, 0=7), idempotency buckets, daily
  run/cost caps, approval-gated mutation actions, run logs, notifications.
  The server ticks the scheduler every 30s (`automationTickMs` option).

## Desktop

App rail: Home / Chat / Projects / Automations / Skills (+ plugins,
settings). The session Sidebar only exists in the chat view.

- **Home** — greeting, quick input, active projects, pending approvals,
  recent artifacts, running/queued tasks, and (when ad accounts exist) the
  Daily Brief panel.
- **Projects** — creation dialog, guarded archival.
- **Project workbench** — goals/files/artifacts rail, task timeline, and a
  right panel with Terminal, Git, and artifact Preview. Advertising projects
  additionally get the decision Action Queue above the timeline.

## Verify

```bash
pnpm verify                 # format→lint→typecheck→tests→security→computer→
                            # permissions→ads-core→build→package→smoke
cd apps/desktop && pnpm test   # 122 desktop tests
```

Useful slices: `npx vitest run packages/kernel packages/git-tools
packages/artifacts packages/ads-intelligence packages/workflows
packages/automations packages/server`

## Build & install

```bash
pnpm package:mac            # build + dmg + package smoke (ad-hoc signed)
rm -rf /Applications/AdPilot.app && cp -R release/mac-arm64/AdPilot.app /Applications/
```

## Ads read-only / mutation verification

- Read-only chain (API-level): create accounts/campaigns/decisions via
  `/api/ads/*`, generate a brief via `POST /api/ads/daily-brief`, run the
  Python engine via `POST /api/ads/uac/analyze`.
- Real Google Ads runs remain gated: `pnpm test:computer:google-ads-readonly|
  prepare|mutation` require a user-named test account/profile and currently
  report `blocked-by-no-test-account`. Mock/fixture evidence is never
  reported as live validation.
