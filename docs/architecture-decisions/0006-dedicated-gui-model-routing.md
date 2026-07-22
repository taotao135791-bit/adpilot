# ADR 0006: GUI grounding and verification are independent roles

AdPilot routes four model roles: Daily, Deep, GUI Grounding and GUI Verification. Grounding receives one screenshot and one micro-task and returns one product-owned `VisualAction`. Verification receives independent before/after evidence and judges only the expected visible result.

The zero-extra-service production default is the Pi visual route: an authenticated image-capable Daily code model handles the normal grounding call, a new screenshot permits one retry, and the image-capable Deep code model handles the third attempt. A dedicated UI-TARS/OpenAI-compatible GUI endpoint is an optional advanced override. Only after a user explicitly configures it does that adapter take higher priority; it does not become another autonomous agent or a prerequisite for Computer Use.

Verification remains a separately invoked role. It may use an explicitly configured independent verifier endpoint; otherwise it uses an independent image-capable Deep code-model call. The same underlying code model may service multiple roles, but calls, prompts, outputs and audit records remain separate.

Provider adapters translate wire formats at the boundary. Policy, permissions, surface identity, approval and retry behavior remain independent of provider output.
