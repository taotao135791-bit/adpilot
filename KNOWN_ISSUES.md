# Known issues

Last updated: 2026-07-29

## Blocked (external prerequisites)

- Real Google Ads Stage A/B/C: `blocked-by-no-test-account` — needs a
  user-named test account, managed logged-in profile, and (for mutations) a
  separate approval. Reports land in `artifacts/evals/google-ads/`.
- Live-model planning E2E: `blocked-by-missing-credentials` — no chat
  provider credential is configured on this machine.
- Live visual model evaluation: `not-run` (`LIVE_MODEL_NOT_CONFIGURED`).
- Developer ID signing and notarization require credentials not in the repo.

## P1

- Renderer privileged controls use unauthenticated loopback HTTP rather than
  a narrow preload bridge; desktop-native routes are cookie-gated per
  instance instead.
- Credentials are private files, not OS credential stores.
- Swift/native code is outside the root TypeScript gate.
- API/RPC is unversioned and front-end wire types are handwritten.
- Workflow recorded-step anchors stay empty (Computer Action records carry
  no OCR/element text); recorded double/right clicks replay as plain clicks.
- The automation `event` trigger is modeled but not fired by any bus.
- Session `waiting_approval`/`paused` lifecycle is implemented for
  automation runs and computer control; conversational run lifecycle
  (paused/resumed chat runs) is still simplified.
- A handful of real-process/real-server tests are load-sensitive under the
  full parallel suite; the known offenders carry explicit 60–90s timeouts
  and vitest is capped at 4 workers.
- `pnpm dev` serves API routes but a 404 renderer root from source mode.

## Resolved

- ~~Project missions degenerated into plain chat~~ — project-bound sessions,
  mission heuristic, and a real project chat in ProjectView.
- ~~0.3 modules were REST-only~~ — 57 registry tools with a unified
  lifecycle, bound into the live composition root.
- ~~Automation approvals accepted fabricated approvalIds~~ — server-minted
  central approvals with one-time tokens, stale/forgery/replay rejection.
- ~~Workflow had no production executor~~ — resolves the connected managed
  browser session as its surface provider, fail-closed otherwise.
- ~~Python UAC was dev-only~~ — ships in the DMG with production path
  resolution and package smoke.
- ~~Slides renderer crashed under tsx/esbuild~~ — constructor unwrap handles
  the `__esModule` facade.

## External or environment-dependent

- OTP, CAPTCHA, passwords, account recovery, and final authentication remain
  user takeover actions.
