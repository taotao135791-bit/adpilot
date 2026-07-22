# Evaluation entrypoint

Product regression tests live in `packages/**/src/*.test.ts` and `tests/visual/`. Migrated advertising fixtures and replay assets live with the deterministic core:

- `packages/advertising-core/evals/creative-evals.json`
- `packages/advertising-core/python/tests/fixtures/`
- `packages/advertising-core/python/examples/replays/`

Run all TypeScript integration/visual evaluations with `pnpm test` and the retained UAC/replay suite with `pnpm test:ads-core`.

The sanitized visual corpus contains 85 tasks across 17 Google Ads-style scenes, five viewport/DPR/theme/language variants, and three manifests. It includes horizontal and vertical table scrolling, profile changes, truncated identities, and obscured critical regions:

- `gui-grounding/cases.json`
- `gui-verification/cases.json`
- `computer-use-replay/cases.json`

The live suite also carries two independent, human-authored specialist oracles:

- `computer-use-live/table-cases.json` — 50 exact row/column/raw/normalized/unit/qualifier cell expectations
- `computer-use-live/identity-cases.json` — positive identity confirmations plus truncated and obscured safe-blocker expectations

Regenerate and verify them with `pnpm fixtures:visual && pnpm test:visual-replay`.

`pnpm eval:gui` evaluates an optional recorded prediction file. It never presents fixture-oracle coverage as a model score.

`pnpm eval:computer-use:live` calls the product `GroundingModel`, `VisualVerifier`, `VisualTableReader`, and `DualVisualIdentityVerifier` interfaces directly. Table Cell Accuracy is emitted only by verified table cells; account and campaign identity accuracy are emitted only by the dual identity gate. Grounding and corpus validation never populate those specialist scores. The command produces four deliberately separate report sections:

- Corpus Validation
- Offline Prediction Eval
- Live Model Eval
- Real Browser Validation

With no usable visual provider credential or dedicated endpoint, Live Model Eval is `not-run`; scores are never synthesized. Use `ADPILOT_EVAL_LIMIT` to cap paid calls. A real-browser result is included only when `ADPILOT_REAL_BROWSER_REPORT` points to an actual validation manifest.
