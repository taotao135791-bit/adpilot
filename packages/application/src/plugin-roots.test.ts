import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePluginResourceLayout } from "./plugin-roots.js";

const sourceTreeRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function stage(file: string, content = ""): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

describe("resolvePluginResourceLayout", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "adpilot-plugin-roots-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves the repository layout from the source tree", () => {
    const layout = resolvePluginResourceLayout({ env: {}, moduleUrl: new URL("./plugins.ts", import.meta.url).href });
    expect(layout.repositoryRoot).toBe(sourceTreeRoot);
    expect(layout.curatedRoot).toBe(path.join(sourceTreeRoot, "plugins", "curated"));
    expect(layout.trustRoot).toBe(path.join(sourceTreeRoot, "plugins", "curated", "trust"));
    expect(layout.hostPath).toBe(path.join(sourceTreeRoot, "packages", "plugin-runtime", "src", "host.mjs"));
    // The resolved source-tree resources really exist.
    expect(existsSync(layout.curatedRoot)).toBe(true);
    expect(existsSync(layout.hostPath)).toBe(true);
  });

  it("resolves the CLI bundle layout relative to dist/", async () => {
    const bundle = path.join(root, "dist", "cli", "index.js");
    await stage(bundle);
    await stage(path.join(root, "dist", "plugins", "curated", "trust", "key.pem"));
    await stage(path.join(root, "dist", "plugin-runtime", "host.mjs"));

    const layout = resolvePluginResourceLayout({ env: {}, moduleUrl: pathToFileURL(bundle).href });
    expect(layout.repositoryRoot).toBe(path.join(root, "dist"));
    expect(layout.curatedRoot).toBe(path.join(root, "dist", "plugins", "curated"));
    expect(layout.trustRoot).toBe(path.join(root, "dist", "plugins", "curated", "trust"));
    expect(layout.hostPath).toBe(path.join(root, "dist", "plugin-runtime", "host.mjs"));
  });

  it("resolves the packaged electron layout inside app.asar and spawns the unpacked host", async () => {
    const resources = path.join(root, "AdPilot.app", "Contents", "Resources");
    const main = path.join(resources, "app.asar", "dist", "electron", "main.js");
    await stage(main);
    await stage(path.join(resources, "app.asar", "dist", "plugins", "curated", "trust", "key.pem"));
    await stage(path.join(resources, "app.asar.unpacked", "dist", "plugin-runtime", "host.mjs"));

    const layout = resolvePluginResourceLayout({ env: {}, moduleUrl: pathToFileURL(main).href });
    // The curated catalog is read through the asar-patched fs in the main process…
    expect(layout.curatedRoot).toBe(path.join(resources, "app.asar", "dist", "plugins", "curated"));
    expect(layout.trustRoot).toBe(path.join(resources, "app.asar", "dist", "plugins", "curated", "trust"));
    // …but the isolation host is spawned as a child entrypoint, so it must be the real unpacked file.
    expect(layout.hostPath).toBe(path.join(resources, "app.asar.unpacked", "dist", "plugin-runtime", "host.mjs"));
    expect(layout.hostPath).not.toContain(`${path.sep}app.asar${path.sep}`);
  });

  it("keeps the in-asar host path when no unpacked counterpart exists", async () => {
    const resources = path.join(root, "AdPilot.app", "Contents", "Resources");
    const main = path.join(resources, "app.asar", "dist", "electron", "main.js");
    await stage(main);
    await stage(path.join(resources, "app.asar", "dist", "plugins", "curated", "trust", "key.pem"));
    await stage(path.join(resources, "app.asar", "dist", "plugin-runtime", "host.mjs"));

    const layout = resolvePluginResourceLayout({ env: {}, moduleUrl: pathToFileURL(main).href });
    expect(layout.hostPath).toBe(path.join(resources, "app.asar", "dist", "plugin-runtime", "host.mjs"));
  });

  it("lets environment variables override discovery", async () => {
    const curated = path.join(root, "custom-curated");
    const trust = path.join(root, "custom-trust");
    const host = path.join(root, "custom-host.mjs");
    await stage(path.join(curated, "trust", "key.pem"));
    await stage(host);
    const layout = resolvePluginResourceLayout({
      env: {
        ADPILOT_PLUGIN_CURATED_ROOT: curated,
        ADPILOT_PLUGIN_TRUST_ROOT: trust,
        ADPILOT_PLUGIN_HOST_PATH: host,
        ADPILOT_REPOSITORY_ROOT: path.join(root, "ignored-repository")
      },
      moduleUrl: new URL("./plugins.ts", import.meta.url).href
    });
    expect(layout.curatedRoot).toBe(curated);
    expect(layout.trustRoot).toBe(trust);
    expect(layout.hostPath).toBe(host);
  });

  it("lets explicit roots override the environment", async () => {
    const curated = path.join(root, "roots-curated");
    const host = path.join(root, "roots-host.mjs");
    await stage(host);
    const layout = resolvePluginResourceLayout({
      env: { ADPILOT_PLUGIN_CURATED_ROOT: path.join(root, "env-curated"), ADPILOT_PLUGIN_HOST_PATH: path.join(root, "env-host.mjs") },
      roots: { curatedRoot: curated, hostPath: host },
      moduleUrl: new URL("./plugins.ts", import.meta.url).href
    });
    expect(layout.curatedRoot).toBe(curated);
    expect(layout.trustRoot).toBe(path.join(curated, "trust"));
    expect(layout.hostPath).toBe(host);
  });

  it("falls back to the process cwd when no layout carries the catalog", () => {
    const layout = resolvePluginResourceLayout({
      env: {},
      moduleUrl: pathToFileURL(path.join(root, "nowhere", "bundle.js")).href,
      exists: () => false
    });
    expect(layout.repositoryRoot).toBe(path.resolve(process.cwd()));
    expect(layout.curatedRoot).toBe(path.join(path.resolve(process.cwd()), "plugins", "curated"));
  });
});
