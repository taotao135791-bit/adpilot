# Rebuild progress

Last updated: 2026-07-27

## Active

- [x] Read the complete rebuild brief.
- [x] Audit tracked repository structure and core source paths.
- [x] Run frozen install, TypeScript, 515 product tests, 410 advertising-core tests, build, Electron launch, browser capture, `.app` packaging, and codesign verification.
- [x] Inspect the real native macOS window and traffic lights.
- [x] Create the rebuild architecture and acceptance documents.
- [ ] Implement the durable Session Service and single-writer boundary.
- [ ] Implement the authenticated native helper and Permission Center foundation.
- [ ] Implement the curated plugin runtime foundation.
- [x] Repair the mutation false-success path with execution provenance, a one-attempt allowlist, and fail-closed approval completion.
- [ ] Add deterministic exact-value reread after a mutation.
- [ ] Repair the live Google Ads validation harness.

## Direct baseline results

```text
pnpm install --frozen-lockfile   pass
pnpm typecheck                   pass
pnpm test                        pass (46 files, 515 tests)
pnpm test:ads-core               pass (410 tests)
pnpm build                       pass
pnpm desktop:dir                 pass
codesign --verify --deep --strict release/mac-arm64/AdPilot.app
                                 pass (ad-hoc integrity only)
focused mutation safety tests    pass (3 files, 48 tests)
live model evaluation            not-run
real Google Ads validation       not-run
```

## Current working batch

1. Add isolated, tested Session/Plugin/Native Helper foundations.
2. Add exact post-mutation value verification.
3. Integrate Session as the daemon/API/UI authority.

No test, live action, or real-account result is recorded as passing unless it ran in this rebuild.
