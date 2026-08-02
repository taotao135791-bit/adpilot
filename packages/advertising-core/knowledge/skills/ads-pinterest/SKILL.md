---
name: ads-pinterest
description: >-
  Read-only Pinterest Ads audit for account access, conversion tracking, catalogs,
  campaign structure, delivery, creative, and reporting. Use for evidence-bound
  Pinterest advertising reviews.
---

# Pinterest Ads Read-Only Audit

## Purpose and Boundary

Audit Pinterest advertising evidence without changing platform state. Use only
official Pinterest capabilities and the account's own evidence. Do not invent
benchmarks, percentages, limits, format specifications, or expected performance.

Treat this skill as advisory knowledge. It grants no API access and does not
authorize tool execution. Keep the audit read-only even when a supplied token or
connected tool has broader permissions.

## Access Preflight

Before requesting data:

1. Confirm that the operator has a Pinterest business account and access to the
   intended ad account.
2. Confirm that the developer app is approved for Pinterest API access.
3. Confirm the exact business and ad-account identifiers in scope.
4. Use OAuth authorization with the least privilege required for the audit.
5. Request `ads:read` for advertising evidence. Request `catalogs:read` only when
   catalog evidence is in scope.
6. Do not request `ads:write`, `catalogs:write`, or any other write scope.
7. Record missing app approval, business access, ad-account access, or billing and
   agreement readiness as an access limitation; do not attempt to bypass it.

Never copy access tokens, app secrets, customer lists, or user-level conversion
data into the audit. Redact identifiers that are not needed to support a finding.

## Evidence Rules

Accept official API responses, Ads Manager exports, catalog diagnostics, tracking
diagnostics, and screenshots supplied by the user. Record the source, account,
reporting window, timezone, attribution settings, and retrieval time for each item.

Classify each check as:

- **Confirmed** — the supplied evidence directly supports the statement.
- **Needs attention** — the supplied evidence shows a contradiction, error, or
  mismatch with the user's stated goal.
- **Unknown** — the necessary evidence or access is missing.
- **Not applicable** — the user confirms the capability is outside this account's
  operating model.

Do not convert missing evidence into a failure. Do not create a weighted health
score unless the user supplies the scoring rubric.

## Audit Workflow

### 1. Account and Access

- Identify the business account, ad account, ownership relationship, and user role
  represented by the evidence.
- Verify that the approved app and OAuth grant resolve to the intended account.
- Confirm that the audit uses only the required read scopes.
- Record account eligibility, agreement, billing, or access errors exactly as the
  platform returns them.
- Flag any mismatch between the requested account and returned advertiser data.

### 2. Conversion Tracking

- Inventory the conversion sources in use: Pinterest Tag, Conversions API, mobile
  app measurement, or offline conversion upload.
- Inspect available event and diagnostic evidence without sending test events or
  editing configuration.
- Compare event names, identifiers, timestamps, and attributed outcomes across the
  available sources.
- When Pinterest Tag and Conversions API both send the same event, inspect the
  available deduplication evidence and report uncertainty when it is unavailable.
- Record consent, privacy, hashing, or data-handling gaps visible in the supplied
  implementation evidence. Do not expose event payloads containing personal data.

### 3. Catalogs

Run this section only for accounts that use catalogs or shopping ads.

- Use `catalogs:read` to inventory catalogs, feeds, product groups, and available
  ingestion diagnostics.
- Inspect feed status, item-level errors, and product-group coverage reported by
  Pinterest.
- Confirm whether the business has the domain and account access required for its
  stated shopping workflow, using evidence rather than assumption.
- Link catalog or feed errors to affected campaign evidence when identifiers make
  that relationship explicit.
- Do not edit feeds, product groups, items, or catalog connections.

### 4. Campaign Structure

- Map the official hierarchy from campaign to ad group to ad for the selected ad
  account.
- Record campaign objectives, entity status, dates, budgets, bids, placements,
  targeting, and associated Pins only when returned by the API or export.
