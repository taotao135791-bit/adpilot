import { createPublicKey } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CuratedPluginRuntime,
  CuratedRegistry,
  DEFAULT_VERIFICATION_POLICY,
  diffPluginPermissions,
  FilePluginStore,
  loadPluginBundle,
  PluginRuntimeError,
  PluginSupervisor,
  StaticPluginTrustStore,
  verifyPluginBundle,
  type BundleVerificationPolicy,
  type CuratedRegistryEntry,
  type InstalledPluginState,
  type LifecycleRecord,
  type MigrationRecord,
  type PluginApprovalReceipt,
  type PluginApprovalReceiptVerifier,
  type PluginManifest,
  type PluginPermissions
} from "./index.ts";

const EMPTY_PERMISSIONS: PluginPermissions = {
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

export type PermissionRiskDto = "low" | "medium" | "high" | "critical";
export type PermissionCategoryDto =
  | "capability"
  | "filesystem"
  | "network"
  | "secret"
  | "browser"
  | "computer-use"
  | "advertising"
  | "storage";

export interface PermissionDescriptionDto {
  key: string;
  category: PermissionCategoryDto;
  title: string;
  description: string;
  risk: PermissionRiskDto;
  requiresReviewWhenAdded: true;
}

export interface PermissionDiffDto {
  added: PermissionDescriptionDto[];
  removed: PermissionDescriptionDto[];
  hasNewPermissions: boolean;
}

export interface PluginUpdateDto {
  version: string;
  permissionDiff: PermissionDiffDto;
  requiresApproval: boolean;
}

export interface PluginCatalogItemDto {
  id: string;
  name: string;
  description: string;
  developer: string;
  latestVersion: string;
  availableVersions: string[];
  tools: Array<{ name: string; description: string; readOnly: boolean }>;
  permissions: PermissionDescriptionDto[];
  signature: { signed: boolean; keyId: string | null };
  review: PluginManifest["review"];
  installed: { status: InstalledPluginState["status"]; version: string } | null;
  update: PluginUpdateDto | null;
}

export interface PluginDetailsDto extends PluginCatalogItemDto {
  selectedVersion: string;
  skills: Array<{ name: string; description: string }>;
  uiExtensions: Array<{ id: string; slot: string; entry: string }>;
  platforms: PluginManifest["platforms"];
  integrity: string;
  dataVersion: number;
}

export interface PendingPluginUpdateDto {
  version: string;
  requestedAt: string;
  previousStatus: "active" | "disabled";
  permissionDiff: PermissionDiffDto;
  approvalRequest: {
    installationId: string;
    stateRevision: number;
    pluginId: string;
    version: string;
    targetIntegrity: string;
    addedPermissionKeys: string[];
  };
}

export interface InstalledPluginDto {
  id: string;
  name: string;
  description: string;
  status: InstalledPluginState["status"];
  version: string;
  installedVersions: string[];
  permissions: PermissionDescriptionDto[];
  pendingUpdate: PendingPluginUpdateDto | null;
  dataVersion: number;
  lifecycle: LifecycleRecord[];
  migrations: MigrationRecord[];
}

export interface UninstalledPluginDto {
  id: string;
  status: "uninstalled";
}

export interface PluginCatalogServiceOptions {
  workspaceRoot: string;
  repositoryRoot?: string;
  curatedRoot?: string;
  trustRoot?: string;
  policy?: BundleVerificationPolicy;
  supervisor?: PluginSupervisor;
  approvalVerifier?: PluginApprovalReceiptVerifier;
}

function permissionDescription(key: string): PermissionDescriptionDto {
  const common = { key, requiresReviewWhenAdded: true as const };
  if (key.startsWith("filesystem:")) {
    const scope = key.slice("filesystem:".length);
    return {
      ...common,
      category: "filesystem",
      title: scope === "read.text" ? "Read approved text files" : `Filesystem scope: ${scope}`,
      description:
        scope === "read.text"
          ? "May request text-file reads only through a host allowlist; direct filesystem access remains blocked."
          : `May request the brokered filesystem scope “${scope}”; direct filesystem access remains blocked.`,
      risk: "medium"
    };
  }
  if (key.startsWith("network:")) {
    const origin = key.slice("network:".length);
    return {
      ...common,
      category: "network",
      title: `Connect to ${origin}`,
      description: `May request network access to the declared origin ${origin} through a host broker.`,
      risk: "high"
    };
  }
  if (key.startsWith("secrets:")) {
    const secret = key.slice("secrets:".length);
    return {
      ...common,
      category: "secret",
      title: `Use secret ${secret}`,
      description: `May request the named secret “${secret}” through a redacting broker; secret values are never included in catalog DTOs.`,
      risk: "high"
    };
  }
  if (key.startsWith("capabilities:")) {
    const capability = key.slice("capabilities:".length);
    return {
      ...common,
      category: "capability",
      title: `Use ${capability}`,
      description: `May call the declared host capability “${capability}”; no internal service object is exposed.`,
      risk: "medium"
    };
  }
  if (key === "browser") {
    return {
      ...common,
      category: "browser",
      title: "Use brokered browser controls",
      description: "May request browser actions through an explicitly registered host broker.",
      risk: "high"
    };
  }
  if (key === "computerUse") {
    return {
      ...common,
      category: "computer-use",
      title: "Use brokered computer controls",
      description: "May request desktop actions through an explicitly registered host broker.",
      risk: "critical"
    };
  }
  if (key === "advertisingRead") {
    return {
      ...common,
      category: "advertising",
      title: "Read advertising data",
      description: "May request read-only advertising entities and metrics through a host broker.",
      risk: "medium"
    };
  }
  if (key === "advertisingMutation") {
    return {
      ...common,
      category: "advertising",
      title: "Change advertising data",
      description: "May request advertising mutations; official risk review and approval components remain protected.",
      risk: "critical"
    };
  }
  if (key === "storage") {
    return {
      ...common,
      category: "storage",
      title: "Use isolated plugin storage",
      description: "May read and write only its own versioned key-value data through the storage broker.",
      risk: "low"
    };
  }
  throw new PluginRuntimeError("UNKNOWN_PERMISSION", `Unknown permission key: ${key}`);
}

export function describePluginPermissions(
  permissions: PluginPermissions
): PermissionDescriptionDto[] {
  return diffPluginPermissions(EMPTY_PERMISSIONS, permissions).added.map(permissionDescription);
}

export function describePermissionDiff(
  previous: PluginPermissions,
  next: PluginPermissions
): PermissionDiffDto {
  const diff = diffPluginPermissions(previous, next);
  return {
    added: diff.added.map(permissionDescription),
    removed: diff.removed.map(permissionDescription),
    hasNewPermissions: diff.added.length > 0
  };
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core = "0.0.0", prerelease] = value.split("-", 2);
    return {
      core: core.split(".").map(Number),
      prerelease: prerelease?.split(".") ?? []
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (b.prerelease.length === 0 && a.prerelease.length > 0) return -1;
  return left.localeCompare(right);
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function loadTrustStore(trustRoot: string): Promise<StaticPluginTrustStore> {
  const trustStore = new StaticPluginTrustStore();
  if (!(await exists(trustRoot))) {
    throw new PluginRuntimeError("TRUST_STORE_MISSING", `Curated trust directory is missing: ${trustRoot}`);
  }
  const entries = await readdir(trustRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith(".pem")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new PluginRuntimeError("TRUST_KEY_REJECTED", `Trust key must be a regular file: ${entry.name}`);
    }
    const keyId = entry.name.slice(0, -".pem".length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(keyId)) {
      throw new PluginRuntimeError("TRUST_KEY_REJECTED", `Unsafe trust key id: ${keyId}`);
    }
    const keyPath = path.join(trustRoot, entry.name);
    const stats = await lstat(keyPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new PluginRuntimeError("TRUST_KEY_REJECTED", `Trust key must not be a symlink: ${entry.name}`);
    }
    const publicKey = createPublicKey(await readFile(keyPath));
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new PluginRuntimeError("TRUST_KEY_REJECTED", `Trust key is not Ed25519: ${entry.name}`);
    }
    trustStore.add(keyId, publicKey);
  }
  return trustStore;
}

