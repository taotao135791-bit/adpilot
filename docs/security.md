# Security model

## Authority boundary

AdPilot starts with no authority over an advertising account. Workspace configuration defines allowed apps/domains and business constraints. A visual task also declares an explicit permission level: `OBSERVE`, `INTERACT`, `MUTATE`, or `DESTRUCTIVE`. `VisualPolicy` rejects permission escalation, changed risk levels, out-of-bounds coordinates and non-allowlisted surfaces.

## Mutation protocol

A real change requires all of the following:

1. Exact operation fields: account, Campaign, operation, current value, proposed value, percentage, reason, evidence, expected impact, observation window, rollback condition and risk level.
2. Deterministic maturity, learning, measurement, magnitude and single-variable checks, backed either by the three direct verified status facts or by their deterministically derived verified lineage from raw visual facts.
3. An independent Risk Reviewer decision persisted before user review.
4. Explicit user approval.
5. A strict `VisualExecutionPlan` bound to client/task/plan, platform, Profile, application/window, domain/application allowlists, account/Campaign/page, operation and values, instruction, target, expected result, allowed ROI, risk, surface/account fingerprints, creation and expiry.
6. Two separately invoked visual reviewers agree on the currently visible platform, account name/id, Campaign name/id, page, operation, current/proposed values and target control with confidence `>= 0.85`.
7. A five-minute HMAC token containing the canonical SHA-256 execution-plan fingerprint and exactly one attempt.
8. The full guardrail fact lineage is reloaded before an approving risk review, user approval and commit/token consumption; stale, rejected, superseded, expired or cross-Campaign evidence cancels the pending authority.
9. The live screenshot and identity are projected back into a complete actual plan and compared byte-for-byte by fingerprint before token consumption, followed by terminal `executed` or `failed` state.

The token is stored only in server memory, is never returned to the browser, and is never included in a model prompt. A changed instruction, target, expected result, ROI, Profile, window, page, account, Campaign, value, identity result or surface; malformed signature; expiry; replay; cancellation; or second attempt burns or invalidates it. Native and visual fields come from the managed live browser and screenshot rather than from model assertions.

## Tool permission gate

Every tool call a model can make is classified in `TOOL_GATE_RULES` (`shared`) as `read`, `write` or `destructive` and is intercepted in `Agent.beforeToolCall` before the tool body runs. Read calls pass untouched. Write and destructive calls must prove the authority their rule declares: a same-client/task approval reference in a required status (ledger-writing skills require the `executed` approval), or the operator-held HMAC token minted at user approval. The gate mirrors the non-destructive checks of `ApprovalService.consume` — approved status, attempt budget, exact token-binding equality and expiry — but the HMAC signature and nonce hash are verified only inside `consume`, which remains the final authority. An unclassified tool fails closed as an approval-gated write, and `commit_approved_action` stays hard-blocked for the model because tokens never enter its context. Allowed write/destructive decisions and every denial are appended to the tamper-evident audit chain.

## Bash and the general tool set

The vendored general tools extend the threat model to the filesystem and the shell, and close it in three independent loops so bash cannot bypass the visual-only red line:

