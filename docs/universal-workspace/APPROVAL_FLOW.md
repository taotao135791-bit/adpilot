# Unified approval flow

One central `ApprovalService` mints every execution right. No subsystem keeps
a private weak-approval path.

```text
write request (automation run / plugin mutable tool / workflow mutation /
ads mutation / git destructive op)
→ server builds operation + execution plan + guardrail (action fingerprint)
→ ApprovalService.create (bound to workspace + task + plan fingerprint)
→ risk review recorded
→ user approves → one-time token
→ consume(token, operation, plan) re-validates fingerprints
→ execute exactly once
→ finish(succeeded?) + audit
```

## Invariants enforced

- **No client-minted approvals**: the automation approve endpoint accepts only
  `{ workspaceId, actor? }`; submitting an `approvalId` is a schema-level
  400. The server mints the approval itself.
- **Forgery fails closed**: the scheduler's `verifyApproval` requires the id
  to exist in the same workspace and already be consumed into `executing`.
- **Replay impossible**: tokens are single-use; re-approving a run that is
  not `waiting-approval` is a 409.
- **Stale plans rejected**: the automation action fingerprint (sha256 of the
  stable action JSON) is pinned when the run parks; any drift between the
  parked run and the current definition fails `APPROVAL_STALE` before an
  approval is even minted.
- **Plugin boundary**: mutable plugin tools require the runtime approval
  gate; the approval proof never reaches the plugin subprocess.