async function discoverBundlePaths(curatedRoot: string): Promise<string[]> {
  if (!(await exists(curatedRoot))) {
    throw new PluginRuntimeError("CURATED_ROOT_MISSING", `Curated plugin directory is missing: ${curatedRoot}`);
  }
  const entries = await readdir(curatedRoot, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "trust") continue;
    if (entry.isSymbolicLink()) {
      throw new PluginRuntimeError("SYMLINK_REJECTED", `Curated bundle cannot be a symlink: ${entry.name}`);
    }
    if (!entry.isDirectory()) continue;
    const bundlePath = path.join(curatedRoot, entry.name);
    if (!(await exists(path.join(bundlePath, "plugin.json")))) continue;
    paths.push(bundlePath);
  }
  return paths;
}

export class PluginCatalogService {
  readonly repositoryRoot: string;
  readonly curatedRoot: string;
  readonly trustRoot: string;
  readonly workspaceRoot: string;
  readonly registry: CuratedRegistry;
  readonly store: FilePluginStore;
  readonly runtime: CuratedPluginRuntime;
  readonly #trustStore: StaticPluginTrustStore;
  readonly #policy: BundleVerificationPolicy;

  private constructor(options: {
    repositoryRoot: string;
    curatedRoot: string;
    trustRoot: string;
    workspaceRoot: string;
    registry: CuratedRegistry;
    store: FilePluginStore;
    runtime: CuratedPluginRuntime;
    trustStore: StaticPluginTrustStore;
    policy: BundleVerificationPolicy;
  }) {
    this.repositoryRoot = options.repositoryRoot;
    this.curatedRoot = options.curatedRoot;
    this.trustRoot = options.trustRoot;
    this.workspaceRoot = options.workspaceRoot;
    this.registry = options.registry;
    this.store = options.store;
    this.runtime = options.runtime;
    this.#trustStore = options.trustStore;
    this.#policy = options.policy;
  }

