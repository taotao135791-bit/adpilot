# Known issues

Last updated: 2026-07-27

## P0

- No single daemon/single-writer boundary; multiple runtimes can corrupt session branch selection and audit integrity.
- Session is not yet a first-class product entity and has no metadata/lifecycle/per-session model or permission state.
- Computer Use has no shipped native helper or Permission Center.
- Computer Use state and browser binding are global rather than session/task scoped.
- Live View contains no live screenshot pixels.
- Curated plugins and their lifecycle/security runtime do not exist.
- `pnpm dev` serves API routes but a 404 renderer root from source mode.

## P1

- Renderer privileged controls use unauthenticated loopback HTTP rather than a narrow preload bridge.
- Credentials are private files, not OS credential stores.
- Swift/native code and unreferenced eval code are outside the root TypeScript gate; `scripts/**/*.ts` is now included.
- Desktop component tests are not included in the root Vitest run.
- API/RPC is unversioned and front-end wire types are handwritten.
- Existing docs and `/api/about` contain stale 0.1.1 release metadata.
- Real-browser validation PNGs are private, ignored, and hash-checked, but do not yet have automatic expiry cleanup.
- Audit hash chaining is not protected against an actor able to rewrite and recompute the entire local file.
- Approval storage lacks a cross-process CAS/lease boundary.
- The full Python UAC engine is tested offline but not packaged or called by the product.

## External or environment-dependent

- Live model evaluation requires an intentionally supplied image-capable credential or local model.
- Real Google Ads validation requires a user-owned, logged-in, allowlisted managed browser and OS permissions.
- Developer ID signing and notarization require credentials and authority not present in the repository.
- OTP, CAPTCHA, passwords, account recovery, and final authentication remain user takeover actions.
