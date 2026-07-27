# Acceptance matrix

Status values: `pass`, `partial`, `fail`, `not-run`, `blocked-external`.

| Area | Acceptance | Status | Current evidence / next proof |
| --- | --- | --- | --- |
| Session | create persists before first message | fail | renderer-only until first send |
| Session | switch among multiple Sessions | partial | conversation string switch exists; no product Session entity |
| Session | background Session continues | partial | runtime can run concurrently; desktop global submitting/stale response is unsafe |
| Session | full Pi context survives restart | pass | completed history session tests; interrupted run recovery missing |
| Session | rename/pin/search/filter/archive/delete/restore/duplicate | fail | not implemented |
| Session | branch uses globally unique IDs | fail | fork currently reuses message/Pi entry IDs |
| Session | three Sessions use three models without leakage | fail | no per-session model binding |
| State | GUI/CLI share one daemon | fail | each constructs a system; Electron can duplicate servers |
| Window | expanded native traffic lights unobstructed | pass | directly inspected on current macOS baseline |
| Window | collapsed/min/max/fullscreen/modes/Retina matrix | not-run | current CSS has collapsed-mode collision risk |
| Permissions | Screen Recording and Accessibility status | fail | no programmatic detection/UI |
| Permissions | request/recheck/test/open settings | fail | docs-only manual guidance |
| Native helper | shipped authenticated helper | fail | production uses `swift -e`/screencapture/nut.js |
| Computer | capture/ground/policy/action/recapture/verify contract | partial | substantive mock/contract tests; production host weak |
| Computer | real Live View | fail | metadata placeholder, no pixels |
| Computer | pause/resume/stop/step/takeover/give-back | fail | only coarse singleton pause/takeover/resume |
| Computer | mutation executes at most once | pass | one-attempt plan allowlist, execution provenance, terminal-`done` rejection, and regression tests |
| Computer | exact post-change value verified | pass | two independent rereads, typed equality, region/screenshot hashes, and verified Shared Fact |
| Computer | real Google Ads read path | not-run | broken harness plus no authenticated account |
| Computer | real approved Google Ads mutation | not-run | requires explicit user environment; no claim made |
| Plugins | curated registry and details | fail | absent |
| Plugins | install/update/disable/uninstall | fail | absent |
| Plugins | signature/integrity/permission diff/isolation | fail | absent |
| Models | global providers/models | partial | fast/strong and custom providers exist |
| Models | per-session/role binding and limits | fail | absent |
| Secrets | OS credential store | fail | private files only |
| Advertising | deterministic TS guardrails | pass | product tests |
| Advertising | verified facts/evidence/specialists | pass | product tests |
| Advertising | approval/token/audit chain | partial | false-success and exact-value gates repaired; multi-writer audit remains |
| Advertising | retained UAC Python engine in packaged app | fail | offline tests only, not wired/packaged |
| GUI | Agent workspace vs permanent dashboard | partial | conversation-first shell exists; required IA/Inspector/routes absent |
| Build | install/typecheck/test/build | pass | direct 2026-07-27 baseline |
| Build | required unified commands | fail | absent |
| Package | ARM64 `.app` builds and verifies | pass | ad-hoc codesign verified |
| Package | notarized distributable | blocked-external | Developer ID/notarization authority not supplied |