  static async create(options: PluginCatalogServiceOptions): Promise<PluginCatalogService> {
    const repositoryRoot = path.resolve(
      options.repositoryRoot ?? fileURLToPath(new URL("../../..", import.meta.url))
    );
    const curatedRoot = path.resolve(
      options.curatedRoot ?? path.join(repositoryRoot, "plugins", "curated")
    );
    const trustRoot = path.resolve(options.trustRoot ?? path.join(curatedRoot, "trust"));
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const policy = options.policy ?? DEFAULT_VERIFICATION_POLICY;
    const trustStore = await loadTrustStore(trustRoot);
    const registry = new CuratedRegistry();
    for (const bundlePath of await discoverBundlePaths(curatedRoot)) {
      const snapshot = await loadPluginBundle(bundlePath);
      await verifyPluginBundle(snapshot, trustStore, policy);
      await registry.registerBundle(bundlePath);
    }
    const store = new FilePluginStore(path.join(workspaceRoot, ".adpilot", "plugin-runtime"));
    await store.initialize();
    const runtime = new CuratedPluginRuntime({
      registry,
      store,
      trustStore,
      ...(options.supervisor ? { supervisor: options.supervisor } : {}),
      ...(options.approvalVerifier ? { approvalVerifier: options.approvalVerifier } : {}),
      policy
    });
    return new PluginCatalogService({
      repositoryRoot,
      curatedRoot,
      trustRoot,
      workspaceRoot,
      registry,
      store,
      runtime,
      trustStore,
      policy
    });
  }

