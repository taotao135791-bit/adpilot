import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fileConstants } from "node:fs";
import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
  type KeyObject
} from "node:crypto";
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const CAPABILITY = /^[a-z][A-Za-z0-9]*(?:[.:/-][A-Za-z0-9][A-Za-z0-9._-]*)+$/;
const MAX_BUNDLE_FILES = 256;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const PROTECTED_COMPONENTS = new Set([
  "advertising-core",
  "@adpilot/advertising-core",
  "risk",
  "risk-reviewer",
  "@adpilot/risk-reviewer",
  "approval",
  "approvals",
  "approval-engine",
  "@adpilot/approvals"
]);

function isSafeRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 240 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value.normalize("NFC") !== value
  ) {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

const safePathSchema = z.string().refine(isSafeRelativePath, "must be a normalized, relative bundle path");
const capabilityListSchema = z.array(z.string().regex(CAPABILITY)).max(64).default([]);

export const PluginPermissionsSchema = z
  .object({
    capabilities: capabilityListSchema,
    filesystem: capabilityListSchema,
    network: z.array(z.string().url()).max(32).default([]),
    secrets: capabilityListSchema,
    browser: z.boolean().default(false),
    computerUse: z.boolean().default(false),
    advertisingRead: z.boolean().default(false),
    advertisingMutation: z.boolean().default(false),
    storage: z.boolean().default(false)
  })
  .strict();

const toolSchema = z
  .object({
    name: z.string().min(3).max(160),
    description: z.string().min(1).max(500),
    readOnly: z.boolean()
  })
  .strict();

const skillSchema = z
  .object({
    name: z.string().min(3).max(160),
    description: z.string().min(1).max(500)
  })
  .strict();

const uiExtensionSchema = z
  .object({
    id: z.string().min(3).max(160),
    slot: z.enum(["workspace-sidebar", "report-panel", "settings"]),
    entry: safePathSchema
  })
  .strict();

const migrationSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
    entry: safePathSchema
  })
  .strict()
  .refine((migration) => migration.to === migration.from + 1, "migration versions must be consecutive");

export const PluginManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(PLUGIN_ID),
    name: z.string().min(1).max(100),
    version: z.string().regex(VERSION),
    developer: z
      .object({
        name: z.string().min(1).max(100),
        url: z.string().url().optional()
      })
      .strict(),
    description: z.string().min(1).max(500),
    entry: safePathSchema.refine((entry) => entry.endsWith(".mjs"), "entry must be an .mjs module"),
    tools: z.array(toolSchema).max(64).default([]),
    skills: z.array(skillSchema).max(64).default([]),
    uiExtensions: z.array(uiExtensionSchema).max(32).default([]),
    permissions: PluginPermissionsSchema,
    platforms: z.array(z.enum(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"])).min(1),
    integrity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    signature: z
      .object({
        algorithm: z.literal("ed25519"),
        keyId: z.string().min(1).max(100),
        value: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/)
      })
      .strict()
      .optional(),
    review: z
      .object({
        status: z.enum(["approved", "pending", "rejected"]),
        reviewedAt: z.string().datetime(),
        reviewer: z.string().min(1).max(100),
        notes: z.string().max(1000).optional()
      })
      .strict(),
    replaces: z.array(z.string().min(1).max(160)).max(16).default([]),
    dataVersion: z.number().int().nonnegative().default(0),
    migrations: z.array(migrationSchema).max(32).default([])
  })
  .strict()
  .superRefine((manifest, context) => {
    const namespace = `${manifest.id}/`;
    const names = [
      ...manifest.tools.map((tool) => tool.name),
      ...manifest.skills.map((skill) => skill.name),
      ...manifest.uiExtensions.map((extension) => extension.id)
    ];
    for (const name of names) {
      if (!name.startsWith(namespace)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `extension "${name}" must be namespaced with "${namespace}"`,
          path: ["tools"]
        });
      }
    }
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tool, skill, and UI extension names must be unique"
      });
    }
    for (const replacement of manifest.replaces) {
      const normalized = replacement.toLowerCase();
      if (PROTECTED_COMPONENTS.has(normalized)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `plugins cannot replace protected component "${replacement}"`,
          path: ["replaces"]
        });
      }
    }
    const sortedMigrations = [...manifest.migrations].sort((left, right) => left.from - right.from);
    if (
      sortedMigrations.some((migration, index) => index > 0 && sortedMigrations[index - 1]?.to !== migration.from) ||
      sortedMigrations.some((migration) => migration.to > manifest.dataVersion)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "migrations must be a unique, consecutive chain ending at dataVersion",
        path: ["migrations"]
      });
    }
  });

export type PluginPermissions = z.infer<typeof PluginPermissionsSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface PluginRuntimeErrorOptions extends ErrorOptions {
  retryable?: boolean;
  reconciliationRequired?: boolean;
  invocationId?: string;
  idempotencyKeys?: string[];
}

export class PluginRuntimeError extends Error {
  readonly retryable: boolean;
  readonly reconciliationRequired: boolean;
  readonly reconciliation_required: boolean;
  readonly invocationId: string | undefined;
  readonly idempotencyKeys: readonly string[];

  constructor(
    public readonly code: string,
    message: string,
    options: PluginRuntimeErrorOptions = {}
  ) {
    super(message, options);
    this.name = "PluginRuntimeError";
    this.retryable = options.retryable ?? false;
    this.reconciliationRequired = options.reconciliationRequired ?? false;
    this.reconciliation_required = this.reconciliationRequired;
    this.invocationId = options.invocationId;
    this.idempotencyKeys = Object.freeze([...(options.idempotencyKeys ?? [])]);
  }
}

export interface BundleFile {
  path: string;
  bytes: Buffer;
}

export interface PluginBundleSnapshot {
  root: string;
  manifest: PluginManifest;
  files: readonly BundleFile[];
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function manifestWithoutSecurityFields(manifest: PluginManifest): Record<string, unknown> {
  const record = { ...manifest } as Record<string, unknown>;
  delete record.integrity;
  delete record.signature;
  return record;
}

function manifestWithoutSignature(manifest: PluginManifest): Record<string, unknown> {
  const record = { ...manifest } as Record<string, unknown>;
  delete record.signature;
  return record;
}

export function computeBundleIntegrity(
  manifest: PluginManifest,
  files: readonly BundleFile[]
): `sha256:${string}` {
  const fileDigests = files
    .filter((file) => file.path !== "plugin.json")
    .map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
      size: file.bytes.byteLength
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash("sha256")
    .update(canonicalize({ manifest: manifestWithoutSecurityFields(manifest), files: fileDigests }))
    .digest("hex");
  return `sha256:${digest}`;
}

export function pluginSignaturePayload(manifest: PluginManifest): Buffer {
  return Buffer.from(canonicalize(manifestWithoutSignature(manifest)), "utf8");
}

async function walkBundle(root: string, relative = ""): Promise<BundleFile[]> {
  const directory = relative ? path.join(root, relative) : root;
  const [directoryStats, canonicalDirectory] = await Promise.all([
    lstat(directory),
    realpath(directory)
  ]);
  if (
    directoryStats.isSymbolicLink() ||
    !directoryStats.isDirectory() ||
    !ensureInsideRoot(canonicalDirectory, root)
  ) {
    throw new PluginRuntimeError("SYMLINK_REJECTED", `Unsafe bundle directory: ${relative || "."}`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const files: BundleFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    if (!isSafeRelativePath(relativePath)) {
      throw new PluginRuntimeError("UNSAFE_PATH", `Unsafe bundle path: ${relativePath}`);
    }
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new PluginRuntimeError("SYMLINK_REJECTED", `Symbolic links are not allowed: ${relativePath}`);
    }
    if (stats.isDirectory()) {
      files.push(...(await walkBundle(root, relativePath)));
    } else if (stats.isFile()) {
      const handle = await open(
        absolutePath,
        fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0)
      );
      try {
        const openedStats = await handle.stat();
        if (!openedStats.isFile()) {
          throw new PluginRuntimeError("UNSAFE_FILE", `Only regular files are allowed: ${relativePath}`);
        }
        files.push({ path: relativePath, bytes: await handle.readFile() });
      } finally {
        await handle.close();
      }
    } else {
      throw new PluginRuntimeError("UNSAFE_FILE", `Only regular files are allowed: ${relativePath}`);
    }
    if (files.length > MAX_BUNDLE_FILES) {
      throw new PluginRuntimeError("BUNDLE_TOO_LARGE", "Plugin bundle contains too many files");
    }
  }
  return files;
}

export async function loadPluginBundle(bundleDirectory: string): Promise<PluginBundleSnapshot> {
  const rootStats = await lstat(bundleDirectory);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new PluginRuntimeError("INVALID_BUNDLE_ROOT", "Plugin bundle root must be a real directory");
  }
  const root = await realpath(bundleDirectory);
  const files = await walkBundle(root);
  const byteCount = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (files.length > MAX_BUNDLE_FILES || byteCount > MAX_BUNDLE_BYTES) {
    throw new PluginRuntimeError("BUNDLE_TOO_LARGE", "Plugin bundle exceeds the safety limit");
  }
  const manifestFile = files.find((file) => file.path === "plugin.json");
  if (!manifestFile) {
    throw new PluginRuntimeError("MISSING_MANIFEST", "Plugin bundle does not contain plugin.json");
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  } catch (error) {
    throw new PluginRuntimeError("INVALID_MANIFEST", "plugin.json is not valid JSON", { cause: error });
  }
  const parsed = PluginManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    throw new PluginRuntimeError("INVALID_MANIFEST", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const referencedFiles = [
    parsed.data.entry,
    ...parsed.data.uiExtensions.map((extension) => extension.entry),
    ...parsed.data.migrations.map((migration) => migration.entry)
  ];
  const availablePaths = new Set(files.map((file) => file.path));
  for (const referencedFile of referencedFiles) {
    if (!availablePaths.has(referencedFile)) {
      throw new PluginRuntimeError("MISSING_ENTRY", `Manifest references missing file: ${referencedFile}`);
    }
  }
  return { root, manifest: parsed.data, files };
}

export interface PluginTrustStore {
  getPublicKey(keyId: string): Promise<KeyObject | string | Buffer | undefined> | KeyObject | string | Buffer | undefined;
}

export class StaticPluginTrustStore implements PluginTrustStore {
  readonly #keys = new Map<string, KeyObject | string | Buffer>();

  constructor(keys: Readonly<Record<string, KeyObject | string | Buffer>> = {}) {
    for (const [keyId, key] of Object.entries(keys)) {
      this.#keys.set(keyId, key);
    }
  }

  add(keyId: string, key: KeyObject | string | Buffer): void {
    this.#keys.set(keyId, key);
  }

  getPublicKey(keyId: string): KeyObject | string | Buffer | undefined {
    return this.#keys.get(keyId);
  }
}

export interface BundleVerificationPolicy {
  unsigned: "reject" | "allow-reviewed";
  developerMode: boolean;
}

export const DEFAULT_VERIFICATION_POLICY: Readonly<BundleVerificationPolicy> = Object.freeze({
  unsigned: "reject",
  developerMode: false
});

