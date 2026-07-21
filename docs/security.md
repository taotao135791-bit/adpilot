# Security model

## Authority boundary

AdPilot starts with no authority over an advertising account. Workspace configuration defines allowed apps/domains and business constraints. A visual task also declares an explicit permission level: `OBSERVE`, `INTERACT`, `MUTATE`, or `DESTRUCTIVE`. `VisualPolicy` rejects permission escalation, changed risk levels, out-of-bounds coordinates and non-allowlisted surfaces.

## Mutation protocol

A real change requires all of the following:

1. Exact operation fields: account, Campaign, operation, current value, proposed value, percentage, reason, evidence, expected impact, observation window, rollback condition and risk level.
2. Deterministic maturity, learning, measurement, magnitude and single-variable checks.
3. An independent Risk Reviewer decision persisted before user review.
4. Explicit user approval.
5. A five-minute one-time HMAC token bound to approval id and the exact operation fingerprint.
6. Token consumption before execution and terminal `executed` or `failed` state afterward.

The token is stored only in server memory, is never returned to the browser, and is never included in a model prompt. Any changed account, Campaign, operation, current value or proposed value invalidates it.

## Computer Use

The runtime takes a fresh screenshot before every attempt. It stops after three failed visual attempts, escalates the third grounding attempt to the Strong tier, and never retries after a timeout because a late native action could otherwise be duplicated. Pause, user takeover and cancel are checked before capturing a new screen.

`ImageChangeVerifier` is a conservative fallback for local tests. Production configuration uses an OpenAI-compatible visual verifier to check the declared expected result against before/after screenshots.

## Local data and secrets

- API keys are environment variables. `.env*` is ignored except `.env.example`.
- The approval secret is generated locally under `workspace/.adpilot/approval-secret` with private permissions when not explicitly configured.
- Audit values redact credential-like keys, bearer tokens and six-digit verification codes.
- Workspace path traversal and cross-client access are rejected.
- Use a dedicated browser Profile. Never save credentials, cookies or OTPs into prompts, task facts, screenshots metadata, or reports.

## Operational guidance

Keep the server on loopback unless an authenticated reverse proxy is deliberately added. Back up client workspaces as sensitive business data. Review audit-chain verification after incidents. Treat a changed platform UI, popup, CAPTCHA, expired session or ambiguous target as a handoff condition, not permission to click blindly.
