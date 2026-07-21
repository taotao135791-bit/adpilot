# ADR 0004: code models own visual reasoning

AdPilot does not expose a separate VLM configuration. The selected Pi Daily model handles screenshot grounding when it accepts images; the Deep model is the automatic fallback and escalation model. Both return the product-owned `VisualAction` schema.

UI-TARS remains responsible for native screenshots, coordinate conversion, mouse and keyboard execution. Pi remains the only planning runtime. This keeps configuration understandable, lets one multimodal code-model credential power conversation and Computer Use, and preserves the screenshot → one action → policy → native execution → screenshot → verification safety loop.
