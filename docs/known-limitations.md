# Known limitations and external requirements

No known in-scope implementation item is intentionally left as a stub. The following capabilities require environment-specific inputs or remain operational constraints:

- Live model calls require valid provider credentials. Repository tests use Pi's faux provider and do not spend external model quota.
- Live Computer Use requires an authenticated image-capable Daily or Deep code model, macOS Screen Recording/Accessibility permissions, and a manually logged-in AdPilot-managed browser Profile. Dedicated grounding/verifier endpoints are optional advanced overrides.
- No real advertising account was accessed in this repository run. `validate:visual:google-ads:observe` and `validate:visual:google-ads:prepare` are production native validation harnesses, but a passing live artifact requires the user's logged-in managed browser window and explicit client allowlist. Offline tests never fabricate that result.
- Login, passwords, cookies, OTP, CAPTCHA and recovery prompts are deliberately user-owned. AdPilot will not automate them.
- The server is safe by default on loopback but does not ship multi-user authentication. Add an authenticated gateway before binding to a shared interface.
- Scheduled/background reviews, team approval, cloud browser execution and direct advertising-platform APIs are extension targets, not hidden mock implementations in this release.
- If only one selected code model supports images, grounding, table reading and independent review use separately invoked roles on that model; escalation diversity is naturally lower than with two capable models.
- A transitive UI-TARS dependency emits Node's `punycode` deprecation warning; it does not fail tests or execution.