  async listCatalog(): Promise<PluginCatalogItemDto[]> {
    const states = new Map((await this.#states()).map((state) => [state.pluginId, state]));
    const grouped = new Map<string, CuratedRegistryEntry[]>();
    for (const entry of this.registry.list()) {
      const entries = grouped.get(entry.id) ?? [];
      entries.push(entry);
      grouped.set(entry.id, entries);
    }
    return Promise.all(
      [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(async ([id, entries]) => {
          const sorted = [...entries].sort((left, right) => compareVersions(right.version, left.version));
          const latest = sorted[0];
          if (!latest) throw new PluginRuntimeError("VERSION_NOT_FOUND", `No versions exist for ${id}`);
          return this.#catalogItem(latest.manifest, sorted, states.get(id));
        })
    );
  }

  async getDetails(pluginId: string, version?: string): Promise<PluginDetailsDto> {
    const entry = this.registry.resolve(pluginId, version);
    const versions = this.registry
      .list()
      .filter((candidate) => candidate.id === pluginId)
      .sort((left, right) => compareVersions(right.version, left.version));
    const state = await this.store.getState(pluginId);
    const base = await this.#catalogItem(entry.manifest, versions, state);
    return {
      ...base,
      selectedVersion: entry.version,
      skills: entry.manifest.skills.map((skill) => ({ ...skill })),
      uiExtensions: entry.manifest.uiExtensions.map((extension) => ({ ...extension })),
      platforms: [...entry.manifest.platforms],
      integrity: entry.manifest.integrity,
      dataVersion: entry.manifest.dataVersion
    };
  }

  async listInstalled(): Promise<InstalledPluginDto[]> {
    return Promise.all(
      (await this.#states())
        .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
        .map((state) => this.#installedDto(state))
    );
  }

  async install(
    pluginId: string,
    version?: string,
    actor = "catalog-service"
  ): Promise<InstalledPluginDto> {
    return this.#installedDto(await this.runtime.install(pluginId, version, actor));
  }

  async update(
    pluginId: string,
    version?: string,
    actor = "catalog-service"
  ): Promise<InstalledPluginDto> {
    return this.#installedDto(await this.runtime.update(pluginId, version, actor));
  }

  async approveUpdate(
    pluginId: string,
    receipt: PluginApprovalReceipt
  ): Promise<InstalledPluginDto> {
    return this.#installedDto(await this.runtime.approvePendingUpdate(pluginId, receipt));
  }

  async disable(pluginId: string, actor = "catalog-service"): Promise<InstalledPluginDto> {
    return this.#installedDto(await this.runtime.disable(pluginId, actor));
  }

  async enable(pluginId: string, actor = "catalog-service"): Promise<InstalledPluginDto> {
    return this.#installedDto(await this.runtime.enable(pluginId, actor));
  }

  async uninstall(pluginId: string): Promise<UninstalledPluginDto> {
    await this.runtime.uninstall(pluginId);
    return { id: pluginId, status: "uninstalled" };
  }

  async #states(): Promise<InstalledPluginState[]> {
    const pluginsRoot = path.join(this.store.root, "plugins");
    const entries = await readdir(pluginsRoot, { withFileTypes: true });
    const states: InstalledPluginState[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new PluginRuntimeError("CORRUPT_STATE", `Installed plugin directory is a symlink: ${entry.name}`);
      }
      if (!entry.isDirectory()) continue;
      const state = await this.store.getState(entry.name);
      if (state) states.push(state);
    }
    return states;
  }

  async #catalogItem(
    manifest: PluginManifest,
    versions: CuratedRegistryEntry[],
    state: InstalledPluginState | undefined
  ): Promise<PluginCatalogItemDto> {
    const latest = versions[0]?.manifest ?? manifest;
    const update = state ? this.#availableUpdate(state, latest) : null;
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      developer: manifest.developer.name,
      latestVersion: latest.version,
      availableVersions: versions.map((entry) => entry.version),
      tools: manifest.tools.map((tool) => ({ ...tool })),
      permissions: describePluginPermissions(manifest.permissions),
      signature: {
        signed: Boolean(manifest.signature),
        keyId: manifest.signature?.keyId ?? null
      },
      review: { ...manifest.review },
      installed: state ? { status: state.status, version: state.activeVersion } : null,
      update
    };
  }

  #availableUpdate(
    state: InstalledPluginState,
    latest: PluginManifest
  ): PluginUpdateDto | null {
    if (state.pendingUpdate) {
      return {
        version: state.pendingUpdate.version,
        permissionDiff: {
          added: state.pendingUpdate.permissionDiff.added.map(permissionDescription),
          removed: state.pendingUpdate.permissionDiff.removed.map(permissionDescription),
          hasNewPermissions: state.pendingUpdate.permissionDiff.added.length > 0
        },
        requiresApproval: true
      };
    }
    if (compareVersions(latest.version, state.activeVersion) <= 0) return null;
    const permissionDiff = describePermissionDiff(state.permissions, latest.permissions);
    return {
      version: latest.version,
      permissionDiff,
      requiresApproval: permissionDiff.hasNewPermissions
    };
  }

  async #installedDto(state: InstalledPluginState): Promise<InstalledPluginDto> {
    const snapshot = await loadPluginBundle(
      this.store.bundlePath(state.pluginId, state.activeVersion)
    );
    await verifyPluginBundle(snapshot, this.#trustStore, this.#policy);
    return {
      id: state.pluginId,
      name: snapshot.manifest.name,
      description: snapshot.manifest.description,
      status: state.status,
      version: state.activeVersion,
      installedVersions: [...state.installedVersions],
      permissions: describePluginPermissions(state.permissions),
      pendingUpdate: state.pendingUpdate
        ? {
            version: state.pendingUpdate.version,
            requestedAt: state.pendingUpdate.requestedAt,
            previousStatus: state.pendingUpdate.previousStatus,
            permissionDiff: {
              added: state.pendingUpdate.permissionDiff.added.map(permissionDescription),
              removed: state.pendingUpdate.permissionDiff.removed.map(permissionDescription),
              hasNewPermissions: state.pendingUpdate.permissionDiff.added.length > 0
            },
            approvalRequest: {
              installationId: state.installationId,
              stateRevision: state.revision,
              pluginId: state.pluginId,
              version: state.pendingUpdate.version,
              targetIntegrity: state.pendingUpdate.targetIntegrity,
              addedPermissionKeys: [...state.pendingUpdate.permissionDiff.added].sort()
            }
          }
        : null,
      dataVersion: state.dataVersion,
      lifecycle: state.lifecycle.map((record) => ({ ...record })),
      migrations: state.migrations.map((record) => ({ ...record }))
    };
  }
}
