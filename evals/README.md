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

Regenerate and verify them with `pnpm fixtures:visual && pnpm test:visual-replay`.

`pnpm eval:gui` evaluates an optional recorded prediction file. It never presents fixture-oracle coverage as a model score.

`pnpm eval:computer-use:live` calls the product `GroundingModel` and `VisualVerifier` interfaces directly and compares the built-in GUI route, Fast vision, Deep vision, and GUI verification. It produces four deliberately separate report sections:

- Corpus Validation
- Offline Prediction Eval
- Live Model Eval
- Real Browser Validation

With no usable visual provider credential or dedicated endpoint, Live Model Eval is `not-run`; scores are never synthesized. Use `ADPILOT_EVAL_LIMIT` to cap paid calls. A real-browser result is included only when `ADPILOT_REAL_BROWSER_REPORT` points to an actual validation manifest.
