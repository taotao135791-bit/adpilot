# Computer Use security review

## Enforced boundaries

- The helper has no listening network socket.
- Parent authentication uses a new high-entropy secret per helper process.
- Wire requests are versioned, correlated, sequenced, size-bounded and deadline-bound.
- Unknown methods/fields, replayed sequences and unauthenticated requests fail closed.
- Helper credentials and raw frames are excluded from model context and public events.
- Plugins can invoke only registered product tools; they cannot import or address the
  helper, frame store or another Computer Session.
- Native input requires a current surface lease and the task's action/text/region
  allowlist.
- Advertising mutations additionally require the existing verified-fact, guardrail,
  risk-review, approval-token and audit chain.
- A mutation request has one attempt. An uncertain native outcome is reconciled by a
  fresh read; it is not retried.

## Threats and tests

| Threat | Expected response |
| --- | --- |
| Fake helper / wrong binary | Stable packaged path, regular executable checks, hello capability validation; fail unavailable. |
| IPC replay | Reject non-monotonic sequence and duplicate request/action IDs. |
| Oversized/malformed frame | Reject before JSON decode/allocation; terminate actor on protocol corruption. |
| Cross-session request | Reject mismatched Computer Session/generation and invalidate proposal. |
| Wrong window/account/campaign | Stop, observe again, require renewed approval where identity-bound. |
| Prompt injection in page | Page text is evidence, never policy or tool authority. |
| Secret exfiltration | Sensitive regions/fields masked; no token, password, OTP or cookie in logs/model payload. |
| Screenshot traversal | Private root, generated identifiers, no caller-provided path, symlink-safe open. |
| User input during agent action | Cancel pending input, yield to `user_control`, invalidate coordinates. |

## Residual constraints

Ad-hoc signing proves bundle integrity only. It does not provide Developer ID identity
or notarization. A real Google Ads result also depends on an external account and
explicit approval; automated tests cannot substitute for that evidence.

