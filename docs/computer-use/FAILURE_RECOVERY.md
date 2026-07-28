# Computer Use failure recovery

## State machine

```text
agent_observing -> agent_proposing -> awaiting_approval
       ^                  |                 |
       |                  v                 v
   recovering <- agent_executing -> verifying
       |                  |
       +---- paused <-----+
       +---- user_control
       +---- failed
       +---- stopped
```

Only one atomic native action can be in flight. State transitions are serialized per
Computer Session and guarded by a generation.

## Recovery rules

- **Pause:** abort grounding, cancel queued (not-yet-posted) input and prevent new
  input. An already posted mutation is reconciled before any next action.
- **Take Over / user input:** immediately enter `user_control`, stop model loops,
  clear proposals and retain task context only.
- **Return Control:** recapture, rebuild observation and identity, increment generation
  and replan. Pre-takeover coordinates cannot execute.
- **Stop:** permanently close the Computer Session, cancel timers/queues, release frame
  buffers and reject late callbacks.
- **Helper crash:** mark helper unavailable, fail queued reads, mark written input
  `OUTCOME_UNKNOWN`, restart with a new credential only for a new observation.
- **Permission revoked:** disable the affected capability and route the user to the
  Permission Center. No fallback shell/AppleScript input path is allowed.
- **Window/profile/page change:** stop before input, invalidate the surface lease and
  any identity-bound approval, then re-observe.
- **Verification mismatch:** record failed/unknown with evidence. A mutation is never
  clicked or submitted again.
- **Renderer/server restart:** re-handshake the helper; UI control state is rebuilt
  from the authoritative runtime, not stale renderer state.

## Mutation reconciliation

When submit outcome is ambiguous:

1. record the action ID as uncertain and burn its one-time approval;
2. perform readonly observation only;
3. re-identify account, campaign and field;
4. read the persisted value after refresh/re-entry;
5. classify as applied, not-applied or unknown;
6. require a new user decision for any further write.

