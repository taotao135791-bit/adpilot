# Known issues

Last updated: 2026-07-28

## P0

- Computer Use has no shipped native helper or Permission Center. (Swift helper sources and host protocol landed in `native/macos-helper` + `packages/native-computer-host`; build wiring and Permission Center UI remain.)
- Computer Use state and browser binding are global rather than session/task scoped.
- Live View contains no live screenshot pixels.
- `pnpm dev` serves API routes but a 404 renderer root from source mode.

## P1

- Renderer privileged controls use unauthenticated loopback HTTP rather than a narrow preload bridge.
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

## Resolved this cycle

- ~~No single daemon/single-writer boundary~~ — composition-root writer lease with fail-loud contention (`f150a97`).
- ~~Session is not a first-class product entity~~ — session-service integrated (migration, REST, model binding, status SSE) plus real desktop session UI (`f150a97`, `c256ebc`).
- ~~Curated plugins and their lifecycle/security runtime do not exist~~ — plugin runtime integrated with signature/integrity gates and desktop catalog page (`5079a4c`, `cdf586b`).

## External or environment-dependent

- Live model evaluation requires an intentionally supplied image-capable credential or local model.
- Real Google Ads validation requires a user-owned, logged-in, allowlisted managed browser and OS permissions.
- Developer ID signing and notarization require credentials and authority not present in the repository.
- OTP, CAPTCHA, passwords, account recovery, and final authentication remain user takeover actions.
