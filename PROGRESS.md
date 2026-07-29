# Rebuild progress

Last updated: 2026-07-29

Maturity ladder: Implemented → Unit Tested → Integration Tested →
Packaged Tested → Mock E2E Verified → Real Account Verified. Blocked means
an external prerequisite is missing; it is never reported as passed.

## AdPilot 0.3.1 — Integration Release

| Capability | Maturity | Evidence |
| --- | --- | --- |
| AgentExecutionContext through /api/messages → agent | Integration Tested | `project-session-binding.test.ts` (5) |
| Project find-or-create Session binding | Integration Tested | same suite; shadow project in session-service |
| Mission → Goal/Task heuristic | Integration Tested | same suite (short/keyword/long cases) |
| Agent Tool Registry (57 tools) + lifecycle | Integration Tested | agent-tools 23 tests + groups tests |
| Registry bound into the live composition root | Integration Tested | server boots with shared terminal/scheduler deps |
| Unified approval (automation/server-minted) | Integration Tested | forgery/replay/stale suites in automation-routes |
| Plugin mutable-tool approval gate | Integration Tested | `mutable-tool-approval.test.ts` |
| Workflow production surface provider | Integration Tested | `surface-provider.test.ts`; fail-closed without a browser session |
| Coding closed loop (worktree→edit→test→diff→PPTX→approval→commit) | Mock E2E Verified | `scripts/acceptance-031.ts` task A, 20/20 steps |
| Ads analysis closed loop (brief→UAC→decision→weekly PPTX) | Mock E2E Verified | task B, 8/8 steps, mock data labeled |
| Python UAC in the DMG | Packaged Tested | extraResources + package smoke runs analyze inside the bundle |
| Restart recovery of project/goal/artifact | Mock E2E Verified | acceptance restart block passed |
| Live-model planning E2E | Blocked | no chat provider credential configured |
| Real Google Ads account run | Blocked | needs user-named test account + managed profile |
| Developer ID notarization | Blocked | no certificate authority in repo |

Full gates: `pnpm typecheck` clean; root suite **905/905**; desktop **127/127**;
Python engine **410/410** (untouched).

## AdPilot 0.3 — Universal Workspace

- [x] kernel/git-tools/artifacts foundations and REST wiring
- [x] terminal + git + checkpoints service layer
- [x] workbench UI (rail, Home, Projects, Project view with panels)
- [x] ads-intelligence backend + daily brief + action queue UI
- [x] record-and-replay workflows + automations scheduler

## Earlier cycles

P0 computer-use closeout (native helper, permissions, live view, mutation
safety) — see `docs/computer-use/CURRENT_STATE.md`.
