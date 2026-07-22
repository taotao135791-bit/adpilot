# Pure-vision production audit

Date: 2026-07-22. Scope: application composition, computer use, tools, approvals, routing, runtime, orchestration, specialists, shared contracts, workspace, audit, desktop, CLI, evals, tests, and documentation.

## Pre-remediation findings

| Boundary | Existing behavior | Production gap |
| --- | --- | --- |
| Approval | Token bound platform/account/campaign/operation/values/risk/surface | Instruction, target, expected result, ROI, page, browser profile, window, and account identity were not one immutable plan fingerprint. |
| Mutation identity | One verifier checked a text description against a screenshot | No independently extracted account fingerprint and no second Deep Vision agreement at confidence 0.85. |
| Model productization | UI-TARS adapter was wired, with PiVision fallback | Ordinary settings exposed endpoint/protocol/coordinate internals and made the built-in automatic behavior unclear. |
| Native surface | macOS app/PID/window/bounds/screen/DPR and optional Chromium profile were probed | The product did not own a client-bound browser process/window lifecycle. |
| Account and campaign | Model prompt and approval values described identity | No screenshot-derived, evidence-bearing account/campaign fingerprint existed. |
| Table data | General screenshot grounding could inspect a table | No header/cell bounding boxes, overlap alignment, numeric normalization, independent verification, or low-confidence blocker. |
| Shared facts | A typed partial fact schema and specialist filter existed | Main orchestration still built a legacy object packet; cell evidence, subject/predicate/unit and staleness were incomplete. |
| Screenshot privacy | Active-window screenshots avoided the system desktop/menu bar | Full images were sent to providers without task ROI cropping, masking, retention metadata, or local-only enforcement. |
| Browser validation | The user foregrounded a browser and account config named a profile/domain | No product-managed profile directory, recorded PID/window id, lost-session state, or strict recovery. |
| Architecture boundary | Production modules currently contain no browser automation or advertising API SDK | No static CI test prevented a future regression to DOM/CDP/API execution. |
| Evaluation | 60 sanitized cases and an honest recorded-prediction evaluator existed | No command invoked the assembled product Computer Use providers directly, and report layers needed explicit separation. |
| Real browser harness | Observe/prepare native harness existed | Naming and artifact paths did not yet match the logged-in-browser pure-vision contract or include ROI/account evidence. |

## Retained invariants

- Advertising accounts use manual browser login only. Passwords, cookies, OTP, CAPTCHA and session storage remain user-owned and unread.
- Pi remains the only planning/session runtime; GUI models return one bounded action.
- Production account interaction stays screenshot → vision → one coordinate action → screenshot → vision verification.
- Playwright remains limited to fixture generation, mock/product tests, and screenshots.
- Deterministic advertising guardrails, independent risk review, explicit user approval, one-attempt execution, experiment tracking, and audit remain product-owned.

This document records the code state at the start of the remediation. Current behavior and validation evidence are maintained in the architecture, security, and test-report documents.

## Remediation state

| Finding | Implemented production control |
| --- | --- |
| Incomplete approval binding | Strict `VisualExecutionPlan` plus canonical SHA-256 fingerprint covers every native, identity, instruction, target, value, result, ROI, risk and lifetime field; mismatch burns the one-attempt token. |
| Weak mutation identity | `VisualAccountFingerprint` combines native surface evidence with two separately invoked pixel reviewers at confidence `>= 0.85`; conflicts, truncation, changed values and obscured identity fail closed. |
| Manual Computer Use composition | Daily/Deep code-model image capability is detected automatically. Normal settings show readiness and route; protocol/endpoints live under advanced controls. |
| Arbitrary foreground browser | `BrowserSessionManager` launches a dedicated Profile/window, persists client/PID/window/bounds/platform and requires exact foreground identity before capture and action. |
| Generic table reading | `VisualTableReader` reads ROI headers/cells and bounding boxes, normalizes advertising values, aligns scroll overlap and uses an independently invoked verification role before producing facts. |
| Legacy fact path | A durable `SharedFactLedger` drives root prompts and specialist packets; only same-client/task, verified, unexpired facts with screenshot evidence are usable. Legacy objects remain migration-only. |
| Full screenshot disclosure | Full PNGs stay local with private permissions. Grounding, verification, identity and table roles receive audited, masked ROIs; remote full-window and local-only/remote combinations are blocked. |
| Missing regression boundary | Architecture tests scan production modules for browser automation, DOM/CDP/accessibility and advertising API imports/calls. |
| Ambiguous evaluation claims | The report has separate Corpus Validation, Offline Prediction Eval, Live Model Eval and Real Browser Validation sections. Unconfigured external calls remain `not-run`, never inferred from oracle passes. |
| Unsafe validation preparation | Both harnesses require the managed browser. Prepare permits one `type` action and an observe-only confirmation, with no click/hotkey/Enter/retry path. Artifacts use `artifacts/visual-validation/`. |