1. A deterministic, LLM-free classifier (`shared/bash-classifier.ts`) lexes every command line — quotes, pipes, redirections, command lists, substitutions — and classifies each simple command, taking the most severe verdict. Read-whitelisted programs (`ls`, `cat`, `grep`, `git status/diff/log`, …) flow at the read level. Anything else floors at approval-gated write: redirects, package installs, inline interpreter code, unknown programs and input the lexer cannot fully resolve. The threat-model channels are hard-denied with no approval path: network egress/ingress (`curl`, `wget`, `ssh`, `rsync`, netcat, package-registry and `git` remote subcommands), screen capture and UI scripting (`screencapture`, `osascript`), credential stores (`.ssh`, keychain `security`, `printenv`/`env`, `.env*`, the approval secret, `pi-auth.json`, `settings.json`, the audit chain), browser profile and cookie stores, privilege escalation, process control (`kill`, `launchctl`), scheduled persistence (`crontab`, `at`) and recursive-force deletion.
2. One protected-path policy is enforced on both sides of the surface. The workspace-aware matcher in `tools/general/protected-paths.ts` backs the read/write/edit path guard and the seatbelt generator: the `.adpilot/approval-secret`, `pi-auth.json` and `settings.json` files, every `.env*` file, PEM/key material, SSH/AWS/GnuPG/cloud config directories, `audit.jsonl` chain files, `browser-profiles/` and `browser-sessions/`, and the macOS browser profile/cookie stores are denied outright — read or write, with or without an approval. The classifier mirrors the same policy with root-independent token patterns, exempting only the public `.adpilot/skills` and `.adpilot/prompts` subtrees that remain readable through the read tools.
3. Execution happens exclusively inside macOS `sandbox-exec` with a generated seatbelt profile: `(deny network*)`, writes confined to the workspace and the temp directories, protected reads denied, and `screencapture`/`osascript` process-exec denied as extra hardening of the screenshot pipeline. The seatbelt is the OS-level floor that holds even when a command was misclassified — bash has no network regardless of classifier output, so it cannot reach advertising APIs, pull remote code or exfiltrate workspace data, and the `local-only` privacy semantics hold for the shell automatically. The child environment is an allowlist stripped of provider keys and tokens.

The sandbox fails closed: when `sandbox-exec` is unavailable the bash tool refuses to execute instead of silently degrading to an unsandboxed shell, so on non-macOS platforms bash simply does not run. Every invocation's classification — allowed or denied, with the decisive rule — is appended to the audit chain as `bash_classify`.

Plan mode grants no new authority in either direction. While enabled it contracts the main agent's tool set to the read-only surface and the gate hard-denies any non-read classification; disabling it returns the conversation to the normal pipeline, where every write still traverses the standard approval chain. Toggles are per-conversation, persisted as workspace metadata and chained into audit.

## Computer Use

AdPilot launches a dedicated browser Profile per client and persists its process id, application id, native window id/bounds and platform. The runtime obtains application, bundle id, PID, title/id, bounds, screen identity and DPR through native macOS APIs, then captures only that bound window. It validates the durable session before and after capture and immediately before native input. A closed/replaced window, changed PID/Profile/application, foreground switch or ambiguous restart is `BROWSER_SESSION_LOST`; it never rebinds automatically.

General desktop Computer Use applies the same native isolation to local windows:
each pointer/keyboard/scroll/drag action and exact-window close consumes a
short-lived, one-time capture lease bound to the product Session, PID, bundle id,
window id, bounds and capture dimensions. Coordinates outside that captured window
are rejected before native input. Pointer actions also require the same app and
window to remain frontmost, so a focus switch cannot redirect the mouse into
another application. Agent-facing window actions use an opaque observation id;
the model cannot supply or override native identity fields.

Every action is bound to task id, step id, plan id, full surface fingerprint, account fingerprint and allowed region. The policy validates screenshot/window coordinates and DPR, refuses repeated coordinates, executes one action at a time, takes a fresh screenshot after failure, escalates only the third non-mutating attempt, and never retries a mutation or timeout.

`ImageChangeVerifier` is limited to local tests. Production uses a separately invoked visual verifier, either an advanced endpoint or the configured image-capable Deep code model, to check the declared result against before/after ROIs. Any successful native action marks the task's screenshot-derived facts stale; a detected surface change does the same. Starting, resuming, replacing or closing a managed-browser session invalidates that client's prior visual evidence.

## Screenshot privacy