export interface VerifiedPluginBundleIdentity {
  integrity: `sha256:${string}`;
  signerFingerprint: `sha256:${string}` | null;
}

async function verifyPluginBundleIdentity(
  snapshot: PluginBundleSnapshot,
  trustStore: PluginTrustStore,
  policy: BundleVerificationPolicy = DEFAULT_VERIFICATION_POLICY
): Promise<VerifiedPluginBundleIdentity> {
  const actualIntegrity = computeBundleIntegrity(snapshot.manifest, snapshot.files);
  if (actualIntegrity !== snapshot.manifest.integrity) {
    throw new PluginRuntimeError(
      "INTEGRITY_MISMATCH",
      `Bundle integrity mismatch for ${snapshot.manifest.id}@${snapshot.manifest.version}`
    );
  }
  if (snapshot.manifest.review.status !== "approved") {
    throw new PluginRuntimeError("REVIEW_REQUIRED", "Only curated, approved plugins can be installed");
  }
  const signature = snapshot.manifest.signature;
  if (!signature) {
    if (policy.unsigned !== "allow-reviewed") {
      throw new PluginRuntimeError(
        "UNSIGNED_REJECTED",
        "Unsigned plugins are rejected unless an explicit allow-reviewed policy is supplied"
      );
    }
    if (!policy.developerMode) {
      throw new PluginRuntimeError(
        "UNSIGNED_REQUIRES_DEVELOPER_MODE",
        "Unsigned reviewed plugins are allowed only when developer mode is explicitly enabled"
      );
    }
    return { integrity: actualIntegrity, signerFingerprint: null };
  }
  const trustedKey = await trustStore.getPublicKey(signature.keyId);
  if (!trustedKey) {
    throw new PluginRuntimeError("UNTRUSTED_SIGNER", `No trusted key exists for ${signature.keyId}`);
  }
  let key: KeyObject;
  try {
    const suppliedKey = trustedKey instanceof Object && "type" in trustedKey
      ? (trustedKey as KeyObject)
      : createPublicKey(trustedKey as string | Buffer);
    key = suppliedKey.type === "public" ? suppliedKey : createPublicKey(suppliedKey);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("trusted key is not Ed25519");
    }
  } catch (error) {
    throw new PluginRuntimeError("INVALID_TRUST_KEY", `Invalid trusted key for ${signature.keyId}`, {
      cause: error
    });
  }
  const valid = verifySignature(
    null,
    pluginSignaturePayload(snapshot.manifest),
    key,
    Buffer.from(signature.value, "base64")
  );
  if (!valid) {
    throw new PluginRuntimeError("SIGNATURE_INVALID", "Plugin signature is invalid");
  }
  const signerFingerprint = `sha256:${createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex")}` as const;
  return { integrity: actualIntegrity, signerFingerprint };
}

export async function verifyPluginBundle(
  snapshot: PluginBundleSnapshot,
  trustStore: PluginTrustStore,
  policy: BundleVerificationPolicy = DEFAULT_VERIFICATION_POLICY
): Promise<void> {
  await verifyPluginBundleIdentity(snapshot, trustStore, policy);
}

export async function verifiedPluginBundleIdentity(
  snapshot: PluginBundleSnapshot,
  trustStore: PluginTrustStore,
  policy: BundleVerificationPolicy = DEFAULT_VERIFICATION_POLICY
): Promise<VerifiedPluginBundleIdentity> {
  return verifyPluginBundleIdentity(snapshot, trustStore, policy);
}

export interface CuratedRegistryEntry {
  id: string;
  version: string;
  bundlePath: string;
  manifest: PluginManifest;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const rightParts = right.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === b) continue;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "number") return 1;
    if (typeof b === "number") return -1;
    return a.localeCompare(b);
  }
  return 0;
}

export class CuratedRegistry {
  readonly #entries = new Map<string, Map<string, CuratedRegistryEntry>>();

  async registerBundle(bundlePath: string): Promise<CuratedRegistryEntry> {
    const snapshot = await loadPluginBundle(bundlePath);
    if (snapshot.manifest.review.status !== "approved") {
      throw new PluginRuntimeError("NOT_CURATED", "Curated registry only accepts approved bundles");
    }
    const entry = {
      id: snapshot.manifest.id,
      version: snapshot.manifest.version,
      bundlePath: snapshot.root,
      manifest: snapshot.manifest
    };
    const versions = this.#entries.get(entry.id) ?? new Map<string, CuratedRegistryEntry>();
    versions.set(entry.version, entry);
    this.#entries.set(entry.id, versions);
    return entry;
  }

  list(): CuratedRegistryEntry[] {
    return [...this.#entries.values()]
      .flatMap((versions) => [...versions.values()])
      .sort((left, right) => left.id.localeCompare(right.id) || compareVersions(right.version, left.version));
  }

  resolve(id: string, version?: string): CuratedRegistryEntry {
    const versions = this.#entries.get(id);
    if (!versions) {
      throw new PluginRuntimeError("PLUGIN_NOT_FOUND", `No curated plugin exists with id ${id}`);
    }
    if (version) {
      const exact = versions.get(version);
      if (!exact) {
        throw new PluginRuntimeError("VERSION_NOT_FOUND", `No curated ${id} version ${version}`);
      }
      return exact;
    }
    const latest = [...versions.values()].sort((left, right) => compareVersions(right.version, left.version))[0];
    if (!latest) {
      throw new PluginRuntimeError("VERSION_NOT_FOUND", `No curated versions exist for ${id}`);
    }
    return latest;
  }
}

export interface PermissionDiff {
  added: string[];
  removed: string[];
}

function flattenPermissions(permissions: PluginPermissions): Set<string> {
  const values = new Set<string>();
  for (const capability of permissions.capabilities) values.add(`capabilities:${capability}`);
  for (const scope of permissions.filesystem) values.add(`filesystem:${scope}`);
  for (const origin of permissions.network) values.add(`network:${origin}`);
  for (const secret of permissions.secrets) values.add(`secrets:${secret}`);
  for (const flag of [
    "browser",
    "computerUse",
    "advertisingRead",
    "advertisingMutation",
    "storage"
  ] as const) {
    if (permissions[flag]) values.add(flag);
  }
  return values;
}

export function diffPluginPermissions(
  previous: PluginPermissions,
  next: PluginPermissions
): PermissionDiff {
  const before = flattenPermissions(previous);
  const after = flattenPermissions(next);
  return {
    added: [...after].filter((permission) => !before.has(permission)).sort(),
    removed: [...before].filter((permission) => !after.has(permission)).sort()
  };
}

const permissionDiffSchema = z
  .object({
    added: z.array(z.string()),
    removed: z.array(z.string())
  })
  .strict();

const lifecycleRecordSchema = z
  .object({
    event: z.enum([
      "installed",
      "updated",
      "update_needs_review",
      "update_approved",
      "disabled",
      "enabled",
      "uninstalled"
    ]),
    at: z.string().datetime(),
    fromVersion: z.string().optional(),
    toVersion: z.string().optional(),
    actor: z.string().min(1),
    details: z.record(z.unknown()).optional()
  })
  .strict();

const migrationRecordSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
    at: z.string().datetime(),
    status: z.literal("completed")
  })
  .strict();

const installedStateSchema = z
  .object({
    schemaVersion: z.literal(2),
    revision: z.number().int().positive(),
    installationId: z.string().uuid(),
    pluginId: z.string().regex(PLUGIN_ID),
    status: z.enum(["active", "disabled", "needs_review"]),
    activeVersion: z.string().regex(VERSION),
    installedVersions: z.array(z.string().regex(VERSION)),
    permissions: PluginPermissionsSchema,
    dataVersion: z.number().int().nonnegative(),
    dataRevision: z.string().regex(/^(?:base|[0-9a-f-]{36})$/),
    activeIntegrity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    signerKeyId: z.string().min(1).max(100).nullable(),
    signerFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    pendingUpdate: z
      .object({
        version: z.string().regex(VERSION),
        targetIntegrity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        permissionDiff: permissionDiffSchema,
        requestedAt: z.string().datetime(),
        previousStatus: z.enum(["active", "disabled"])
      })
      .strict()
      .optional(),
    lifecycle: z.array(lifecycleRecordSchema),
    migrations: z.array(migrationRecordSchema)
  })
  .strict();

export type InstalledPluginState = z.infer<typeof installedStateSchema>;
export type LifecycleRecord = z.infer<typeof lifecycleRecordSchema>;
export type MigrationRecord = z.infer<typeof migrationRecordSchema>;

export const PluginApprovalReceiptSchema = z
  .object({
    receiptId: z.string().uuid(),
    installationId: z.string().uuid(),
    stateRevision: z.number().int().positive(),
    pluginId: z.string().regex(PLUGIN_ID),
    version: z.string().regex(VERSION),
    targetIntegrity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    approvedPermissionKeys: z.array(z.string().min(1)).max(128),
    actor: z.string().min(1).max(200),
    approvedAt: z.string().datetime(),
    decision: z.literal("approved")
  })
  .strict();

export type PluginApprovalReceipt = z.infer<typeof PluginApprovalReceiptSchema>;

export interface PluginApprovalExpectation {
  installationId: string;
  stateRevision: number;
  pluginId: string;
  version: string;
  targetIntegrity: string;
  addedPermissionKeys: string[];
}

export interface PluginApprovalReceiptVerifier {
  verify(
    receipt: PluginApprovalReceipt,
    expectation: PluginApprovalExpectation
  ): Promise<boolean> | boolean;
}

const mutationReconciliationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    pluginId: z.string().regex(PLUGIN_ID),
    invocationId: z.string().uuid(),
    operationIdempotencyKey: z.string().min(1).max(200),
    capabilityRequestId: z.string().min(1).max(200),
    capability: z.string().regex(CAPABILITY),
    idempotencyKey: z.string().regex(/^plugin-capability:[a-f0-9]{64}$/),
    state: z.enum(["dispatched", "completed", "outcome_unknown", "reconciled"]),
    dispatchedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    settledAt: z.string().datetime().optional(),
    reconciledAt: z.string().datetime().optional(),
    resolution: z.enum(["confirmed_applied", "confirmed_not_applied"]).optional(),
    actor: z.string().min(1).max(200).optional(),
    note: z.string().max(1000).optional()
  })
  .strict();

const pluginReconciliationGateSchema = z
  .object({
    schemaVersion: z.literal(1),
    pluginId: z.string().regex(PLUGIN_ID),
    invocationId: z.string().uuid(),
    operationIdempotencyKey: z.string().min(1).max(200),
    state: z.enum(["dispatched", "outcome_unknown"]),
    openedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    errorCode: z.string().min(1).max(100).optional(),
    errorMessage: z.string().min(1).max(2000).optional()
  })
  .strict();

const pluginReconciliationDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    pluginId: z.string().regex(PLUGIN_ID),
    invocationId: z.string().uuid(),
    resolution: z.enum(["confirmed_applied", "confirmed_not_applied"]),
    actor: z.string().min(1).max(200),
    note: z.string().max(1000).optional(),
    reconciledAt: z.string().datetime()
  })
  .strict();

