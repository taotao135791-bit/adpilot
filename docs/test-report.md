# Test and release verification report

Status: release-candidate verification complete. Date: 2026-07-22.

This document deliberately separates deterministic/offline evidence from calls that need external credentials or a real logged-in browser. It was updated from the final command output immediately before publishing. No `PENDING_FINAL_VERIFICATION` field below carries a remembered result, a fixture result, or a result from a different machine.

## Final release gate

Run from a clean checkout after `pnpm install --frozen-lockfile`:

```bash
pnpm check
pnpm fixtures:visual
pnpm test:visual-replay
pnpm eval:gui
pnpm eval:computer-use:live
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm desktop:dmg
hdiutil verify release/<actual-dmg-name>.dmg
shasum -a 256 release/<actual-dmg-name>.dmg
```

| Gate | Scope | Final result |
| --- | --- | --- |
| `pnpm typecheck` | strict TypeScript contracts, including approval/guardrail, server and desktop state types | pass, 0 errors |
| `pnpm test` | product unit/integration tests and mock/local visual product tests | pass, 27 files / 275 tests |
| `pnpm test:ads-core` | retained deterministic UAC Python contract and replay suite | pass, 410 tests |
| `pnpm build` | CLI, React desktop and Electron main-process bundles | pass |
| `pnpm check` | aggregate of the four gates above | pass |
| `pnpm test:visual-replay` | sanitized fixture replay mechanics and annotations | pass, 86 tests (included in the 275 above) |
| `pnpm eval:gui` | optional recorded-prediction comparison; not a live model call | `not-run` — no recorded predictions supplied; no score fabricated |
| `pnpm eval:computer-use:live` | assembled product visual interfaces, only when credentials exist | `not-run` — no usable image-capable credential; report at `artifacts/evals/computer-use-live-report.json` |
| `pnpm desktop:dmg` | certificate-free ad-hoc signed macOS ARM64 DMG with legal notices packaged | pass, `release/AdPilot-0.1.1-arm64.dmg` |
| `hdiutil verify` + SHA-256 | actual final DMG integrity | `VALID`; SHA-256 `2ea1ddbedd8541c3d1f5d1b3f8ad2ec401fd977101b6b3228ffe7e09a9b576d0` |

Final test count: 685 (275 vitest across 27 files, including 86 visual-replay cases, plus 410 pytest).

Final DMG filename: `AdPilot-0.1.1-arm64.dmg`.

Final DMG bytes: 144,693,653.

Final DMG SHA-256: `2ea1ddbedd8541c3d1f5d1b3f8ad2ec401fd977101b6b3228ffe7e09a9b576d0`.

## What the offline and mock suites establish

- TypeScript and product tests exercise deterministic approval state, exact-plan fingerprints, one-attempt tokens, screenshot fact isolation, guardrail evidence validation, server client isolation, runtime pause/resume/cancel state and desktop disclosure rendering.
- The UAC Python suite validates the retained deterministic advertising-core contracts. It makes no advertising-platform API call.
- Visual replay uses sanitized fixtures and deterministic or faux-model responses. It checks coordinate/action protocol, policy and expected blocking paths. It does **not** measure a remote model's live quality and does **not** operate a real account.
- `eval:gui` consumes an optional local recorded-prediction file. Its coverage/oracle results cannot be reported as live grounding, table-reading or identity accuracy.

## Live Model Eval

`pnpm eval:computer-use:live` invokes the product `GroundingModel`, `VisualVerifier`, `VisualTableReader` and `DualVisualIdentityVerifier` interfaces against the committed corpus. Its report keeps Corpus Validation, Offline Prediction Eval, Live Model Eval and Real Browser Validation as separate sections.

Without a configured authenticated image-capable model or an explicitly configured advanced visual endpoint, the only correct result is `not-run`. No score is synthesized from fixture annotations, a faux Pi provider, or a UI test. `ADPILOT_EVAL_LIMIT` caps paid calls; credentials and customer screenshots are not written into this report.

Live Model Eval result for this release candidate: `not-run` (no release credential was intentionally supplied; Corpus Validation section `passed`).

## Logged-in-browser harness boundary

The two commands below are production-native validation harnesses, not mock tests and not mutation submission flows:

```bash
pnpm validate:google-ads:readonly -- --client <id> --browser-profile <profile> --campaign "Campaign name"
pnpm validate:google-ads:prepare -- --client <id> --browser-profile <profile> --campaign "Campaign name" --draft-budget 120
```

They require a user-owned, AdPilot-managed browser Profile, an allowlisted client, a manually logged-in foreground account, Screen Recording and Accessibility permission. The readonly harness observes only. The prepare harness requires the user to open and focus the draft field and permits at most one `type` action without Enter, followed by read-only confirmation; it rejects click, hotkey, submit/save controls and retries. It neither logs in nor submits an advertising-platform change.

Real Browser Validation result for this release candidate: `not-run` (no actual local artifact manifest was attached at release time).

## Packaging evidence

The desktop build deliberately uses `CSC_IDENTITY_AUTO_DISCOVERY=false` and macOS `identity: "-"`. The bundled `.app` is ad-hoc signed without a certificate so `codesign` can verify bundle integrity; it has no Developer ID or Team ID and is not notarized. `LICENSE`, `LICENSES.md`, `THIRD_PARTY_NOTICES.md` and `licenses/**` are release inputs and must be checked in the built application/DMG, not merely in the repository. Gatekeeper rejection or an explicit Open requirement is an expected distribution consequence, not a failed integrity check.

Release artefact inspection result: `codesign --verify --deep --strict release/mac-arm64/AdPilot.app` passed (ad-hoc identity `-`, no Developer ID/Team ID, not notarized); `hdiutil verify` reported `VALID`; packaged legal notices confirmed inside `app.asar`: `/LICENSE`, `/LICENSES.md`, `/THIRD_PARTY_NOTICES.md`, `/licenses/codex-ads-MIT.txt`, `/licenses/pi-MIT.txt`, `/licenses/ui-tars-Apache-2.0.txt`.
