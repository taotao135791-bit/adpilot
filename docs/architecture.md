# Architecture

## Invariants

1. Pi (`@earendil-works/pi-agent-core`) is the only agent loop and conversation runtime.
2. UI-TARS is not an autonomous agent. A grounding provider receives one screenshot and returns at most one parsed action.
3. The user talks to one AdPilot Agent. Specialists have isolated prompts, tool scopes and sessions; they return structured results to the main agent.
4. Knowledge is evidence, Skill is a typed workflow, Tool is an executable capability. Markdown cannot grant authority.
5. No mutation is authorized by model output. Approval state is persisted and verified outside the model.

## Runtime flow

```text
User goal
  -> AdPilot Agent (Pi)
    -> Specialist dispatch
      -> typed Skill
        -> deterministic Tool / read-only visual microtask
    -> evidence synthesis
    -> deterministic change guardrail
    -> independent Risk Reviewer
    -> user approval
    -> one-attempt token bound to the complete VisualExecutionPlan
    -> Account Operator visual microtask
      -> assert managed browser client/Profile/PID/window
      -> local full screenshot + masked task ROI
      -> built-in visual grounding (advanced UI-TARS override optional)
      -> dual visual account/Campaign/value/target confirmation for mutation
      -> VisualPolicy
      -> one native NutJS action
      -> screenshot
      -> visual verification
    -> audit + verified Shared Facts + experiment ledger + monitoring
```

## Package ownership

| Package | Responsibility | Forbidden responsibility |
| --- | --- | --- |
| `agent-orchestrator` | One user-facing task lifecycle and specialist dispatch | Direct account mutation |
| `runtime` | Pi sessions, streaming, compaction, tool calls | GUI planning loop |
| `specialist-agents` | Bounded expert roles | Sharing hidden session state |
| `skills` | Typed prerequisites, outputs and failure rules | Direct native I/O |
| `tools` | Workspace, metrics, approvals, experiments, visual execution | Inventing policy |
| `advertising-core` | Deterministic metrics, UAC policy and replay | Live account credentials |
| `computer-use` | One-action visual protocol and verification | Overall task planning |
| `visual-table-reader` | ROI table headers/cells, overlap alignment, normalization and independent review | DOM, OCR services or guessed values |
| `approvals` | Risk/user state machine and token binding | Exposing tokens to models or HTTP clients |
| `workspace` | Client isolation and atomic local persistence | Cross-client paths |
| `audit` | Redacted append-only hash chain | Storing secrets |
| `server` / `desktop` / `cli` | Product interfaces | Bypassing application services |

## Persistence

Each client lives under `workspace/clients/<client-id>/`. Profile, KPI, accounts and constraints are YAML. Tasks, approvals and experiments are structured JSON; audit is JSONL with a SHA-256 chain. Main and specialist Pi sessions are JSONL under `sessions/`, keyed by client plus conversation or task plus role. Runtime checkpoints and compaction summaries restore conversation context, unresolved task state and evidence references after restart. Writes are atomic or append-only and private files use mode `0600` where supported.

## Managed browser and model routing

Each client uses an AdPilot-launched browser with a dedicated on-disk Profile. Durable session metadata binds client, Profile, process id, native window id/bounds and platform. Every capture and action revalidates the original process and foreground window. Close, replacement, Profile drift, application switch or restart ambiguity returns `BROWSER_SESSION_LOST`; the runtime never adopts a different browser automatically.

- Daily: natural conversation, extraction and routine synthesis.
- Deep: ambiguity, conflicts, failed visual retries and risk-sensitive reasoning.
- GUI grounding: built-in adapter over an authenticated image-capable Daily/Deep code model. An advanced dedicated provider, when configured, is attempted first.
- Visual verification: a separately invoked advanced endpoint when configured; otherwise an independent Deep vision call.
- Account identity: two separately invoked visual reviewers must agree at confidence `>= 0.85`; they may use the same configured code model but remain distinct calls, roles and audit records.

Provider/model names come from the persisted native Settings store or environment configuration. The catalog is read directly from Pi, and routing never changes Tool permissions.

## Visual evidence path

Complete screenshots are written only to the local Workspace. Grounding, verification, identity and table calls receive cropped task ROIs with sensitive masks and produce an append-only disclosure record. Remote full-window uploads are rejected, and `local-only` privacy mode rejects remote image providers.

`VisualTableReader` detects headers and cells from pixels, records raw/normalized value, unit, confidence, bounding box and screenshot id, aligns vertical/horizontal scrolls using overlap rows, and asks a separate verifier call to confirm critical cells. Only verified, unexpired `SharedFact` records for the same client/task reach specialists. Low-confidence, truncated, loading or conflicting values stop with `UNRELIABLE_VISUAL_VALUE`.

## Approval binding

`VisualExecutionPlan` is a strict schema covering plan/task/client, platform, Profile, native application/window, allowlists, account/Campaign/page identity, operation and values, instruction, target, expected result, allowed region, risk, surface/account fingerprints and lifetime. Its canonical SHA-256 fingerprint is embedded in the HMAC token binding. Immediately before mutation, AdPilot reconstructs the actual plan from the live managed screenshot and dual-reviewed identity; any mismatch destroys the token and requires a new approval.
