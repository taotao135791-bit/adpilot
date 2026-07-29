import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CapabilityBroker,
  computeBundleIntegrity,
  createReadOnlyFileBroker,
  CuratedPluginRuntime,
  CuratedRegistry,
  DEFAULT_VERIFICATION_POLICY,
  diffPluginPermissions,
  FilePluginStore,
  loadPluginBundle,
  PluginManifestSchema,
  PluginRuntimeError,
  PluginSupervisor,
  pluginSignaturePayload,
  StaticPluginTrustStore,
  StructuredPluginLogger,
  verifyPluginBundle,
  type BundleFile,
  type BundleVerificationPolicy,
  type InstalledPluginState,
  type PluginApprovalReceipt,
  type PluginManifest,
  type PluginPermissions
} from "./index.ts";

const firstPartyBundle = fileURLToPath(
  new URL("../../../plugins/curated/com.adpilot.csv-daily-report", import.meta.url)
);
const firstPartyKey = fileURLToPath(
  new URL("../../../plugins/curated/trust/adpilot-first-party-2026-01.pem", import.meta.url)
);

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

const testApprovalVerifier = {
  verify: async () => true
};

function approvalReceiptFor(
  state: InstalledPluginState,
  actor = "security-reviewer"
): PluginApprovalReceipt {
  if (!state.pendingUpdate) throw new Error("Expected a pending update");
  return {
    receiptId: randomUUID(),
    installationId: state.installationId,
    stateRevision: state.revision,
    pluginId: state.pluginId,
    version: state.pendingUpdate.version,
    targetIntegrity: state.pendingUpdate.targetIntegrity,
    approvedPermissionKeys: [...state.pendingUpdate.permissionDiff.added],
    actor,
    approvedAt: new Date().toISOString(),
    decision: "approved"
  };
}

interface CreateBundleOptions {
  id?: string;
  version?: string;
  entrySource?: string;
  files?: Record<string, string>;
  permissions?: PluginPermissions;
  dataVersion?: number;
  migrations?: PluginManifest["migrations"];
  replaces?: string[];
  privateKey?: KeyObject;
  keyId?: string;
  unsigned?: boolean;
  toolReadOnly?: boolean;
}

async function createBundle(base: string, options: CreateBundleOptions = {}) {
  const id = options.id ?? "com.example.test-plugin";
  const version = options.version ?? "1.0.0";
  const directory = path.join(base, `${id}-${version}-${Math.random().toString(16).slice(2)}`);
  await mkdir(directory, { recursive: true });
  const files = {
    "index.mjs":
      options.entrySource ??
      `export const tools = Object.freeze({"${id}/run": async (input) => ({input})});`,
    ...options.files
  };
  const unsignedManifest = PluginManifestSchema.parse({
    schemaVersion: 1,
    id,
    name: "Test Plugin",
    version,
    developer: { name: "AdPilot Tests" },
    description: "A test-only curated plugin bundle.",
    entry: "index.mjs",
    tools: [
      {
        name: `${id}/run`,
        description: "Run test tool.",
        readOnly: options.toolReadOnly ?? true
      }
    ],
    skills: [],
    uiExtensions: [],
    permissions: options.permissions ?? emptyPermissions,
    platforms: ["darwin-arm64", "linux-x64"],
    integrity: `sha256:${"0".repeat(64)}`,
    review: {
      status: "approved",
      reviewedAt: "2026-07-27T00:00:00.000Z",
      reviewer: "AdPilot Tests"
    },
    replaces: options.replaces ?? [],
    dataVersion: options.dataVersion ?? 0,
    migrations: options.migrations ?? []
  });
  const bundleFiles: BundleFile[] = Object.entries(files).map(([filePath, source]) => ({
    path: filePath,
    bytes: Buffer.from(source)
  }));
  const integrity = computeBundleIntegrity(unsignedManifest, bundleFiles);
  let manifest: PluginManifest = { ...unsignedManifest, integrity };
  if (!options.unsigned) {
    if (!options.privateKey) throw new Error("A private key is required for signed test bundles");
    manifest = {
      ...manifest,
      signature: {
        algorithm: "ed25519",
        keyId: options.keyId ?? "test-key",
        value: sign(null, pluginSignaturePayload(manifest), options.privateKey).toString("base64")
      }
    };
  }
  for (const [filePath, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, filePath)), { recursive: true });
    await writeFile(path.join(directory, filePath), source, "utf8");
  }
  await writeFile(path.join(directory, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, manifest };
}

