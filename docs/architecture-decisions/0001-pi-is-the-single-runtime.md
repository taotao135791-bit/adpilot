# ADR 0001: Pi is the single agent runtime

Status: accepted, 2026-07-21.

AdPilot uses Pi's `Agent`, model registry, streaming, Tool calling, Session storage, compaction helpers and extension hooks. Long-term goals and specialist orchestration stay in the product layer. UI-TARS is not allowed to own an agent loop. This avoids competing planners while preserving an exact upstream source boundary and dependency pin.