export type MutationReconciliationRecord = z.infer<
  typeof mutationReconciliationRecordSchema
>;
export type PluginReconciliationGateRecord = z.infer<
  typeof pluginReconciliationGateSchema
>;

export interface MutationDispatchRecord {
  pluginId: string;
  invocationId: string;
  operationIdempotencyKey: string;
  capabilityRequestId: string;
  capability: string;
  idempotencyKey: string;
}

export interface PluginMutationReconciliationLedger {
  beginMutation(record: MutationDispatchRecord): Promise<void>;
  markInvocationOutcomeUnknown(
    pluginId: string,
    invocationId: string,
    error: PluginRuntimeError
  ): Promise<void>;
  completeInvocation(pluginId: string, invocationId: string): Promise<void>;
}

export interface ReconcilePluginMutationInput {
  invocationId: string;
  resolution: "confirmed_applied" | "confirmed_not_applied";
  actor: string;
  note?: string;
}

export interface PluginReconciliationStatus {
  active: PluginReconciliationGateRecord | null;
  records: MutationReconciliationRecord[];
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicJsonWrite(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await syncDirectoryBestEffort(path.dirname(target));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicJsonCreate(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.pending`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
    await syncDirectoryBestEffort(path.dirname(target));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await rm(temporary, { force: true }).catch(() => undefined);
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // The file content itself is fsynced. Some platforms reject directory fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readJsonWithSchema<S extends z.ZodTypeAny>(
  target: string,
  schema: S,
  errorCode: string,
  description: string
): Promise<z.output<S>> {
  try {
    return schema.parse(JSON.parse(await readFile(target, "utf8")));
  } catch (error) {
    throw new PluginRuntimeError(errorCode, `Cannot read ${description}: ${target}`, {
      cause: error
    });
  }
}

const pluginStoreQueues = new Map<string, Promise<void>>();
const pluginStoreLockContext = new AsyncLocalStorage<ReadonlySet<string>>();

export class FilePluginStore implements PluginMutationReconciliationLedger {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  pluginRoot(pluginId: string): string {
    if (!PLUGIN_ID.test(pluginId)) {
      throw new PluginRuntimeError("INVALID_PLUGIN_ID", "Unsafe plugin id");
    }
    return path.join(this.root, "plugins", pluginId);
  }

  bundlePath(pluginId: string, version: string): string {
    if (!VERSION.test(version)) {
      throw new PluginRuntimeError("INVALID_VERSION", "Unsafe plugin version");
    }
    return path.join(this.pluginRoot(pluginId), "versions", version, "bundle");
  }

  dataPath(pluginId: string, revision = "base"): string {
    if (!/^(?:base|[0-9a-f-]{36})$/.test(revision)) {
      throw new PluginRuntimeError("INVALID_DATA_REVISION", "Unsafe plugin data revision");
    }
    return path.join(this.pluginRoot(pluginId), "data", `${revision}.json`);
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(path.join(this.root, "plugins"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(this.root, ".transactions"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(this.root, "tombstones"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(this.root, "reconciliation"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(this.root, "approval-receipts"), { recursive: true, mode: 0o700 })
    ]);
  }

  async getState(pluginId: string): Promise<InstalledPluginState | undefined> {
    const revisionsRoot = path.join(this.pluginRoot(pluginId), "state.revisions");
    const revisions = await readdir(revisionsRoot, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    );
    const latestRevision = revisions
      .filter((entry) => entry.isFile() && /^\d+\.json$/.test(entry.name))
      .map((entry) => Number.parseInt(entry.name.slice(0, -".json".length), 10))
      .filter((revision) => Number.isSafeInteger(revision) && revision > 0)
      .sort((left, right) => right - left)[0];
    if (latestRevision !== undefined) {
      const state = await readJsonWithSchema(
        path.join(revisionsRoot, `${latestRevision}.json`),
        installedStateSchema,
        "CORRUPT_STATE",
        `${pluginId} revision ${latestRevision}`
      );
      if (state.revision !== latestRevision) {
        throw new PluginRuntimeError(
          "CORRUPT_STATE",
          `${pluginId} revision filename does not match its state`
        );
      }
      return state;
    }
    const statePath = path.join(this.pluginRoot(pluginId), "state.json");
    if (!(await pathExists(statePath))) return undefined;
    return readJsonWithSchema(
      statePath,
      installedStateSchema,
      "CORRUPT_STATE",
      `${pluginId} state`
    );
  }

  async runExclusive<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    this.pluginRoot(pluginId);
    const lockKey = `${this.root}\0${pluginId}`;
    const heldLocks = pluginStoreLockContext.getStore();
    if (heldLocks?.has(lockKey)) return operation();
    const previous = pluginStoreQueues.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    pluginStoreQueues.set(lockKey, queued);
    await previous.catch(() => undefined);
    try {
      return await pluginStoreLockContext.run(
        new Set([...(heldLocks ?? []), lockKey]),
        operation
      );
    } finally {
      release();
      if (pluginStoreQueues.get(lockKey) === queued) {
        pluginStoreQueues.delete(lockKey);
      }
    }
  }

  async createState(state: InstalledPluginState): Promise<void> {
    await this.runExclusive(state.pluginId, async () => {
      if (state.revision !== 1) {
        throw new PluginRuntimeError("STATE_CAS_FAILED", "Initial plugin state revision must be 1");
      }
      if (await this.getState(state.pluginId)) {
        throw new PluginRuntimeError("STATE_CAS_FAILED", `${state.pluginId} state already exists`);
      }
      await this.#commitStateRevision(state);
    });
  }

  async compareAndSwapState(
    expectedRevision: number,
    state: InstalledPluginState
  ): Promise<void> {
    await this.runExclusive(state.pluginId, async () => {
      const current = await this.getState(state.pluginId);
      if (
        !current ||
        current.revision !== expectedRevision ||
        state.revision !== expectedRevision + 1
      ) {
        throw new PluginRuntimeError(
          "STATE_CAS_FAILED",
          `Expected ${state.pluginId} revision ${expectedRevision}`
        );
      }
      await this.#commitStateRevision(state);
    });
  }

  async #commitStateRevision(state: InstalledPluginState): Promise<void> {
    const parsed = installedStateSchema.parse(state);
    const revisionPath = path.join(
      this.pluginRoot(state.pluginId),
      "state.revisions",
      `${state.revision}.json`
    );
    try {
      await atomicJsonCreate(revisionPath, parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PluginRuntimeError(
          "STATE_CAS_FAILED",
          `${state.pluginId} revision ${state.revision} was already committed`
        );
      }
      throw error;
    }
    // state.json is a compatibility mirror; the exclusive revision commit is
    // authoritative, so a post-commit mirror failure must not report rollback.
    await atomicJsonWrite(
      path.join(this.pluginRoot(state.pluginId), "state.json"),
      parsed
    ).catch(() => undefined);
  }

  async stageVersion(snapshot: PluginBundleSnapshot): Promise<void> {
    await this.initialize();
    const finalPath = this.bundlePath(snapshot.manifest.id, snapshot.manifest.version);
    if (await pathExists(finalPath)) {
      const existing = await loadPluginBundle(finalPath);
      if (existing.manifest.integrity !== snapshot.manifest.integrity) {
        throw new PluginRuntimeError("VERSION_CONFLICT", "Installed version has different integrity");
      }
      return;
    }
    const transactionRoot = path.join(this.root, ".transactions", randomUUID());
    const stagedBundle = path.join(transactionRoot, "bundle");
    await mkdir(stagedBundle, { recursive: true, mode: 0o700 });
    try {
      for (const file of snapshot.files) {
        if (!isSafeRelativePath(file.path)) {
          throw new PluginRuntimeError("UNSAFE_PATH", `Unsafe bundle path: ${file.path}`);
        }
        const target = path.join(stagedBundle, ...file.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, file.bytes, { flag: "wx", mode: 0o600 });
      }
      await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
      await rename(stagedBundle, finalPath);
      await chmod(finalPath, 0o700);
    } finally {
      await rm(transactionRoot, { recursive: true, force: true });
    }
  }

  async beginMutation(rawRecord: MutationDispatchRecord): Promise<void> {
    const now = new Date().toISOString();
    const record = mutationReconciliationRecordSchema.parse({
      schemaVersion: 1,
      ...rawRecord,
      state: "dispatched",
      dispatchedAt: now,
      updatedAt: now
    });
    await this.runExclusive(record.pluginId, async () => {
      await this.initialize();
      const recordPath = this.#mutationRecordPath(
        record.pluginId,
        record.idempotencyKey
      );
      if (await pathExists(recordPath)) {
        throw new PluginRuntimeError(
          "IDEMPOTENCY_KEY_REPLAY",
          `Mutation idempotency key was already dispatched: ${record.idempotencyKey}`,
          { reconciliationRequired: true, invocationId: record.invocationId }
        );
      }

      const activePath = this.#reconciliationActivePath(record.pluginId);
      let active = await this.#readActiveReconciliation(record.pluginId);
      if (!active) {
        const initialGate = pluginReconciliationGateSchema.parse({
          schemaVersion: 1,
          pluginId: record.pluginId,
          invocationId: record.invocationId,
          operationIdempotencyKey: record.operationIdempotencyKey,
          state: "dispatched",
          openedAt: now,
          updatedAt: now
        });
        try {
          await atomicJsonCreate(activePath, initialGate);
          active = initialGate;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          active = await this.#readActiveReconciliation(record.pluginId);
        }
      }
      if (!active || active.invocationId !== record.invocationId) {
        throw new PluginRuntimeError(
          "RECONCILIATION_REQUIRED",
          `${record.pluginId} has an unresolved mutation and cannot dispatch another mutation`,
          {
            reconciliationRequired: true,
            ...(active ? { invocationId: active.invocationId } : {}),
            idempotencyKeys: (
              await this.#mutationRecords(record.pluginId, active?.invocationId)
            ).map((candidate) => candidate.idempotencyKey)
          }
        );
      }
      try {
        await atomicJsonCreate(recordPath, record);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new PluginRuntimeError(
            "IDEMPOTENCY_KEY_REPLAY",
            `Mutation idempotency key was already dispatched: ${record.idempotencyKey}`,
            { reconciliationRequired: true, invocationId: record.invocationId }
          );
        }
        throw error;
      }
    });
  }

  async markInvocationOutcomeUnknown(
    pluginId: string,
    invocationId: string,
    error: PluginRuntimeError
  ): Promise<void> {
    await this.runExclusive(pluginId, async () => {
      const active = await this.#readActiveReconciliation(pluginId);
      if (!active || active.invocationId !== invocationId) {
        throw new PluginRuntimeError(
          "RECONCILIATION_LEDGER_MISSING",
          `Cannot persist unknown outcome for ${pluginId}/${invocationId}`,
          { reconciliationRequired: true, invocationId }
        );
      }
      const now = new Date().toISOString();
      await atomicJsonWrite(
        this.#reconciliationActivePath(pluginId),
        pluginReconciliationGateSchema.parse({
          ...active,
          state: "outcome_unknown",
          updatedAt: now,
          errorCode: error.code,
          errorMessage: error.message.slice(0, 2000)
        })
      );
      for (const record of await this.#mutationRecords(pluginId, invocationId)) {
        await atomicJsonWrite(
          this.#mutationRecordPath(pluginId, record.idempotencyKey),
          mutationReconciliationRecordSchema.parse({
            ...record,
            state: "outcome_unknown",
            updatedAt: now
          })
        );
      }
    });
  }

  async completeInvocation(pluginId: string, invocationId: string): Promise<void> {
    await this.runExclusive(pluginId, async () => {
      const active = await this.#readActiveReconciliation(pluginId);
      if (!active || active.invocationId !== invocationId) return;
      const now = new Date().toISOString();
      for (const record of await this.#mutationRecords(pluginId, invocationId)) {
        await atomicJsonWrite(
          this.#mutationRecordPath(pluginId, record.idempotencyKey),
          mutationReconciliationRecordSchema.parse({
            ...record,
            state: "completed",
            updatedAt: now,
            settledAt: now
          })
        );
      }
      const historyRoot = path.join(
        this.#reconciliationRoot(pluginId),
        "history"
      );
      await mkdir(historyRoot, { recursive: true, mode: 0o700 });
      await rename(
        this.#reconciliationActivePath(pluginId),
        path.join(historyRoot, `${invocationId}.completed.json`)
      );
    });
  }

  async getReconciliationStatus(
    pluginId: string
  ): Promise<PluginReconciliationStatus> {
    return {
      active: (await this.#readActiveReconciliation(pluginId)) ?? null,
      records: await this.#mutationRecords(pluginId)
    };
  }

  async reconcilePluginMutation(
    pluginId: string,
    rawInput: ReconcilePluginMutationInput
  ): Promise<PluginReconciliationStatus> {
    const input = pluginReconciliationDecisionSchema
      .omit({
        schemaVersion: true,
        pluginId: true,
        reconciledAt: true
      })
      .parse(rawInput);
    return this.runExclusive(pluginId, async () => {
      const active = await this.#readActiveReconciliation(pluginId);
      if (!active) {
        throw new PluginRuntimeError(
          "NO_RECONCILIATION_REQUIRED",
          `${pluginId} has no unresolved mutation`
        );
      }
      if (active.invocationId !== input.invocationId) {
        throw new PluginRuntimeError(
          "RECONCILIATION_MISMATCH",
          `Reconciliation does not match the active invocation for ${pluginId}`
        );
      }
      const now = new Date().toISOString();
      const decision = pluginReconciliationDecisionSchema.parse({
        schemaVersion: 1,
        pluginId,
        ...input,
        reconciledAt: now
      });
      const decisionsRoot = path.join(
        this.#reconciliationRoot(pluginId),
        "decisions"
      );
      const decisionPath = path.join(
        decisionsRoot,
        `${input.invocationId}.json`
      );
      if (await pathExists(decisionPath)) {
        const existing = await readJsonWithSchema(
          decisionPath,
          pluginReconciliationDecisionSchema,
          "CORRUPT_RECONCILIATION",
          "reconciliation decision"
        );
        if (
          existing.resolution !== decision.resolution ||
          existing.actor !== decision.actor ||
          existing.note !== decision.note
        ) {
          throw new PluginRuntimeError(
            "RECONCILIATION_REPLAY_MISMATCH",
            "A different reconciliation decision was already recorded"
          );
        }
      } else {
        await atomicJsonCreate(decisionPath, decision);
      }

      for (const record of await this.#mutationRecords(
        pluginId,
        input.invocationId
      )) {
        await atomicJsonWrite(
          this.#mutationRecordPath(pluginId, record.idempotencyKey),
          mutationReconciliationRecordSchema.parse({
            ...record,
            state: "reconciled",
            updatedAt: now,
            reconciledAt: now,
            resolution: input.resolution,
            actor: input.actor,
            ...(input.note === undefined ? {} : { note: input.note })
          })
        );
      }
      const historyRoot = path.join(
        this.#reconciliationRoot(pluginId),
        "history"
      );
      await mkdir(historyRoot, { recursive: true, mode: 0o700 });
      await rename(
        this.#reconciliationActivePath(pluginId),
        path.join(historyRoot, `${input.invocationId}.reconciled.json`)
      );
      return this.getReconciliationStatus(pluginId);
    });
  }

  async consumeApprovalReceipt(receipt: PluginApprovalReceipt): Promise<void> {
    const parsed = PluginApprovalReceiptSchema.parse(receipt);
    await this.initialize();
    try {
      await atomicJsonCreate(
        path.join(this.root, "approval-receipts", `${parsed.receiptId}.json`),
        parsed
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PluginRuntimeError(
          "APPROVAL_RECEIPT_REPLAY",
          `Approval receipt ${parsed.receiptId} was already consumed`
        );
      }
      throw error;
    }
  }

  #reconciliationRoot(pluginId: string): string {
    this.pluginRoot(pluginId);
    return path.join(this.root, "reconciliation", pluginId);
  }

  #reconciliationActivePath(pluginId: string): string {
    return path.join(this.#reconciliationRoot(pluginId), "active.json");
  }

  #mutationRecordPath(pluginId: string, idempotencyKey: string): string {
    const digest = createHash("sha256").update(idempotencyKey).digest("hex");
    return path.join(
      this.#reconciliationRoot(pluginId),
      "records",
      `${digest}.json`
    );
  }

  async #readActiveReconciliation(
    pluginId: string
  ): Promise<PluginReconciliationGateRecord | undefined> {
    const activePath = this.#reconciliationActivePath(pluginId);
    if (!(await pathExists(activePath))) return undefined;
    return readJsonWithSchema(
      activePath,
      pluginReconciliationGateSchema,
      "CORRUPT_RECONCILIATION",
      `${pluginId} reconciliation gate`
    );
  }

  async #mutationRecords(
    pluginId: string,
    invocationId?: string
  ): Promise<MutationReconciliationRecord[]> {
    const recordsRoot = path.join(
      this.#reconciliationRoot(pluginId),
      "records"
    );
    const entries = await readdir(recordsRoot, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    );
    const records: MutationReconciliationRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const record = await readJsonWithSchema(
        path.join(recordsRoot, entry.name),
        mutationReconciliationRecordSchema,
        "CORRUPT_RECONCILIATION",
        `${pluginId} mutation record`
      );
      if (invocationId === undefined || record.invocationId === invocationId) {
        records.push(record);
      }
    }
    return records.sort((left, right) =>
      left.dispatchedAt.localeCompare(right.dispatchedAt)
    );
  }

  async uninstall(pluginId: string, state: InstalledPluginState): Promise<void> {
    await this.runExclusive(pluginId, async () => {
      await this.initialize();
      const current = await this.getState(pluginId);
      if (!current || current.revision !== state.revision) {
        throw new PluginRuntimeError("STATE_CAS_FAILED", `Stale uninstall state for ${pluginId}`);
      }
      const pluginRoot = this.pluginRoot(pluginId);
      if (!(await pathExists(pluginRoot))) return;
      const transactionRoot = path.join(this.root, ".transactions", `${pluginId}-${randomUUID()}`);
      await rename(pluginRoot, transactionRoot);
      const tombstone = {
        ...state,
        status: "disabled" as const,
        lifecycle: [
          ...state.lifecycle,
          {
            event: "uninstalled" as const,
            at: new Date().toISOString(),
            actor: "runtime"
          }
        ]
      };
      try {
        await atomicJsonWrite(
          path.join(this.root, "tombstones", `${pluginId}-${Date.now()}.json`),
          tombstone
        );
      } catch (error) {
        await rename(transactionRoot, pluginRoot);
        throw error;
      }
      await rm(transactionRoot, { recursive: true, force: true });
    });
  }
}

type JsonObject = Record<string, unknown>;

export type CapabilityEffect = "read" | "transactional" | "mutation";

export interface CapabilityRequestContext {
  pluginId: string;
  manifest: PluginManifest;
  invocationId: string;
  capabilityRequestId: string;
  idempotencyKey: string;
  signal: AbortSignal;
  effect: CapabilityEffect;
}

export type CapabilityHandler = (
  args: unknown,
  context: CapabilityRequestContext
) => Promise<unknown> | unknown;

interface CapabilityRegistration {
  permission: string;
  handler: CapabilityHandler;
  effect: CapabilityEffect;
}

export interface CapabilityRegistrationOptions {
  effect: CapabilityEffect;
}

export interface CapabilityDescriptor {
  permission: string;
  effect: CapabilityEffect;
}

interface CapabilityInvocationContext {
  pluginId: string;
  manifest: PluginManifest;
  invocationId: string;
  capabilityRequestId: string;
  idempotencyKey: string;
  signal: AbortSignal;
  toolReadOnly: boolean;
  allowedEffects: ReadonlySet<CapabilityEffect>;
  onDispatch: (effect: CapabilityEffect) => Promise<void> | void;
}

function hasPermission(permissions: PluginPermissions, required: string): boolean {
  if (required.startsWith("capabilities:")) {
    return permissions.capabilities.includes(required.slice("capabilities:".length));
  }
  if (required.startsWith("filesystem:")) {
    return permissions.filesystem.includes(required.slice("filesystem:".length));
  }
  if (required.startsWith("network:")) {
    return permissions.network.includes(required.slice("network:".length));
  }
  if (required.startsWith("secrets:")) {
    return permissions.secrets.includes(required.slice("secrets:".length));
  }
  if (required === "storage") return permissions.storage;
  if (required === "advertisingRead") return permissions.advertisingRead;
  if (required === "advertisingMutation") return permissions.advertisingMutation;
  if (required === "browser") return permissions.browser;
  if (required === "computerUse") return permissions.computerUse;
  return false;
}

export class CapabilityBroker {
  readonly #capabilities = new Map<string, CapabilityRegistration>();

  register(
    name: string,
    permission: string,
    handler: CapabilityHandler,
    options: CapabilityRegistrationOptions = { effect: "mutation" }
  ): this {
    if (!CAPABILITY.test(name)) {
      throw new PluginRuntimeError("INVALID_CAPABILITY", `Invalid capability name: ${name}`);
    }
    if (this.#capabilities.has(name)) {
      throw new PluginRuntimeError("DUPLICATE_CAPABILITY", `Capability already registered: ${name}`);
    }
    this.#capabilities.set(name, { permission, handler, effect: options.effect });
    return this;
  }

  describe(name: string): CapabilityDescriptor | undefined {
    const registration = this.#capabilities.get(name);
    return registration
      ? { permission: registration.permission, effect: registration.effect }
      : undefined;
  }

  async invoke(
    name: string,
    args: unknown,
    context: CapabilityInvocationContext
  ): Promise<unknown> {
    const registration = this.#capabilities.get(name);
    if (!registration) {
      throw new PluginRuntimeError("CAPABILITY_DENIED", `Capability is not brokered: ${name}`);
    }
    if (!hasPermission(context.manifest.permissions, registration.permission)) {
      throw new PluginRuntimeError(
        "CAPABILITY_DENIED",
        `${context.pluginId} did not declare ${registration.permission}`
      );
    }
    if (!context.allowedEffects.has(registration.effect)) {
      throw new PluginRuntimeError(
        context.toolReadOnly
          ? "READ_ONLY_CAPABILITY_DENIED"
          : "CAPABILITY_EFFECT_DENIED",
        context.toolReadOnly
          ? `Read-only tool cannot invoke ${registration.effect} capability ${name}`
          : `Invocation cannot use ${registration.effect} capability ${name}`
      );
    }
    context.signal.throwIfAborted();
    await context.onDispatch(registration.effect);
    const handlerContext: CapabilityRequestContext = {
      pluginId: context.pluginId,
      manifest: context.manifest,
      invocationId: context.invocationId,
      capabilityRequestId: context.capabilityRequestId,
      idempotencyKey: context.idempotencyKey,
      signal: context.signal,
      effect: registration.effect
    };
    return registration.handler(args, handlerContext);
  }
}

function ensureInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createReadOnlyFileBroker(allowedRoots: readonly string[]): CapabilityBroker {
  const roots = allowedRoots.map((root) => path.resolve(root));
  return new CapabilityBroker().register(
    "filesystem.readText",
    "filesystem:read.text",
    async (rawArgs, context) => {
      context.signal.throwIfAborted();
      const args = z
        .object({ path: z.string().min(1), maxBytes: z.number().int().positive().max(2_000_000).optional() })
        .strict()
        .parse(rawArgs);
      const unresolved = path.resolve(args.path);
      const unresolvedStats = await lstat(unresolved);
      context.signal.throwIfAborted();
      if (unresolvedStats.isSymbolicLink()) {
        throw new PluginRuntimeError("PATH_DENIED", "Symbolic links cannot be read");
      }
      const [candidate, canonicalRoots] = await Promise.all([
        realpath(unresolved),
        Promise.all(roots.map((root) => realpath(root)))
      ]);
      context.signal.throwIfAborted();
      if (!canonicalRoots.some((root) => ensureInsideRoot(candidate, root))) {
        throw new PluginRuntimeError("PATH_DENIED", "Requested file is outside the allowed roots");
      }
      const stats = await lstat(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new PluginRuntimeError("PATH_DENIED", "Only regular, non-symlink files can be read");
      }
      const limit = args.maxBytes ?? 1_000_000;
      if (stats.size > limit) {
        throw new PluginRuntimeError("FILE_TOO_LARGE", `File exceeds ${limit} bytes`);
      }
      return readFile(candidate, { encoding: "utf8", signal: context.signal });
    },
    { effect: "read" }
  );
}

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:token|secret|password|authorization|cookie|api[-_]?key|credential)/i;
const SENSITIVE_VALUE = /(?:bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{8,})/gi;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return value.slice(0, 4000).replace(SENSITIVE_VALUE, REDACTED);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1)])
    );
  }
  return value;
}

export interface PluginLogEvent {
  timestamp: string;
  pluginId: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  data?: unknown;
}

export class StructuredPluginLogger {
  readonly #logPath: string | undefined;
  readonly #sink: ((event: PluginLogEvent) => void) | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: { logPath?: string; sink?: (event: PluginLogEvent) => void } = {}) {
    this.#logPath = options.logPath;
    this.#sink = options.sink;
  }

  write(event: Omit<PluginLogEvent, "timestamp">): Promise<void> {
    const clean: PluginLogEvent = {
      timestamp: new Date().toISOString(),
      pluginId: event.pluginId,
      level: event.level,
      event: event.event,
      ...(event.data === undefined ? {} : { data: redact(event.data) })
    };
    this.#sink?.(clean);
    if (!this.#logPath) return Promise.resolve();
    this.#queue = this.#queue.then(async () => {
      await mkdir(path.dirname(this.#logPath!), { recursive: true });
      await appendFile(this.#logPath!, `${JSON.stringify(clean)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    return this.#queue;
  }
}

export type PluginProcessState =
  | "idle"
  | "running"
  | "crashed"
  | "timed_out"
  | "aborted"
  | "outcome_unknown"
  | "completed";

export type CapabilityInvocationState = "pending" | "succeeded" | "failed" | "aborted";

export interface CapabilityInvocationStatus {
  requestId: string;
  capability: string;
  effect: CapabilityEffect;
  idempotencyKey: string;
  state: CapabilityInvocationState;
  dispatched: boolean;
  startedAt: string;
  settledAt?: string;
  error?: string;
}

export interface PluginInvocationStatus {
  invocationId: string;
  pluginId: string;
  operation: "tool" | "migration";
  state: PluginProcessState;
  retryable: boolean;
  reconciliationRequired: boolean;
  startedAt: string;
  completedAt?: string;
  capabilities: CapabilityInvocationStatus[];
}

export interface PluginSupervisorStatus {
  pluginId: string;
  state: PluginProcessState;
  isolation: "child_process+vm";
  developerMode: boolean;
  lastInvocationId?: string;
  reconciliationRequired?: boolean;
  lastError?: string;
  updatedAt: string;
}

export interface PluginInvocationOptions {
  timeoutMs?: number;
  idempotencyKey?: string;
  signal?: AbortSignal;
  expectedIntegrity?: string;
  reconciliationLedger?: PluginMutationReconciliationLedger;
}

interface HostMessage {
  type: string;
  requestId?: string;
  capability?: string;
  args?: unknown;
  result?: unknown;
  error?: {
    message?: string;
    stack?: string;
    code?: string;
    retryable?: boolean;
    reconciliationRequired?: boolean;
  };
  level?: "debug" | "info" | "warn" | "error";
  event?: string;
  data?: unknown;
}

interface HostTerminalMessage {
  type: "result" | "error";
  result?: unknown;
  error?: HostMessage["error"];
}

function normalizeInvocationOptions(
  value: number | PluginInvocationOptions | undefined
): Required<Pick<PluginInvocationOptions, "timeoutMs">> & Omit<PluginInvocationOptions, "timeoutMs"> {
  const options = typeof value === "number" ? { timeoutMs: value } : (value ?? {});
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new PluginRuntimeError("INVALID_TIMEOUT", "Plugin timeout must be between 1 and 120000ms");
  }
  if (
    options.idempotencyKey !== undefined &&
    (options.idempotencyKey.length < 1 || options.idempotencyKey.length > 200)
  ) {
      throw new PluginRuntimeError("INVALID_IDEMPOTENCY_KEY", "Invocation idempotency key is invalid");
  }
  if (
    options.expectedIntegrity !== undefined &&
    !/^sha256:[a-f0-9]{64}$/.test(options.expectedIntegrity)
  ) {
    throw new PluginRuntimeError(
      "INVALID_INTEGRITY_PIN",
      "Invocation integrity pin is invalid"
    );
  }
  return {
    timeoutMs,
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.expectedIntegrity === undefined
      ? {}
      : { expectedIntegrity: options.expectedIntegrity }),
    ...(options.reconciliationLedger === undefined
      ? {}
      : { reconciliationLedger: options.reconciliationLedger })
  };
}

