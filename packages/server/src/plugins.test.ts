import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdPilotSystem, type AdPilotSystem } from "@adpilot/application";
import {
  computeBundleIntegrity,
  PluginManifestSchema,
  pluginSignaturePayload,
  type BundleFile,
  type PluginManifest,
  type PluginPermissions
} from "@adpilot/plugin-runtime";
import { createServer } from "./index.js";

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

async function writeBundle(
  curatedRoot: string,
  options: {
    id: string;
    version: string;
    keyId: string;
    privateKey?: KeyObject;
    permissions?: PluginPermissions;
  }
): Promise<void> {
  const directory = path.join(curatedRoot, `${options.id}-${options.version}`);
  await mkdir(directory, { recursive: true });
  const source = `export const tools = Object.freeze({"${options.id}/run": async (input) => ({ input })});`;
  const unsigned = PluginManifestSchema.parse({
    schemaVersion: 1,
    id: options.id,
    name: "Test Plugin",
    version: options.version,
    developer: { name: "AdPilot Tests" },
    description: "A test-only curated plugin bundle.",
    entry: "index.mjs",
    tools: [{ name: `${options.id}/run`, description: "Run the test tool.", readOnly: true }],
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
}

/** A custom curated repository (plugins/curated + trust anchor) for fixture bundles. */
async function createCustomRepository(root: string): Promise<{ repositoryRoot: string; curatedRoot: string; keyId: string; privateKey: KeyObject }> {
  const repositoryRoot = path.join(root, "repository");
  const curatedRoot = path.join(repositoryRoot, "plugins", "curated");
  const trustRoot = path.join(curatedRoot, "trust");
  await mkdir(trustRoot, { recursive: true });
  const pair = generateKeyPairSync("ed25519");
  const keyId = "server-test-key";
  await writeFile(path.join(trustRoot, `${keyId}.pem`), pair.publicKey.export({ type: "spki", format: "pem" }));
  return { repositoryRoot, curatedRoot, keyId, privateKey: pair.privateKey };
}

async function inject(app: Awaited<ReturnType<typeof createServer>>, method: "GET" | "POST", url: string, body?: unknown) {
  const response = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe("plugin REST endpoints", () => {
  let root: string;
  let system: AdPilotSystem;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "adpilot-server-plugins-"));
  });

  afterEach(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });

  async function boot(options: { pluginCatalog?: { repositoryRoot: string } } = {}) {
    system = await createAdPilotSystem({ workspaceRoot: path.join(root, "workspace"), env: {}, ...options });
    app = await createServer(system);
  }

  it("lists the curated catalog with signature, review, and install status", async () => {
    await boot();
    const { status, body } = await inject(app, "GET", "/api/plugins");
    expect(status).toBe(200);
    expect(body.runtime).toMatchObject({ available: true, developerMode: false, isolation: "child_process+vm" });
    expect(body.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "github-official-mcp", installable: false, recommendedMode: "read-only" }),
      expect.objectContaining({ id: "google-drive-official-mcp", installable: false, maturity: "developer-preview" }),
      expect.objectContaining({ id: "figma-official-mcp", installable: false, maturity: "beta" }),
      expect.objectContaining({ id: "google-ads-api-connector", installable: false, maturity: "stable" }),
      expect.objectContaining({ id: "tiktok-business-api-connector", installable: false, maturity: "stable" })
    ]));
    const plugins = body.plugins as Array<Record<string, unknown>>;
    const csv = plugins.find((plugin) => plugin.id === "com.adpilot.csv-daily-report");
    expect(csv).toMatchObject({
      name: "CSV Daily Report",
      latestVersion: "1.0.0",
      installed: null,
      signature: { signed: true, keyId: "adpilot-first-party-2026-01" },
      review: { status: "approved" }
    });
    expect(csv?.tools).toEqual([{ name: "com.adpilot.csv-daily-report/summarize", description: expect.any(String), readOnly: true }]);
    expect(csv?.permissions).toEqual([
      expect.objectContaining({ key: "filesystem:read.text", category: "filesystem", requiresReviewWhenAdded: true })
    ]);

    const candidateInstall = await inject(app, "POST", "/api/plugins/github-official-mcp/install", {});
    expect(candidateInstall).toMatchObject({
      status: 404,
      body: { code: "PLUGIN_NOT_FOUND" }
    });
  });

  it("runs the full lifecycle over REST with details, verification, SSE, and audit", async () => {
    await boot();
    const pluginEvents: Array<Record<string, unknown>> = [];
    system.events.subscribe((event) => {
      if (event.type === "plugin") pluginEvents.push(event as unknown as Record<string, unknown>);
    }, "personal");

    const installed = await inject(app, "POST", "/api/plugins/com.adpilot.csv-daily-report/install", {});
    expect(installed.status).toBe(201);
    expect(installed.body).toMatchObject({ id: "com.adpilot.csv-daily-report", status: "active", version: "1.0.0" });

    const details = await inject(app, "GET", "/api/plugins/com.adpilot.csv-daily-report");
    expect(details.status).toBe(200);
    expect(details.body.installed).toMatchObject({ status: "active", version: "1.0.0" });
    expect(details.body.verification).toMatchObject({
      ok: true,
      signerKeyId: "adpilot-first-party-2026-01",
      error: null
    });
    expect(details.body.supervisor).toMatchObject({ state: "idle", isolation: "child_process+vm" });
    expect(details.body.logs).toEqual([]);
    expect(details.body.plugin).toMatchObject({ integrity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });

    expect((await inject(app, "POST", "/api/plugins/com.adpilot.csv-daily-report/disable", {})).body).toMatchObject({ status: "disabled" });
    expect((await inject(app, "POST", "/api/plugins/com.adpilot.csv-daily-report/enable", {})).body).toMatchObject({ status: "active" });
    // Already at the latest version: update is an idempotent no-op.
    const update = await inject(app, "POST", "/api/plugins/com.adpilot.csv-daily-report/update", {});
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({ status: "active", version: "1.0.0" });
    expect((await inject(app, "POST", "/api/plugins/com.adpilot.csv-daily-report/uninstall", {})).body).toEqual({
      id: "com.adpilot.csv-daily-report",
      status: "uninstalled"
    });
    expect((await inject(app, "GET", "/api/plugins/com.adpilot.csv-daily-report")).body.installed).toBeNull();

    expect(pluginEvents.map((event) => event.status)).toEqual(["installed", "disabled", "enabled", "uninstalled"]);
    const audit = await system.audit.list("personal");
    expect(audit.filter((event) => event.action.startsWith("plugin_")).map((event) => `${event.action}:${event.status}`)).toEqual([
      "plugin_install:succeeded",
      "plugin_disable:succeeded",
      "plugin_enable:succeeded",
      "plugin_uninstall:succeeded"
    ]);
    expect(await system.audit.verify("personal")).toBe(true);
  });

  it("maps unknown plugins and malformed bodies onto the error contract", async () => {
    await boot();
    const missing = await inject(app, "GET", "/api/plugins/com.example.unknown");
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "PLUGIN_NOT_FOUND" });

    const installMissing = await inject(app, "POST", "/api/plugins/com.example.unknown/install", {});
    expect(installMissing.status).toBe(404);

    const invalidBody = await inject(app, "POST", "/api/plugins/com.adpilot.csv-daily-report/install", { allowUnsigned: false });
    expect(invalidBody.status).toBe(400);

    const invalidVersion = await inject(app, "POST", "/api/plugins/com.adpilot.csv-daily-report/install", { version: "not-a-version" });
    expect(invalidVersion.status).toBe(400);

    const disableMissing = await inject(app, "POST", "/api/plugins/com.adpilot.csv-daily-report/disable", {});
    expect(disableMissing.status).toBe(404);
    expect(disableMissing.body).toMatchObject({ code: "NOT_INSTALLED" });
  });

  it("requires acceptPermissions for updates that add permissions (409 with the exact diff)", async () => {
    const repository = await createCustomRepository(root);
    const id = "com.example.consent";
    await writeBundle(repository.curatedRoot, { id, version: "1.0.0", keyId: repository.keyId, privateKey: repository.privateKey });
    await writeBundle(repository.curatedRoot, {
      id,
      version: "2.0.0",
      keyId: repository.keyId,
      privateKey: repository.privateKey,
      permissions: { ...emptyPermissions, filesystem: ["read.text"] }
    });
    await boot({ pluginCatalog: { repositoryRoot: repository.repositoryRoot } });

    expect((await inject(app, "POST", `/api/plugins/${id}/install`, { version: "1.0.0" })).status).toBe(201);

    const refused = await inject(app, "POST", `/api/plugins/${id}/update`, {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "PLUGIN_PERMISSION_REVIEW_REQUIRED" });
    const update = refused.body.update as Record<string, unknown>;
    expect(update).toMatchObject({ version: "2.0.0", requiresApproval: true });
    const diff = update.permissionDiff as { hasNewPermissions: boolean; added: Array<{ key: string }> };
    expect(diff.hasNewPermissions).toBe(true);
    expect(diff.added.map((permission) => permission.key)).toEqual(["filesystem:read.text"]);
    // Refusal staged nothing.
    expect((await inject(app, "GET", `/api/plugins/${id}`)).body.installed).toMatchObject({ status: "active", version: "1.0.0" });

    const approved = await inject(app, "POST", `/api/plugins/${id}/update`, { acceptPermissions: true });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: "active", version: "2.0.0", pendingUpdate: null });

    const audit = await system.audit.list("personal");
    const updateAudit = audit.filter((event) => event.action === "plugin_update").at(-1);
    expect(updateAudit).toMatchObject({
      status: "succeeded",
      details: { pluginId: id, toVersion: "2.0.0", approvedPermissions: ["filesystem:read.text"] }
    });
  });

  it("rejects unsigned installs without the flag and audits allowUnsigned as high risk", async () => {
    const repository = await createCustomRepository(root);
    const id = "com.example.unsigned";
    await writeBundle(repository.curatedRoot, { id, version: "1.0.0", keyId: repository.keyId });
    await boot({ pluginCatalog: { repositoryRoot: repository.repositoryRoot } });

    const catalog = await inject(app, "GET", "/api/plugins");
    expect(catalog.body.runtime).toMatchObject({ available: true, developerMode: true });

    const refused = await inject(app, "POST", `/api/plugins/${id}/install`, {});
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "UNSIGNED_REJECTED" });

    const allowed = await inject(app, "POST", `/api/plugins/${id}/install`, { allowUnsigned: true });
    expect(allowed.status).toBe(201);
    expect(allowed.body).toMatchObject({ id, status: "active", version: "1.0.0" });

    const audit = await system.audit.list("personal");
    expect(audit.find((event) => event.action === "plugin_catalog_developer_mode")).toMatchObject({
      status: "denied",
      details: { highRisk: true }
    });
    const installs = audit.filter((event) => event.action === "plugin_install");
    expect(installs.map((event) => event.status)).toEqual(["denied", "succeeded"]);
    expect(installs[1]?.details).toMatchObject({ highRisk: true, allowUnsigned: true, pluginId: id });
    expect(await system.audit.verify("personal")).toBe(true);
  });
});
