# Rebuild progress

Last updated: 2026-07-28

## Active

- [x] Read the complete rebuild brief.
- [x] Audit tracked repository structure and core source paths.
- [x] Run frozen install, TypeScript, 515 product tests, 410 advertising-core tests, build, Electron launch, browser capture, `.app` packaging, and codesign verification.
- [x] Inspect the real native macOS window and traffic lights.
- [x] Create the rebuild architecture and acceptance documents.
- [x] Keep one Electron Runtime/Server alive across macOS window close and Dock reactivation.
- [x] Move the collapsed native sidebar control below the macOS traffic-light zone.
- [x] Implement the durable Session Service and single-writer boundary. — integrated as backend authority (`f150a97`): composition-root lease, idempotent legacy migration, 11 REST endpoints, message flow by `sessionId`, per-session model override, status SSE.
- [x] Desktop real session UI (`c256ebc`): sidebar list with live status dots, create/rename/pin/archive with revision chains, search, branch produces new sessions.
- [ ] Implement the authenticated native helper and Permission Center foundation. — Swift helper sources and host protocol landed (`a22b740`); build/permission-center UI integration remains.
- [x] Implement the curated plugin runtime foundation. — integrated (`5079a4c`): catalog/detail/lifecycle endpoints, signature and integrity recheck, permission-diff consent, supervised subprocess isolation; desktop catalog page (`cdf586b`).
- [x] Repair the mutation false-success path with execution provenance, a one-attempt allowlist, and fail-closed approval completion.
- [x] Add dual-review exact-value reread, typed equality, evidence hashing, and a verified Shared Fact after mutation.
- [x] Repair the live Google Ads validation harness without claiming a live account run.

## Direct baseline results

```text
pnpm install --frozen-lockfile   pass
pnpm typecheck                   pass
pnpm test                        pass (60 files, 631 tests)
pnpm test:ads-core               pass (410 tests)
pnpm build                       pass
pnpm desktop:dir                 pass
codesign --verify --deep --strict release/mac-arm64/AdPilot.app
                                 pass (ad-hoc integrity only)
focused mutation safety tests    pass (3 files, 48 tests)
validation manifest/evidence tests     pass (2 files, 13 tests)
live model evaluation            not-run
real Google Ads validation       not-run
```

## Current working batch

1. Compile and wire the Swift native helper; build the Permission Center page.
2. Session-scoped Computer Use state and Live View pixels.
3. Model/provider page with OS credential storage.

No test, live action, or real-account result is recorded as passing unless it ran in this rebuild.
