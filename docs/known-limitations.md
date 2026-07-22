# Known limitations and external requirements

No known in-scope implementation item is intentionally left as a stub. The following capabilities require environment-specific inputs or remain operational constraints:

- Live model calls require valid provider credentials. Repository tests use Pi's faux provider and do not spend external model quota.
- Live Computer Use requires either configured dedicated grounding plus verification endpoints or an authenticated image-capable code model, macOS Screen Recording/Accessibility permissions, and an authenticated dedicated browser Profile.
- No real advertising account was accessed in this repository run. `validate:google-ads:readonly` and `validate:google-ads:prepare` are production native validation harnesses, but a passing live artifact requires the operator's explicitly authorized, logged-in foreground account. Offline tests never fabricate that result.
- Login, passwords, cookies, OTP, CAPTCHA and recovery prompts are deliberately user-owned. AdPilot will not automate them.
- The server is safe by default on loopback but does not ship multi-user authentication. Add an authenticated gateway before binding to a shared interface.
- Scheduled/background reviews, team approval, cloud browser execution and direct advertising-platform APIs are extension targets, not hidden mock implementations in this release.
- If only the Daily model supports images and no dedicated endpoint is configured, the third visual attempt and verification reuse it; a dedicated/strong route provides better escalation.
- A transitive UI-TARS dependency emits Node's `punycode` deprecation warning; it does not fail tests or execution.
