# Known issues

Last updated: 2026-07-28

## P0

- Real Google Ads Stage A/B/C runs remain `blocked-by-no-test-account`: the harness requires a user-named client, test account, browser profile, and campaign, and never auto-selects a production target. Structured reports land in `artifacts/evals/google-ads/`.
- Live model evaluation remains `not-run` (`LIVE_MODEL_NOT_CONFIGURED`): no live visual provider credential is configured on this machine.
- `pnpm dev` serves API routes but a 404 renderer root from source mode.

## P1

- Renderer privileged controls use unauthenticated loopback HTTP rather than a narrow preload bridge; desktop-native routes are cookie-gated per instance instead.
- Credentials are private files, not OS credential stores.
- Swift/native code is outside the root TypeScript gate; `scripts/**/*.ts` is now included.
- Desktop component tests are not included in the root Vitest run.
- API/RPC is unversioned and front-end wire types are handwritten.
- Existing docs and `/api/about` contain stale 0.1.1 release metadata.
- Real-browser validation PNGs are private, ignored, and hash-checked, but do not yet have automatic expiry cleanup.
- Audit hash chaining is not protected against an actor able to rewrite and recompute the entire local file.
- Approval storage lacks a cross-process CAS/lease boundary.
- The full Python UAC engine is tested offline but not packaged or called by the product.
- Session `waiting_approval`/`paused` lifecycle and per-session usage/cost accounting are not wired yet; daemon restart resets `running` sessions to `failed` without a review queue.
- Plugin mutable tools remain gated off pending a bridge into the approval pipeline; per-plugin storage broker and update rollback UI are not implemented.
- A handful of real-process/real-server tests are load-sensitive under the full parallel suite; the known offenders now carry explicit 60–90s timeouts.

## Resolved this cycle

- ~~No single daemon/single-writer boundary~~ — composition-root writer lease with fail-loud contention (`f150a97`).
- ~~Session is not a first-class product entity~~ — session-service integrated (migration, REST, model binding, status SSE) plus real desktop session UI (`f150a97`, `c256ebc`).
- ~~Curated plugins and their lifecycle/security runtime do not exist~~ — plugin runtime integrated with signature/integrity gates and desktop catalog page (`5079a4c`, `cdf586b`).
- ~~Computer Use has no shipped native helper or Permission Center~~ — authenticated Swift Helper (`com.adpilot.computer-helper`, protocol v3) is built, signed ad-hoc, staged as a nested app, and driven by `NativeHelperOperator`; Permission Center is live in Settings with real Helper state, request flow, settings links, and permission tests.
- ~~Computer Use state and browser binding are global~~ — Product+Browser session-scoped bindings, per-session control state, durable Computer Action records, and restart-safe mutation replay claims.
- ~~Live View contains no live screenshot pixels~~ — authenticated `/api/desktop-native/live-frame` returns real bound-window JPEG previews (cursor + page identity included), rendered with grounding overlay in the Computer Use card; proven end to end by `scripts/live-view-e2e.ts` on real hardware.

## External or environment-dependent

- Live model evaluation requires an intentionally supplied image-capable credential or local model.
- Real Google Ads validation requires a user-owned, logged-in, allowlisted managed browser and OS permissions.
- Developer ID signing and notarization require credentials and authority not present in the repository.
- OTP, CAPTCHA, passwords, account recovery, and final authentication remain user takeover actions.