describe("curated plugin runtime", () => {
  let temporaryRoot: string;
  let privateKey: KeyObject;
  let publicKey: KeyObject;
  let trustStore: StaticPluginTrustStore;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "adpilot-plugin-runtime-"));
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    trustStore = new StaticPluginTrustStore({ "test-key": publicKey });
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("installs and invokes the signed first-party CSV tool through a read-only broker", async () => {
    const registry = new CuratedRegistry();
    await registry.registerBundle(firstPartyBundle);
    const pem = await readFile(firstPartyKey);
    const runtime = new CuratedPluginRuntime({
      registry,
      store: new FilePluginStore(path.join(temporaryRoot, "store")),
      trustStore: new StaticPluginTrustStore({ "adpilot-first-party-2026-01": pem })
    });
    const installed = await runtime.install("com.adpilot.csv-daily-report");
    expect(installed.status).toBe("active");
    expect(installed.lifecycle[0]?.event).toBe("installed");

    const csvPath = path.join(temporaryRoot, "daily.csv");
    await writeFile(csvPath, "campaign,spend,clicks\nAlpha,12.5,4\nBeta,7.5,6\n");
    const result = await runtime.executeTool(
      "com.adpilot.csv-daily-report",
      "com.adpilot.csv-daily-report/summarize",
      { path: csvPath },
      createReadOnlyFileBroker([temporaryRoot])
    );
    expect(result).toEqual({
      rowCount: 2,
      columns: ["campaign", "spend", "clicks"],
      numericTotals: { spend: 20, clicks: 10 },
      numericCounts: { spend: 2, clicks: 2 }
    });
  });

  it("persists disable/enable lifecycle and transactionally uninstalls with a tombstone", async () => {
    const bundle = await createBundle(temporaryRoot, { privateKey });
    const registry = new CuratedRegistry();
    await registry.registerBundle(bundle.directory);
    const store = new FilePluginStore(path.join(temporaryRoot, "store"));
    const runtime = new CuratedPluginRuntime({
      registry,
      store,
      trustStore,
      approvalVerifier: testApprovalVerifier
    });
    await runtime.install(bundle.manifest.id);
    expect((await runtime.disable(bundle.manifest.id)).status).toBe("disabled");
    expect((await runtime.enable(bundle.manifest.id)).status).toBe("active");
    await runtime.uninstall(bundle.manifest.id);
    expect(await store.getState(bundle.manifest.id)).toBeUndefined();
    const tombstones = await readdir(path.join(store.root, "tombstones"));
    expect(tombstones).toHaveLength(1);
    const tombstone = JSON.parse(
      await readFile(path.join(store.root, "tombstones", tombstones[0]!), "utf8")
    ) as { lifecycle: Array<{ event: string }> };
    expect(tombstone.lifecycle.map((record) => record.event)).toEqual([
      "installed",
      "disabled",
      "enabled",
      "uninstalled"
    ]);
  });

  it("stages permission-expanding updates as needs_review and activates only after approval", async () => {
    const id = "com.example.permission-review";
    const first = await createBundle(temporaryRoot, { id, version: "1.0.0", privateKey });
    const secondPermissions = {
      ...emptyPermissions,
      capabilities: ["reports.read"]
    };
    const second = await createBundle(temporaryRoot, {
      id,
      version: "2.0.0",
      permissions: secondPermissions,
      privateKey
    });
    const registry = new CuratedRegistry();
    await registry.registerBundle(first.directory);
    await registry.registerBundle(second.directory);
    const store = new FilePluginStore(path.join(temporaryRoot, "store"));
    const runtime = new CuratedPluginRuntime({
      registry,
      store,
      trustStore,
      approvalVerifier: testApprovalVerifier
    });
    await runtime.install(id, "1.0.0");
    const pending = await runtime.update(id, "2.0.0");
    expect(pending.status).toBe("needs_review");
    expect(pending.activeVersion).toBe("1.0.0");
    expect(pending.pendingUpdate?.permissionDiff.added).toEqual(["capabilities:reports.read"]);
    await expect(
      runtime.executeTool(id, `${id}/run`, {}, new CapabilityBroker())
    ).rejects.toMatchObject({ code: "PLUGIN_INACTIVE" });
    const runtimeWithoutApprovalTrust = new CuratedPluginRuntime({
      registry,
      store,
      trustStore
    });
    await expect(
      runtimeWithoutApprovalTrust.approvePendingUpdate(id, approvalReceiptFor(pending))
    ).rejects.toMatchObject({ code: "APPROVAL_VERIFIER_REQUIRED" });

    const approvalReceipt = approvalReceiptFor(pending);
    const approved = await runtime.approvePendingUpdate(id, approvalReceipt);
    expect(approved.status).toBe("active");
    expect(approved.activeVersion).toBe("2.0.0");
    expect(approved.pendingUpdate).toBeUndefined();
    expect(approved.lifecycle.at(-1)?.event).toBe("update_approved");
    await expect(
      new FilePluginStore(store.root).consumeApprovalReceipt(approvalReceipt)
    ).rejects.toMatchObject({ code: "APPROVAL_RECEIPT_REPLAY" });
  });

  it("hard-blocks signer rotation until a separately authenticated key workflow exists", async () => {
    const id = "com.example.signer-continuity";
    const rotatedPair = generateKeyPairSync("ed25519");
    trustStore.add("rotated-test-key", rotatedPair.publicKey);
    const first = await createBundle(temporaryRoot, {
      id,
      version: "1.0.0",
      privateKey
    });
    const rotated = await createBundle(temporaryRoot, {
      id,
      version: "2.0.0",
      privateKey: rotatedPair.privateKey,
      keyId: "rotated-test-key"
    });
    const registry = new CuratedRegistry();
    await registry.registerBundle(first.directory);
    await registry.registerBundle(rotated.directory);
    const runtime = new CuratedPluginRuntime({
      registry,
      store: new FilePluginStore(path.join(temporaryRoot, "store")),
      trustStore
    });
    await runtime.install(id, "1.0.0");
    await expect(runtime.update(id, "2.0.0")).rejects.toMatchObject({
      code: "SIGNER_CONTINUITY_VIOLATION"
    });
  });

  it("serializes lifecycle writes and rejects stale state revisions", async () => {
    const bundle = await createBundle(temporaryRoot, { privateKey });
    const registry = new CuratedRegistry();
    await registry.registerBundle(bundle.directory);
    const store = new FilePluginStore(path.join(temporaryRoot, "store"));
    const runtime = new CuratedPluginRuntime({
      registry,
      store,
      trustStore,
      approvalVerifier: testApprovalVerifier
    });
    const installed = await runtime.install(bundle.manifest.id);
    expect(installed.revision).toBe(1);

    await Promise.all([
      runtime.disable(bundle.manifest.id, "first-operation"),
      runtime.enable(bundle.manifest.id, "second-operation")
    ]);
    const current = await store.getState(bundle.manifest.id);
    expect(current).toMatchObject({ revision: 3, status: "active" });
    expect(current?.lifecycle.slice(-2).map((record) => record.event)).toEqual([
      "disabled",
      "enabled"
    ]);

    const firstCandidate = {
      ...current!,
      revision: current!.revision + 1,
      status: "disabled" as const
    };
    const secondCandidate = {
      ...current!,
      revision: current!.revision + 1,
      status: "active" as const
    };
    const secondStoreInstance = new FilePluginStore(store.root);
    const writes = await Promise.allSettled([
      store.compareAndSwapState(current!.revision, firstCandidate),
      secondStoreInstance.compareAndSwapState(current!.revision, secondCandidate)
    ]);
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await store.getState(bundle.manifest.id)).toMatchObject({ revision: 4 });
  });

  it("re-verifies the actual staged bundle immediately before update activation", async () => {
    const id = "com.example.staged-reverify";
    const first = await createBundle(temporaryRoot, {
      id,
      version: "1.0.0",
      privateKey
    });
    const second = await createBundle(temporaryRoot, {
      id,
      version: "2.0.0",
      privateKey,
      permissions: { ...emptyPermissions, capabilities: ["reports.read"] }
    });
    const registry = new CuratedRegistry();
    await registry.registerBundle(first.directory);
    await registry.registerBundle(second.directory);
    const store = new FilePluginStore(path.join(temporaryRoot, "store"));
    const runtime = new CuratedPluginRuntime({
      registry,
      store,
      trustStore,
      approvalVerifier: testApprovalVerifier
    });
    await runtime.install(id, "1.0.0");
    await runtime.update(id, "2.0.0");
    await writeFile(
      path.join(store.bundlePath(id, "2.0.0"), "index.mjs"),
      "export const tools = {};\n"
    );
    await expect(
      runtime.approvePendingUpdate(
        id,
        approvalReceiptFor((await store.getState(id))!)
      )
    ).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
    expect(await store.getState(id)).toMatchObject({
      status: "needs_review",
      activeVersion: "1.0.0"
    });
  });

  it("computes deterministic permission additions and removals", () => {
    const next = {
      ...emptyPermissions,
      filesystem: ["read.text"],
      advertisingRead: true
    };
    expect(diffPluginPermissions({ ...emptyPermissions, storage: true }, next)).toEqual({
      added: ["advertisingRead", "filesystem:read.text"],
      removed: ["storage"]
    });
  });

  it("rejects unsigned bundles by default and requires an explicit reviewed policy", async () => {
    const bundle = await createBundle(temporaryRoot, { unsigned: true });
    const snapshot = await loadPluginBundle(bundle.directory);
    await expect(
      verifyPluginBundle(snapshot, new StaticPluginTrustStore(), DEFAULT_VERIFICATION_POLICY)
    ).rejects.toMatchObject({ code: "UNSIGNED_REJECTED" });
    await expect(
      verifyPluginBundle(snapshot, new StaticPluginTrustStore(), {
        unsigned: "allow-reviewed",
        developerMode: false
      })
    ).rejects.toMatchObject({ code: "UNSIGNED_REQUIRES_DEVELOPER_MODE" });
    const explicitPolicy: BundleVerificationPolicy = {
      unsigned: "allow-reviewed",
      developerMode: true
    };
    await expect(
      verifyPluginBundle(snapshot, new StaticPluginTrustStore(), explicitPolicy)
    ).resolves.toBeUndefined();
    const supervisor = new PluginSupervisor({ developerMode: true });
    expect(supervisor.status(bundle.manifest.id)).toMatchObject({
      developerMode: true,
      isolation: "child_process+vm"
    });
  });

  it("rejects invalid signatures independently from integrity", async () => {
    const bundle = await createBundle(temporaryRoot, { privateKey });
    const manifestPath = path.join(bundle.directory, "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PluginManifest;
    manifest.signature = {
      algorithm: "ed25519",
      keyId: "test-key",
      value: Buffer.alloc(64, 7).toString("base64")
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const snapshot = await loadPluginBundle(bundle.directory);
    await expect(verifyPluginBundle(snapshot, trustStore)).rejects.toMatchObject({
      code: "SIGNATURE_INVALID"
    });
  });

  it("detects bundle tampering with SHA-256 integrity", async () => {
    const bundle = await createBundle(temporaryRoot, { privateKey });
    await writeFile(path.join(bundle.directory, "index.mjs"), "export const tools = {};\n");
    const snapshot = await loadPluginBundle(bundle.directory);
    await expect(verifyPluginBundle(snapshot, trustStore)).rejects.toMatchObject({
      code: "INTEGRITY_MISMATCH"
    });
  });

  it("pins the active signer SPKI even when the key id, version, and integrity are unchanged", async () => {
    const id = "com.example.active-signer-pin";
    const replacementPair = generateKeyPairSync("ed25519");
    const first = await createBundle(temporaryRoot, {
      id,
      privateKey,
      keyId: "test-key"
    });
    const replacement = await createBundle(temporaryRoot, {
      id,
      privateKey: replacementPair.privateKey,
      keyId: "test-key"
    });
    expect(replacement.manifest.integrity).toBe(first.manifest.integrity);
    const registry = new CuratedRegistry();
    await registry.registerBundle(first.directory);
    const store = new FilePluginStore(path.join(temporaryRoot, "signer-pin-store"));
    const runtime = new CuratedPluginRuntime({ registry, store, trustStore });
    const installed = await runtime.install(id);
    expect(installed.activeIntegrity).toBe(first.manifest.integrity);
    expect(installed.signerFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);

    const activeBundlePath = store.bundlePath(id, installed.activeVersion);
    await rm(activeBundlePath, { recursive: true, force: true });
    await cp(replacement.directory, activeBundlePath, { recursive: true });
    trustStore.add("test-key", replacementPair.publicKey);
    await expect(
      runtime.executeTool(id, `${id}/run`, {}, new CapabilityBroker())
    ).rejects.toMatchObject({ code: "ACTIVE_BUNDLE_MISMATCH" });
  });

  it("executes dynamic imports from the verified IPC byte snapshot, never the mutable bundle directory", async () => {
    const id = "com.example.immutable-execution";
    const bundle = await createBundle(temporaryRoot, {
      id,
      privateKey,
      permissions: { ...emptyPermissions, capabilities: ["barrier.wait"] },
      files: {
        "late.mjs": 'export const value = "verified-original";\n'
      },
      entrySource: `
        export const tools = {
          "${id}/run": async () => {
            await capabilities.call("barrier.wait", {});
            const late = await import("./late.mjs");
            return late.value;
          }
        };
      `
    });
    const registry = new CuratedRegistry();
    await registry.registerBundle(bundle.directory);
    const store = new FilePluginStore(path.join(temporaryRoot, "immutable-store"));
    const runtime = new CuratedPluginRuntime({ registry, store, trustStore });
    const installed = await runtime.install(id);
    const mutableLateModule = path.join(
      store.bundlePath(id, installed.activeVersion),
      "late.mjs"
    );
    const broker = new CapabilityBroker().register(
      "barrier.wait",
      "capabilities:barrier.wait",
      async () => {
        await writeFile(
          mutableLateModule,
          'export const value = "tampered-after-verification";\n',
          "utf8"
        );
        return true;
      },
      { effect: "read" }
    );

    await expect(
      runtime.executeTool(id, `${id}/run`, {}, broker)
    ).resolves.toBe("verified-original");
    await expect(
      runtime.executeTool(id, `${id}/run`, {}, broker)
    ).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
  });

  it("rejects traversal, symlinks, unknown manifest fields, and protected replacements", async () => {
    const valid = await createBundle(temporaryRoot, { privateKey });
    const manifestPath = path.join(valid.directory, "plugin.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    raw.entry = "../escape.mjs";
    raw.replaces = ["approval-engine"];
    raw.unreviewedExecutable = true;
    await writeFile(manifestPath, JSON.stringify(raw));
    await expect(loadPluginBundle(valid.directory)).rejects.toMatchObject({
      code: "INVALID_MANIFEST"
    });

    const symlinked = await createBundle(temporaryRoot, { privateKey });
    await symlink(path.join(symlinked.directory, "index.mjs"), path.join(symlinked.directory, "alias.mjs"));
    await expect(loadPluginBundle(symlinked.directory)).rejects.toMatchObject({
      code: "SYMLINK_REJECTED"
    });
  });

  it("denies plugin imports and capabilities that were not brokered and declared", async () => {
    const imported = await createBundle(temporaryRoot, {
      id: "com.example.import-attack",
      privateKey,
      entrySource:
        'import fs from "node:fs"; export const tools={"com.example.import-attack/run":()=>fs.readFileSync("/etc/passwd","utf8")};'
    });
    const snapshot = await loadPluginBundle(imported.directory);
    const supervisor = new PluginSupervisor();
    await expect(
      supervisor.executeTool(snapshot, `${imported.manifest.id}/run`, {}, new CapabilityBroker())
    ).rejects.toMatchObject({ code: "PLUGIN_EXECUTION_FAILED" });

    const capability = await createBundle(temporaryRoot, {
      id: "com.example.capability-attack",
      privateKey,
      entrySource:
        'export const tools={"com.example.capability-attack/run":()=>capabilities.call("filesystem.readText",{path:"/etc/passwd"})};'
    });
    await expect(
      supervisor.executeTool(
        await loadPluginBundle(capability.directory),
        `${capability.manifest.id}/run`,
        {},
        createReadOnlyFileBroker([temporaryRoot])
      )
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  });

  it("waits for fire-and-forget broker promises before accepting a child result", async () => {
    const id = "com.example.fire-and-forget";
    const bundle = await createBundle(temporaryRoot, {
      id,
      privateKey,
      toolReadOnly: false,
      permissions: { ...emptyPermissions, capabilities: ["effects.write"] },
      entrySource: `
        export const tools = {
          "${id}/run": () => {
            void capabilities.call("effects.write", {value: 7});
            return {pluginReturned: true};
          }
        };
      `
    });
    let sideEffect = 0;
    let observedIdempotencyKey = "";
    const broker = new CapabilityBroker().register(
      "effects.write",
      "capabilities:effects.write",
      async (_args, context) => {
        observedIdempotencyKey = context.idempotencyKey;
        await new Promise((resolve) => setTimeout(resolve, 60));
        sideEffect += 1;
        return { applied: true };
      },
      { effect: "mutation" }
    );
    const supervisor = new PluginSupervisor();
    const result = await supervisor.executeTool(
      await loadPluginBundle(bundle.directory),
      `${id}/run`,
      {},
      broker,
      { timeoutMs: 1_000, idempotencyKey: "stable-fire-and-forget-operation" }
    );
    expect(result).toEqual({ pluginReturned: true });
    expect(sideEffect).toBe(1);
    expect(observedIdempotencyKey).toMatch(/^plugin-capability:[a-f0-9]{64}$/);
    const invocationId = supervisor.status(id).lastInvocationId;
    expect(invocationId).toBeTruthy();
    expect(supervisor.invocationStatus(invocationId!)).toMatchObject({
      state: "completed",
      reconciliationRequired: false,
      capabilities: [
        {
          capability: "effects.write",
          effect: "mutation",
          state: "succeeded",
          dispatched: true,
          idempotencyKey: observedIdempotencyKey
        }
      ]
    });
  });

  it("returns OUTCOME_UNKNOWN and keeps tracking a late non-cancelable mutation", async () => {
    const id = "com.example.late-mutation";
    const bundle = await createBundle(temporaryRoot, {
      id,
      privateKey,
      toolReadOnly: false,
      permissions: { ...emptyPermissions, advertisingMutation: true },
      entrySource: `
        export const tools = {
          "${id}/run": () => {
            void capabilities.call("ads.change", {budget: 42});
            return {queued: true};
          }
        };
      `
    });
    let lateSideEffect = false;
    let receivedSignal: AbortSignal | undefined;
    const events: Array<{ event: string }> = [];
    let signalMutationDispatched!: () => void;
    const mutationDispatched = new Promise<void>((resolve) => {
      signalMutationDispatched = resolve;
    });
    let releaseMutation!: () => void;
    const mutationRelease = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let signalLateSettlement!: () => void;
    const lateSettlement = new Promise<void>((resolve) => {
      signalLateSettlement = resolve;
    });
    const broker = new CapabilityBroker().register(
      "ads.change",
      "advertisingMutation",
      async (_args, context) => {
        receivedSignal = context.signal;
        signalMutationDispatched();
        await mutationRelease;
        lateSideEffect = true;
        return { remoteMutationId: "mutation-1" };
      },
      { effect: "mutation" }
    );
    const abortController = new AbortController();
    const supervisor = new PluginSupervisor({
      logger: new StructuredPluginLogger({
        sink: (event) => {
          events.push(event);
          if (event.event === "plugin_late_mutation_settled") {
            signalLateSettlement();
          }
        }
      })
    });
    const execution = supervisor.executeTool(
      await loadPluginBundle(bundle.directory),
      `${id}/run`,
      {},
      broker,
      {
        timeoutMs: 5_000,
        idempotencyKey: "late-mutation-operation",
        signal: abortController.signal
      }
    );
    await mutationDispatched;
    abortController.abort(new Error("controlled test abort after mutation dispatch"));
    let caught: PluginRuntimeError | undefined;
    try {
      await execution;
    } catch (error) {
      caught = error as PluginRuntimeError;
    }
    expect(caught).toMatchObject({
      code: "OUTCOME_UNKNOWN",
      retryable: false,
      reconciliationRequired: true,
      reconciliation_required: true
    });
    expect(caught?.idempotencyKeys).toHaveLength(1);
    expect(receivedSignal?.aborted).toBe(true);
    expect(supervisor.status(id)).toMatchObject({
      state: "outcome_unknown",
      reconciliationRequired: true
    });

    releaseMutation();
    await lateSettlement;
    expect(lateSideEffect).toBe(true);
    expect(supervisor.invocationStatus(caught!.invocationId!)).toMatchObject({
      state: "outcome_unknown",
      retryable: false,
      reconciliationRequired: true,
      capabilities: [
        {
          capability: "ads.change",
          effect: "mutation",
          state: "succeeded",
          dispatched: true
        }
      ]
    });
    expect(supervisor.reconciliationRequired()).toHaveLength(1);
    expect(events.some((event) => event.event === "plugin_late_mutation_settled")).toBe(true);
  });

  it("persists an unknown mutation across restart and gates every retry until explicit reconciliation", async () => {
    const id = "com.example.durable-reconciliation";
    const bundle = await createBundle(temporaryRoot, {
      id,
      privateKey,
      toolReadOnly: false,
      permissions: { ...emptyPermissions, advertisingMutation: true },
      entrySource: `
        export const tools = {
          "${id}/run": () => capabilities.call("ads.change", {budget: 42})
        };
      `
    });
    const registry = new CuratedRegistry();
    await registry.registerBundle(bundle.directory);
    const storeRoot = path.join(temporaryRoot, "durable-store");
    const approvalGate = { verify: async () => undefined };
    const runtime = new CuratedPluginRuntime({
      registry,
      store: new FilePluginStore(storeRoot),
      trustStore,
      mutableToolApprovalGate: approvalGate
    });
    await runtime.install(id);

    let signalDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      signalDispatched = resolve;
    });
    let releaseMutation!: () => void;
    const mutationRelease = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let signalLateSettled!: () => void;
    const lateSettled = new Promise<void>((resolve) => {
      signalLateSettled = resolve;
    });
    let mutationCount = 0;
    const firstBroker = new CapabilityBroker().register(
      "ads.change",
      "advertisingMutation",
      async () => {
        mutationCount += 1;
        signalDispatched();
        await mutationRelease;
        signalLateSettled();
        return { remoteMutationId: "mutation-1" };
      },
      { effect: "mutation" }
    );
    const abortController = new AbortController();
    const execution = runtime.executeTool(
      id,
      `${id}/run`,
      {},
      firstBroker,
      {
        timeoutMs: 5_000,
        idempotencyKey: "durable-operation",
        signal: abortController.signal,
        approval: { test: "mutable-gate" }
      }
    );
    await dispatched;
    abortController.abort();
    let unknown!: PluginRuntimeError;
    try {
      await execution;
    } catch (error) {
      unknown = error as PluginRuntimeError;
    }
    expect(unknown).toMatchObject({
      code: "OUTCOME_UNKNOWN",
      reconciliationRequired: true
    });
    releaseMutation();
    await lateSettled;

    const restarted = new CuratedPluginRuntime({
      registry,
      store: new FilePluginStore(storeRoot),
      trustStore,
      mutableToolApprovalGate: approvalGate
    });
    let restartedMutationCount = 0;
    const restartedBroker = new CapabilityBroker().register(
      "ads.change",
      "advertisingMutation",
      () => {
        restartedMutationCount += 1;
        return { remoteMutationId: "mutation-2" };
      },
      { effect: "mutation" }
    );
    await expect(
      restarted.executeTool(
        id,
        `${id}/run`,
        {},
        restartedBroker,
        { idempotencyKey: "different-operation" }
      )
    ).rejects.toMatchObject({
      code: "RECONCILIATION_REQUIRED",
      reconciliationRequired: true,
      invocationId: unknown.invocationId
    });
    expect(restartedMutationCount).toBe(0);

    const durableStatus = await restarted.reconciliationStatus(id);
    expect(durableStatus.active).toMatchObject({
      invocationId: unknown.invocationId,
      state: "outcome_unknown"
    });
    expect(durableStatus.records).toEqual([
      expect.objectContaining({
        idempotencyKey: unknown.idempotencyKeys[0],
        state: "outcome_unknown"
      })
    ]);
    await restarted.reconcileMutation(id, {
      invocationId: unknown.invocationId!,
      resolution: "confirmed_applied",
      actor: "operator"
    });

    await expect(
      restarted.executeTool(
        id,
        `${id}/run`,
        {},
        restartedBroker,
        { idempotencyKey: "durable-operation", approval: { test: "mutable-gate" } }
      )
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REPLAY",
      reconciliationRequired: true
    });
    expect(restartedMutationCount).toBe(0);
    await expect(
      restarted.executeTool(
        id,
        `${id}/run`,
        {},
        restartedBroker,
        { idempotencyKey: "post-reconciliation-operation", approval: { test: "mutable-gate" } }
      )
    ).resolves.toEqual({ remoteMutationId: "mutation-2" });
    expect(restartedMutationCount).toBe(1);
    expect(mutationCount).toBe(1);
  });

  it("aborts reads on timeout and blocks mutation capabilities for read-only tools", async () => {
    const readId = "com.example.abortable-read";
    const readBundle = await createBundle(temporaryRoot, {
      id: readId,
      privateKey,
      permissions: { ...emptyPermissions, capabilities: ["reports.read"] },
      entrySource: `
        export const tools = {
          "${readId}/run": () => capabilities.call("reports.read", {})
        };
      `
    });
    let readAborted = false;
    const readBroker = new CapabilityBroker().register(
      "reports.read",
      "capabilities:reports.read",
      (_args, context) =>
        new Promise((_resolve, reject) => {
          const abort = () => {
            readAborted = true;
            reject(context.signal.reason);
          };
          if (context.signal.aborted) abort();
          else context.signal.addEventListener("abort", abort, { once: true });
        }),
      { effect: "read" }
    );
    const readSupervisor = new PluginSupervisor();
    await expect(
      readSupervisor.executeTool(
        await loadPluginBundle(readBundle.directory),
        `${readId}/run`,
        {},
        readBroker,
        250
      )
    ).rejects.toMatchObject({
      code: "PLUGIN_TIMEOUT",
      retryable: true,
      reconciliationRequired: false
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readAborted).toBe(true);
    expect(readSupervisor.status(readId).state).toBe("timed_out");

    const mutationId = "com.example.read-only-mutation";
    const mutationBundle = await createBundle(temporaryRoot, {
      id: mutationId,
      privateKey,
      toolReadOnly: true,
      permissions: { ...emptyPermissions, advertisingMutation: true },
      entrySource: `
        export const tools = {
          "${mutationId}/run": () => capabilities.call("ads.change", {})
        };
      `
    });
    let mutationRan = false;
    const mutationBroker = new CapabilityBroker().register(
      "ads.change",
      "advertisingMutation",
      () => {
        mutationRan = true;
        return true;
      },
      { effect: "mutation" }
    );
    await expect(
      new PluginSupervisor().executeTool(
        await loadPluginBundle(mutationBundle.directory),
        `${mutationId}/run`,
        {},
        mutationBroker
      )
    ).rejects.toMatchObject({
      code: "READ_ONLY_CAPABILITY_DENIED",
      reconciliationRequired: false
    });
    expect(mutationRan).toBe(false);
  });

  it("records child-process crashes and kills timed-out plugins", async () => {
    const bundle = await createBundle(temporaryRoot, {
      privateKey,
      entrySource:
        'export const tools={"com.example.test-plugin/run":()=>new Promise(()=>{})};'
    });
    const snapshot = await loadPluginBundle(bundle.directory);
    const timeoutSupervisor = new PluginSupervisor();
    await expect(
      timeoutSupervisor.executeTool(snapshot, `${bundle.manifest.id}/run`, {}, new CapabilityBroker(), 100)
    ).rejects.toMatchObject({ code: "PLUGIN_TIMEOUT" });
    expect(timeoutSupervisor.status(bundle.manifest.id).state).toBe("timed_out");

    const crashHost = path.join(temporaryRoot, "crash-host.mjs");
    await writeFile(crashHost, "process.exit(23);\n");
    const crashSupervisor = new PluginSupervisor({ hostPath: crashHost });
    await expect(
      crashSupervisor.executeTool(snapshot, `${bundle.manifest.id}/run`, {}, new CapabilityBroker())
    ).rejects.toMatchObject({ code: "PLUGIN_CRASH" });
    expect(crashSupervisor.status(bundle.manifest.id).state).toBe("crashed");
  });

  it("runs data migrations in the isolate and commits data before activating an update", async () => {
    const id = "com.example.migrating";
    const permissions = { ...emptyPermissions, storage: true };
    const first = await createBundle(temporaryRoot, {
      id,
      version: "1.0.0",
      permissions,
      privateKey
    });
    const second = await createBundle(temporaryRoot, {
      id,
      version: "2.0.0",
      permissions,
      dataVersion: 1,
      migrations: [{ from: 0, to: 1, entry: "migrate.mjs" }],
      files: {
        "migrate.mjs": `
          export async function migrate(_input, runtime) {
            const legacy = await runtime.capabilities.call("storage.get", {key: "legacy"});
            void runtime.capabilities.call("storage.set", {key: "current", value: legacy});
            void runtime.capabilities.call("storage.delete", {key: "legacy"});
          }
        `
      },
      privateKey
    });
    const registry = new CuratedRegistry();
    await registry.registerBundle(first.directory);
    await registry.registerBundle(second.directory);
    const store = new FilePluginStore(path.join(temporaryRoot, "store"));
    const runtime = new CuratedPluginRuntime({ registry, store, trustStore });
    await runtime.install(id, "1.0.0");
    await mkdir(path.dirname(store.dataPath(id)), { recursive: true });
    await writeFile(store.dataPath(id), JSON.stringify({ legacy: { value: 42 } }));

    const state = await runtime.update(id, "2.0.0");
    expect(state.activeVersion).toBe("2.0.0");
    expect(state.dataVersion).toBe(1);
    expect(state.migrations).toMatchObject([{ from: 0, to: 1, status: "completed" }]);
    expect(JSON.parse(await readFile(store.dataPath(id, state.dataRevision), "utf8"))).toEqual({
      current: { value: 42 }
    });
    expect(JSON.parse(await readFile(store.dataPath(id, "base"), "utf8"))).toEqual({
      legacy: { value: 42 }
    });
  });

  it("writes structured logs with recursive secret redaction", async () => {
    const events: Array<{ data?: unknown }> = [];
    const logger = new StructuredPluginLogger({ sink: (event) => events.push(event) });
    await logger.write({
      pluginId: "com.example.logger",
      level: "info",
      event: "test",
      data: {
        apiKey: "sk-should-never-appear",
        nested: { authorization: "Bearer super-secret-token" }
      }
    });
    expect(events[0]?.data).toEqual({
      apiKey: "[REDACTED]",
      nested: { authorization: "[REDACTED]" }
    });
  });
});
