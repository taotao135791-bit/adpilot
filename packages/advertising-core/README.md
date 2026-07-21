# AdPilot advertising core

This package has two deliberately separate layers:

- `src/` contains the TypeScript contracts and safety calculations used by the Pi runtime.
- `python/scripts/adpilot_ads/uac/` contains the deterministic Google App Campaign analysis, policy, experiment-ledger, normalization, doctor, and replay engine.
- `knowledge/` contains platform analysis and creative references. It is evidence for specialists, not executable authority.
- `schemas/`, `templates/`, and `evals/` are versioned product assets.

The Python engine never writes to an advertising account and requires no advertising or model credentials. Live mutations remain behind AdPilot's TypeScript approval service and visual computer runtime.

Run its retained contract suite with:

```bash
python3 -m pip install -r packages/advertising-core/python/requirements-dev.txt
pnpm test:ads-core
```

The migrated implementation is derived from the MIT-licensed advertising-policy upstream listed in the root third-party notices. Product naming and storage paths are AdPilot-native; attribution remains intact in the license and About screen.
