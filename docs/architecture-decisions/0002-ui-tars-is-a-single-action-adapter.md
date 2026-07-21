# ADR 0002: UI-TARS is a single-action adapter

Status: accepted, 2026-07-21.

AdPilot directly calls `UITarsModel.invoke()` for one screenshot and requires exactly one parsed action. The product action schema and `VisualPolicy` sit between model output and NutJS. `GUIAgent.run()` is not used because it would create a second planner beneath Pi. Every non-terminal action is followed by a new screenshot and verification.
