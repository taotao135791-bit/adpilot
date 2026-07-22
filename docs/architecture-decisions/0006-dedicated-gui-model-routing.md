# ADR 0006: GUI grounding and verification are independent roles

AdPilot routes four model roles: Daily, Deep, GUI Grounding and GUI Verification. Grounding receives one screenshot and one micro-task and returns one product-owned `VisualAction`. Verification receives independent before/after evidence and judges only the expected visible result.

The grounding priority is a configured dedicated adapter (UI-TARS or OpenAI-compatible), its configured strong retry, then an explicitly enabled Pi vision compatibility fallback. `PiVisionModel` is not the default production grounding model. Verification may use an independent endpoint, reuse the GUI endpoint, or use an image-capable Deep model.

Provider adapters translate wire formats at the boundary. Policy, permissions, surface identity, approval and retry behavior remain independent of provider output.