function capabilityIdempotencyKey(base: string, ordinal: number, capability: string): string {
  return `plugin-capability:${createHash("sha256")
    .update(`${base}:${ordinal}:${capability}`)
    .digest("hex")}`;
}

interface InvocationBundleFile {
  path: string;
  contentBase64: string;
}

function snapshotInvocationBundle(
  snapshot: PluginBundleSnapshot,
  expectedIntegrity?: string
): InvocationBundleFile[] {
  const actualIntegrity = computeBundleIntegrity(snapshot.manifest, snapshot.files);
  if (
    actualIntegrity !== snapshot.manifest.integrity ||
    (expectedIntegrity !== undefined && actualIntegrity !== expectedIntegrity)
  ) {
    throw new PluginRuntimeError(
      "ACTIVE_BUNDLE_MISMATCH",
      `Invocation bundle does not match the pinned integrity for ${snapshot.manifest.id}`
    );
  }
  const written = new Set<string>();
  const files: InvocationBundleFile[] = [];
  for (const file of snapshot.files) {
    if (file.path === "plugin.json") continue;
    if (!isSafeRelativePath(file.path) || written.has(file.path)) {
      throw new PluginRuntimeError(
        "UNSAFE_PATH",
        `Unsafe or duplicate invocation bundle path: ${file.path}`
      );
    }
    written.add(file.path);
    files.push({
      path: file.path,
      contentBase64: Buffer.from(file.bytes).toString("base64")
    });
  }
  return files;
}

