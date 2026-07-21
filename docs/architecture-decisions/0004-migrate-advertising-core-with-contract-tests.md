# ADR 0004: Migrate advertising logic with contract tests

Status: accepted, 2026-07-21.

The advertising-policy upstream is migrated into product-owned, platform-neutral paths rather than mounted as a third runtime. Installers, product branding and Git history are excluded. Deterministic code, schemas, fixtures, replay bundles, evals and knowledge are retained, renamed and guarded by 410 contract tests. Attribution remains in About and license notices.
