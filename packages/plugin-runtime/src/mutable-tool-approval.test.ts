import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CapabilityBroker,
  computeBundleIntegrity,
  CuratedPluginRuntime,
  CuratedRegistry,
  FilePluginStore,
  PluginManifestSchema,
  PluginRuntimeError,
  pluginSignaturePayload,
  StaticPluginTrustStore,
  type BundleFile,
  type PluginManifest,
  type PluginMutableToolApprovalContext,
  type PluginPermissions
} from "./index.ts";

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

const PLUGIN_ID = "com.example.mutable-plugin";
const TOOL = `${PLUGIN_ID}/run`;

async function createMutableBundle(base: string, privateKey: KeyObject) {
  const directory = path.join(base, `${PLUGIN_ID}-1.0.0`);
  await mkdir(directory, { recursive: true });
  const files = {
    "index.mjs": `export const tools = Object.freeze({"${TOOL}": async (input) => ({ input })});`
  };
  const unsignedManifest = PluginManifestSchema.parse({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: "Mutable Test Plugin",
    version: "1.0.0",
    developer: { name: "AdPilot Tests" },
    description: "A test-only plugin with a mutable (readOnly: false) tool.",
    entry: "index.mjs",
    tools: [{ name: TOOL, description: "Mutable test tool.", readOnly: false }],
    skills: [],
    uiExtensions: [],
    permissions: emptyPermissions,
    platforms: ["darwin-arm64", "linux-x64"],
    integrity: `sha256:${"0".repeat(64)}`,
    review: { status: "approved", reviewedAt: "2026-07-27T00:00:00.000Z", reviewer: "AdPilot Tests" },
    replaces: [],
    dataVersion: 0,
    migrations: []
  });
  const bundleFiles: BundleFile[] = Object.entries(files).map(([filePath, source]) => ({
    path: filePath,
    bytes: Buffer.from(source)
  }));
  const integrity = computeBundleIntegrity(unsignedManifest, bundleFiles);
  const unsignedWithIntegrity = { ...unsignedManifest, integrity };
  const manifest: PluginManifest = {
    ...unsignedWithIntegrity,
    signature: {
      algorithm: "ed25519",
      keyId: "test-key",
      value: sign(null, pluginSignaturePayload(unsignedWithIntegrity), privateKey).toString("base64")
    }
  };
  for (const [filePath, source] of Object.entries(files)) {
    await writeFile(path.join(directory, filePath), source, "utf8");
  }
  await writeFile(path.join(directory, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, manifest };
}

describe("mutable plugin tool approval gate", () => {
  let temporaryRoot: string;
  let privateKey: KeyObject;
  let runtime: (gate?: { verify(context: PluginMutableToolApprovalContext): Promise<void> }) => Promise<CuratedPluginRuntime>;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "adpilot-plugin-approval-gate-"));
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    const bundle = await createMutableBundle(temporaryRoot, privateKey);
    const registry = new CuratedRegistry();
    await registry.registerBundle(bundle.directory);
    const trustStore = new StaticPluginTrustStore({ "test-key": pair.publicKey });
    runtime = async (gate) => {
      const instance = new CuratedPluginRuntime({
        registry,
        store: new FilePluginStore(path.join(temporaryRoot, `store-${Math.random().toString(16).slice(2)}`)),
        trustStore,
        ...(gate ? { mutableToolApprovalGate: gate } : {})
      });
      await instance.install(PLUGIN_ID);
      return instance;
    };
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("fails closed with APPROVAL_REQUIRED when no gate is configured", async () => {
    const instance = await runtime();
    const rejection = await instance
      .executeTool(PLUGIN_ID, TOOL, { value: 1 }, new CapabilityBroker(), { approval: { id: "x" } })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(PluginRuntimeError);
    expect(rejection).toMatchObject({ code: "APPROVAL_REQUIRED", retryable: false });
  });

  it("fails closed with APPROVAL_REQUIRED when the invocation carries no approval", async () => {
    const gate = { verify: vi.fn(async (_context: PluginMutableToolApprovalContext) => undefined) };
    const instance = await runtime(gate);
    const rejection = await instance
      .executeTool(PLUGIN_ID, TOOL, { value: 1 }, new CapabilityBroker())
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(PluginRuntimeError);
    expect(rejection).toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(gate.verify).not.toHaveBeenCalled();
  });

  it("rejects with APPROVAL_INVALID when the gate refuses the approval", async () => {
    const gate = {
      verify: vi.fn(async (_context: PluginMutableToolApprovalContext) => {
        throw new Error("token already consumed");
      })
    };
    const instance = await runtime(gate);
    const rejection = await instance
      .executeTool(PLUGIN_ID, TOOL, { value: 1 }, new CapabilityBroker(), { approval: { id: "consumed" } })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(PluginRuntimeError);
    expect(rejection).toMatchObject({ code: "APPROVAL_INVALID" });
    expect((rejection as Error).message).toContain("token already consumed");
  });

  it("lets a mutable invocation through once the gate accepts the approval", async () => {
    const approval = { approvalId: "approval-1", token: "one-time-token" };
    const gate = { verify: vi.fn(async (_context: PluginMutableToolApprovalContext) => undefined) };
    const instance = await runtime(gate);
    const result = await instance.executeTool(
      PLUGIN_ID,
      TOOL,
      { value: 42 },
      new CapabilityBroker(),
      { approval }
    );
    expect(result).toEqual({ input: { value: 42 } });
    expect(gate.verify).toHaveBeenCalledTimes(1);
    expect(gate.verify).toHaveBeenCalledWith({
      pluginId: PLUGIN_ID,
      tool: TOOL,
      input: { value: 42 },
      approval
    });
  });
});