- Compare the hierarchy and settings with the user's documented objective and
  naming model.
- Identify orphaned, contradictory, duplicate, or unexpectedly inactive entities
  only when the evidence supports the relationship.
- Do not infer a preferred structure or numeric threshold from generic industry
  practice.

### 5. Delivery and Targeting

- Compare delivery and outcome data across the available campaign, ad-group, ad,
  targeting, keyword, or product-group breakdowns.
- Preserve the selected reporting window, timezone, attribution window, and report
  time so comparisons remain like-for-like.
- Separate a platform-reported delivery restriction from low observed delivery and
  from missing evidence.
- Describe concentration, inconsistency, or trend changes using the account's own
  data; do not label them against an invented benchmark.
- Treat any proposed budget, bid, placement, schedule, or targeting change as a
  separate write action, outside this audit.

### 6. Creative

- Inventory the Pins and creative records associated with the audited ads.
- Compare available creative status, destination, message, and product association
  with the campaign objective and supplied brand brief.
- Record platform-returned review or delivery issues verbatim only as short facts;
  paraphrase longer policy text and link its official source.
- Use outcome breakdowns to describe relative performance inside this account.
- Do not claim that a creative format, duration, dimension, or result is required
  unless current official documentation and the exact account evidence support it.
- Do not create, publish, edit, or delete Pins or ads.

### 7. Reporting

- Choose the reporting level that matches the question: advertiser, campaign,
  ad group, ad, keyword, or product group.
- Use synchronous or asynchronous reporting only as supported by the connected
  read-only integration and the requested data volume.
- Preserve metric names and definitions from the current API. Record ambiguous or
  unavailable definitions as unknown.
- Reconcile totals only across compatible windows, attribution settings, report
  times, currencies, and entity scopes.
- Keep observations separate from recommendations and from any proposed mutation.

## Output Contract

Return:

1. **Scope and access** — account identifiers in redacted form, OAuth scopes,
   reporting window, timezone, and unavailable evidence.
2. **Evidence matrix** — section, status, observation, evidence source, affected
   entity, and confidence.
3. **Findings** — account, tracking, catalog, structure, delivery, creative, and
   reporting observations, with unknowns stated explicitly.
4. **Read-only next checks** — additional reports or diagnostics that can close an
   evidence gap without changing state.
5. **Proposed changes** — a separate, unexecuted list containing the exact entity,
   current value, proposed value, expected purpose, risk, and rollback path.

## Exact Approval for Any Write

Do not perform a write as part of this skill. A user request to "optimize," "fix,"
or "apply recommendations" is not approval for an unspecified batch of changes.

For every proposed write, require a separate approval that names the exact account,
entity, operation, and before/after value. Reconfirm approval if the entity, value,
or scope changes. Use a separately reviewed write-capable integration; never widen
the read-only OAuth grant silently. Keep campaign, ad-group, ad, Pin, targeting,
budget, bid, audience, conversion, and catalog mutations outside the audit run.

## Official Sources

- [Pinterest API for Ads](https://developers.pinterest.com/usecase/ads/)
- [Ads overview](https://developers.pinterest.com/docs/work-with-ads/ads-overview/)
- [Authentication and authorization](https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/)
- [Quickstart tools and approved-app access](https://developers.pinterest.com/docs/developer-tools/quickstart-tools/)
- [Managing ads](https://developers.pinterest.com/docs/work-with-ads/managing-ads/)
- [Campaigns and ad groups](https://developers.pinterest.com/docs/work-with-ads/create-campaigns-and-ad-groups/)
- [Ads reporting](https://developers.pinterest.com/docs/analytics-and-reports/ads-reporting/)
- [Conversion tracking](https://developers.pinterest.com/docs/track-conversions/understand-conversions-and-how-to-track-them/)
- [Pinterest Tag](https://developers.pinterest.com/docs/track-conversions/pinterest-tag/)
- [Shopping and catalogs](https://developers.pinterest.com/docs/work-with-catalogs/shopping-overview/)
