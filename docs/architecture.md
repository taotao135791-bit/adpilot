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
    -> one-attempt token bound to exact operation + live native surface
    -> Account Operator visual microtask
      -> screenshot
      -> dedicated UI-TARS grounding (PiVision fallback)
      -> VisualPolicy
      -> native NutJS action
      -> screenshot
      -> visual verification
    -> audit + experiment ledger + monitoring
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
| `approvals` | Risk/user state machine and token binding | Exposing tokens to models or HTTP clients |
| `workspace` | Client isolation and atomic local persistence | Cross-client paths |
| `audit` | Redacted append-only hash chain | Storing secrets |
| `server` / `desktop` / `cli` | Product interfaces | Bypassing application services |

## Persistence

Each client lives under `workspace/clients/<client-id>/`. Profile, KPI, accounts and constraints are YAML. Tasks, approvals and experiments are structured JSON; audit is JSONL with a SHA-256 chain. Main and specialist Pi sessions are JSONL under `sessions/`, keyed by client plus conversation or task plus role. Runtime checkpoints and compaction summaries restore conversation context, unresolved task state and evidence references after restart. Writes are atomic or append-only and private files use mode `0600` where supported.

## Model routing

- Daily: natural conversation, extraction and routine synthesis.
- Deep: ambiguity, conflicts, failed visual retries and risk-sensitive reasoning.
- GUI grounding: dedicated provider first, optional dedicated Strong provider after failures, then an image-capable Pi model fallback.
- Visual verification: independent endpoint when configured; otherwise the image-capable Deep model.

Provider/model names come from the persisted native Settings store or environment configuration. The catalog is read directly from Pi, and routing never changes Tool permissions.
