# Security model

## Authority boundary

AdPilot starts with no authority over an advertising account. Workspace configuration defines allowed apps/domains and business constraints. A visual task also declares an explicit permission level: `OBSERVE`, `INTERACT`, `MUTATE`, or `DESTRUCTIVE`. `VisualPolicy` rejects permission escalation, changed risk levels, out-of-bounds coordinates and non-allowlisted surfaces.

## Mutation protocol

A real change requires all of the following:

1. Exact operation fields: account, Campaign, operation, current value, proposed value, percentage, reason, evidence, expected impact, observation window, rollback condition and risk level.
2. Deterministic maturity, learning, measurement, magnitude and single-variable checks.
3. An independent Risk Reviewer decision persisted before user review.
4. Explicit user approval.
5. A five-minute HMAC token bound to approval id, client, platform, account, Campaign, operation, current/proposed values, risk, live native-surface fingerprint, expiry and exactly one attempt.
6. Token consumption before execution and terminal `executed` or `failed` state afterward.

The token is stored only in server memory, is never returned to the browser, and is never included in a model prompt. Any changed binding, malformed signature, expiry, replay, cancellation, second attempt, or changed live surface burns or invalidates it. Approval creation obtains the fingerprint from the native operator rather than trusting model output, and consumption re-identifies the foreground surface before execution.

## Computer Use

The runtime obtains the active application, bundle id, PID, window title/id, window bounds, screen identity and DPR through native macOS APIs, then captures that window. Every action is bound to task id, step id and its full surface fingerprint. It re-identifies immediately before execution, validates screenshot/window coordinates and DPR, refuses repeated coordinates, and never retries a mutation or timeout. A different app/window/PID/screen is a typed `SURFACE_CHANGED` blocker; an expected title change inside the same native window can proceed to visual verification.

`ImageChangeVerifier` is a conservative fallback for local tests. Production configuration uses an OpenAI-compatible visual verifier to check the declared expected result against before/after screenshots.

## Local data and secrets

- API keys can come from environment variables or the local Settings store. Settings and Pi OAuth credentials are written under the active Workspace with `0600` permissions; the settings API returns configuration flags but never secret values. `.env*` is ignored except `.env.example`.
- The approval secret is generated locally under `workspace/.adpilot/approval-secret` with private permissions when not explicitly configured.
- Audit values redact credential-like keys, bearer tokens and six-digit verification codes.
- Workspace path traversal and cross-client access are rejected.
- Use a dedicated browser Profile. Never save credentials, cookies or OTPs into prompts, task facts, screenshots metadata, or reports.

## Operational guidance

Keep the server on loopback unless an authenticated reverse proxy is deliberately added. Back up client workspaces as sensitive business data. Review audit-chain verification after incidents. Treat a changed platform UI, popup, CAPTCHA, expired session or ambiguous target as a handoff condition, not permission to click blindly.
