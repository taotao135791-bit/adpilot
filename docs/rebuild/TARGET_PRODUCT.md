# Target product

Status: accepted product direction, living implementation contract

AdPilot is an always-open desktop Agent workspace for advertising work. The shell behaves like a mature coding Agent workbench: durable sessions, projects, files, models, tools, plugins, permissions, long-running tasks, and Computer Use. Its advertising decision core is native product authority rather than a prompt pack.

## Product equation

```text
AdPilot
= durable Agent workbench
+ Pi runtime
+ native Computer Use
+ curated plugin ecosystem
+ advertising decision and safety core
```

## Daily loop

1. The user opens a project or client and resumes one of several sessions.
2. A session keeps its own model binding, advertising account context, permissions, run state, tools, approvals, Computer Use task, cost, and artifacts.
3. Pi plans and calls ordinary tools, curated plugin tools, or advertising specialists.
4. The workspace shows conversation, progress, tool calls, approvals, and results; contextual evidence lives in a collapsible Inspector.
5. Background sessions continue while the user opens another session.
6. Any advertising mutation is reconstructed from verified facts, reviewed, approved, executed once, reread exactly, and audited.
7. Closing and reopening the app restores both presentation state and Pi model context.

## Primary product surfaces

- Session workspace: conversation, progress, tool calls, approvals, artifacts, composer.
- Inspector: context, evidence, metrics, files, Computer Live View, tool history, token/cost.
- Clients and projects: durable context and optional overview panels.
- Plugins: curated catalog, installed state, permissions, review status, versions, logs.
- Automations: scheduled/background work with stricter permissions than interactive sessions.
- Models and providers: role bindings, health, capability, cost limits, secure credentials.
- Permission Center: OS capabilities, reasons, impact, request/recheck/test, revocation guidance.
- Audit: user-readable and machine-verifiable history.

## Experience principles

- Conversation first; advertising panels appear when relevant.
- High information density without a dashboard permanently occupying the workspace.
- One quiet accent color, native platform surfaces, explicit loading/empty/error/recovery states.
- State always comes from the daemon; renderer state is a cache, never authority.
- “Unavailable” and “not run” are valid product states. A mock, fixture, or schema cannot appear as a live success.
- The user can always pause, stop, inspect, take over, and understand what will happen next.

## Completion threshold

The target is not reached by static screens or isolated schemas. A feature counts only when its storage, daemon/RPC path, runtime behavior, desktop interaction, tests, restart recovery, audit, and truthful failure state form one working chain.

