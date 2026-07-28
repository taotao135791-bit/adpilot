import { chmod, cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/", import.meta.url);

await chmod(fileURLToPath(new URL("cli/index.js", dist)), 0o755);

// Stage the plugin runtime resources next to the bundles. Both the CLI
// (dist/cli) and the packaged desktop app (dist/** inside app.asar, with
// dist/plugin-runtime asarUnpack'ed) resolve them relative to the bundle
// location — see packages/application/src/plugin-roots.ts.
await cp(new URL("../plugins/curated", import.meta.url), new URL("plugins/curated", dist), { recursive: true });
await mkdir(fileURLToPath(new URL("plugin-runtime", dist)), { recursive: true });
await cp(new URL("../packages/plugin-runtime/src/host.mjs", import.meta.url), new URL("plugin-runtime/host.mjs", dist));
