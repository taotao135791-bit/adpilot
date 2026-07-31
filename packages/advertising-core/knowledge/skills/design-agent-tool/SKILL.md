---
name: design-agent-tool
description: Design or review agent tools and harness behavior with explicit authority, schemas, isolation, cancellation, idempotency, audit, and truthful result semantics. Use for agent harness, tool calling, MCP adapters, approvals, or computer-use boundaries.
---

# Design Agent Tool

Design each tool as a narrow capability crossing an untrusted model boundary.
The model proposes arguments; trusted code decides whether and how to act.

## Define the Contract

Specify:

- one clear purpose and an unambiguous name
- strict input and output schemas with size and count limits
- read, write, destructive, or external-communication classification
- exact workspace, account, session, application, and resource binding
- required approval or user gesture
- deterministic error codes and whether retry is safe
- timeout, cancellation, output cap, and cleanup behavior

Avoid free-form command or URL fields when a structured allow-listed operation
can express the same intent.

## Separate Authority

Keep secrets, approval tokens, signing keys, and privileged handles outside
model context. Bind authority to the intended actor, session, target, action,
arguments, expiry, and attempt count. Revalidate mutable targets immediately
before use.

For computer use, bind every action to one observed application and exact
window. Confine coordinates to that captured surface and reject focus,
identity, bounds, or generation changes. Never fall back to global mouse or
keyboard control.

## Make Execution Robust

1. Propagate cancellation through every adapter and child process.
2. Make repeated calls idempotent or reject replay explicitly.
3. Bound stdout, stderr, binary payloads, and retained session state.
4. Isolate filesystem, network, environment, and process access by default.
5. Treat an unknown post-mutation audit outcome as non-retryable until state is
   reconciled.
6. Return evidence of what changed, not only an optimistic message.

## Test the Boundary

Test malformed inputs, guessed identifiers, cross-session reuse, expired and
replayed authority, target changes after observation, cancellation, timeout,
process crash, audit failure, concurrent calls, output overflow, and secret
redaction. Verify that every unclassified operation fails closed.
