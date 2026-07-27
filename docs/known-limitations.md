# Known limitations and external requirements

No known in-scope implementation item is intentionally left as a stub. The following capabilities require environment-specific inputs or remain operational constraints:

- Live model calls require valid provider credentials. Repository tests use Pi's faux provider and do not spend external model quota.
- Live Computer Use quality is not inferred from fixture replay. `eval:computer-use:live` is `not-run` without a usable visual credential or advanced endpoint; this is the correct release status, not a failed score or a synthetic pass.
- Live Computer Use requires an authenticated image-capable Daily or Deep code model, macOS Screen Recording/Accessibility permissions, and a manually logged-in AdPilot-managed browser Profile. Dedicated grounding/verifier endpoints are optional advanced overrides.
- No real advertising account was accessed in this repository run. `validate:google-ads:readonly` and `validate:google-ads:prepare` are production native validation harnesses, but a passing live artifact requires the user's logged-in managed browser window and explicit client allowlist. Offline tests never fabricate that result.
- Login, passwords, cookies, OTP, CAPTCHA and recovery prompts are deliberately user-owned. AdPilot will not automate them.
- The server is safe by default on loopback but does not ship multi-user authentication. Add an authenticated gateway before binding to a shared interface.
- Scheduled/background reviews, team approval, cloud browser execution and direct advertising-platform APIs are extension targets, not hidden mock implementations in this release.
- If only one selected code model supports images, grounding, table reading and independent review use separately invoked roles on that model; escalation diversity is naturally lower than with two capable models.
- Deterministic mutation guardrails intentionally require verified `measurement_status`, `campaign_mature` and `learning_phase` facts for the target Campaign. They may be read directly or deterministically derived from verified screenshot-backed raw metrics/status facts. If the UI cannot expose sufficient source evidence, the change is blocked rather than inferred from narrative, historical migration or a model claim.
- The open-source macOS app is certificate-free ad-hoc signed (`identity: "-"`) so its sealed bundle can be checked for integrity, but it has no Developer ID, Team ID or notarization. Users may need macOS's explicit Open action. An Apple-trusted signing/notarization release requires separate credentials and authority.
- Conversation fork anchors resolve only for messages written since fork support shipped. Forking at an older message — one with no linked session entry, or one answered directly without a model run — returns 409 (`invalid_fork_target`) instead of a fork.
- Rate-limited monitoring alerts are not dropped: they persist like pending alerts and are delivered when the client's next session run starts, so an alert storm surfaces later rather than immediately.
- Model and provider changes require a restart to take effect; the running server keeps the routing it started with.
- Under `local-only` privacy mode the conversational path blocks remote providers, so a public enterprise gateway endpoint is rejected there even though it is a valid custom provider; loopback and private-network endpoints remain exempt.
- A transitive UI-TARS dependency emits Node's `punycode` deprecation warning; it does not fail tests or execution.
- The vendored `bash` tool is macOS-only: it executes exclusively through `/usr/bin/sandbox-exec`, so on other platforms it fails closed and never runs an unsandboxed shell.
- The in-process `grep` evaluates model-supplied regexes with the JavaScript engine, not ripgrep's RE2; pathological patterns have no ReDoS immunity beyond the tool timeout, so patterns should stay simple.
- Filesystem walking for `grep`/`find`/`ls` honors a fixed ignore set (`.git`, `node_modules`) rather than full `.gitignore` semantics.
- A hard-denied bash command can appear at the tool gate as its mapped `destructive` class with a `succeeded` gate decision (the gate only checks approval authority); the full story — the deny verdict, the decisive rule and the non-execution — lives in the tool-side `bash_classify` audit entry with status `denied`.
- The seatbelt profile intentionally leaves the system temp directories writable; write confinement is "workspace plus temp", not the workspace alone.

## Next steps

- Run `eval:computer-use:live` with deliberately supplied image-capable provider credentials and publish the resulting live report separately from fixture coverage.
- Run the read-only and prepare native harnesses against a manually authenticated, allowlisted managed browser; do not reinterpret them as submitted advertising changes.
- Add an authenticated gateway and an operator-identity policy before any shared-network or multi-user deployment.
- Expand and continuously refresh sanitized visual fixtures as supported advertising interfaces change, especially localization, responsive layout and obstructed-state cases.
- Add Windows/Linux native surface adapters only with equivalent process/window/Profile binding, screenshot minimization and pre-input validation.
- If maintainers later obtain Apple authority, add Developer ID signing and notarization as a distinct release lane while retaining the reproducible certificate-free build.
