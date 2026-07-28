# Google Ads live evaluation

Fixture replay, live model calls against fixtures, logged-in browser validation and a
real advertising mutation are four different evidence classes. Reports keep them
separate.

## Stage A — readonly

The harness requires:

- a user-owned, manually authenticated AdPilot browser profile;
- a client account binding allowlisting `ads.google.com`;
- a connected PID/profile/window lease;
- Screen Recording and Accessibility status appropriate to the requested actions;
- an explicitly named campaign.

It may navigate and scroll, but it cannot type, save, publish, delete or enter billing.
Every value includes a before/after evidence reference and identity fingerprint.

## Stage B — prepare, never submit

The user chooses the exact account, campaign, field and draft value. The harness reads
the current value, types only the exact allowlisted draft and confirms that it remains
unsubmitted. It has retry policy `none`; Save/Apply/Enter/hotkeys are forbidden.
Reject, takeover or identity change cancels the draft and invalidates its coordinates.

## Stage C — controlled mutation

Stage C is not run merely because its code exists. A command requires a fresh,
single-use approval bound to:

- client/account/customer ID;
- campaign name and immutable campaign identifier;
- browser profile, PID, window, URL/page type and surface fingerprint;
- field, exact old value and exact new value;
- expiry, guardrail facts and rollback/verification plan.

The runtime rereads identity and old value immediately before consuming the approval,
submits once, then rereads the exact field and refreshes/re-enters before an independent
verification. Timeout or ambiguous platform feedback is `unknown`, never an automatic
second submission.

## Statuses

```text
passed
failed
skipped
not-run
blocked-by-permission
blocked-by-missing-credentials
blocked-by-no-test-account
```

The repository does not contain Google credentials or a production test target.
Consequently this P0 batch may complete implementation and automated safety tests
while keeping real-account stages honestly blocked/not-run.

