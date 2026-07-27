# Rebuild architecture

Status: target architecture; implementation is incremental

## State ownership

```text
Desktop renderer ─ preload RPC ─┐
CLI/TUI ─ local RPC ────────────┼─ Local daemon (single writer)
Automation workers ─────────────┤
Plugin UI/processes ─ broker ───┘
                                │
                                ├─ Session Service + persistent store
                                ├─ Pi Runtime
                                ├─ Tool Runtime + policy
                                ├─ Advertising Core
                                ├─ Approval + verification + audit
                                ├─ Computer Runtime actors
                                ├─ Native Helper client
                                ├─ Plugin supervisor
                                ├─ Model/credential service
                                └─ Artifact/event service
```

The daemon owns all mutable state. Electron starts or connects to it and never constructs a second system for the same workspace. CLI commands are RPC clients. One workspace lease prevents a second writer.

## Schema and RPC

- Canonical schemas are versioned Zod contracts shared by storage, RPC, desktop types, CLI, validation, and migrations.
- RPC envelopes contain protocol version, request ID, client identity, method, payload, and typed error.
- Privileged desktop operations use a narrow preload bridge. Renderer code does not receive Node, helper tokens, approval tokens, secrets, or raw helper pipes.
- Loopback transport uses an instance capability token, strict Host/Origin checks, and CSRF protection. External network binding remains unsupported without a separate authenticated gateway.
- Events have globally unique IDs, a monotonic per-session sequence, and resumable cursors.

## Persistent records

```text
Session
  ├─ AgentRun
  │   ├─ Message
  │   ├─ ToolCall
  │   └─ Usage
  ├─ Approval
  ├─ ComputerTask
  │   └─ ComputerAction
  ├─ Artifact / Evidence / SharedFact
  └─ AuditEvent
```

Every record uses a globally unique ID. Foreign keys include `sessionId`; advertising records additionally bind client, account, Campaign, task, and evidence lineage.

## Runtime isolation

- Pi remains the only agent loop.
- A session actor serializes mutations to its own transcript while different session actors can run concurrently.
- Model/provider selection is immutable in a run context. Escalation returns a new routing decision without mutating a global router.
- Tool permission checks resolve the session permission profile and current approval binding at call time.
- Computer actors use a task-scoped lease and never share a mutable browser binding.
- Plugin processes receive only brokered capabilities declared in their installed permission grant.

## Native boundary

```text
Pi tool request
→ schema validation
→ session permission
→ advertising guardrail
→ policy/risk/approval
→ Computer actor
→ authenticated helper command
→ native capture/input
→ capture + exact verification
→ append-only audit
```

The helper has no prompt, model, network listener, provider credentials, or advertising policy. It accepts only versioned native commands over an authenticated local child-process/XPC channel.

## Migration policy

- Storage writes are atomic and versioned.
- Migrations are idempotent and record source version, target version, time, result, and checksum.
- Legacy conversation IDs remain compatibility keys while new product Session IDs become canonical.
- No migration promotes unverified facts or fabricates live validation.

