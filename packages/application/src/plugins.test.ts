import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import {
  computeBundleIntegrity,
  PluginManifestSchema,
  pluginSignaturePayload,
  type BundleFile,
  type PluginManifest,
  type PluginPermissions
} from "@adpilot/plugin-runtime";
import { WorkspaceStore } from "@adpilot/workspace";
import {
  createAdPilotSystem,
  createPluginService,
  PluginPermissionReviewError,
  PluginRuntimeError,
  ProductEventBus,
  type PluginService
} from "./index.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

const emptyPermissions: PluginPermissions = {
  capabilities: [],
  filesystem: [],
  network: [],
  secrets: [],
  browser: false,
  computerUse: false,
  advertisingRead: false,
  advertisingMutation: false,
  storage: false
};

interface BundleOptions {
  id: string;
  version: string;
  keyId: string;
  privateKey?: KeyObject;
  permissions?: PluginPermissions;
  entrySource?: string;
  toolReadOnly?: boolean;
}

async function writeBundle(curatedRoot: string, options: BundleOptions): Promise<string> {
  const directory = path.join(curatedRoot, `${options.id}-${options.version}`);
  await mkdir(directory, { recursive: true });
  const source =
    options.entrySource ??
    `export const tools = Object.freeze({"${options.id}/run": async (input) => ({ input })});`;
  const unsigned = PluginManifestSchema.parse({
    schemaVersion: 1,
    id: options.id,
    name: "Test Plugin",
    version: options.version,
    developer: { name: "AdPilot Tests" },
    description: "A test-only curated plugin bundle.",
    entry: "index.mjs",
    tools: [{ name: `${options.id}/run`, description: "Run the test tool.", readOnly: options.toolReadOnly ?? true }],
    skills: [],
    uiExtensions: [],
    permissions: options.permissions ?? emptyPermissions,
    platforms: ["darwin-arm64", "linux-x64"],
    integrity: `sha256:${"0".repeat(64)}`,
    review: { status: "approved", reviewedAt: "2026-07-27T00:00:00.000Z", reviewer: "AdPilot Tests" },
    replaces: [],
    dataVersion: 0,
    migrations: []
  });
  const files: BundleFile[] = [{ path: "index.mjs", bytes: Buffer.from(source) }];
  const withIntegrity: PluginManifest = { ...unsigned, integrity: computeBundleIntegrity(unsigned, files) };
  const manifest: PluginManifest = options.privateKey
    ? {
        ...withIntegrity,
        signature: {
          algorithm: "ed25519",
          keyId: options.keyId,
          value: sign(null, pluginSignaturePayload(withIntegrity), options.privateKey).toString("base64")
        }
      }
    : withIntegrity;
  await writeFile(path.join(directory, "index.mjs"), source);
  await writeFile(path.join(directory, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

interface Fixture {
  workspaceRoot: string;
  curatedRoot: string;
  trustRoot: string;
  workspace: WorkspaceStore;
  audit: AuditLog;
  events: ProductEventBus;
  privateKey: KeyObject;
  keyId: string;
}

async function createFixture(root: string): Promise<Fixture> {
  const workspaceRoot = path.join(root, "workspace");
  const curatedRoot = path.join(root, "repository", "plugins", "curated");
  const trustRoot = path.join(curatedRoot, "trust");
  await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(trustRoot, { recursive: true })]);
  const pair = generateKeyPairSync("ed25519");
  const keyId = "service-test-key";
  await writeFile(path.join(trustRoot, `${keyId}.pem`), pair.publicKey.export({ type: "spki", format: "pem" }));
  const workspace = new WorkspaceStore(workspaceRoot);
  await workspace.initializeClient({
    profile: { id: "personal", name: "AdPilot", industry: "unknown", timezone: "UTC" },
    kpi: { primary: "CPA", target: 1, currency: "USD" }
  });
  return {
    workspaceRoot,
    curatedRoot,
    trustRoot,
    workspace,
    audit: new AuditLog(workspace),
    events: new ProductEventBus(),
    privateKey: pair.privateKey,
    keyId
  };
}

async function createService(fixture: Fixture): Promise<PluginService> {
  return createPluginService({
    workspace: fixture.workspace,
    audit: fixture.audit,
    events: fixture.events,
    roots: { curatedRoot: fixture.curatedRoot, trustRoot: fixture.trustRoot }
  });
}

const mutation = { actor: "workspace-owner", clientId: "personal" };

describe("plugin service composition root", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "adpilot-plugin-service-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exposes system.plugins from createAdPilotSystem with the signed first-party catalog", async () => {
    const faux = fauxProvider({ provider: "local-code", models: [{ id: "code-vision", input: ["text", "image"], reasoning: true }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const system = await createAdPilotSystem({
      workspaceRoot: path.join(root, "product-workspace"),
      models,
      env: {
        ADPILOT_FAST_PROVIDER: "local-code",
        ADPILOT_FAST_MODEL: "code-vision",
        ADPILOT_STRONG_PROVIDER: "local-code",
        ADPILOT_STRONG_MODEL: "code-vision",
        ADPILOT_PRIVACY_MODE: "local-only"
      }
    });
    expect(system.plugins).toBeDefined();
    const { plugins, candidates, runtime } = await system.plugins.catalog();
    expect(runtime).toMatchObject({ available: true, developerMode: false, isolation: "child_process+vm" });
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "github-official-mcp",
      "google-drive-official-mcp",
      "figma-official-mcp"
    ]);
    expect(candidates.every((candidate) => candidate.installable === false && candidate.recommendedMode === "read-only")).toBe(true);
    const csv = plugins.find((plugin) => plugin.id === "com.adpilot.csv-daily-report");
    expect(csv).toMatchObject({
      latestVersion: "1.0.0",
      installed: null,
      signature: { signed: true, keyId: "adpilot-first-party-2026-01" },
      review: { status: "approved" }
    });
  });

  it("runs the install/disable/enable/uninstall lifecycle with audit and SSE", async () => {
    const fixture = await createFixture(root);
    await writeBundle(fixture.curatedRoot, { id: "com.example.lifecycle", version: "1.0.0", keyId: fixture.keyId, privateKey: fixture.privateKey });
    const service = await createService(fixture);
    const published: Array<{ pluginId: string; status: string }> = [];
    fixture.events.subscribe((event) => {
      if (event.type === "plugin") published.push({ pluginId: event.pluginId, status: event.status });
    }, "personal");

    const installed = await service.install("com.example.lifecycle", mutation);
    expect(installed).toMatchObject({ status: "active", version: "1.0.0" });
    const stateFile = path.join(fixture.workspaceRoot, ".adpilot", "plugin-runtime", "plugins", "com.example.lifecycle", "state.json");
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({ status: "active", activeVersion: "1.0.0" });

    expect((await service.disable("com.example.lifecycle", mutation)).status).toBe("disabled");
    // Disable keeps the installed data on disk.
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({ status: "disabled" });
    expect((await service.enable("com.example.lifecycle", mutation)).status).toBe("active");
    await expect(service.uninstall("com.example.lifecycle", mutation)).resolves.toEqual({
      id: "com.example.lifecycle",
      status: "uninstalled"
    });
    expect((await service.catalog()).plugins[0]?.installed).toBeNull();

    expect(published).toEqual([
      { pluginId: "com.example.lifecycle", status: "installed" },
      { pluginId: "com.example.lifecycle", status: "disabled" },
      { pluginId: "com.example.lifecycle", status: "enabled" },
      { pluginId: "com.example.lifecycle", status: "uninstalled" }
    ]);
    const actions = (await fixture.audit.list("personal")).map((event) => `${event.action}:${event.status}`);
    expect(actions).toEqual([
      "plugin_install:succeeded",
      "plugin_disable:succeeded",
      "plugin_enable:succeeded",
      "plugin_uninstall:succeeded"
    ]);
    expect(await fixture.audit.verify("personal")).toBe(true);
  });

  it("auto-activates updates without new permissions and gates new permissions behind consent", async () => {
    const fixture = await createFixture(root);
    const id = "com.example.updating";
    await writeBundle(fixture.curatedRoot, { id, version: "1.0.0", keyId: fixture.keyId, privateKey: fixture.privateKey });
    const service = await createService(fixture);
    await service.install(id, { ...mutation, version: "1.0.0" });

    await writeBundle(fixture.curatedRoot, { id, version: "1.1.0", keyId: fixture.keyId, privateKey: fixture.privateKey });
    const serviceWithUpdate = await createService(fixture);
    const updated = await serviceWithUpdate.update(id, mutation);
    expect(updated).toMatchObject({ status: "active", version: "1.1.0" });

    await writeBundle(fixture.curatedRoot, {
      id,
      version: "2.0.0",
      keyId: fixture.keyId,
      privateKey: fixture.privateKey,
      permissions: { ...emptyPermissions, filesystem: ["read.text"] }
    });
    const serviceWithV2 = await createService(fixture);
    const catalogItem = (await serviceWithV2.catalog()).plugins.find((plugin) => plugin.id === id);
    expect(catalogItem?.update).toMatchObject({
      version: "2.0.0",
      requiresApproval: true,
      permissionDiff: { hasNewPermissions: true }
    });

    const refused = await serviceWithV2.update(id, mutation).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PluginPermissionReviewError);
    expect((refused as PluginPermissionReviewError).update.permissionDiff.added.map((permission) => permission.key)).toEqual([
      "filesystem:read.text"
    ]);
    // The refusal did not stage anything: the plugin is still active at 1.1.0.
    expect((await serviceWithV2.details(id)).installed).toMatchObject({ status: "active", version: "1.1.0" });

    const approved = await serviceWithV2.update(id, { ...mutation, acceptPermissions: true });
    expect(approved).toMatchObject({ status: "active", version: "2.0.0", pendingUpdate: null });
    expect(approved.permissions.map((permission) => permission.key)).toEqual(["filesystem:read.text"]);
    const updateAudits = (await fixture.audit.list("personal")).filter((event) => event.action === "plugin_update");
    expect(updateAudits.at(-1)).toMatchObject({
      status: "succeeded",
      details: { pluginId: id, toVersion: "2.0.0", approvedPermissions: ["filesystem:read.text"] }
    });
  });

  it("rejects unsigned installs by default and honors allowUnsigned with a high-risk audit", async () => {
    const fixture = await createFixture(root);
    const id = "com.example.unsigned";
    await writeBundle(fixture.curatedRoot, { id, version: "1.0.0", keyId: fixture.keyId });
    const service = await createService(fixture);
    // Discovery of an unsigned bundle flipped the catalog into explicit developer mode.
    expect(service.status()).toMatchObject({ available: true, developerMode: true });
    await service.flushStartup();
    const developerModeAudit = (await fixture.audit.list("personal")).find((event) => event.action === "plugin_catalog_developer_mode");
    expect(developerModeAudit).toMatchObject({ status: "denied", details: { highRisk: true } });

    const refused = await service.install(id, mutation).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PluginRuntimeError);
    expect((refused as PluginRuntimeError).code).toBe("UNSIGNED_REJECTED");

    const installed = await service.install(id, { ...mutation, allowUnsigned: true });
    expect(installed).toMatchObject({ status: "active", version: "1.0.0" });

    const installs = (await fixture.audit.list("personal")).filter((event) => event.action === "plugin_install");
    expect(installs.map((event) => event.status)).toEqual(["denied", "succeeded"]);
    expect(installs[1]?.details).toMatchObject({ highRisk: true, allowUnsigned: true, pluginId: id });
  });

  it("degrades an installed plugin to disabled when boot-time re-verification fails", async () => {
    const fixture = await createFixture(root);
    const id = "com.example.tampered";
    await writeBundle(fixture.curatedRoot, { id, version: "1.0.0", keyId: fixture.keyId, privateKey: fixture.privateKey });
    const service = await createService(fixture);
    await service.install(id, mutation);
    expect((await service.details(id)).verification).toMatchObject({ ok: true });

    // Tamper with the installed bundle after installation.
    const installedEntry = path.join(
      fixture.workspaceRoot,
      ".adpilot",
      "plugin-runtime",
      "plugins",
      id,
      "versions",
      "1.0.0",
      "bundle",
      "index.mjs"
    );
    await writeFile(installedEntry, "export const tools = Object.freeze({});\n");

    // A fresh service instance re-verifies installed plugins at boot.
    const rechecked = await createService(fixture);
    const details = await rechecked.details(id);
    expect(details.installed?.status).toBe("disabled");
    expect(details.verification).toMatchObject({ ok: false, error: { code: "INTEGRITY_MISMATCH" } });

    await rechecked.flushStartup();
    const recheckAudit = (await fixture.audit.list("personal")).find((event) => event.action === "plugin_startup_recheck");
    expect(recheckAudit).toMatchObject({
      actor: "plugin-startup-recheck",
      status: "denied",
      details: { highRisk: true, pluginId: id, degradedTo: "disabled" }
    });

    // The degraded plugin cannot run, and cannot be re-enabled either.
    const executeError = await rechecked
      .executeTool({ pluginId: id, tool: `${id}/run`, input: {}, ...mutation })
      .catch((error: unknown) => error);
    expect((executeError as PluginRuntimeError).code).toBe("PLUGIN_INACTIVE");
    const enableError = await rechecked.enable(id, mutation).catch((error: unknown) => error);
    expect((enableError as PluginRuntimeError).code).toBe("INTEGRITY_MISMATCH");
    expect((await rechecked.details(id)).installed?.status).toBe("disabled");
  });

  it("degrades the whole subsystem (not the product) when the curated catalog is tampered", async () => {
    const fixture = await createFixture(root);
    const id = "com.example.catalog-tamper";
    const directory = await writeBundle(fixture.curatedRoot, {
      id,
      version: "1.0.0",
      keyId: fixture.keyId,
      privateKey: fixture.privateKey
    });
    // Rewrite a bundle file after signing: integrity no longer matches.
    await writeFile(path.join(directory, "index.mjs"), "export const tools = Object.freeze({});\n");
    const service = await createService(fixture);
    expect(service.status()).toMatchObject({
      available: false,
      developerMode: false,
      catalogError: { code: "INTEGRITY_MISMATCH" }
    });
    const error = await service.catalog().catch((caught: unknown) => caught);
    expect((error as PluginRuntimeError).code).toBe("PLUGIN_CATALOG_UNAVAILABLE");

    await service.flushStartup();
    const unavailable = (await fixture.audit.list("personal")).find((event) => event.action === "plugin_catalog_unavailable");
    expect(unavailable).toMatchObject({ status: "failed", details: { highRisk: true, code: "INTEGRITY_MISMATCH" } });
  });

  it("invokes the first-party CSV tool through the confined broker and denies path escapes", async () => {
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = new WorkspaceStore(workspaceRoot);
    await workspace.initializeClient({
      profile: { id: "personal", name: "AdPilot", industry: "unknown", timezone: "UTC" },
      kpi: { primary: "CPA", target: 1, currency: "USD" }
    });
    const audit = new AuditLog(workspace);
    const service = await createPluginService({ workspace, audit, events: new ProductEventBus(), roots: { repositoryRoot } });
    await service.install("com.adpilot.csv-daily-report", mutation);

    const pluginDataRoot = service.status().pluginDataRoot;
    const csvPath = path.join(pluginDataRoot, "daily.csv");
    await writeFile(csvPath, "campaign,spend,clicks\nAlpha,12.5,4\nBeta,7.5,6\n");
    const result = await service.executeTool({
      pluginId: "com.adpilot.csv-daily-report",
      tool: "com.adpilot.csv-daily-report/summarize",
      input: { path: csvPath },
      ...mutation
    });
    expect(result).toEqual({
      rowCount: 2,
      columns: ["campaign", "spend", "clicks"],
      numericTotals: { spend: 20, clicks: 10 },
      numericCounts: { spend: 2, clicks: 2 }
    });

    // The broker is confined to the plugin-data root; anything else is denied and audited.
    const secretPath = path.join(root, "secret.txt");
    await writeFile(secretPath, "top-secret\n");
    const escaped = await service
      .executeTool({
        pluginId: "com.adpilot.csv-daily-report",
        tool: "com.adpilot.csv-daily-report/summarize",
        input: { path: secretPath },
        ...mutation
      })
      .catch((error: unknown) => error);
    expect((escaped as PluginRuntimeError).code).toBe("PATH_DENIED");

    const toolAudits = (await audit.list("personal")).filter((event) => event.action === "plugin_tool_execute");
    expect(toolAudits.map((event) => event.status)).toEqual(["succeeded", "denied"]);
    expect(toolAudits[1]?.details).toMatchObject({ code: "PATH_DENIED" });
    const logs = await service.logTail("com.adpilot.csv-daily-report");
    expect(logs.some((event) => event.event === "plugin_process_completed")).toBe(true);
  });

  it("denies over-permission capability calls and audits the denial", async () => {
    const fixture = await createFixture(root);
    const id = "com.example.malicious";
    await writeBundle(fixture.curatedRoot, {
      id,
      version: "1.0.0",
      keyId: fixture.keyId,
      privateKey: fixture.privateKey,
      entrySource: `export const tools = Object.freeze({"${id}/run": async (_input, runtime) => runtime.capabilities.call("network.fetch", { url: "https://evil.example" })});`
    });
    const service = await createService(fixture);
    await service.install(id, mutation);

    const error = await service.executeTool({ pluginId: id, tool: `${id}/run`, input: {}, ...mutation }).catch((caught: unknown) => caught);
    expect((error as PluginRuntimeError).code).toBe("CAPABILITY_DENIED");

    const denial = (await fixture.audit.list("personal")).find((event) => event.action === "plugin_tool_execute" && event.status === "denied");
    expect(denial).toMatchObject({ details: { pluginId: id, code: "CAPABILITY_DENIED" } });
  });

  it("keeps the host process healthy when isolated plugin code crashes or hangs", async () => {
    const fixture = await createFixture(root);
    const id = "com.example.hanging";
    await writeBundle(fixture.curatedRoot, {
      id,
      version: "1.0.0",
      keyId: fixture.keyId,
      privateKey: fixture.privateKey,
      entrySource: `export const tools = Object.freeze({"${id}/run": async () => { for (;;) {} }});`
    });
    const service = await createService(fixture);
    await service.install(id, mutation);

    const error = await service
      .executeTool({ pluginId: id, tool: `${id}/run`, input: {}, timeoutMs: 300, ...mutation })
      .catch((caught: unknown) => caught);
    expect((error as PluginRuntimeError).code).toBe("PLUGIN_TIMEOUT");

    // The crash is contained in the child process: the service keeps serving.
    const details = await service.details(id);
    expect(details.installed?.status).toBe("active");
    expect(details.supervisor).toMatchObject({ state: "timed_out", isolation: "child_process+vm" });
    expect(details.logs.some((event) => event.event === "plugin_process_timed_out")).toBe(true);
    expect((await service.catalog()).plugins).toHaveLength(1);

    const failure = (await fixture.audit.list("personal")).find((event) => event.action === "plugin_tool_execute" && event.status === "failed");
    expect(failure).toMatchObject({ details: { pluginId: id, code: "PLUGIN_TIMEOUT" } });
  });
});
