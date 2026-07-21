# ADR 0003: Approval authority stays outside models

Status: accepted, 2026-07-21.

Models may prepare an exact proposal only through a Tool. Risk review, user approval, token creation, token storage and token consumption are deterministic application services. The browser never receives the token and the model cannot call the commit Tool. The server reloads the persisted operation and execution plan at commit time so request clients cannot substitute values or targets.
