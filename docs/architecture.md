# Architecture

## Invariants

1. Pi (`@earendil-works/pi-agent-core`) is the only agent loop and conversation runtime.
2. UI-TARS is not an autonomous agent. A grounding provider receives one screenshot and returns at most one parsed action.
3. The user talks to one AdPilot Agent. Specialists have isolated prompts, tool scopes and sessions; they return structured results to the main agent.
4. Knowledge is evidence, Skill is a typed workflow, Tool is an executable capability. Markdown cannot grant authority.
5. No mutation is authorized by model output. Approval state is persisted and verified outside the model.
6. Every model-initiated tool call passes a declarative permission gate before the tool body runs. Write and destructive calls require a valid approval reference or token; unclassified tools fail closed.
7. Bash never becomes a back channel around the visual-only red line. A deterministic classifier hard-denies network, capture, credential, process-control and persistence command classes with no approval path, and every executed command runs inside a networkless macOS seatbelt sandbox that holds even if a command was misclassified.

## Runtime flow

```text
User goal
  -> AdPilot Agent (Pi)
    -> Specialist dispatch
      -> typed Skill
        -> deterministic Tool / read-only visual microtask
    -> tool-permission gate on every tool call
    -> evidence synthesis
    -> deterministic guardrail from three verified status facts,
       supplied directly or derived from verified raw visual metrics/status facts
    -> independent Risk Reviewer
    -> user approval with complete plan/guardrail disclosure
    -> one-attempt token bound to the complete VisualExecutionPlan and guardrail
    -> Account Operator visual microtask
      -> assert managed browser client/Profile/PID/window
      -> local full screenshot + minimized model disclosure
      -> Pi code-model visual grounding (configured UI-TARS override optional)
      -> first identity locator on cropped/masked browser content
      -> second identity reviewer on four tight evidence regions
      -> reuse those four regions at mutation commit
      -> VisualPolicy
      -> one native NutJS action
      -> screenshot
      -> visual verification
    -> audit + verified Shared Facts + experiment ledger + monitoring alerts
```

## Package ownership

| Package | Responsibility | Forbidden responsibility |
| --- | --- | --- |
| `agent-orchestrator` | One user-facing task lifecycle and specialist dispatch | Direct account mutation |
| `application` | Dependency composition, event bus, monitoring-alert delivery and user skill/prompt-template discovery | Direct account mutation |
| `runtime` | Pi sessions, streaming, compaction, tool-permission gate, audit extension, conversation fork, plan mode | GUI planning loop |
| `specialist-agents` | Seven bounded expert roles | Sharing hidden session state |
| `skills` | Typed prerequisites, outputs and failure rules; audited execution with zod-derived contracts | Direct native I/O |
| `tools` | Workspace, metrics, approvals, experiments, visual execution, vendored general tools with their path guards and seatbelt sandbox | Inventing policy |
| `advertising-core` | Deterministic metrics, UAC policy and replay | Live account credentials |
| `computer-use` | One-action visual protocol and verification | Overall task planning |
| `visual-table-reader` | ROI table headers/cells, overlap alignment, normalization and independent review | DOM, OCR services or guessed values |
| `approvals` | Risk/user state machine and token binding | Exposing tokens to models or HTTP clients |
| `workspace` | Client isolation and atomic local persistence | Cross-client paths |
| `audit` | Redacted append-only hash chain | Storing secrets |
| `shared` | Product contracts, tool-gate rules and the deterministic bash classifier | Granting authority |
| `server` / `desktop` / `cli` | Product interfaces | Bypassing application services |

## Persistence

Each client lives under `workspace/clients/<client-id>/`. Profile, KPI, accounts and constraints are YAML. Tasks, approvals and experiments are structured JSON; audit is JSONL with a SHA-256 chain. Main and specialist Pi sessions are JSONL under `sessions/`, keyed by client plus conversation or task plus role. Runtime checkpoints and compaction summaries restore conversation context, unresolved task state and evidence references after restart, and compaction and branch summaries are explicitly projected back into the model context rather than dropped. Monitoring alerts awaiting delivery persist under `alerts/pending.json`. Writes are atomic or append-only and private files use mode `0600` where supported.

## Managed browser and model routing

