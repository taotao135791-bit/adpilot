# Core readiness audit — 2026-07-22

Scope: `packages/runtime`, `agent-orchestrator`, `specialist-agents`, `computer-use`, `model-router`, `application`, `workspace`, `approvals`, `experiments`, `audit`, `advertising-core`, desktop, CLI, tests, evals, and product documentation.

## Findings before remediation

| Area | Observed implementation | Risk | Required remediation |
| --- | --- | --- | --- |
| Main Pi session | `PiAgentRuntime.execute()` created `InMemorySessionStorage` for every call. Callers supplied random session IDs. | Restart and even the next turn lost Pi messages, tool calls and tool results. | Stable `clientId + conversationId` mapping and a Pi `SessionStorage` backed by the client workspace. |
| Conversation context | The server placed the last 12 rendered messages inside `sharedFacts`; it did not restore Pi context. | Tool and assistant message semantics were flattened into JSON prompt text. | Build the model context from the persisted Pi session. |
| Compaction | A `compactSession()` helper existed but no production path invoked it. | Long conversations could only grow or be manually truncated outside Pi. | Trigger Pi compaction from durable session entries and persist its summary/checkpoint. |
| Specialist continuity | Pi specialists created a random session for every dispatch. | A specialist could not continue its own reasoning in the same task. | Stable `taskId + specialistRole` sessions with scoped verified facts. |
| GUI grounding | `UiTarsGroundingModel` existed, but `createAdPilotSystem()` always assembled `PiVisionModel` for both grounding and verification. | The dedicated grounding implementation was dead production code. | Four explicit model roles and a provider-neutral grounding chain with UI-TARS first. |
| Native identity | `UiTarsNativeOperator` exposed only full-screen capture and execute. | The policy trusted caller-supplied app/domain strings and stale screenshot coordinates. | Query active app, window, title, PID, bounds and screen; fingerprint before every action. |
| Visual retries | A failed verification re-grounded and executed up to three times for every risk level. | An unchanged page could receive duplicate clicks; a mutation could be submitted twice. | Never retry an executed mutation, reject repeated coordinates, and stop on surface change. |
| Approval token | HMAC covered account, campaign, operation and values; persisted status provided one-time consumption. | Platform, risk, real surface and attempt cap were not bound. No explicit revoke API existed. | Sign the complete binding, enforce one attempt, compare the live surface and support cancellation. |
| Structured output | Most agents used `JSON.parse` followed by `Zod.parse`. | Provider formatting differences became user-visible blockers. | Normal parse, same-model repair, strong-model repair, then typed blocker. |
| Visual evaluation | Two mock-dashboard tests covered one happy path and one screenshot flow. | No representative grounding/verification regression corpus or metrics. | At least 50 sanitized, multi-state replay tasks and an honest offline/live evaluator. |
| Real account validation | No user-run Google Ads harness existed. | Product claims could not be verified against a logged-in foreground browser. | Read-only and prepare-without-submit harnesses with artifact capture. |

## Existing controls retained

- Pi remains the only long-running planning runtime.
- UI-TARS is limited to a single visual micro-action and native execution.
- Deterministic advertising guardrails, independent risk review, user approval, one-time execution and hash-chained audit remain product-owned.
- Customer credentials remain outside model/session logs.
- The migrated advertising core and its upstream contract suite remain unchanged.

This audit records the pre-change state. Completion evidence and remaining environment-dependent validation are maintained in `docs/test-report.md` and `docs/known-limitations.md`.
