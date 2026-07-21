# Evaluation entrypoint

Product regression tests live in `packages/**/src/*.test.ts` and `tests/visual/`. Migrated advertising fixtures and replay assets live with the deterministic core:

- `packages/advertising-core/evals/creative-evals.json`
- `packages/advertising-core/python/tests/fixtures/`
- `packages/advertising-core/python/examples/replays/`

Run all TypeScript integration/visual evaluations with `pnpm test` and the retained UAC/replay suite with `pnpm test:ads-core`.
