# ADR 0005: Pi sessions are durable product state

AdPilot maps a main conversation to `clientId + conversationId` and a specialist conversation to `clientId + taskId + specialistRole`. These keys resolve to stable Pi session IDs. Pi `Session` entries—not a parallel transcript abstraction—are persisted below the client workspace.

Persisted entries include user/assistant/tool messages, tool events, model changes, compaction entries and product checkpoints. Restart recovery rebuilds context through Pi's session context projection. Compaction uses Pi's preparation and compact functions, with AdPilot instructions requiring account identity, KPI, evidence, approvals, experiments and side effects to survive summarization.

The human-facing `conversation.jsonl` remains a presentation index. It is not the source of model context.
