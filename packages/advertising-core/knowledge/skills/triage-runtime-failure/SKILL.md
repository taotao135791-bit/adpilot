---
name: triage-runtime-failure
description: Diagnose runtime, build, test, and tool-call failures from evidence before proposing changes. Use when an agent, command, UI flow, integration, or application fails, hangs, crashes, or behaves inconsistently.
---

# Triage Runtime Failure

Determine the failure boundary and most likely cause before changing code.
Keep reproduction read-only whenever possible.

## Capture the Failure

1. Record the user action, expected result, actual result, timestamp, version,
   environment, and stable error code.
2. Collect the smallest relevant logs, traces, audit entries, and state
   snapshots. Redact credentials and private content before sharing.
3. Distinguish a timeout, cancellation, permission denial, invalid input,
   dependency outage, process crash, and audit uncertainty; they require
   different recovery behavior.

## Localize the Boundary

Trace one failing request through:

1. UI interaction and request construction
2. server or harness validation
3. permission and approval gate
4. tool adapter and process boundary
5. external service or operating-system call
6. result normalization, persistence, audit, and UI rendering

At each step, compare the expected invariant with observed evidence. Keep a
short hypothesis table with evidence for, evidence against, and the next
discriminating check.

## Reproduce

Prefer a deterministic, local, sanitized fixture. Change one variable at a
time. Check the denial, retry, cancellation, and partial-success paths in
addition to the happy path.

Do not repeatedly execute a state-changing operation when the prior outcome is
unknown. First reconcile external state or obtain new user authority.

## Conclude

State the cause only when evidence supports it. Otherwise report the narrowed
boundary, leading hypothesis, and missing evidence. Recommend a fix separately;
do not implement it unless the task includes implementation.
