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
- [x] Implement the authenticated native helper and Permission Center foundation. — Swift helper built/staged/signed (`com.adpilot.computer-helper`, protocol v3); `NativeHelperOperator` is the product operator; Permission Center live in Settings with real Helper state, request flow, and permission tests.
- [x] Implement the curated plugin runtime foundation. — integrated (`5079a4c`): catalog/detail/lifecycle endpoints, signature and integrity recheck, permission-diff consent, supervised subprocess isolation; desktop catalog page (`cdf586b`).
- [x] Repair the mutation false-success path with execution provenance, a one-attempt allowlist, and fail-closed approval completion.
- [x] Add dual-review exact-value reread, typed equality, evidence hashing, and a verified Shared Fact after mutation — now extended with a post-refresh persistence reread and durable Computer Action records; a mutation without a persistent record aborts the approval fail-closed.
- [x] Repair the live Google Ads validation harness without claiming a live account run.
- [x] Session-scoped Computer Use state and Live View pixels. — Product+Browser session bindings, per-session control state, durable action records; authenticated `/api/desktop-native/live-frame` returns real bound-window previews rendered with grounding overlay; proven end to end on real hardware (`scripts/live-view-e2e.ts`).
- [ ] Model/provider page with OS credential storage.

## Direct results this cycle (2026-07-28, commits through `34cb1f8`)

```text
pnpm typecheck                   pass
pnpm lint                        pass (354 files)
pnpm test                        pass (70 files, 719 tests)
swift test (native helper)       pass (23 tests)
pnpm test:computer:permissions   pass (real machine: screen capture + accessibility,
                                 real PNG capture, real window focus)
real screen capture              pass (3024x1964 PNG via authenticated Helper, inspected)
real native input                pass (lease-bound mouse move posted to a live Chrome window)
permission center end to end     pass (all eight items with real Helper state)
live view end to end             pass (real managed Chrome window bound by PID+CGWindowID,
                                 real JPEG preview through the authenticated route)
pnpm test:computer:google-ads-readonly  blocked-by-no-test-account (structured report)
pnpm test:computer:google-ads-prepare   blocked-by-no-test-account (structured report)
pnpm test:computer:google-ads-mutation  blocked-by-no-test-account (structured report)
pnpm eval:computer-use:live      not-run (LIVE_MODEL_NOT_CONFIGURED)
pnpm verify                      pass (59s on a calm machine: format, lint, typecheck,
                                 719 tests in 18s, security 48, computer 155 + Swift 23,
                                 permissions real-machine pass, ads-core 410, build,
                                 package:mac:dir, package:smoke all green)
desktop component tests          pass (10 files, 89 tests; apps/desktop vitest)
```

No test, live action, or real-account result is recorded as passing unless it ran in this rebuild.
