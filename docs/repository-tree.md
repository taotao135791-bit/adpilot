# Repository tree

```text
adpilot/
├── apps/
│   ├── cli/                    # adpilot entrypoint, init and doctor
│   ├── desktop/                # React + Fluent UI control center
│   └── mock-ad-dashboard/      # local visual workflow fixture
├── packages/
│   ├── advertising-core/       # deterministic TS policy + migrated UAC core/knowledge/evals
│   ├── agent-orchestrator/     # one user-facing AdPilot Agent
│   ├── application/            # dependency composition and event bus
│   ├── approvals/              # risk/user approval and bound tokens
│   ├── audit/                  # redaction and hash chain
│   ├── computer-use/           # UI-TARS adapter and one-action visual loop
│   ├── experiments/            # single-variable lifecycle
│   ├── model-router/           # Fast / Strong / GUI routing
│   ├── runtime/                # Pi Agent, Session, streaming, compaction, extensions
│   ├── server/                 # local API, SSE and static UI
│   ├── shared/                 # product contracts
│   ├── skills/                 # typed advertising workflows
│   ├── specialist-agents/      # six isolated roles
│   ├── tools/                  # deterministic execution boundary
│   └── workspace/              # client-scoped persistence
├── upstream/
│   ├── pi/                     # pinned v0.80.10 source submodule
│   └── ui-tars/                # pinned reviewed source submodule
├── tests/visual/               # mock console and approval/execute/verify tests
├── evals/                      # 60-case grounding, verification, and replay corpus
├── fixtures/screenshots/       # sanitized synthetic visual fixtures
├── docs/
│   ├── architecture-decisions/
│   └── screenshots/
├── licenses/
├── scripts/
├── README.md
├── LICENSES.md
├── THIRD_PARTY_NOTICES.md
└── UPSTREAM_VERSIONS.json
```

Generated `dist/`, dependency directories, local `.env` and client Workspace data are ignored.
