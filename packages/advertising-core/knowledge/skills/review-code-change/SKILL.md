---
name: review-code-change
description: Review code changes for correctness, regressions, security, privacy, API contracts, and missing tests. Use when asked to review a diff, pull request, commit, patch, or implementation.
---

# Review Code Change

Review the changed behavior, not only the changed lines. Treat the task as
read-only unless the user also asks for fixes.

## Reconstruct Intent

1. Read the request, repository instructions, diff, and surrounding callers.
2. Identify the contract that should remain true: inputs, outputs, authority,
   persistence, error handling, cancellation, and user-visible behavior.
3. Trace changed values across trust boundaries and downstream consumers.

## Look for Findings

Prioritize issues that can cause incorrect behavior, data loss, privilege
expansion, privacy leakage, or silent failure:

- missing validation or fail-open defaults
- identity, workspace, session, or resource confusion
- replay, race, retry, and time-of-check/time-of-use problems
- incomplete cancellation or cleanup
- swallowed errors and success claims without durable evidence
- secrets or private data in source, logs, telemetry, fixtures, or artifacts
- UI states that trap focus, hide errors, permit double submission, or mislead
  users about progress and authority
- untested branches, especially denial and partial-failure paths

Confirm each suspected issue against executable code. Do not report a style
preference as a defect.

## Report

List findings first, ordered by severity. For each finding, provide:

1. the exact file and location
2. the concrete failure scenario
3. the user or system impact
4. the smallest credible remediation

Then note unanswered questions and test gaps. If no material findings remain,
say so directly and describe residual risk or validation that was not possible.