Each client uses an AdPilot-launched browser with a dedicated on-disk Profile. Durable session metadata binds client, Profile, process id, native window id/bounds and platform. Every capture and action revalidates the original process and foreground window. Close, replacement, Profile drift, application switch or restart ambiguity returns `BROWSER_SESSION_LOST`; the runtime never adopts a different browser automatically.

- Daily: natural conversation, extraction and routine synthesis.
- Deep: ambiguity, conflicts, failed visual retries and risk-sensitive reasoning.
- GUI grounding: the default built-in adapter uses an authenticated image-capable Daily/Deep Pi code model. A dedicated UI-TARS-compatible endpoint is only an advanced override and, when explicitly configured, is attempted first.
- Visual verification: a separately invoked advanced endpoint when configured; otherwise an independent Deep vision call.
- Account identity: two separately invoked visual reviewers must agree at confidence `>= 0.85`; they may use the same configured code model but remain distinct calls, roles and audit records.

Provider/model names come from the persisted native Settings store or environment configuration. Settings may additionally register custom OpenAI-completions- or Anthropic-messages-compatible endpoints (enterprise gateways or local inference) with their own base URLs and optional keys; keys are stored with private permissions and never returned by the settings view. `local-only` privacy mode blocks remote providers on the conversational path with the same semantics as on the screenshot path, exempting loopback and private-network endpoints, and model changes take effect on restart. The catalog is read directly from Pi, and routing never changes Tool permissions.

## Visual evidence path

Complete screenshots are written only to the local Workspace. Before a target has pixel coordinates, the first grounding or identity locator receives a browser-content crop with the default browser-chrome, personal-information and notification masks. Once a target ROI exists, grounding and verification use a tight crop around that ROI and black out surrounding pixels. For mutation identity, the first locator returns the account, Campaign, current-value and target regions; the second reviewer receives only the tight union of those four regions with every gap masked. The agreed regions are persisted with the plan and reused during commit-time identity review. Every disclosure is append-only and records its role, ROI and masks. Remote full-window uploads are rejected, and `local-only` privacy mode rejects remote image providers.

`VisualTableReader` detects headers and cells from pixels, records raw/normalized value, unit, confidence, bounding box and screenshot id, aligns vertical/horizontal scrolls using overlap rows, and asks a separate verifier call to confirm critical cells. Only verified, unexpired `SharedFact` records for the same client/task reach specialists. For the Performance Analyst, Media Buyer and Measurement Reviewer, every account-number field is mapped to one exact Fact ID, must equal that fact's value, and all bound facts must use the same Campaign subject. Low-confidence, truncated, loading, conflicting, stale, cross-Campaign or unbound values stop instead of becoming model context.

## Approval binding and deterministic guardrails

`VisualExecutionPlan` is a strict schema covering plan/task/client, platform, Profile, native application/window, allowlists, account/Campaign/page identity, operation and values, instruction, target, expected result, allowed region, risk, surface/account fingerprints and lifetime. Its canonical SHA-256 fingerprint is embedded in the HMAC token binding.

Numeric `mutate` and `destructive` operations additionally require a deterministic guardrail attestation for three `SharedFact` records: `measurement_status`, `campaign_mature` and `learning_phase`. The caller may supply those three exact Fact IDs, or supply exact IDs for verified raw visual metrics/status facts such as conversions, observation days and the visible learning status. In the latter path, `tools` deterministically runs the maturity and measurement checks, persists the three derived verified facts with the complete source lineage, and then builds the same attestation. Every direct, raw and derived fact must be same-client/task/Campaign, verified, unexpired, non-migration, screenshot-backed, bounded and at least the configured confidence threshold. `tools` loads client constraints and active experiments, caps the change at `min(client maximum, 20%)`, requires a matching single variable and runs `advertising-core`'s `evaluateChangeGuardrail`. Hypotheses, text summaries and model-supplied booleans are not substitutes.

The persisted guardrail contains its input, decision, fact IDs, single-variable result, operation fingerprint and evaluation time. Its canonical fingerprint is bound to the token beside the execution-plan fingerprint. Before an approving risk review, user approval and commit/token consumption, AdPilot reloads every bound fact and its derivation lineage, rechecks lifecycle/provenance/expiry/Campaign binding, and recomputes the guardrail against current constraints and experiments. A page-changing native action marks that task's visual facts stale; starting, resuming, replacing or closing a managed-browser session invalidates the client's visual evidence. A missing, stale, rejected, superseded, changed or denied lineage blocks and cancels the pending approval. Immediately before mutation, AdPilot reconstructs the actual plan from the live managed screenshot and dual-reviewed identity regions persisted at approval time; any mismatch destroys the token and requires a new approval.