export class PluginSupervisor {
  readonly #statuses = new Map<string, PluginSupervisorStatus>();
  readonly #invocations = new Map<string, PluginInvocationStatus>();
  readonly #logger: StructuredPluginLogger;
  readonly #developerMode: boolean;
  readonly #hostPath: string;

  constructor(options: {
    logger?: StructuredPluginLogger;
    developerMode?: boolean;
    hostPath?: string;
  } = {}) {
    this.#logger = options.logger ?? new StructuredPluginLogger();
    this.#developerMode = options.developerMode ?? false;
    this.#hostPath = options.hostPath ?? fileURLToPath(new URL("./host.mjs", import.meta.url));
  }

  status(pluginId: string): PluginSupervisorStatus {
    const status = this.#statuses.get(pluginId);
    return status
      ? { ...status }
      : {
          pluginId,
          state: "idle",
          isolation: "child_process+vm",
          developerMode: this.#developerMode,
          updatedAt: new Date().toISOString()
        };
  }

  invocationStatus(invocationId: string): PluginInvocationStatus | undefined {
    const invocation = this.#invocations.get(invocationId);
    return invocation
      ? {
          ...invocation,
          capabilities: invocation.capabilities.map((capability) => ({ ...capability }))
        }
      : undefined;
  }

  reconciliationRequired(): PluginInvocationStatus[] {
    return [...this.#invocations.values()]
      .filter((invocation) => invocation.reconciliationRequired)
      .map((invocation) => ({
        ...invocation,
        capabilities: invocation.capabilities.map((capability) => ({ ...capability }))
      }));
  }

  async executeTool(
    snapshot: PluginBundleSnapshot,
    tool: string,
    input: unknown,
    broker: CapabilityBroker,
    options?: number | PluginInvocationOptions
  ): Promise<unknown> {
    const declaration = snapshot.manifest.tools.find((candidate) => candidate.name === tool);
    if (!declaration) {
      throw new PluginRuntimeError("TOOL_NOT_DECLARED", `Plugin did not declare tool ${tool}`);
    }
    return this.#run(
      snapshot,
      { mode: "tool", module: snapshot.manifest.entry, name: tool, input },
      broker,
      normalizeInvocationOptions(options),
      declaration.readOnly,
      declaration.readOnly
        ? new Set<CapabilityEffect>(["read"])
        : new Set<CapabilityEffect>(["read", "transactional", "mutation"])
    );
  }

