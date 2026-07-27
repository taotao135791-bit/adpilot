# Current state audit

Status: living audit  
Baseline: `807f59c` (`main`, 2026-07-27)  
Scope: tracked product code, desktop shell, runtime, persistence, Computer Use, plugins, advertising core, tests, packaging, and current local artifacts.

## Directly observed baseline

| Check | Result | Evidence boundary |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | pass | 19 workspace projects, lockfile unchanged |
| `pnpm typecheck` | pass | Current `tsconfig.json` excludes `scripts/**`, native code, and most eval harness code |
| `pnpm test` | pass: 46 files / 515 tests | Unit, integration, replay, and local mock coverage; not a live advertising account result |
| `pnpm test:ads-core` | pass: 410 tests | Retained deterministic UAC Python contracts |
| `pnpm build` | pass | CLI, web renderer, and Electron main bundle |
| `pnpm desktop:dir` | pass | ARM64 `.app` created and ad-hoc signed |
| `codesign --verify --deep --strict` | pass | Bundle integrity only; no Developer ID or notarization |
| Browser UI capture | pass through built CLI | Current source-mode `pnpm dev` serves API but returns 404 for `/` |
| Native Electron launch | pass | Real macOS traffic lights inspected; expanded sidebar currently leaves room |
| Live model evaluation | not run | No release credential was supplied |
| Real Google Ads validation | not run | No authenticated, allowlisted account was used |
| Real advertising mutation | not run | No claim of success is permitted |

## What is real today

- Pi is the only planning/conversation loop.
- Pi session entries are persisted per `clientId + conversationId`, and completed history can be projected back into model context.
- Runtime locks isolate concurrent calls only inside one `PiAgentRuntime` process.
- Deterministic advertising guardrails, approval fingerprints, one-use tokens, evidence lifecycle rules, specialist fact binding, and the hash-chain audit have substantive tests.
- Browser sessions persist a client/Profile/PID/window binding.
- The Electron renderer runs sandboxed with context isolation and no Node integration.
- The desktop can render conversation messages, approval cards, task state, model settings, browser session metadata, and Computer Use event metadata.
- The retained advertising core and its 410 Python contract tests pass.

## P0 findings

### Session and state ownership

- Session is not a product entity. The product schema only has `ConversationMessage`; `/api/state` derives a list of conversation strings from `conversation.jsonl`.
- “New conversation” exists only in renderer state until the first message.
- There is no title, rename, pin, search, filter, archive, trash/restore, duplicate, parent/branch metadata, per-session model, per-session permission profile, cost, or independent Computer Use binding.
- Task, approval, Computer Use, and SSE event state are client-global and can appear in the wrong conversation.
- A global `submitting` flag prevents useful multi-session work. An older request can complete after the user switches conversations and overwrite the newly selected UI state.
- Recovery checkpoints are written but never read. They document a crash; they do not resume it.
- Fork currently reuses copied Pi entry IDs and human transcript message IDs, so those IDs are not globally unique.
- Session and audit locks are process-local. Two AdPilot runtimes writing the same workspace can fork the audit chain or lose a session branch.
- Electron recreates a full system/server on a later app activation after the window closed without first closing the old server. CLI commands also create independent systems instead of acting as clients of one daemon.

### Desktop and permissions

- Expanded sidebar traffic-light spacing is currently visible, but collapsed mode removes the safe inset and can place its menu control in the native traffic-light region.
- There is no permanent native titlebar-safe row and no real Electron visual regression suite.
- There is no preload or narrow privileged IPC bridge.
- There is no Permission Center, first-run permission onboarding, permission status model, recheck/test flow, or programmatic System Settings navigation.
- Runtime `permission` in public model status is a hard-coded advertising permission label, not macOS TCC state.
- API/provider credentials are private files with mode `0600`; they are not stored in Keychain/Credential Manager/Secret Service.

### Computer Use

- The “native helper” is not a shipped helper. TypeScript invokes `/usr/bin/swift -e`, `/usr/sbin/screencapture`, AppleScript fallback, and an in-process nut.js addon.
- A release machine may not have the Swift toolchain. There is no helper identity, protocol version, authenticated channel, crash isolation, or capability lease.
- Pause/takeover is a singleton flag checked too coarsely. A pause during asynchronous grounding can still be followed by input.
- Computer Use is not session-scoped and does not have a durable per-task actor.
- Live View renders text and an icon, not screenshot pixels, overlays, cursor, or replay history.
- Baseline finding: a grounded `done` action could return a successful visual result without executing or independently verifying a mutation. Rebuild checkpoint 1 repairs this with native-execution provenance, an independent-verification flag, a one-attempt action allowlist without `done`, Runtime rejection, and approval-layer rejection.
- Baseline finding: mutation success was a model boolean against free-text `expectedResult`. Rebuild checkpoint 2 now requires two independent post-action rereads, exact typed equality with the approved value, screenshot/region evidence hashes, and a verified Shared Fact before experiment start.
- The logged-in Google Ads validation script reads event history without the required `clientId`, then assumes a redacted event still contains screenshot bytes. The current empty event list masks the mismatch.

### Plugin system

- No curated registry, manifest runtime, download/install/update/disable/uninstall flow, integrity/signature verification, permission diff, isolation, migration, logs, or Plugins UI/API exists.
- User markdown skills/prompts are advisory content discovery, not an installable plugin system.

### Developer and release workflow

- Required commands such as `setup`, `dev:desktop`, `dev:daemon`, `test:e2e`, `test:security`, `test:computer`, `test:plugins`, `verify`, and `package:mac` are absent.
- `pnpm dev` resolves the renderer path relative to source (`apps/cli/desktop`) and serves a 404 root page.
- `scripts/**` is outside TypeScript checking, which hid a broken live validation harness.
- Existing release/test documentation contains old version numbers, test counts, and artifacts and cannot be treated as current evidence.

## Non-negotiable code to preserve

- Pi as the sole agent loop.
- Verified facts and evidence lifecycle.
- Deterministic measurement/maturity/learning guardrails.
- Independent risk review, user approval, one-use execution token, and audit chain.
- Specialist boundaries and typed advertising skills.
- Browser/Profile/account/Campaign identity binding and fail-closed mutation policy.
- Retained advertising-core contracts and experiment single-variable rules.

## Immediate rebuild order

1. Establish one daemon/state owner and a durable Session Service.
2. Move every run, task, approval, event, model binding, permission profile, and Computer Use task under a session ID.
3. Ship a versioned native helper and Permission Center; remove `swift -e` from production.
4. Make Computer Use an abortable per-session actor with real Live View and exact post-change verification.
5. Add a curated, verified, isolated plugin runtime.
6. Recompose the desktop into Session sidebar, Agent workspace, Inspector, and mature settings pages.
7. Expand verification to scripts/native code, real Electron E2E, packaging smoke tests, live model eval, and explicitly user-provided real-account validation.
