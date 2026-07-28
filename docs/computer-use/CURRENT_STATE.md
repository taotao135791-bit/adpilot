# Computer Use current state

Last verified: 2026-07-28

This document records observed product behavior. It is not a statement of intended
architecture and it does not treat fixture or replay coverage as a live result.

## Baseline

| Check | Result | Evidence / limitation |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | passed | Existing lockfile resolved without changes. |
| `pnpm typecheck` | passed | Root TypeScript project completed before this P0 batch. |
| `pnpm lint` | failed to start | The root package had no `lint` script. |
| `pnpm test` | running at audit start | The prior report listed 631 tests; this batch records its own final count. |
| Native Swift sources | present | `native/macos-helper`, protocol v2, permissions/window/capture/basic input. |
| Native helper in root build | missing at audit start | `build-native-helper.sh` was not called by `pnpm build`. |
| Native helper in `.app` | missing at audit start | No stable `extraResources` entry or packaged path resolver. |
| Product execution path | unsafe/incomplete at audit start | `createAdPilotSystem` instantiated `UiTarsNativeOperator`; the Swift helper was not the product operator. |
| Screen Recording detection | helper-only at audit start | No product Permission Center path to the helper. |
| Accessibility detection | helper-only at audit start | No product Permission Center path to the helper. |
| Live pixels in GUI | missing at audit start | Public runtime events intentionally removed image bytes and the card showed metadata only. |
| Pause / Take Over | partial at audit start | Server endpoints toggled a global runtime pause flag; there was no session ownership or input-queue cancellation contract. |
| Browser binding | partial | PID, native profile fingerprint, window and application checks exist, but were not represented as a session-scoped Computer Runtime lease. |
| Mutation verification | partial but fail-closed | Approval binding and exact-value reread exist; image change is not accepted as final advertising proof. |
| Real Google Ads readonly run | not-run | No user-supplied logged-in managed profile/test account was available in the repository. |
| Real Google Ads prepare run | not-run | Requires an explicitly selected account/campaign and a managed logged-in profile. |
| Real Google Ads mutation | not-run | Requires a separate, explicit approval for a named low-risk test entity. |

## Root causes

1. The native implementation and the product runtime were separate foundations with
   no composition-root connection.
2. The packaged application had no stable helper resource path, signing relationship,
   usage-description plist entries, or helper smoke test.
3. Renderer controls were backed by broad, global runtime state and did not carry a
   Computer Session identifier or generation.
4. Screenshot bytes were deliberately stripped from public events for privacy, but no
   separate bounded local-only Live View channel replaced them.
5. The existing live-evaluation harness correctly distinguished fixture, provider and
   real-browser evidence, but the standard P0 command surface was absent.
6. Permission ownership was not explained in-product: a development shell, Electron,
   a packaged app, and a child helper can appear as different TCC principals.

## Acceptance rule

A row is marked passed only after its command or manual check runs on the current
source revision. Environment-dependent checks remain `blocked-*` or `not-run`; they
are never inferred from unit tests.