  async executeMigration(
    snapshot: PluginBundleSnapshot,
    module: string,
    input: unknown,
    broker: CapabilityBroker,
    options?: number | PluginInvocationOptions
  ): Promise<unknown> {
    return this.#run(
      snapshot,
      { mode: "migration", module, input },
      broker,
      normalizeInvocationOptions(options),
      false,
      new Set<CapabilityEffect>(["read", "transactional"])
    );
  }

  async #run(
    snapshot: PluginBundleSnapshot,
    operation: JsonObject,
    broker: CapabilityBroker,
    options: ReturnType<typeof normalizeInvocationOptions>,
    toolReadOnly: boolean,
    allowedEffects: ReadonlySet<CapabilityEffect>
  ): Promise<unknown> {
    const pluginId = snapshot.manifest.id;
    const operationType = operation.mode === "migration" ? "migration" : "tool";
    const invocationId = randomUUID();
    const baseIdempotencyKey = options.idempotencyKey ?? `plugin-invocation:${invocationId}`;
    // Copy the verified bytes synchronously before yielding. The child receives
    // this immutable IPC payload and never re-opens the mutable source bundle.
    const invocationBundleFiles = snapshotInvocationBundle(
      snapshot,
      options.expectedIntegrity
    );
    const permissionFlag = process.allowedNodeEnvironmentFlags.has("--permission")
      ? "--permission"
      : process.allowedNodeEnvironmentFlags.has("--experimental-permission")
        ? "--experimental-permission"
        : undefined;
    if (!permissionFlag) {
      const error = new PluginRuntimeError(
        "PLUGIN_SANDBOX_UNSUPPORTED",
        "This Node runtime does not provide the permission model required for plugin isolation",
        { invocationId }
      );
      this.#setStatus(pluginId, "crashed", invocationId, error.message);
      await this.#logger.write({
        pluginId,
        level: "error",
        event: "plugin_sandbox_unsupported"
      });
      throw error;
    }

    const invocation: PluginInvocationStatus = {
      invocationId,
      pluginId,
      operation: operationType,
      state: "running",
      retryable: false,
      reconciliationRequired: false,
      startedAt: new Date().toISOString(),
      capabilities: []
    };
    this.#invocations.set(invocationId, invocation);
    this.#setStatus(pluginId, "running", invocationId);
    await this.#logger.write({
      pluginId,
      level: "info",
      event: "plugin_process_started",
      data: {
        invocationId,
        mode: operation.mode,
        developerMode: this.#developerMode
      }
    });

    const args = [
      "--experimental-vm-modules",
      "--max-old-space-size=128",
      permissionFlag,
      `--allow-fs-read=${this.#hostPath}`,
      this.#hostPath
    ];
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      // Under Electron the executable is the Electron binary; it only runs a
      // plain Node entrypoint when ELECTRON_RUN_AS_NODE=1 is set for the child.
      env: { NODE_NO_WARNINGS: "1", ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    const requestId = randomUUID();
    const abortController = new AbortController();

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let mutationDispatched = false;
      let capabilityOrdinal = 0;
      let terminal: HostTerminalMessage | undefined;
      let timer: NodeJS.Timeout | undefined;
      const pending = new Map<string, Promise<void>>();
      const capabilityFailures: unknown[] = [];

      const mutationKeys = () =>
        invocation.capabilities
          .filter((capability) => capability.effect === "mutation" && capability.dispatched)
          .map((capability) => capability.idempotencyKey);

      const outcomeUnknown = (cause: Error): PluginRuntimeError =>
        new PluginRuntimeError(
          "OUTCOME_UNKNOWN",
          `${pluginId} dispatched a non-cancelable mutation; reconciliation is required before any retry`,
          {
            cause,
            retryable: false,
            reconciliationRequired: true,
            invocationId,
            idempotencyKeys: mutationKeys()
          }
        );

      const finish = (
        state: PluginProcessState,
        value?: unknown,
        error?: PluginRuntimeError
      ) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", externalAbort);
        if (child.connected) child.disconnect();
        if (!child.killed) child.kill("SIGKILL");
        void (async () => {
          let finalState = state;
          let finalError = error;
          try {
            if (
              mutationDispatched &&
              options.reconciliationLedger &&
              state === "completed"
            ) {
              await options.reconciliationLedger.completeInvocation(
                pluginId,
                invocationId
              );
            } else if (
              mutationDispatched &&
              options.reconciliationLedger &&
              state === "outcome_unknown" &&
              error
            ) {
              await options.reconciliationLedger.markInvocationOutcomeUnknown(
                pluginId,
                invocationId,
                error
              );
            }
          } catch (ledgerError) {
            finalState = "outcome_unknown";
            finalError = new PluginRuntimeError(
              "RECONCILIATION_PERSIST_FAILED",
              `${pluginId} mutation ledger could not reach a terminal durable state`,
              {
                cause:
                  ledgerError instanceof Error ? ledgerError : undefined,
                retryable: false,
                reconciliationRequired: true,
                invocationId,
                idempotencyKeys: mutationKeys()
              }
            );
          }
          invocation.state = finalState;
          invocation.retryable = finalError?.retryable ?? false;
          invocation.reconciliationRequired =
            finalError?.reconciliationRequired ?? false;
          invocation.completedAt = new Date().toISOString();
          this.#setStatus(
            pluginId,
            finalState,
            invocationId,
            finalError?.message,
            invocation.reconciliationRequired
          );
          await this.#logger.write({
            pluginId,
            level: finalError ? "error" : "info",
            event: `plugin_process_${finalState}`,
            data: {
              invocationId,
              ...(finalError
                ? {
                    error: finalError.message,
                    code: finalError.code,
                    retryable: finalError.retryable,
                    reconciliationRequired:
                      finalError.reconciliationRequired,
                    idempotencyKeys: finalError.idempotencyKeys
                  }
                : {})
            }
          });
          if (finalError) reject(finalError);
          else resolve(value);
        })();
      };

      const fail = (
        fallbackState: Exclude<PluginProcessState, "idle" | "running" | "completed" | "outcome_unknown">,
        error: PluginRuntimeError
      ) => {
        if (!abortController.signal.aborted) abortController.abort(error);
        finish(
          mutationDispatched ? "outcome_unknown" : fallbackState,
          undefined,
          mutationDispatched ? outcomeUnknown(error) : error
        );
      };

      const errorFromUnknown = (
        error: unknown,
        fallbackCode = "CAPABILITY_FAILED"
      ): PluginRuntimeError => {
        if (error instanceof PluginRuntimeError) return error;
        return new PluginRuntimeError(
          fallbackCode,
          error instanceof Error ? error.message : String(error),
          { cause: error instanceof Error ? error : undefined, invocationId }
        );
      };

      const finalizeTerminal = () => {
        if (settled || !terminal || pending.size > 0) return;
        if (terminal.type === "result" && capabilityFailures.length === 0) {
          finish("completed", terminal.result);
          return;
        }
        const terminalError =
          terminal.type === "error"
            ? new PluginRuntimeError(
                terminal.error?.code ?? "PLUGIN_EXECUTION_FAILED",
                terminal.error?.message ?? "Plugin failed",
                {
                  retryable: terminal.error?.retryable ?? false,
                  reconciliationRequired:
                    terminal.error?.reconciliationRequired ?? false,
                  invocationId
                }
              )
            : errorFromUnknown(capabilityFailures[0]);
        fail("crashed", terminalError);
      };

      const abortInvocation = (code: "PLUGIN_TIMEOUT" | "PLUGIN_ABORTED", message: string) => {
        const abortError = new PluginRuntimeError(code, message, {
          retryable: code === "PLUGIN_TIMEOUT",
          invocationId
        });
        if (!abortController.signal.aborted) abortController.abort(abortError);
        fail(code === "PLUGIN_TIMEOUT" ? "timed_out" : "aborted", abortError);
      };

      const externalAbort = () => {
        abortInvocation("PLUGIN_ABORTED", `${pluginId} invocation was aborted`);
      };

      timer = setTimeout(() => {
        abortInvocation("PLUGIN_TIMEOUT", `${pluginId} exceeded ${options.timeoutMs}ms`);
      }, options.timeoutMs);
      options.signal?.addEventListener("abort", externalAbort, { once: true });
      if (options.signal?.aborted) queueMicrotask(externalAbort);

      child.on("error", (error) => {
        fail(
          "crashed",
          new PluginRuntimeError("PLUGIN_CRASH", error.message, {
            cause: error,
            invocationId
          })
        );
      });
      child.on("exit", (code, signal) => {
        if (!settled && !terminal) {
          fail(
            "crashed",
            new PluginRuntimeError(
              "PLUGIN_CRASH",
              `${pluginId} exited before returning a result (${signal ?? code ?? "unknown"})`,
              { invocationId }
            )
          );
        }
      });
      child.on("message", (rawMessage) => {
        const message = rawMessage as HostMessage;
        if (message.type === "ready") {
          if (!settled) {
            child.send({
              type: "execute",
              requestId,
              invocationId,
              bundleFiles: invocationBundleFiles,
              operation
            });
          }
          return;
        }
        if (message.type === "capability" && message.requestId && message.capability) {
          if (settled || pending.has(message.requestId)) return;
          capabilityOrdinal += 1;
          const descriptor = broker.describe(message.capability);
          const capabilityStatus: CapabilityInvocationStatus = {
            requestId: message.requestId,
            capability: message.capability,
            effect: descriptor?.effect ?? "mutation",
            idempotencyKey: capabilityIdempotencyKey(
              baseIdempotencyKey,
              capabilityOrdinal,
              message.capability
            ),
            state: "pending",
            dispatched: false,
            startedAt: new Date().toISOString()
          };
          invocation.capabilities.push(capabilityStatus);
          const capabilityPromise = broker
            .invoke(message.capability, message.args, {
              pluginId,
              manifest: snapshot.manifest,
              invocationId,
              capabilityRequestId: message.requestId,
              idempotencyKey: capabilityStatus.idempotencyKey,
              signal: abortController.signal,
              toolReadOnly,
              allowedEffects,
              onDispatch: async (effect) => {
                capabilityStatus.effect = effect;
                if (effect === "mutation" && options.reconciliationLedger) {
                  await options.reconciliationLedger.beginMutation({
                    pluginId,
                    invocationId,
                    operationIdempotencyKey: baseIdempotencyKey,
                    capabilityRequestId: message.requestId!,
                    capability: message.capability!,
                    idempotencyKey: capabilityStatus.idempotencyKey
                  });
                }
                capabilityStatus.dispatched = true;
                if (effect === "mutation") mutationDispatched = true;
              }
            })
            .then((result) => {
              capabilityStatus.state = "succeeded";
              capabilityStatus.settledAt = new Date().toISOString();
              if (!settled && child.connected) {
                child.send({
                  type: "capability_result",
                  requestId: message.requestId,
                  result
                });
              }
            })
            .catch((error: unknown) => {
              capabilityStatus.state = abortController.signal.aborted ? "aborted" : "failed";
              capabilityStatus.error = error instanceof Error ? error.message : String(error);
              capabilityStatus.settledAt = new Date().toISOString();
              capabilityFailures.push(error);
              if (!settled && child.connected) {
                const runtimeError = errorFromUnknown(error);
                child.send({
                  type: "capability_error",
                  requestId: message.requestId,
                  error: {
                    message: runtimeError.message,
                    code: runtimeError.code,
                    retryable: runtimeError.retryable,
                    reconciliationRequired: runtimeError.reconciliationRequired
                  }
                });
              }
            })
            .finally(() => {
              pending.delete(message.requestId!);
              if (settled && capabilityStatus.effect === "mutation") {
                void this.#logger.write({
                  pluginId,
                  level: "warn",
                  event: "plugin_late_mutation_settled",
                  data: {
                    invocationId,
                    capability: capabilityStatus.capability,
                    idempotencyKey: capabilityStatus.idempotencyKey,
                    state: capabilityStatus.state
                  }
                });
              }
              finalizeTerminal();
            });
          pending.set(message.requestId, capabilityPromise);
          return;
        }
        if (message.type === "log") {
          void this.#logger.write({
            pluginId,
            level: message.level ?? "info",
            event: message.event ?? "plugin_log",
            ...(message.data === undefined ? {} : { data: message.data })
          });
          return;
        }
        if (message.requestId !== requestId || settled) return;
        if (message.type === "result" || message.type === "error") {
          terminal = {
            type: message.type,
            ...(message.result === undefined ? {} : { result: message.result }),
            ...(message.error === undefined ? {} : { error: message.error })
          };
          finalizeTerminal();
        }
      });
    });
  }

  #setStatus(
    pluginId: string,
    state: PluginProcessState,
    invocationId?: string,
    lastError?: string,
    reconciliationRequired?: boolean
  ): void {
    this.#statuses.set(pluginId, {
      pluginId,
      state,
      isolation: "child_process+vm",
      developerMode: this.#developerMode,
      ...(invocationId ? { lastInvocationId: invocationId } : {}),
      ...(reconciliationRequired === undefined ? {} : { reconciliationRequired }),
      ...(lastError ? { lastError } : {}),
      updatedAt: new Date().toISOString()
    });
  }
}

