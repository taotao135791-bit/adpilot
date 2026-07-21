# Test report

Run date: 2026-07-21. Environment: macOS arm64, Node 24.13.1 (product minimum Node 22), pnpm 10.30.3, Python 3.13.

## Product suite

Command: `pnpm typecheck && pnpm test`

- TypeScript strict typecheck: passed.
- Vitest: 15 files, 39 tests, all passed.
- Coverage includes action schema/policy, visual retries/timeouts/cancel, Pi code-model screenshot grounding and verification, first-launch Workspace creation, persistent natural-language conversation, workspace isolation, audit redaction/hash chain, approval binding/expiry/caps, experiments, model routing, private settings and OAuth persistence, Skills, Pi runtime tool calls, specialist isolation, main-Agent approval creation, server token handling and local visual execution.

## Advertising-core suite

Command: `pnpm test:ads-core`

- Pytest: 410 tests passed.
- Covers UAC behavior, doctor, CLI, schema migration, normalization, numeric policy, policy overrides, Quick Ops, replay, safety edges, signal derivation, terminology and workspace boundaries.

## Build and runtime

Command: `pnpm build`

- Strict typecheck: passed.
- CLI ESM bundle: passed.
- React production bundle: passed.
- Electron ESM main-process bundle: passed.
- Post-build executable permission: verified as `-rwxr-xr-x`.

Smoke checks:

- `adpilot init` created a private client Workspace and all four YAML control files.
- `adpilot doctor` read the installed Workspace and model routing state.
- A clean-prefix global npm install produced a working `adpilot` executable; `adpilot providers` returned all 36 Pi providers.
- `adpilot serve` launched from `/tmp`, proving the compiled CLI resolves its sibling UI without relying on repository CWD.
- `/api/health`, `/api/about`, `/api/state` and `/` returned successfully.
- `node scripts/verify-upstreams.mjs` matched both reviewed git pins.
- A real headless Chrome session loaded the production UI and captured `docs/screenshots/adpilot-console.png`.
- Bilingual settings smoke tests passed: Chinese and English shells contained only their selected interface language, all 36 Pi providers were selectable, OAuth controls rendered for OAuth providers, settings survived a process restart, and the 1440×1000 viewport had no horizontal overflow.
- A real browser completed the primary chat flow against Pi's deterministic faux provider: automatic personal Workspace, user message, assistant response, persisted two-sided history, and reload through `/api/state`.
- First-launch onboarding opened the model tab directly from “Configure model”; the Computer Use panel contained no separate VLM fields and reported the selected code model for screenshot grounding and verification.
- Responsive UI checks passed at 1440×1000 and 390×844 with no horizontal overflow; the mobile command surface remains reachable above the fixed navigation.
- The Electron development shell started the same local API on a random loopback port with sandboxing, context isolation and navigation restrictions enabled.
- `pnpm desktop:dir` produced a runnable arm64 `AdPilot.app`; its packaged API, HTML, JavaScript and CSS assets all returned successfully.
- `pnpm desktop:dmg` produced `AdPilot-0.1.0-arm64.dmg`; `hdiutil verify` passed and the mounted image contained `AdPilot.app` plus the `/Applications` install link.

## Upstream audit baseline

Before integration, reviewed upstream suites passed at their pinned revisions: the advertising-policy source reported 650 passed / 6 skipped; targeted UI-TARS parser/SDK/operator suites reported 80 passing tests; reviewed Pi agent/runtime/session/provider suites passed. AdPilot's retained tests are the ongoing compatibility gate.
