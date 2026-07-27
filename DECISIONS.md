# Rebuild decisions

## 2026-07-27 — preserve Pi as the only agent loop

Pi session storage, compaction, steering, follow-up, and tool events remain the model-context layer. Product Session metadata wraps Pi; it does not introduce a parallel agent loop.

## 2026-07-27 — one daemon and one workspace writer

Electron, CLI, automations, and plugin UI must be clients of one local daemon. Process-local locks are insufficient because they allow deterministic session and audit split-brain.

## 2026-07-27 — add product Session IDs without destroying legacy context

New globally unique Session IDs map to the existing `runtimeConversationId`. Migration does not rewrite or promote Pi JSONL; it records an idempotent mapping and provenance.

## 2026-07-27 — native helper owns primitives, never policy

The Swift helper owns TCC probes, window/display identity, capture, and bounded input. It receives no prompt, model, plugin code, provider secret, advertising policy, or approval authority.

## 2026-07-27 — mutation success requires exact business verification

A native action, screenshot change, verifier boolean, or `done` response is insufficient. AdPilot must reread the authoritative field, normalize unit/currency, compare it with the approved proposed value, and bind the result to fresh verified evidence.

## 2026-07-27 — plugins are untrusted processes

Plugins are verified bundles supervised outside the daemon authority graph. They receive brokered declared capabilities; official advertising guardrails, risk, approval, verification, and audit cannot be replaced.

## 2026-07-27 — truthful evidence levels

Unit/mock, offline replay, live model, logged-in browser, and real mutation are distinct evidence layers. Results never flow upward by implication.

