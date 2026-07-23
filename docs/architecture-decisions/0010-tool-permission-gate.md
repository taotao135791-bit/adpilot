# ADR 0010: Tool calls pass a fail-closed permission gate before execution

- Status: accepted
- Date: 2026-07-23

## Decision

Every tool a model can invoke through `PiAgentRuntime` is classified by a declarative rule table (`TOOL_GATE_RULES` in `@adpilot/shared`) as `read`, `write` or `destructive`, each rule declaring its authority: `self_gated`, `approval_reference` (a same-client/task approval in a required status) or `approval_token` (the operator-held HMAC token minted at user approval). The runtime enforces the classification uniformly in `Agent.beforeToolCall`, before the tool body runs, instead of relying on each tool to police itself. A tool without a rule fails closed: it is treated as an approval-gated write. `commit_approved_action` remains hard-blocked for the model because approval tokens never enter the model context.

## Consequences

- A newly added tool is controlled by default; enabling it requires an explicit, reviewable classification in the shared rule table rather than remembering per-tool checks, and a wrong `read` classification is a visible decision instead of an omission.
- Argument-aware classifiers must stay in sync with the code they describe: `READ_SKILL_NAMES` in `@adpilot/shared` must mirror the skills whose execution only reads or computes — any unknown or ledger-writing skill fails closed to `write` — and `dispatch_specialist` escalates to `destructive` whenever the requested visual task declares `MUTATE`/`DESTRUCTIVE`.
- The gate is an advisory pre-check. It stops calls that could never succeed, but `ApprovalService.consume` remains the final authority: the HMAC signature and nonce hash are verified there at execution time, not at the gate.
- Allowed write/destructive decisions and every denial are appended to the audit hash chain, so the compliance record covers blocked intent, not only executed calls.
