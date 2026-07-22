# Evaluation entrypoint

Product regression tests live in `packages/**/src/*.test.ts` and `tests/visual/`. Migrated advertising fixtures and replay assets live with the deterministic core:

- `packages/advertising-core/evals/creative-evals.json`
- `packages/advertising-core/python/tests/fixtures/`
- `packages/advertising-core/python/examples/replays/`

Run all TypeScript integration/visual evaluations with `pnpm test` and the retained UAC/replay suite with `pnpm test:ads-core`.

The sanitized visual corpus contains 60 tasks across 12 Google Ads-style scenes, five viewport/DPR/theme/language variants, and three manifests:

- `gui-grounding/cases.json`
- `gui-verification/cases.json`
- `computer-use-replay/cases.json`

Regenerate and verify them with `pnpm fixtures:visual && pnpm test:visual-replay`. `pnpm eval:gui` calculates grounding, action, completion, false-click, unsafe-action, retry, escalation, token, latency, and verification metrics. Without a recorded prediction file it reports all three live model routes as `not-run`; fixture-oracle coverage is not presented as a model score.