class TransactionalPluginData {
  readonly #values: Record<string, unknown>;

  private constructor(values: Record<string, unknown>) {
    this.#values = values;
  }

  static async load(target: string): Promise<TransactionalPluginData> {
    if (!(await pathExists(target))) return new TransactionalPluginData({});
    const value = JSON.parse(await readFile(target, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PluginRuntimeError("CORRUPT_PLUGIN_DATA", "Plugin data must be a JSON object");
    }
    return new TransactionalPluginData(structuredClone(value as Record<string, unknown>));
  }

  broker(): CapabilityBroker {
    const keySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    return new CapabilityBroker()
      .register("storage.get", "storage", (rawArgs) => {
        const { key } = z.object({ key: keySchema }).strict().parse(rawArgs);
        return structuredClone(this.#values[key] ?? null);
      }, { effect: "read" })
      .register("storage.set", "storage", (rawArgs) => {
        const { key, value } = z.object({ key: keySchema, value: z.unknown() }).strict().parse(rawArgs);
        this.#values[key] = structuredClone(value);
        return true;
      }, { effect: "transactional" })
      .register("storage.delete", "storage", (rawArgs) => {
        const { key } = z.object({ key: keySchema }).strict().parse(rawArgs);
        return delete this.#values[key];
      }, { effect: "transactional" });
  }

  async commit(target: string): Promise<void> {
    await atomicJsonWrite(target, this.#values);
  }
}

export class CuratedPluginRuntime {
  readonly registry: CuratedRegistry;
  readonly store: FilePluginStore;
  readonly supervisor: PluginSupervisor;
  readonly #trustStore: PluginTrustStore;
  readonly #policy: BundleVerificationPolicy;
  readonly #approvalVerifier: PluginApprovalReceiptVerifier | undefined;

  constructor(options: {
    registry: CuratedRegistry;
    store: FilePluginStore;
    trustStore: PluginTrustStore;
    supervisor?: PluginSupervisor;
    policy?: BundleVerificationPolicy;
    approvalVerifier?: PluginApprovalReceiptVerifier;
  }) {
    this.registry = options.registry;
    this.store = options.store;
    this.#trustStore = options.trustStore;
    this.#policy = options.policy ?? DEFAULT_VERIFICATION_POLICY;
    this.#approvalVerifier = options.approvalVerifier;
    this.supervisor =
      options.supervisor ??
      new PluginSupervisor({ developerMode: this.#policy.developerMode });
  }

  async install(pluginId: string, version?: string, actor = "user"): Promise<InstalledPluginState> {
    return this.store.runExclusive(pluginId, async () => {
      if (await this.store.getState(pluginId)) {
        throw new PluginRuntimeError("ALREADY_INSTALLED", `${pluginId} is already installed`);
      }
      const registrySnapshot = await this.#verifiedRegistryBundle(pluginId, version);
      const snapshot = await this.#stageAndVerify(registrySnapshot);
      const identity = await verifiedPluginBundleIdentity(
        snapshot,
        this.#trustStore,
        this.#policy
      );
      const state: InstalledPluginState = {
        schemaVersion: 2,
        revision: 1,
        installationId: randomUUID(),
        pluginId,
        status: "active",
        activeVersion: snapshot.manifest.version,
        installedVersions: [snapshot.manifest.version],
        permissions: snapshot.manifest.permissions,
        dataVersion: snapshot.manifest.dataVersion,
        dataRevision: "base",
        activeIntegrity: identity.integrity,
        signerKeyId: snapshot.manifest.signature?.keyId ?? null,
        signerFingerprint: identity.signerFingerprint,
        lifecycle: [
          {
            event: "installed",
            at: new Date().toISOString(),
            toVersion: snapshot.manifest.version,
            actor,
            details: {
              signer: snapshot.manifest.signature?.keyId ?? "unsigned-explicit-policy",
              developerMode: this.#policy.developerMode
            }
          }
        ],
        migrations: []
      };
      await this.store.createState(state);
      return state;
    });
  }

  async update(pluginId: string, version?: string, actor = "user"): Promise<InstalledPluginState> {
    return this.store.runExclusive(pluginId, async () => {
      const state = await this.#requiredState(pluginId);
      if (state.pendingUpdate) {
        throw new PluginRuntimeError("UPDATE_ALREADY_PENDING", "Resolve the pending update first");
      }
      const registrySnapshot = await this.#verifiedRegistryBundle(pluginId, version);
      if (registrySnapshot.manifest.version === state.activeVersion) return state;
      if (compareVersions(registrySnapshot.manifest.version, state.activeVersion) <= 0) {
        throw new PluginRuntimeError("DOWNGRADE_REJECTED", "Plugin downgrades are not supported");
      }
      const registryIdentity = await verifiedPluginBundleIdentity(
        registrySnapshot,
        this.#trustStore,
        this.#policy
      );
      if (registryIdentity.signerFingerprint !== state.signerFingerprint) {
        throw new PluginRuntimeError(
          "SIGNER_CONTINUITY_VIOLATION",
          `Signer rotation for ${pluginId} requires a separately authenticated key-rotation workflow`
        );
      }
      const snapshot = await this.#stageAndVerify(registrySnapshot);
      const permissionDiff = diffPluginPermissions(state.permissions, snapshot.manifest.permissions);
      const installedVersions = [...new Set([...state.installedVersions, snapshot.manifest.version])];
      if (permissionDiff.added.length > 0) {
        const needsReview: InstalledPluginState = {
          ...state,
          revision: state.revision + 1,
          status: "needs_review",
          installedVersions,
          pendingUpdate: {
            version: snapshot.manifest.version,
            targetIntegrity: snapshot.manifest.integrity,
            permissionDiff,
            requestedAt: new Date().toISOString(),
            previousStatus: state.status === "disabled" ? "disabled" : "active"
          },
          lifecycle: [
            ...state.lifecycle,
            {
              event: "update_needs_review",
              at: new Date().toISOString(),
              fromVersion: state.activeVersion,
              toVersion: snapshot.manifest.version,
              actor,
              details: { addedPermissions: permissionDiff.added }
            }
          ]
        };
        await this.store.compareAndSwapState(state.revision, needsReview);
        return needsReview;
      }
      return this.#activateUpdate(state, snapshot, installedVersions, "updated", actor);
    });
  }

  async approvePendingUpdate(
    pluginId: string,
    rawReceipt: PluginApprovalReceipt
  ): Promise<InstalledPluginState> {
    return this.store.runExclusive(pluginId, async () => {
      const state = await this.#requiredState(pluginId);
      if (!state.pendingUpdate) {
        throw new PluginRuntimeError("NO_PENDING_UPDATE", "Plugin has no pending permission review");
      }
      if (!this.#approvalVerifier) {
        throw new PluginRuntimeError(
          "APPROVAL_VERIFIER_REQUIRED",
          "Update activation is blocked until an authenticated approval receipt verifier is configured"
        );
      }
      const receipt = PluginApprovalReceiptSchema.parse(rawReceipt);
      const expectation: PluginApprovalExpectation = {
        installationId: state.installationId,
        stateRevision: state.revision,
        pluginId,
        version: state.pendingUpdate.version,
        targetIntegrity: state.pendingUpdate.targetIntegrity,
        addedPermissionKeys: [...state.pendingUpdate.permissionDiff.added].sort()
      };
      const receiptPermissions = [...new Set(receipt.approvedPermissionKeys)].sort();
      if (
        receipt.installationId !== expectation.installationId ||
        receipt.stateRevision !== expectation.stateRevision ||
        receipt.pluginId !== expectation.pluginId ||
        receipt.version !== expectation.version ||
        receipt.targetIntegrity !== expectation.targetIntegrity ||
        receiptPermissions.length !== expectation.addedPermissionKeys.length ||
        receiptPermissions.some(
          (permission, index) => permission !== expectation.addedPermissionKeys[index]
        )
      ) {
        throw new PluginRuntimeError(
          "APPROVAL_RECEIPT_MISMATCH",
          "Approval receipt does not exactly match the pending update"
        );
      }
      if (!(await this.#approvalVerifier.verify(receipt, expectation))) {
        throw new PluginRuntimeError(
          "APPROVAL_RECEIPT_INVALID",
          "Approval receipt could not be authenticated"
        );
      }
      const snapshot = await this.#verifiedStagedBundle(
        pluginId,
        state.pendingUpdate.version,
        state.pendingUpdate.targetIntegrity,
        state.signerFingerprint
      );
      return this.#activateUpdate(
        state,
        snapshot,
        state.installedVersions,
        "update_approved",
        receipt.actor,
        state.pendingUpdate.previousStatus,
        {
          approvalReceiptId: receipt.receiptId,
          approvalReceiptAt: receipt.approvedAt
        },
        receipt
      );
    });
  }

  async disable(pluginId: string, actor = "user"): Promise<InstalledPluginState> {
    return this.store.runExclusive(pluginId, async () => {
      const state = await this.#requiredState(pluginId);
      if (state.status === "disabled") return state;
      const next: InstalledPluginState = {
        ...state,
        revision: state.revision + 1,
        status: "disabled",
        ...(state.pendingUpdate
          ? {
              pendingUpdate: {
                ...state.pendingUpdate,
                previousStatus: "disabled" as const
              }
            }
          : {}),
        lifecycle: [
          ...state.lifecycle,
          { event: "disabled", at: new Date().toISOString(), actor }
        ]
      };
      await this.store.compareAndSwapState(state.revision, next);
      return next;
    });
  }

  async enable(pluginId: string, actor = "user"): Promise<InstalledPluginState> {
    return this.store.runExclusive(pluginId, async () => {
      const state = await this.#requiredState(pluginId);
      if (state.pendingUpdate || state.status === "needs_review") {
        throw new PluginRuntimeError("REVIEW_REQUIRED", "Review the pending update before enabling");
      }
      if (state.status === "active") return state;
      const next: InstalledPluginState = {
        ...state,
        revision: state.revision + 1,
        status: "active",
        lifecycle: [...state.lifecycle, { event: "enabled", at: new Date().toISOString(), actor }]
      };
      await this.store.compareAndSwapState(state.revision, next);
      return next;
    });
  }

  async uninstall(pluginId: string): Promise<void> {
    await this.store.runExclusive(pluginId, async () => {
      const state = await this.#requiredState(pluginId);
      const reconciliation = await this.store.getReconciliationStatus(pluginId);
      if (reconciliation.active) {
        throw new PluginRuntimeError(
          "RECONCILIATION_REQUIRED",
          `Reconcile ${pluginId}'s unresolved mutation before uninstalling`,
          {
            reconciliationRequired: true,
            invocationId: reconciliation.active.invocationId,
            idempotencyKeys: reconciliation.records
              .filter(
                (record) =>
                  record.invocationId === reconciliation.active!.invocationId
              )
              .map((record) => record.idempotencyKey)
          }
        );
      }
      await this.store.uninstall(pluginId, state);
    });
  }

  async executeTool(
    pluginId: string,
    tool: string,
    input: unknown,
    broker: CapabilityBroker,
    options?: number | PluginInvocationOptions
  ): Promise<unknown> {
    const state = await this.#requiredState(pluginId);
    if (state.status !== "active") {
      throw new PluginRuntimeError("PLUGIN_INACTIVE", `${pluginId} is ${state.status}`);
    }
    const snapshot = await loadPluginBundle(this.store.bundlePath(pluginId, state.activeVersion));
    if (
      snapshot.manifest.id !== pluginId ||
      snapshot.manifest.version !== state.activeVersion ||
      snapshot.manifest.integrity !== state.activeIntegrity ||
      (snapshot.manifest.signature?.keyId ?? null) !== state.signerKeyId
    ) {
      throw new PluginRuntimeError(
        "ACTIVE_BUNDLE_MISMATCH",
        `${pluginId} active bundle no longer matches its installed state`
      );
    }
    const identity = await verifiedPluginBundleIdentity(
      snapshot,
      this.#trustStore,
      this.#policy
    );
    if (
      identity.integrity !== state.activeIntegrity ||
      identity.signerFingerprint !== state.signerFingerprint
    ) {
      throw new PluginRuntimeError(
        "ACTIVE_BUNDLE_MISMATCH",
        `${pluginId} active bundle signer or integrity pin changed`
      );
    }
    const declaration = snapshot.manifest.tools.find(
      (candidate) => candidate.name === tool
    );
    if (declaration && !declaration.readOnly) {
      const reconciliation = await this.store.getReconciliationStatus(pluginId);
      if (reconciliation.active) {
        throw new PluginRuntimeError(
          "RECONCILIATION_REQUIRED",
          `${pluginId} has an unresolved mutation; reconcile it before another mutable invocation`,
          {
            retryable: false,
            reconciliationRequired: true,
            invocationId: reconciliation.active.invocationId,
            idempotencyKeys: reconciliation.records
              .filter(
                (record) =>
                  record.invocationId === reconciliation.active!.invocationId
              )
              .map((record) => record.idempotencyKey)
          }
        );
      }
    }
    const invocationOptions =
      typeof options === "number" ? { timeoutMs: options } : { ...(options ?? {}) };
    return this.supervisor.executeTool(snapshot, tool, input, broker, {
      ...invocationOptions,
      expectedIntegrity: state.activeIntegrity,
      reconciliationLedger: this.store
    });
  }

  async reconciliationStatus(
    pluginId: string
  ): Promise<PluginReconciliationStatus> {
    await this.#requiredState(pluginId);
    return this.store.getReconciliationStatus(pluginId);
  }

  async reconcileMutation(
    pluginId: string,
    input: ReconcilePluginMutationInput
  ): Promise<PluginReconciliationStatus> {
    await this.#requiredState(pluginId);
    return this.store.reconcilePluginMutation(pluginId, input);
  }

  async #verifiedRegistryBundle(pluginId: string, version?: string): Promise<PluginBundleSnapshot> {
    const entry = this.registry.resolve(pluginId, version);
    const snapshot = await loadPluginBundle(entry.bundlePath);
    await verifyPluginBundle(snapshot, this.#trustStore, this.#policy);
    return snapshot;
  }

  async #stageAndVerify(snapshot: PluginBundleSnapshot): Promise<PluginBundleSnapshot> {
    const sourceIdentity = await verifiedPluginBundleIdentity(
      snapshot,
      this.#trustStore,
      this.#policy
    );
    await this.store.stageVersion(snapshot);
    return this.#verifiedStagedBundle(
      snapshot.manifest.id,
      snapshot.manifest.version,
      sourceIdentity.integrity,
      sourceIdentity.signerFingerprint
    );
  }

  async #verifiedStagedBundle(
    pluginId: string,
    version: string,
    expectedIntegrity: string,
    expectedSignerFingerprint: string | null
  ): Promise<PluginBundleSnapshot> {
    const snapshot = await loadPluginBundle(this.store.bundlePath(pluginId, version));
    if (
      snapshot.manifest.id !== pluginId ||
      snapshot.manifest.version !== version ||
      snapshot.manifest.integrity !== expectedIntegrity
    ) {
      throw new PluginRuntimeError(
        "STAGED_BUNDLE_MISMATCH",
        `Staged ${pluginId}@${version} does not match the verified source bundle`
      );
    }
    const identity = await verifiedPluginBundleIdentity(
      snapshot,
      this.#trustStore,
      this.#policy
    );
    if (
      identity.integrity !== expectedIntegrity ||
      identity.signerFingerprint !== expectedSignerFingerprint
    ) {
      throw new PluginRuntimeError(
        "STAGED_BUNDLE_MISMATCH",
        `Staged ${pluginId}@${version} signer does not match the verified source bundle`
      );
    }
    return snapshot;
  }

  async #requiredState(pluginId: string): Promise<InstalledPluginState> {
    const state = await this.store.getState(pluginId);
    if (!state) throw new PluginRuntimeError("NOT_INSTALLED", `${pluginId} is not installed`);
    return state;
  }

