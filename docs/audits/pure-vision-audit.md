# Pure-vision production audit

Date: 2026-07-22. Scope: application composition, computer use, tools, approvals, routing, runtime, orchestration, shared facts, desktop, CLI, evaluation, packaging and release documentation.

Status: implementation audit. The final test count, live evaluation result and DMG metadata are recorded from the final verification run in [the release verification report](../test-report.md); this audit makes no substitute claim for them.

## Non-negotiable product boundary

- Advertising accounts are authenticated manually in an AdPilot-launched, client-scoped browser Profile. The product does not read passwords, cookies, localStorage, OTPs, CAPTCHAs or browser DOM.
- Production interaction is: native surface identity → local full screenshot → cropped/masked locator view → tight target ROI → one bounded vision action → deterministic policy → native input → new tight screenshot view → independent verification.
- No advertising API, advertising-account OAuth, CDP, WebDriver, DOM selector, accessibility-tree, browser-storage or automated-login path is part of product authority. Architecture tests are intended to reject future production imports/calls that cross this boundary.
- Pi owns the conversation and planning loop. A visual provider only returns a single typed action; it does not grant authority, own retries or execute a browser loop.

## Current controls and their evidence boundary

| Boundary | Implemented control | What it proves / does not prove |
| --- | --- | --- |
| Browser session | `BrowserSessionManager` records client, dedicated Profile, PID, native window/bounds and platform; capture/action re-check the active foreground surface. Drift, replacement, close or Profile ambiguity stop with a typed blocker. | Proves local binding enforcement in product tests; it is not a claim that a real account was logged in or changed. |
| Native surface | Native identity includes app/PID/window/bounds/display scale and a surface fingerprint. Screenshot coordinates are checked before conversion to native input coordinates. | A different app/window/bounds/DPR fails closed. Platform coverage beyond the implemented native adapter remains an operational boundary. |
| Visual identity | Before mutation, the first reviewer locates screenshot-derived account/Campaign/current-value/target regions in a cropped browser-content image with default masks. The second reviewer receives only the tight union of those four regions with all intervening pixels masked. Both must agree at the configured threshold; the regions are persisted with the plan and reused at commit. | Distinct calls and audit records are enforced; if one selected code model services both calls, provider diversity is lower even though roles remain separate. The full screenshot remains local. |
| Shared facts and specialists | `VisualTableReader` records header/cell ROI evidence, normalization, bounding boxes, screenshot IDs and independent verification. Performance Analyst, Media Buyer and Measurement Reviewer inputs bind every account-number field path to one exact same-value Fact ID, and every number in one packet must share the same Campaign subject. | Fixture/offline facts do not become real-account measurements. Low-confidence, loading, truncated, conflicting, stale, unbound or cross-Campaign cells block rather than guess. |
| Deterministic mutation guardrail | A `mutate`/`destructive` approval needs verified `measurement_status`, `campaign_mature` and `learning_phase` facts for the intended Campaign. It accepts their three exact IDs directly, or exact verified raw visual metrics/status Fact IDs from which deterministic code derives and verifies the same predicates while preserving the complete lineage. It recomputes the advertising-core decision from numeric before/after values, verified statuses, active experiments and `min(client maximum, 20%)`. | Models cannot manufacture the attestation. Before an approving risk review, user approval and commit/token consumption, the service reloads every source/derived fact and rechecks lifecycle, provenance, expiry and Campaign binding. A page/session invalidation, tampering or policy drift cancels pending authority. |
| Approval authority | The immutable `VisualExecutionPlan` covers client/task, platform, Profile, native app/window, allowlists, account/Campaign/page identity, operation/values, instruction, target, expected result, allowed ROI, risk, surface/account fingerprints and lifetime. Its SHA-256 fingerprint and the guardrail fingerprint bind the HMAC, five-minute, one-attempt token. | A request client cannot replace plan details after approval. Any live-plan mismatch burns the token and needs a new approval. |
| User disclosure | The desktop approval card renders all plan fields, allowed ROI, validity, surface/account/plan/guardrail fingerprints, guardrail allowed/fresh-review/cap/reasons/single-variable status and exact evidence Fact IDs before approval. | It exposes what was authorized; it does not itself authorize or execute a change. |
| Runtime control | Server state reports computer execution status as `running`, `paused`, `cancelled` or `unavailable`. Pause, takeover, resume and cancel endpoints return the runtime result; takeover remains paused until an explicit resume. No computer runtime is reported as unavailable rather than successful. | The UI reflects server/runtime state, not an optimistic local toggle. A pause can only stop the next action boundary; it cannot roll back a native action that already completed. |
| Screenshot privacy | Full captures remain in the local Workspace. With no coordinates, a locator receives a browser-content crop and default masks; with a target, calls receive a tight crop with surrounding other-Campaign/unrelated-financial pixels masked. Identity review narrows from the locator view to four explicit regions. Every role is separately audited, and `local-only` rejects remote visual providers. | This is data-flow enforcement, not a promise that a remote model provider has no independent retention policy. |

