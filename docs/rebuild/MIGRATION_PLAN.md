# Migration plan

Status: living implementation sequence

Each stage must compile, test, capture/inspect its UI where applicable, update `PROGRESS.md` and `ACCEPTANCE_MATRIX.md`, and produce a reviewable commit.

## Stage 0 — truthful baseline

- [x] Run install, TypeScript, product tests, Python contracts, build, app packaging, and real Electron inspection.
- [x] Record live model and real browser work as `not-run`.
- [x] Identify the source-mode dev-server 404.
- [ ] Repair the broken Google Ads validation harness before it is used again.

## Stage 1 — single writer and Session Service

- Add canonical Session/Project/model/permission schemas and migration records.
- Add durable Session CRUD, search, archive, trash/restore, duplicate, branch provenance, usage, and optimistic revisions.
- Add workspace writer lease and daemon lifecycle.
- Convert Electron and CLI into clients of one system.
- Add per-session actor, immutable run context, model binding, and recovery reconcile.
- Keep Pi JSONL as model context and migrate legacy conversation mappings without loss.

Rollback: existing Pi files and transcript remain untouched; the new metadata index can be rebuilt from migration records.

## Stage 2 — desktop Agent workbench

- Use server-created Sessions and session-scoped state/events.
- Eliminate stale request overwrites and global submitting.
- Rebuild navigation, main workspace, composer, Inspector, routes, and session operations.
- Add stable macOS titlebar-safe layout and real Electron screenshots.

Rollback: preserve compatibility API while the new `/api/v1` route is introduced.

## Stage 3 — native helper and Permission Center

- Ship/version/authenticate the Swift helper.
- Add TCC status/request/recheck/test and System Settings deep links.
- Add preload bridge and narrow privileged IPC.
- Make readiness depend on real permission/helper health.

Rollback: legacy `swift -e` path remains test-only during transition and is not selected in packaged production.

## Stage 4 — Computer Use actor and Live View

- Session/task-scoped actor, abortable boundaries, pause/stop/step/takeover/give-back.
- Screenshot frames, overlay, cursor, identity, and replay.
- Remove `done` as mutation success.
- Add exact post-change value reread and typed equality verification.
- Repair live harness and run explicit offline/live/real-browser layers.

## Stage 5 — curated plugins

- Registry, verified bundle format, transactional lifecycle, permission diff, isolated supervisor, logs, and migrations.
- Ship one signed read-only plugin and exercise it end to end.
- Add Plugins catalog/details/installed/update/review UI.

## Stage 6 — models, credentials, and advertising integration

- Role-level and session-level bindings, connection tests, fallback, health, context/cost capability display.
- Move secrets to OS credential stores.
- Preserve deterministic advertising authority while exposing core operations as natural Session tools/cards.
- Integrate retained Python UAC capability through a packaged, typed boundary or remove unsupported runtime claims.

## Stage 7 — verification and release

- Required unified commands and CI lanes.
- Script/native/helper type and build checks.
- Session/security/plugin/computer/Electron E2E.
- App restart/recovery, permissions matrix, multi-display/Retina/modes.
- Package smoke, actual artifact hash, signing status, and honest known limits.
- Live model and Google Ads results only when the user supplies the required environment and account access.

