# Google Ads live evaluation

Fixture replay, live model calls against fixtures, logged-in browser validation and a
real advertising mutation are four different evidence classes. Reports keep them
separate.

## Commands and report contract

Every P0 command prints and persists a `ComputerUseEvaluation` JSON document:

```bash
pnpm test:computer:google-ads-readonly -- \
  --client <client-id> \
  --test-account <account-ref> \
  --browser-profile <managed-profile> \
  --campaign <exact-campaign-name>

pnpm test:computer:google-ads-prepare -- \
  --client <client-id> \
  --test-account <account-ref> \
  --browser-profile <managed-profile> \
  --campaign <exact-campaign-name> \
  --draft-budget <exact-value>

pnpm test:computer:google-ads-mutation
```

With no arguments, the first two commands return
`blocked-by-no-test-account`. This is a successful execution of the diagnostic
command, but it is not a successful evaluation run. Its metrics contain `runs: 0`
and all rates are `null`; the report never converts zero observations into 100%.

The `evidenceClass` and execution flags make it impossible to silently relabel
fixture replay, live model calls over fixtures, or a native-helper smoke test as a
real-browser result. Reports are written under
`artifacts/evals/google-ads/` with owner-only file permissions.

## Stage A — readonly

The harness requires:

- a user-owned, manually authenticated AdPilot browser profile;
- a client account binding allowlisting `ads.google.com`;
- a connected PID/profile/window lease;
- Screen Recording and Accessibility status appropriate to the requested actions;
- an explicitly named campaign.

It may navigate and scroll, but it cannot type, save, publish, delete or enter billing.
Every value includes a before/after evidence reference and identity fingerprint.
The wrapper also requires `--test-account`; the bound workspace `accountRef` must
match that exact value.

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

The P0 `test:computer:google-ads-mutation` command is fail-closed but executable.
It accepts only an existing exact product Approval in `pending_user` state, after
the deterministic risk reviewer has approved it. Before it can enter the one-shot
production commit path, all of the following must be supplied:

```text
--product-session-id
--approval-id
--client
--test-account
--browser-profile
--campaign
--campaign-id
--field
--old-value
--new-value
--approval-file
--allow-test-mutation
```

The approval file must be a regular, non-symlink, owner-only (`0600`) JSON file,
issued no more than five minutes ago, expiring within ten minutes, and exactly bound
to every named value:

```json
{
  "schema": "AdPilotGoogleAdsTestMutationApproval",
  "schemaVersion": 1,
  "approvalId": "00000000-0000-4000-8000-000000000000",
  "approvedBy": "named-operator",
  "issuedAt": "2026-07-28T10:00:00.000Z",
  "expiresAt": "2026-07-28T10:05:00.000Z",
  "singleUse": true,
  "productSessionId": "00000000-0000-4000-8000-000000000001",
  "clientId": "explicit-test-client",
  "testAccount": "explicit-test-account",
  "browserProfile": "isolated-test-profile",
  "campaign": "explicit-test-campaign",
  "campaignId": "immutable-test-campaign-id",
  "field": "set_daily_budget",
  "oldValue": "100",
  "newValue": "101"
}
```

The product session must belong to the same client, be
`waiting_for_approval`, include Google Ads, and carry an approval-gated
`EXECUTE` permission profile bound to the exact account and managed browser
profile. The persisted product Approval, its complete visual plan, its deterministic
guardrail, the fresh external authorization, and every command-line binding must all
agree.

Only then does the wrapper call `approveByUser` and immediately pass the returned
in-memory token to `commitApprovedVisualAction` once. The token is never written to
the report or retained for a retry. A `passed` result additionally requires the
typed refreshed persistence proof: a refreshed-frame hash, matching identity,
account and campaign, the exact new value, timestamp and evidence IDs. Absence or
failure of that proof is `failed`/unknown even if native input may already have
executed, and it never causes a second submission. This repository never chooses an
account or campaign on behalf of the operator.

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

`blocked-by-permission` means Screen Recording, Accessibility, or fresh operator
approval is absent. `blocked-by-missing-credentials` means the configured image
provider cannot make the live visual call. `blocked-by-no-test-account` means an
explicit isolated account/campaign binding is absent. A disconnected managed browser
is `not-run`. Only a completed browser harness with its evidence manifest may be
`passed`.
