import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PluginCatalogService,
  describePermissionDiff,
  describePluginPermissions
} from "./catalog-service.ts";
import {
  computeBundleIntegrity,
  PluginManifestSchema,
  pluginSignaturePayload,
  type BundleFile,
  type PluginManifest,
  type PluginPermissions
} from "./index.ts";

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

async function writeSignedBundle(options: {
  curatedRoot: string;
  privateKey: KeyObject;
  keyId: string;
  id: string;
  version: string;
  permissions: PluginPermissions;
}): Promise<{ directory: string; manifest: PluginManifest }> {
  const directory = path.join(options.curatedRoot, `${options.id}-${options.version}`);
  await mkdir(directory, { recursive: true });
  const source = `export const tools = Object.freeze({"${options.id}/inspect": async () => ({ok: true})});`;
  const unsigned = PluginManifestSchema.parse({
    schemaVersion: 1,
    id: options.id,
    name: "Catalog Test Plugin",
    version: options.version,
    developer: { name: "AdPilot Tests" },
    description: "A signed bundle used to verify product catalog DTOs.",
    entry: "index.mjs",
    tools: [
      {
        name: `${options.id}/inspect`,
        description: "Inspect catalog behavior.",
        readOnly: true
      }
    ],
    skills: [],
    uiExtensions: [],
    permissions: options.permissions,
    platforms: ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"],
    integrity: `sha256:${"0".repeat(64)}`,
    review: {
      status: "approved",
      reviewedAt: "2026-07-27T00:00:00.000Z",
      reviewer: "AdPilot Tests"
    },
    replaces: [],
    dataVersion: 0,
    migrations: []
  });
  const files: BundleFile[] = [{ path: "index.mjs", bytes: Buffer.from(source) }];
  const withIntegrity: PluginManifest = {
    ...unsigned,
    integrity: computeBundleIntegrity(unsigned, files)
  };
  const manifest: PluginManifest = {
    ...withIntegrity,
    signature: {
      algorithm: "ed25519",
      keyId: options.keyId,
      value: sign(null, pluginSignaturePayload(withIntegrity), options.privateKey).toString("base64")
    }
  };
  await writeFile(path.join(directory, "index.mjs"), source);
  await writeFile(path.join(directory, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, manifest };
}

describe("PluginCatalogService", () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "adpilot-plugin-catalog-"));
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("discovers the repository catalog, loads first-party trust, and exposes lifecycle DTOs", async () => {
    const workspaceRoot = path.join(temporaryRoot, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const service = await PluginCatalogService.create({ workspaceRoot, repositoryRoot });

    expect(service.store.root).toBe(
      path.join(workspaceRoot, ".adpilot", "plugin-runtime")
    );
    const catalog = await service.listCatalog();
    const csv = catalog.find((plugin) => plugin.id === "com.adpilot.csv-daily-report");
    expect(csv).toMatchObject({
      name: "CSV Daily Report",
      latestVersion: "1.0.0",
      availableVersions: ["1.0.0"],
      installed: null,
      signature: {
        signed: true,
        keyId: "adpilot-first-party-2026-01"
      },
      permissions: [
        {
          key: "filesystem:read.text",
          category: "filesystem",
          risk: "medium",
          requiresReviewWhenAdded: true
        }
      ]
    });
    expect(csv?.permissions[0]?.description).toContain("host allowlist");

    const details = await service.getDetails("com.adpilot.csv-daily-report");
    expect(details).toMatchObject({
      selectedVersion: "1.0.0",
      dataVersion: 0,
      review: { status: "approved" }
    });
    expect(details.integrity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(details.tools[0]?.readOnly).toBe(true);

    const installed = await service.install("com.adpilot.csv-daily-report");
    expect(installed).toMatchObject({
      id: "com.adpilot.csv-daily-report",
      status: "active",
      version: "1.0.0",
      pendingUpdate: null
    });
    expect(await service.listInstalled()).toHaveLength(1);
    expect((await service.disable(installed.id)).status).toBe("disabled");
    expect((await service.enable(installed.id)).status).toBe("active");
    expect(await service.uninstall(installed.id)).toEqual({
      id: installed.id,
      status: "uninstalled"
    });
    expect(await service.listInstalled()).toEqual([]);
  });

  it("shows a human-readable new-permission diff before an update can activate", async () => {
    const customRepository = path.join(temporaryRoot, "repository");
    const curatedRoot = path.join(customRepository, "plugins", "curated");
    const trustRoot = path.join(curatedRoot, "trust");
    const workspaceRoot = path.join(temporaryRoot, "workspace");
    await Promise.all([
      mkdir(trustRoot, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true })
    ]);
    const pair = generateKeyPairSync("ed25519");
    const keyId = "catalog-test-key";
    await writeFile(
      path.join(trustRoot, `${keyId}.pem`),
      pair.publicKey.export({ type: "spki", format: "pem" })
    );
    const id = "com.example.catalog-update";
    await writeSignedBundle({
      curatedRoot,
      privateKey: pair.privateKey,
      keyId,
      id,
      version: "1.0.0",
      permissions: emptyPermissions
    });
    await writeSignedBundle({
      curatedRoot,
      privateKey: pair.privateKey,
      keyId,
      id,
      version: "2.0.0",
      permissions: {
        ...emptyPermissions,
        filesystem: ["read.text"],
        advertisingRead: true
      }
    });
    const service = await PluginCatalogService.create({
      workspaceRoot,
      repositoryRoot: customRepository,
      approvalVerifier: { verify: async () => true }
    });
    await service.install(id, "1.0.0");

    const catalogItem = (await service.listCatalog()).find((plugin) => plugin.id === id);
    expect(catalogItem?.update).toMatchObject({
      version: "2.0.0",
      requiresApproval: true,
      permissionDiff: {
        hasNewPermissions: true,
        added: [
          {
            key: "advertisingRead",
            title: "Read advertising data",
            risk: "medium"
          },
          {
            key: "filesystem:read.text",
            title: "Read approved text files",
            risk: "medium"
          }
        ]
      }
    });

    const pending = await service.update(id, "2.0.0");
    expect(pending.status).toBe("needs_review");
    expect(pending.version).toBe("1.0.0");
    expect(pending.pendingUpdate).toMatchObject({
      version: "2.0.0",
      permissionDiff: {
        hasNewPermissions: true
      }
    });
    expect(pending.pendingUpdate?.permissionDiff.added.map((permission) => permission.key)).toEqual([
      "advertisingRead",
      "filesystem:read.text"
    ]);

    const approvalRequest = pending.pendingUpdate!.approvalRequest;
    const approved = await service.approveUpdate(id, {
      receiptId: randomUUID(),
      installationId: approvalRequest.installationId,
      stateRevision: approvalRequest.stateRevision,
      pluginId: approvalRequest.pluginId,
      version: approvalRequest.version,
      targetIntegrity: approvalRequest.targetIntegrity,
      approvedPermissionKeys: approvalRequest.addedPermissionKeys,
      actor: "product-security",
      approvedAt: new Date().toISOString(),
      decision: "approved"
    });
    expect(approved).toMatchObject({
      status: "active",
      version: "2.0.0",
      pendingUpdate: null
    });
    expect(approved.permissions.map((permission) => permission.key)).toEqual([
      "advertisingRead",
      "filesystem:read.text"
    ]);
  });

  it("fails catalog creation when a discovered curated bundle was tampered", async () => {
    const customRepository = path.join(temporaryRoot, "tampered-repository");
    const curatedRoot = path.join(customRepository, "plugins", "curated");
    const trustRoot = path.join(curatedRoot, "trust");
    await mkdir(trustRoot, { recursive: true });
    const pair = generateKeyPairSync("ed25519");
    const keyId = "tamper-test-key";
    await writeFile(
      path.join(trustRoot, `${keyId}.pem`),
      pair.publicKey.export({ type: "spki", format: "pem" })
    );
    const bundle = await writeSignedBundle({
      curatedRoot,
      privateKey: pair.privateKey,
      keyId,
      id: "com.example.tampered-catalog",
      version: "1.0.0",
      permissions: emptyPermissions
    });
    await writeFile(path.join(bundle.directory, "index.mjs"), "export const tools = {};\n");

    await expect(
      PluginCatalogService.create({
        workspaceRoot: path.join(temporaryRoot, "workspace"),
        repositoryRoot: customRepository
      })
    ).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
  });

  it("describes sensitive permissions without exposing secret values", () => {
    const descriptions = describePluginPermissions({
      ...emptyPermissions,
      secrets: ["reporting.api-key"],
      computerUse: true,
      advertisingMutation: true
    });
    expect(descriptions.map(({ key, risk }) => ({ key, risk }))).toEqual([
      { key: "advertisingMutation", risk: "critical" },
      { key: "computerUse", risk: "critical" },
      { key: "secrets:reporting.api-key", risk: "high" }
    ]);
    expect(descriptions.find((permission) => permission.category === "secret")?.description).not.toContain(
      "secret-value"
    );
    expect(
      describePermissionDiff(
        { ...emptyPermissions, storage: true },
        { ...emptyPermissions, browser: true }
      )
    ).toMatchObject({
      hasNewPermissions: true,
      added: [{ key: "browser", risk: "high" }],
      removed: [{ key: "storage", risk: "low" }]
    });
  });
});
