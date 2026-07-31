---
name: review-plugin-safety
description: Review plugins, MCP servers, connectors, and skills before adoption, covering provenance, licenses, signatures, integrity, permissions, secrets, isolation, data flow, and rollback. Use when evaluating, installing, publishing, or updating ecosystem extensions.
---

# Review Plugin Safety

Treat discovery metadata as a lead, not a security endorsement. Do not install
or execute an extension until its artifact and requested authority are
reviewed.

## Verify Provenance

1. Prefer the publisher's official repository or service documentation.
2. Record the source URL, immutable revision or digest, publisher, release
   date, license, and maintenance status.
3. Verify signatures and artifact integrity against a trust anchor distributed
   independently of the artifact.
4. Reject mutable URLs, unexplained binaries, generated bundles without source,
   install scripts with unrelated side effects, and embedded credentials.

## Minimize Authority

Inventory filesystem roots, network hosts, secret names, account scopes,
browser or computer-use access, external writes, and subprocess capability.
Default to read-only and the smallest tool allow-list. Keep OAuth and API
credentials in the host credential store; never place them in manifests,
prompts, logs, or repository files.

Run executable extensions out of process with a scrubbed environment, bounded
resources, explicit network policy, timeouts, cancellation, and capped output.
A skill containing only advisory text grants no tools or permissions.

## Inspect Data Flow

Document what data enters the extension, where it is sent, what is retained,
which organization policies apply, and how users can revoke access or delete
data. Check prompt-injection exposure in third-party content and constrain
content-derived tool calls.

## Decide

Use one result:

- **approved**: exact reviewed artifact may be enabled with listed permissions
- **approved read-only**: writes remain disabled pending separate review
- **candidate**: useful source found, but packaging, authentication, or review
  is incomplete; do not show an install action
- **rejected**: provenance, license, integrity, behavior, or authority is
  unacceptable

Record review evidence and a rollback or disable path. Re-review every update;
never transfer approval across a changed digest or permission set.