## Desktop and release trust boundary

The Electron application starts the same API on a random loopback port. Its renderer uses `contextIsolation`, sandbox and no Node integration; permission requests are denied by default. Desktop navigation is trusted only when `new URL(url).origin` exactly equals the current random local origin. Any other internal navigation is denied; only ordinary `http:` and `https:` URLs are handed to the OS browser. The app loads `.env` only from its Electron user-data directory, not the caller's working directory.

The distribution disables certificate discovery (`CSC_IDENTITY_AUTO_DISCOVERY=false`) and uses electron-builder's certificate-free ad-hoc identity (`identity: "-"`). This seals the macOS bundle for local integrity verification without a Developer ID or Team ID. The DMG is not notarized or Apple-trusted and may need explicit user confirmation in Gatekeeper. `LICENSE`, `LICENSES.md`, `THIRD_PARTY_NOTICES.md` and `licenses/**` are included in both CLI publication files and Electron packaging inputs.

Actual artifact: `AdPilot-0.1.1-arm64.dmg`, 144,693,653 bytes, SHA-256 `2ea1ddbedd8541c3d1f5d1b3f8ad2ec401fd977101b6b3228ffe7e09a9b576d0`, `hdiutil verify` `VALID`, `codesign --verify --deep --strict` passed with ad-hoc identity `-` (no Developer ID/Team ID, not notarized). Packaged-license inspection confirmed `/LICENSE`, `/LICENSES.md`, `/THIRD_PARTY_NOTICES.md` and all three `/licenses/*.txt` notices inside `app.asar`.

## Evaluation and harness claims

| Layer | Inputs | Permitted claim |
| --- | --- | --- |
| Product/unit/integration tests | faux Pi, mock dashboard, local filesystem and deterministic adapters | Contract and regression behavior only. |
| Visual corpus/replay | 85 sanitized grounding/verification/replay cases plus a separate 7-case identity oracle and fixture annotations | Protocol/oracle and replay coverage only; never a live model score. |
| Offline prediction eval | an operator-supplied recorded prediction file | Comparison for that file only; never a real browser or model-provider claim. |
| Live Model Eval | configured visual credential or advanced endpoint; direct product visual interfaces | Live score only when command executes. With no usable credential it is exactly `not-run`. |
| Real Browser Validation | manually logged-in managed browser, allowlisted client and local artifact manifest | Native logged-in-browser evidence only. It is not a submitted account mutation. |

The logged-in-browser `readonly` harness observes. The `prepare` harness only types into a field the user already opened and focused, without Enter, click, hotkey, save/apply/publish or retry; it then observes. It does not provide a general UI automation channel and does not replace the approval path.

## Release checklist

1. Run all commands in [docs/test-report.md](../test-report.md) from a clean checkout.
2. Keep live model evaluation `not-run` when no release credential is intentionally supplied.
3. Keep real browser validation `not-run` when no actual managed-browser artifact manifest exists.
4. Verify the final ad-hoc signed DMG and packaged app with `hdiutil`/`codesign`, inspect the bundled legal notices, confirm no Developer ID/Team ID/notarization claim, and record actual artifact metadata.
5. Publish only the output of the final run; replace every `PENDING_FINAL_VERIFICATION` marker with directly observed data or retain the marker.
