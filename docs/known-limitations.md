# Known limitations and external requirements

No known in-scope implementation item is intentionally left as a stub. The following capabilities require environment-specific inputs or remain operational constraints:

- Live model calls require valid provider credentials. Repository tests use Pi's faux provider and do not spend external model quota.
- Live Computer Use requires at least one selected code model with image input, macOS Screen Recording/Accessibility permissions and an authenticated dedicated browser Profile.
- No real advertising account was accessed during development. The end-to-end mutation test uses the included local console so it cannot validate a future platform UI redesign, account-specific permissions or regional consent screens.
- Login, passwords, cookies, OTP, CAPTCHA and recovery prompts are deliberately user-owned. AdPilot will not automate them.
- The server is safe by default on loopback but does not ship multi-user authentication. Add an authenticated gateway before binding to a shared interface.
- Scheduled/background reviews, team approval, cloud browser execution and direct advertising-platform APIs are extension targets, not hidden mock implementations in this release.
- If only the Daily model supports images, the third visual attempt and verification reuse it; selecting an image-capable Deep model provides stronger escalation.
- A transitive UI-TARS dependency emits Node's `punycode` deprecation warning; it does not fail tests or execution.
