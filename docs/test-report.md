# Test report

Run date: 2026-07-22. Environment: macOS arm64, Node 24.13.1 (product minimum Node 22), pnpm 10.30.3, Python 3.13.

## Complete quality gate

Command: `pnpm check`

- Strict TypeScript: passed.
- Vitest: 18 files, 132 tests, all passed.
- Advertising core: 410 Pytest tests passed in 8.45 seconds.
- CLI, React desktop, and Electron production builds: passed.

The 132 product tests include stable client/conversation session IDs, disk-backed Pi Session storage, tool messages/results, real Pi compaction, recovery checkpoints, restart conversation continuation, task-scoped specialist continuation across reconstructed runtimes, SharedFact lifecycle/isolation, structured JSON repair, GUI model routing/fallback, action schema, native window identity, active-window screenshot capture, screenshot/window/DPR coordinates, application/window/bounds/DPI changes, application exit, pause/takeover/cancel, timeout, duplicate coordinates, mutation non-retry, approval value/surface/signature/expiry/replay/restart invalidation, pending approval and active experiment restart recovery, end-to-end approval/execute/verify, and server secret isolation.

## Visual replay and model evaluation

Commands:

```bash
pnpm fixtures:visual
pnpm test:visual-replay
pnpm eval:gui
```

- 60 sanitized visual tasks, plus one corpus-coverage test: 61/61 passed.
- 12 scenes: campaign list, date selector, budget, bid, conversions, assets, account switch, confirmation, loading, error, switched browser, unauthorized app.
- Five variants per scene cover Chinese/English, light/dark, 1024–1600 logical widths, and DPR 1/1.25/2.
- Fixture-protocol oracle: grounding/action/completion 100%, false-click/unsafe-action 0%. This validates corpus annotations and replay mechanics, not model quality.
- PiVision, UI-TARS, and Strong GUI live scores are honestly `not-run` because no external credentials/prediction file was supplied. `ADPILOT_EVAL_PREDICTIONS` enables a recorded three-route comparison without embedding customer data.

## Native and packaging checks

- The macOS probe was exercised against a real foreground window and returned application, bundle id, PID, window id/title/bounds, display, DPR=2, and an exact active-window capture.
- `pnpm validate:google-ads:readonly -- --help` passed preflight. No authorized real Google Ads account was used, so no live-account pass is claimed.
- `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm desktop:dmg` produced the unsigned arm64 application and DMG.
- `hdiutil verify release/AdPilot-0.1.1-arm64.dmg` reported a valid checksum.
- Final DMG: `release/AdPilot-0.1.1-arm64.dmg`, 145,773,330 bytes.

## External requirements

Live model evaluation needs configured model credentials. Live Google Ads validation additionally needs Screen Recording and Accessibility permissions, an authorized dedicated browser Profile, a logged-in foreground account, and an explicit client account allowlist. The harness writes screenshots, grounding, actions, verification, model route, latency, failures, and available usage data to `artifacts/validation/`; the prepare flow fills a draft and forbids submission.

The only recurring non-failing warning is Node's `DEP0040` warning from a transitive UI-TARS dependency.
