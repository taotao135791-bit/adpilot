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

## Computer Use

AdPilot launches a dedicated browser Profile per client and persists its process id, application id, native window id/bounds and platform. The runtime obtains application, bundle id, PID, title/id, bounds, screen identity and DPR through native macOS APIs, then captures only that bound window. It validates the durable session before and after capture and immediately before native input. A closed/replaced window, changed PID/Profile/application, foreground switch or ambiguous restart is `BROWSER_SESSION_LOST`; it never rebinds automatically.

Every action is bound to task id, step id, plan id, full surface fingerprint, account fingerprint and allowed region. The policy validates screenshot/window coordinates and DPR, refuses repeated coordinates, executes one action at a time, takes a fresh screenshot after failure, escalates only the third non-mutating attempt, and never retries a mutation or timeout.

`ImageChangeVerifier` is limited to local tests. Production uses a separately invoked visual verifier, either an advanced endpoint or the configured image-capable Deep code model, to check the declared result against before/after ROIs. Any successful native action marks the task's screenshot-derived facts stale; a detected surface change does the same. Starting, resuming, replacing or closing a managed-browser session invalidates that client's prior visual evidence.

## Screenshot privacy

- Full screenshots are local artifacts with private file permissions and are never returned by settings/session APIs.
- Before target coordinates exist, a locator receives a browser-content crop with default browser-chrome, system-menu, avatar/email and notification masks. It never receives the uncropped window.
- After a target ROI exists, grounding and verification receive a tight crop around that target with surrounding pixels masked as other-Campaign or unrelated-financial data.
- Mutation identity is two-stage: the first locator identifies the visible account, Campaign, current-value and target regions; the second reviewer receives only their tight union with every gap masked. Those four agreed regions are stored with the approval plan and reused during commit review.
- Every disclosure records model provider/id, call role, screenshot id, ROI, masks, whether data left the machine and retention policy.
- Remote providers are blocked from receiving a full window. `local-only` privacy mode rejects remote screenshot calls entirely.

## Specialist fact boundary

Performance Analyst, Media Buyer and Measurement Reviewer requests cannot pass model-authored account numbers as ordinary JSON. Each numeric field path must name exactly one verified, unexpired, screenshot-backed Fact ID whose value matches byte-for-byte after numeric normalization. Every bound number in one request must use the same Campaign subject. Missing mappings, stale/migration evidence, predicate mismatch, ambiguous values and cross-Campaign joins stop before the specialist model receives the packet.

## Guardrail fact lineage

A caller may bind the exact verified `measurement_status`, `campaign_mature` and `learning_phase` Fact IDs directly. It may instead bind verified raw screenshot facts—such as conversions, observation days, visible learning status and optional measurement-integrity signals—from which deterministic advertising-core code derives and verifies those three facts. Derived facts retain their source screenshot, bounding box and complete Fact-ID lineage, with an expiry no later than the shortest-lived source.

Risk review, user approval and commit/token consumption reload that lineage and re-run the guardrail against the current client cap and active-experiment state. Model prose, specialist output and previously cached booleans never replace this validation.

## Local data and secrets

- API keys can come from environment variables or the local Settings store. Settings and Pi OAuth credentials are written under the active Workspace with `0600` permissions; the settings API returns configuration flags but never secret values. `.env*` is ignored except `.env.example`.
- The approval secret is generated locally under `workspace/.adpilot/approval-secret` with private permissions when not explicitly configured.
- Audit values redact credential-like keys, bearer tokens and six-digit verification codes.
- Workspace path traversal and cross-client access are rejected.
- Advertising login is always manual inside the managed browser. AdPilot never reads or stores passwords, cookies, localStorage, OTPs, CAPTCHA answers or advertising-platform OAuth tokens.

## Operational guidance

Keep the server on loopback unless an authenticated reverse proxy is deliberately added. Back up client workspaces as sensitive business data. Review audit-chain verification after incidents. Treat a changed platform UI, popup, CAPTCHA, expired session or ambiguous target as a handoff condition, not permission to click blindly.

The distributed macOS application is ad-hoc signed with electron-builder identity `"-"` to seal bundle integrity without Apple credentials. It has no Developer ID, Team ID or notarization, so Gatekeeper may still require the user's explicit Open action. This must not be represented as either an Apple-trusted release or an unsigned/unsealed bundle. The desktop local trust boundary is recorded in [ADR 0009](architecture-decisions/0009-desktop-local-trust-boundary.md).