  async #activateUpdate(
    state: InstalledPluginState,
    snapshot: PluginBundleSnapshot,
    installedVersions: string[],
    event: "updated" | "update_approved",
    actor: string,
    targetStatus: "active" | "disabled" = state.status === "disabled" ? "disabled" : "active",
    lifecycleDetails?: Record<string, unknown>,
    approvalReceipt?: PluginApprovalReceipt
  ): Promise<InstalledPluginState> {
    let activationSnapshot = await this.#verifiedStagedBundle(
      state.pluginId,
      snapshot.manifest.version,
      snapshot.manifest.integrity,
      state.signerFingerprint
    );
    let activationIdentity = await verifiedPluginBundleIdentity(
      activationSnapshot,
      this.#trustStore,
      this.#policy
    );
    if (activationIdentity.signerFingerprint !== state.signerFingerprint) {
      throw new PluginRuntimeError(
        "SIGNER_CONTINUITY_VIOLATION",
        `Staged signer for ${state.pluginId} changed before activation`
      );
    }
    const migrationRecords: MigrationRecord[] = [];
    let dataRevision = state.dataRevision;
    if (activationSnapshot.manifest.dataVersion < state.dataVersion) {
      throw new PluginRuntimeError("DATA_DOWNGRADE_REJECTED", "Update cannot lower plugin dataVersion");
    }
    if (activationSnapshot.manifest.dataVersion > state.dataVersion) {
      const data = await TransactionalPluginData.load(
        this.store.dataPath(state.pluginId, state.dataRevision)
      );
      let current = state.dataVersion;
      while (current < activationSnapshot.manifest.dataVersion) {
        const migration = activationSnapshot.manifest.migrations.find(
          (candidate) => candidate.from === current
        );
        if (!migration) {
          throw new PluginRuntimeError(
            "MIGRATION_MISSING",
            `Missing migration from data version ${current}`
          );
        }
        await this.supervisor.executeMigration(
          activationSnapshot,
          migration.entry,
          { from: migration.from, to: migration.to },
          data.broker(),
          { expectedIntegrity: activationSnapshot.manifest.integrity }
        );
        migrationRecords.push({
          from: migration.from,
          to: migration.to,
          at: new Date().toISOString(),
          status: "completed"
        });
        current = migration.to;
      }
      dataRevision = randomUUID();
      await data.commit(this.store.dataPath(state.pluginId, dataRevision));
    }
    activationSnapshot = await this.#verifiedStagedBundle(
      state.pluginId,
      activationSnapshot.manifest.version,
      activationSnapshot.manifest.integrity,
      state.signerFingerprint
    );
    activationIdentity = await verifiedPluginBundleIdentity(
      activationSnapshot,
      this.#trustStore,
      this.#policy
    );
    if (activationIdentity.signerFingerprint !== state.signerFingerprint) {
      throw new PluginRuntimeError(
        "SIGNER_CONTINUITY_VIOLATION",
        `Staged signer for ${state.pluginId} changed before activation`
      );
    }
    const next: InstalledPluginState = {
      ...state,
      revision: state.revision + 1,
      status: targetStatus,
      activeVersion: activationSnapshot.manifest.version,
      installedVersions,
      permissions: activationSnapshot.manifest.permissions,
      dataVersion: activationSnapshot.manifest.dataVersion,
      dataRevision,
      activeIntegrity: activationIdentity.integrity,
      signerKeyId: activationSnapshot.manifest.signature?.keyId ?? null,
      signerFingerprint: activationIdentity.signerFingerprint,
      lifecycle: [
        ...state.lifecycle,
        {
          event,
          at: new Date().toISOString(),
          fromVersion: state.activeVersion,
          toVersion: activationSnapshot.manifest.version,
          actor,
          ...(lifecycleDetails ? { details: lifecycleDetails } : {})
        }
      ],
      migrations: [...state.migrations, ...migrationRecords]
    };
    delete next.pendingUpdate;
    if (approvalReceipt) {
      await this.store.consumeApprovalReceipt(approvalReceipt);
    }
    await this.store.compareAndSwapState(state.revision, next);
    return next;
  }
}