- Full screenshots are local artifacts with private file permissions and are never returned by settings/session APIs.
- Before target coordinates exist, a locator receives a browser-content crop with default browser-chrome, system-menu, avatar/email and notification masks. It never receives the uncropped window.
- After a target ROI exists, grounding and verification receive a tight crop around that target with surrounding pixels masked as other-Campaign or unrelated-financial data.
- Mutation identity is two-stage: the first locator identifies the visible account, Campaign, current-value and target regions; the second reviewer receives only their tight union with every gap masked. Those four agreed regions are stored with the approval plan and reused during commit review.
- Every disclosure records model provider/id, call role, screenshot id, ROI, masks, whether data left the machine and retention policy.
- Remote providers are blocked from receiving a full window. `local-only` privacy mode rejects remote screenshot calls entirely and also blocks remote providers on the conversational path (chat and planning), with loopback and private-network endpoints exempt; a blocked call is refused with `PRIVACY_MODE_REMOTE_PROVIDER_BLOCKED` before any content leaves the machine.

## Specialist fact boundary

Performance Analyst, Media Buyer and Measurement Reviewer requests cannot pass model-authored account numbers as ordinary JSON. Each numeric field path must name exactly one verified, unexpired, screenshot-backed Fact ID whose value matches byte-for-byte after numeric normalization. Every bound number in one request must use the same Campaign subject. Missing mappings, stale/migration evidence, predicate mismatch, ambiguous values and cross-Campaign joins stop before the specialist model receives the packet.

## Guardrail fact lineage

A caller may bind the exact verified `measurement_status`, `campaign_mature` and `learning_phase` Fact IDs directly. It may instead bind verified raw screenshot facts—such as conversions, observation days, visible learning status and optional measurement-integrity signals—from which deterministic advertising-core code derives and verifies those three facts. Derived facts retain their source screenshot, bounding box and complete Fact-ID lineage, with an expiry no later than the shortest-lived source.

Risk review, user approval and commit/token consumption reload that lineage and re-run the guardrail against the current client cap and active-experiment state. Model prose, specialist output and previously cached booleans never replace this validation.

## Monitoring alerts

Monitoring alerts enter the conversation as advisory user messages. They request analysis and recommendations only: the injected text states explicitly that an alert grants no approval authority, and any mutation it prompts still traverses the standard approval chain (prepare, risk review, user approval, token, commit). Every alert metric value must bind a verified Shared Fact ID rather than a free-floating number. Submission, deduplication, rate limiting, persistence, delivery and requeue transitions are chained into the audit log.

## Local data and secrets

- API keys can come from environment variables or the local Settings store. Settings and Pi OAuth credentials are written under the active Workspace with `0600` permissions; the settings API returns configuration flags but never secret values. `.env*` is ignored except `.env.example`.
- Custom OpenAI-completions- or Anthropic-messages-compatible provider definitions (base URL, API kind, optional key) live in the same private settings store; the settings view returns only `hasApiKey` for each custom provider, never the key.
- The approval secret is generated locally under `workspace/.adpilot/approval-secret` with private permissions when not explicitly configured.
- Audit values redact credential-like keys, bearer tokens and six-digit verification codes.
- Workspace path traversal and cross-client access are rejected.
- Advertising login is always manual inside the managed browser. AdPilot never reads or stores passwords, cookies, localStorage, OTPs, CAPTCHA answers or advertising-platform OAuth tokens.

## Operational guidance

Keep the server on loopback unless an authenticated reverse proxy is deliberately added. Back up client workspaces as sensitive business data. Review audit-chain verification after incidents. Treat a changed platform UI, popup, CAPTCHA, expired session or ambiguous target as a handoff condition, not permission to click blindly.

The distributed macOS application is ad-hoc signed with electron-builder identity `"-"` to seal bundle integrity without Apple credentials. It has no Developer ID, Team ID or notarization, so Gatekeeper may still require the user's explicit Open action. This must not be represented as either an Apple-trusted release or an unsigned/unsealed bundle. The desktop local trust boundary is recorded in [ADR 0009](architecture-decisions/0009-desktop-local-trust-boundary.md).
