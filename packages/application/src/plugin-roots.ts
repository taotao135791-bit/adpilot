/**
 * Plugin resource root resolution for the three layouts AdPilot ships in:
 *
 * 1. Source tree (tsx/vitest): this module lives at
 *    packages/application/src, the curated catalog at <repo>/plugins/curated
 *    and the isolation host at <repo>/packages/plugin-runtime/src/host.mjs.
 * 2. CLI bundle (dist/cli/index.js): tsup inlines this module, so
 *    import.meta.url is the bundle location. postbuild.mjs stages the
 *    resources next to it: <dist>/plugins/curated and
 *    <dist>/plugin-runtime/host.mjs. The same layout covers the dev-time
 *    electron bundle at dist/electron/main.js.
 * 3. Packaged desktop app: the bundle is
 *    <resources>/app.asar/dist/electron/main.js and electron-builder ships
 *    dist/plugins/** inside the asar (the main process reads it through the
 *    asar-patched fs) while dist/plugin-runtime/** is asarUnpack'ed because
 *    the supervisor must spawn host.mjs as a real on-disk child entrypoint.
 *
 * Explicit overrides always win (deps.roots, then ADPILOT_PLUGIN_* / ADPILOT_REPOSITORY_ROOT
 * environment variables). Without overrides the curated catalog is discovered
 * by walking up from the module directory to the first ancestor that carries
 * plugins/curated, which lands on the repository root, dist/, or
 * app.asar/dist depending on the layout. The historical last resort is the
 * process cwd; a wrong cwd then surfaces as a clear CURATED_ROOT_MISSING
 * catalog error instead of a silent mis-resolution.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PluginResourceRootsOverride {
  repositoryRoot?: string;
  curatedRoot?: string;
  trustRoot?: string;
  hostPath?: string;
}

export interface PluginResourceLayout {
  /** Base that carries plugins/curated: repository root, dist/, or app.asar/dist. */
  repositoryRoot: string;
  curatedRoot: string;
  trustRoot: string;
  /** Real on-disk isolation host entrypoint (asar paths are translated to app.asar.unpacked). */
  hostPath: string;
}

export interface ResolvePluginResourceLayoutOptions {
  env?: NodeJS.ProcessEnv;
  roots?: PluginResourceRootsOverride;
  /** import.meta.url of the calling module; injectable for layout tests. */
  moduleUrl?: string;
  /** Existence probe (files or directories); injectable for layout tests. */
  exists?: (candidate: string) => boolean;
}

/** Source tree needs 3 hops (src → application → packages → root); 6 covers every bundle nesting without escaping to / . */
const MAX_ANCESTOR_HOPS = 6;

function asarUnpackedVariant(candidate: string): string | undefined {
  const marker = `app.asar${path.sep}`;
  if (!candidate.includes(marker)) return undefined;
  return candidate.replace(marker, `app.asar.unpacked${path.sep}`);
}

/** The child process cannot execute a script from inside the asar archive; spawn the unpacked copy. */
function preferAsarUnpacked(candidate: string, exists: (candidate: string) => boolean): string {
  const unpacked = asarUnpackedVariant(candidate);
  return unpacked && exists(unpacked) ? unpacked : candidate;
}

function discoverResourceBase(moduleDirectory: string, exists: (candidate: string) => boolean): string | undefined {
  let current = moduleDirectory;
  for (let hop = 0; hop <= MAX_ANCESTOR_HOPS; hop += 1) {
    if (exists(path.join(current, "plugins", "curated"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

export function resolvePluginResourceLayout(options: ResolvePluginResourceLayoutOptions = {}): PluginResourceLayout {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const moduleDirectory = fileURLToPath(new URL(".", options.moduleUrl ?? import.meta.url));
  const discoveredBase = discoverResourceBase(moduleDirectory, exists);

  const repositoryRoot = path.resolve(
    options.roots?.repositoryRoot ?? env.ADPILOT_REPOSITORY_ROOT ?? discoveredBase ?? process.cwd()
  );
  const curatedRoot = path.resolve(
    options.roots?.curatedRoot ?? env.ADPILOT_PLUGIN_CURATED_ROOT ?? path.join(repositoryRoot, "plugins", "curated")
  );
  const trustRoot = path.resolve(options.roots?.trustRoot ?? env.ADPILOT_PLUGIN_TRUST_ROOT ?? path.join(curatedRoot, "trust"));

  const hostCandidates = [
    env.ADPILOT_PLUGIN_HOST_PATH,
    options.roots?.hostPath,
    path.join(moduleDirectory, "host.mjs"),
    path.resolve(moduleDirectory, "..", "..", "plugin-runtime", "src", "host.mjs"),
    ...(discoveredBase ? [path.join(discoveredBase, "plugin-runtime", "host.mjs")] : []),
    path.resolve(process.cwd(), "packages", "plugin-runtime", "src", "host.mjs")
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  let hostPath: string | undefined;
  for (const candidate of hostCandidates) {
    if (exists(candidate)) {
      hostPath = preferAsarUnpacked(candidate, exists);
      break;
    }
    const unpacked = asarUnpackedVariant(candidate);
    if (unpacked && exists(unpacked)) {
      hostPath = unpacked;
      break;
    }
  }
  // Keep the historical fallback: a missing host is only fatal when the
  // supervisor actually spawns it, and the catalog must still boot.
  hostPath ??= hostCandidates[1] ?? hostCandidates[0];
  if (!hostPath) throw new Error("Plugin isolation host could not be resolved");

  return { repositoryRoot, curatedRoot, trustRoot, hostPath };
}
