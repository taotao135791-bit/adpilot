# Computer Use design

Status: target safety and execution contract

## Ownership

Each Computer task belongs to exactly one `sessionId`, `runId`, `taskId`, client, browser Profile, native application/window, account, and Campaign. A singleton mutable runtime is not permitted.

## Task state machine

```text
queued
→ checking_permissions
→ capturing
→ observing
→ grounding
→ policy_check
→ waiting_approval (when required)
→ executing_one_action
→ recapturing
→ verifying
→ completed

Any active state
→ pausing → paused
→ stopping → stopped
→ takeover_requested → quiescent → user_control
→ blocked | failed
```

Every asynchronous boundary checks an AbortSignal and the current generation. Native input requires a final lease check immediately before the helper command. Pause/takeover acknowledges only after the actor is quiescent.

## Native helper protocol

- Shipped Swift executable, later replaceable by signed XPC.
- Versioned JSON or MessagePack envelopes over child stdio; no TCP listener.
- Random per-launch authentication token, command ID, monotonic sequence, deadline, and response correlation.
- Commands: capability/permission status, window/display list, active identity, bounded capture, click, type, key, scroll, activate, cursor, and user-input observation.
- The helper receives no prompt, secrets, model configuration, plugin code, or advertising policy.
- The parent validates all helper responses against schemas and records redacted audit facts.

## Perception

Use the strongest locally available evidence in order:

1. Native window/app/display identity.
2. Browser DOM/CDP only inside a future dedicated product browser and only as observation evidence.
3. Accessibility tree when permission is present.
4. OCR and visual grounding.
5. Screenshot history and prior verified regions.

Mutation identity needs independent account, Campaign, current-value, and target evidence. A changed page or window invalidates grounding.

## Mutation protocol

```text
read current exact value
→ bind verified fact and ROI
→ deterministic guardrail
→ risk review
→ user approves exact before/after plan
→ execute one mutation action sequence once
→ reopen/reread the authoritative value
→ normalize unit/currency
→ compare exact expected value
→ mark executed only on equality
```

`done`, screenshot hash change, a model success boolean, or free-text expected result can never mark a mutation executed. Ambiguous results move to `needs_review`; mutations are not retried.

## Live View

- Redacted screenshot frames or bounded window thumbnails.
- Current app/window/page/goal and next action.
- Cursor, allowed region, grounding overlay, confidence, and screenshot history.
- Pause, Resume, Stop, Step, Take Over, and Give Back.
- Replay is built from immutable action/screenshot metadata and locally stored artifacts.

## Evaluation

Offline fixtures measure only protocol regressions. Live reports separately record:

- page/account/Campaign identity accuracy;
- grounding and OCR exactness;
- click/input success;
- takeover and wrong-target rate;
- mutation once-only rate;
- exact post-change verification rate;
- time and action count.

No logged-in browser or credential means `not-run`.

