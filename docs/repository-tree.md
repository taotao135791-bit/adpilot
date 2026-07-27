# Repository tree

```text
adpilot/
├── apps/
│   ├── cli/                    # adpilot entrypoint, init and doctor
│   ├── desktop/                # React + Fluent UI control center
│   ├── electron/               # native macOS main process and window guard
│   └── mock-ad-dashboard/      # local visual workflow fixture
├── packages/
│   ├── advertising-core/       # deterministic TS policy + migrated UAC core/knowledge/evals
│   ├── agent-orchestrator/     # one user-facing AdPilot Agent
│   ├── application/            # dependency composition, event bus, alert monitor and user skill/prompt discovery
│   ├── approvals/              # risk/user approval and bound tokens
│   ├── audit/                  # redaction and hash chain
│   ├── computer-use/           # UI-TARS adapter and one-action visual loop
│   ├── configuration/          # settings, providers and secret storage
│   ├── experiments/            # single-variable lifecycle
│   ├── model-router/           # Fast / Strong / GUI routing
│   ├── runtime/                # Pi Agent, Session, streaming, compaction, tool gate, plan mode and extensions
│   ├── server/                 # local API, SSE and static UI
│   ├── shared/                 # product contracts, tool-gate rules and the bash classifier
│   ├── skills/                 # typed advertising workflows
│   ├── specialist-agents/      # seven isolated roles
│   ├── tools/                  # deterministic execution boundary and vendored general tools
│   ├── visual-table-reader/    # screenshot ROI table reading into verified facts
│   └── workspace/              # client-scoped persistence
├── upstream/
│   ├── pi/                     # pinned v0.80.10 source submodule
│   └── ui-tars/                # pinned reviewed source submodule
├── tests/
│   ├── architecture/           # executable production-boundary guard tests
│   ├── visual/                 # mock console and approval/execute/verify tests
│   └── electron-security.test.ts # desktop origin and signature guard tests
├── evals/                      # 85-case visual corpus plus live table/identity oracles
├── fixtures/screenshots/       # sanitized synthetic visual fixtures
├── docs/
│   ├── architecture-decisions/
│   ├── audits/
│   └── screenshots/
├── licenses/
├── scripts/                    # build, validation and knowledge-embedding harnesses
├── README.md
├── LICENSES.md
├── THIRD_PARTY_NOTICES.md
└── UPSTREAM_VERSIONS.json
```

Generated `dist/`, dependency directories, local `.env` and client Workspace data are ignored.