The desktop user approval UI renders the complete plan plus the surface/account/plan/guardrail fingerprints, guardrail decision, cap, reasons and evidence Fact IDs. It is a disclosure surface over the deterministic approval service, never an alternate authority path.

## Tool permission gate

`TOOL_GATE_RULES` in `shared` declaratively classifies every model-callable tool as `read`, `write` or `destructive`, with an authority of `self_gated`, `approval_reference` or `approval_token`. `PiAgentRuntime` enforces the classification in `Agent.beforeToolCall`: read calls flow untouched; write and destructive calls must carry a valid same-client/task approval reference or the operator-held token; any unclassified tool fails closed as an approval-gated write. `commit_approved_action` is additionally hard-blocked because tokens never enter the model context. The gate is an advisory pre-check — `ApprovalService.consume` remains the final authority that verifies the HMAC token at execution time. Allowed write/destructive decisions and every denial are appended to the audit hash chain. This decision is recorded in [ADR 0010](architecture-decisions/0010-tool-permission-gate.md).

A runtime audit extension chains the factual event stream into the same tamper-evident log: every tool call and result (secret-redacted and size-capped, so screenshot payloads never enter the chain), deterministic guardrail decisions, the final model routing decision per run and failed runs. Audit appends are serialized, so concurrent writers cannot fork the hash chain.

## General tools, bash and plan mode

The main agent additionally receives a vendored general tool set (`tools/general`, adapted from pi @ 0.80.10, MIT). `read`, `grep`, `find` and `ls` observe through one shared read-path guard: every path is confined to the client workspace plus explicitly allowed roots, lexical and symlink escapes are rejected before any byte is read, and protected paths — the `.adpilot` private subtree outside its public skills/prompts directories, credential stores, the audit chain and browser profile stores — are never tool-accessible. `write` and `edit` are confined to the workspace and approval-gated at the tool gate exactly like ledger-writing skills. Specialists receive only the read set; bash is main-agent-only.

`bash` is enforced by three independent layers. First, the deterministic, LLM-free classifier in `shared` lexes the command line (quotes, pipes, redirections, command lists, substitutions), classifies every simple command and takes the most severe verdict: whitelisted read-only programs flow at the read level; anything else — redirects, package installs, inline interpreter code, unknown programs, unparseable input — floors at write and requires an executed approval reference of the same client and task; and the threat-model deny classes are refused absolutely with no approval path: network egress/ingress, screen capture and UI scripting, credential and browser profile stores, privilege escalation, process control, scheduled persistence and recursive-force deletion. Second, one protected-path policy is enforced on both sides of the surface: the workspace-aware matcher in `tools/general/protected-paths.ts` backs the path guard and the seatbelt generator, while the classifier mirrors it with root-independent token patterns. Third, execution happens exclusively through macOS `sandbox-exec` with a generated seatbelt profile — no network, writes confined to the workspace and temp directories, protected reads denied — over a child environment stripped of provider credentials. The sandbox fails closed: without `sandbox-exec` the tool refuses to execute rather than degrading to an unsandboxed shell. Every invocation's classification, allowed or denied, is chained into audit as `bash_classify`. Together the deny classes and the OS-level network floor are the mechanism behind invariant 7: bash cannot reach advertising APIs, cookies or pixels directly, so the visual-only red line and the local-only privacy semantics hold for the shell as well.

Plan mode (`runtime/plan-mode.ts`) is a conversation-level read-only switch persisted as workspace metadata. While enabled, the main agent's tool set shrinks to `PLAN_MODE_READ_TOOL_NAMES`, an injected system prompt requires a numbered side-effect-free plan, and the tool gate hard-denies any non-read classification — so plan mode only ever contracts authority and never grants it. The server exposes per-conversation GET/POST plan-mode endpoints, carries the state in `/api/state`, and chains every toggle into the audit log; the desktop renders a composer toggle from that state, and disabling the mode returns the conversation to the normal pipeline where writes still traverse the approval chain.

## Skills, knowledge and slash commands

