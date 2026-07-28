# @adpilot/ads-intelligence

Advertising decision domain model, Python UAC engine bridge, and deterministic
Daily Brief aggregation for AdPilot 0.3 (Phase 4 server side).

## Domain model

Zod schemas + per-entity JSON file stores with the kernel discipline
(private directories `0o700`, record files `0o600`, atomic temp-file + rename
writes, symlink fail-closed) under `<root>/.adpilot/ads/`:

- `AdAccount` — a platform ad account scoped to a workspace.
- `CampaignEntity` — a campaign belonging to an `AdAccount`.
- `AdvertisingDecision` — a recommendation with rationale, `evidenceIds`
  (Shared Fact ids from `@adpilot/shared`), confidence, risks, and a lifecycle
  state machine: `proposed → approved → executed → observing →
  successful | failed | reverted`. Illegal transitions raise
  `DECISION_INVALID_TRANSITION`.
- `CreativeAsset` — a creative with optional metrics and lifecycle
  (`new | active | fatiguing | retired`).

`DecisionService` validates project existence through an injected
`ProjectExistsQuery` (wired to `KernelService.getProject` by the host — the
service never reads the kernel file system), runs the status machine, and
suppresses duplicate proposals via `findSimilarOpen(projectId, campaignId,
sha256(recommendation))` against open decisions
(`proposed`/`approved`/`observing`).

## Python UAC engine bridge

`PythonUacEngine` shells out to the real deterministic UAC helper in
`packages/advertising-core/python` — the same entry its pytest suite uses:

```
python3 packages/advertising-core/python/scripts/uac_experiment.py analyze <input.json>
python3 packages/advertising-core/python/scripts/uac_experiment.py decide <input.json> --json [--question "..."]
```

Request mapping (`UacAnalyzeRequest`):

| field      | engine mapping                                                        |
| ---------- | --------------------------------------------------------------------- |
| `kind`     | `analyze` → full analysis JSON; `decide` → Quick Decision card JSON   |
| `case`     | UAC input contract object, written to a private temp JSON file        |
| `question` | forwarded to `decide --question` (AC2.0/2.5/3.0 terminology routing)  |

Response mapping: stdout is JSON-parsed and validated —
`UacAnalysisResult` for `analyze` (checks `schema_version`,
`measurement_state.status`, `learning_eligibility.status`,
`optimization_feasibility.status`, passes the rest through) and
`UacQuickDecisionResult` for `decide` (checks `mode`, `terminology`,
`decision.verdict/confidence/summary`).

Failure contract (coded `AdsIntelligenceError`, never a fabricated result):

- `UAC_ENGINE_UNAVAILABLE` — interpreter does not answer `python3 --version`
- `UAC_ENGINE_FAILED` — non-zero exit, spawn failure, or 30s timeout
- `UAC_OUTPUT_INVALID` — stdout is not JSON or fails schema validation

### Engine capability boundary

What genuinely runs today:

- `analyze` — deterministic diagnosis of a Google Ads app-campaign (UAC)
  input: funnel/measurement/learning eligibility, feasibility, evidence-based
  recommendations. Input must satisfy the engine contract
  (`scope.platform = google_ads`, `scope.campaign_type = app_campaign`,
  declared measurement/learning/maturity/permissions facts).
- `decide` — read-only Campaign Level (AC2.0/AC2.5/AC3.0) Quick Decision card:
  terminology resolution, upgrade/rollback verdicts, budget/bid/creative
  guidance. No account writes and no ledger appends happen through this
  bridge.
- Other engine subcommands (`doctor`, `normalize`, `replay`, ledger ops) are
  not exposed through `PythonUacEngine`.

What is blocked: anything that is not a Google Ads app campaign (the engine
contract rejects other platforms/campaign types), any request whose `case`
fails the engine's input contract (exit 2 → `UAC_ENGINE_FAILED`), and any
environment without a working `python3` (+ PyYAML for YAML inputs; JSON input
is used by this bridge).

## Daily Brief

`DailyBriefService.generate(input)` aggregates caller-supplied facts
(accounts, campaigns, creatives, a metrics snapshot, decisions, experiments,
pending reports, declared measurement issues) into a structured brief with
seven sections: anomaly accounts, creative fatigue, learning-phase risks,
pending observations (observing decisions + in-flight experiments), pending
approvals (proposed decisions), pending reports, and measurement reminders.
Every rule is deterministic and threshold-driven (`DailyBriefThresholds`);
each item carries a `severity` and `evidenceIds`. No model calls.
