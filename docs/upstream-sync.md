# Upstream synchronization

AdPilot pins reviewed upstream revisions. Production code uses published Pi and UI-TARS packages at exact versions; submodules preserve the audited source and license context.

| Component | Pin | Source role |
| --- | --- | --- |
| Pi | tag `v0.80.10`, commit `8dc78834cde4e329284cf505f9e3f99763df5529` | Sole agent/model runtime |
| UI-TARS desktop | commit `c2ad42e3eb9b27830db41a3e6f51ca7179d9b168` | Audited source for SDK/parser/native operator 1.2.3 |
| Advertising policy upstream | commit `e4815fc9ae7a9fa69ee8dc3e06404dddd4913394`, version `1.9.2` | Migrated deterministic UAC core and knowledge |

## Upgrade procedure

1. Create a dedicated `upstream/<component>-<version>` branch.
2. Read the release diff, license, security advisories and API changes. Never move a pin only because a newer tag exists.
3. Update the exact dependency and its matching submodule commit together.
4. For the advertising core, migrate current-tree changes into AdPilot names and paths; do not import upstream Git history or installer/branding files.
5. Run `pnpm test`, `pnpm test:ads-core`, `pnpm build`, the local visual workflow, branding scan and license check.
6. Review the Computer Use contract manually: exactly one grounding call, one parsed action, fresh screenshot, policy check, native execution and verification.
7. Update `UPSTREAM_VERSIONS.json`, this table and `THIRD_PARTY_NOTICES.md` in the same commit.

Useful read-only checks:

```bash
git submodule status
node scripts/verify-upstreams.mjs
rg -n -i 'codex[ _-]?ads' --glob '!upstream/**' --glob '!licenses/**' --glob '!THIRD_PARTY_NOTICES.md' --glob '!apps/desktop/src/main.tsx' .
pnpm check
```

The advertising core is intentionally migrated rather than mounted as a runtime submodule. Its retained Python contract suite is the compatibility gate.