Eleven typed skills define validated investigation, evaluation, reporting and experiment workflows. The `reporting_analyst` specialist owns the reporting skills (`daily-report`, `weekly-report`, `account-audit`, `generate-client-report`). The `execute_skill` tool description exposes each allowed skill's input and output contract — field paths, types, required flags and descriptions derived from its zod schema — and `SkillRegistry.execute` validates both ends and appends `denied`/`failed`/`succeeded` outcomes with input/output SHA-256 fingerprints to the audit chain. The experiment-creation skill writes the ledger and must reference the `executed` approval of the same client and task.

Thirty-three knowledge skills—twenty-seven advertising playbooks plus six coding, harness, extension-safety, and release workflows—are embedded at build time (`scripts/build-knowledge-data.mjs` produces `knowledge-data.generated.ts`), so they load identically from the single-file CLI bundle and the Electron asar. Decision turns inject a compressed catalog plus deterministic trigger matches; planning turns inject selected full texts on demand. Skills are reference material only: they grant no tools, permissions or execution authority. The desktop catalog surfaces built-in provenance and MIT licensing alongside user/workspace overrides. Slash commands split into two classes: `/report daily|weekly` and `/audit` expand into advisory investigation directives that travel the normal conversation pipeline, while `/approvals`, `/skills` and `/help` are answered directly by the server from workspace data with no model call. The desktop additionally answers `/experiments` and `/audit-trail` locally from the `/api/state` payload, again with no model call.

Two user extension layers (`application/user-skills.ts`, `application/prompt-templates.ts`) follow the same advisory rule. Markdown skills discovered from `~/.adpilot/skills/` and `<workspace>/.adpilot/skills/` merge into the knowledge catalog — a workspace skill overrides a user-global one, and both override a same-named embedded playbook, which is safe precisely because knowledge grants no authority. Prompt templates from the sibling `prompts/` directories become custom slash commands that expand into an advisory request; built-in commands always win a name conflict because they are bound to typed, audited pipelines while a template is prose. Invalid entries are rejected with recorded reasons, and refresh is incremental on mtime/size.

Plugin discovery is also separated from execution. The compiled candidate
catalog contains publisher-source metadata only and has no install action.
Only reviewed bundles under `plugins/curated` can enter the signed registry;
promotion requires an immutable artifact, license and permission review,
isolation tests, integrity pinning, and an Ed25519 release signature whose
private key remains outside the repository. See `docs/ecosystem.md`.

## Monitoring alerts and conversation fork

`AlertMonitor` accepts monitoring alerts over `POST /api/clients/:id/alerts` and routes them into the client's live conversation as advisory user messages. An alert is follow-up-injected into a running session, persisted to `alerts/pending.json` when no session is active, and replayed (coalesced and bounded) when the next run starts; delivery is confirmed only once the message visibly enters the transcript, and an undrained injection is requeued. A dedupe window anchored in the audit chain and a per-client rate limit bound noise; rate-limited alerts persist like pending ones and deliver when the next session run starts. Every metric value must bind a verified Shared Fact ID, and the injected text states that alerts grant no approval authority. Every transition is chained into audit and published over SSE.

Conversation fork creates an independent conversation from an anchored message: the source session path (root to fork point) is replayed into a new session file with provenance recorded, and the fork is chained into audit. Anchors are the per-message labels written since fork support shipped; older messages cannot be forked and return 409.

## Runtime and desktop security state

`VisualComputerRuntime` has an explicit execution status: `running`, `paused` or `cancelled`; server state reports `unavailable` when no Computer Use runtime exists. Pause, takeover, resume and cancel responses are based on that runtime state. User takeover leaves execution paused until an explicit resume, and cancellation is terminal for the runtime instance.

The Electron shell runs the product server on a random loopback port. It uses context isolation, sandbox and disabled Node integration, denies permission requests, accepts renderer navigation only when the URL origin exactly matches that server origin, and only opens `http:`/`https:` external URLs. It reads desktop `.env` only from Electron user data, avoiding working-directory environment injection. The open-source DMG uses certificate-free ad-hoc signing (`identity: "-"`) for bundle-integrity verification; it has no Apple Developer ID, Team ID or notarization. This desktop local trust boundary is recorded in [ADR 0009](architecture-decisions/0009-desktop-local-trust-boundary.md).
