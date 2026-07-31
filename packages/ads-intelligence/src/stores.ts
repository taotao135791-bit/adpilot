import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertSafeIdentifier } from "@adpilot/shared";
import {
  AdAccount,
  AdvertisingDecision,
  CampaignEntity,
  CreativeAsset,
  type AdAccount as AdAccountValue,
  type AdPlatform,
  type AdvertisingDecision as AdvertisingDecisionValue,
  type CampaignEntity as CampaignEntityValue,
  type CreativeAsset as CreativeAssetValue,
  type CreativeLifecycle,
  type DecisionStatus
} from "./entities.js";
import { AdsIntelligenceError } from "./errors.js";

/**
 * Persistence contract shared by every ads-intelligence entity store.
 *
 * Concurrency semantics are whole-document, last-writer-wins: each `save` is
 * an atomic temp-file-plus-rename replace of `<id>.json`, so concurrent saves
 * of the same id never interleave or corrupt the file. Callers needing
 * optimistic concurrency must read, bump `revision`, and reconcile themselves.
 */
export interface AdsEntityStore<T, F> {
  save(value: T): Promise<void>;
  get(id: string): Promise<T | undefined>;
  list(filter?: F): Promise<T[]>;
  /** Returns true when a record existed and was removed. */
  delete(id: string): Promise<boolean>;
}

export type AdAccountFilter = {
  workspaceId?: string;
  platform?: AdPlatform;
};

export type CampaignFilter = {
  accountId?: string;
};

export type AdvertisingDecisionFilter = {
  projectId?: string;
  campaignId?: string;
  status?: DecisionStatus;
};

export type CreativeAssetFilter = {
  accountId?: string;
  lifecycle?: CreativeLifecycle;
};

export type AdAccountStore = AdsEntityStore<AdAccountValue, AdAccountFilter>;
export type CampaignStore = AdsEntityStore<CampaignEntityValue, CampaignFilter>;
export type AdvertisingDecisionStore = AdsEntityStore<AdvertisingDecisionValue, AdvertisingDecisionFilter>;
export type CreativeAssetStore = AdsEntityStore<CreativeAssetValue, CreativeAssetFilter>;

export interface WorkspaceCampaignStores {
  accounts: AdAccountStore;
  campaigns: CampaignStore;
}

export interface WorkspaceCreativeStores {
  accounts: AdAccountStore;
  creatives: CreativeAssetStore;
}

export interface WorkspaceAdsStores extends WorkspaceCampaignStores, WorkspaceCreativeStores {}

export interface WorkspaceAdsSnapshot {
  accounts: AdAccountValue[];
  campaigns: CampaignEntityValue[];
  creatives: CreativeAssetValue[];
}

interface EntitySchema<T> {
  parse(value: unknown): T;
}

/**
 * Private, atomic per-entity JSON store. Layout:
 *
 *   <root>/.adpilot/ads/<entityDirectory>/<id>.json
 *
 * Mirrors the kernel FileEntityStore discipline: directories are created
 * 0o700, record files 0o600, writes go through a private temporary file plus
 * rename, and symlinked roots, directories, or record targets fail closed.
 * Records are re-parsed through their zod schema on every read.
 */
abstract class FileEntityStore<T extends { id: string; createdAt: string }, F>
  implements AdsEntityStore<T, F>
{
  readonly root: string;
  readonly directory: string;

  protected constructor(
    root: string,
    private readonly entityDirectory: string,
    private readonly schema: EntitySchema<T>
  ) {
    if (!root) throw new Error("ads-intelligence store root is required");
    this.root = resolve(root);
    this.directory = resolve(this.root, ".adpilot", "ads", entityDirectory);
  }

  async save(value: T): Promise<void> {
    const parsed = this.schema.parse(value);
    await this.ensureSafeDirectory();
    const target = this.pathFor(parsed.id);
    await assertNotSymlink(target, this.entityDirectory, true);
    const temporary = this.pathForTemporary(parsed.id);
    try {
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async get(id: string): Promise<T | undefined> {
    await this.ensureSafeDirectory();
    const target = this.pathFor(id);
    try {
      await assertNotSymlink(target, this.entityDirectory, false);
      const contents = await readFile(target, "utf8");
      return this.schema.parse(JSON.parse(contents));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(filter?: F): Promise<T[]> {
    await this.ensureSafeDirectory();
    const records: T[] = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const record = await this.get(name.slice(0, -".json".length));
      if (record) records.push(record);
    }
    records.sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
    return filter ? records.filter((record) => this.matches(record, filter)) : records;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureSafeDirectory();
    const target = this.pathFor(id);
    try {
      await assertNotSymlink(target, this.entityDirectory, false);
      await rm(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  protected abstract matches(value: T, filter: F): boolean;

  private async ensureSafeDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const rootMetadata = await lstat(this.root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new Error(`ads-intelligence ${this.entityDirectory} store root must not be a symlink`);
    }
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`ads-intelligence ${this.entityDirectory} directory must be a real private directory, not a symlink`);
    }
    await chmod(this.directory, 0o700);
  }

  private pathFor(id: string): string {
    assertSafeIdentifier(id, `ads-intelligence ${this.entityDirectory} id`);
    const path = resolve(join(this.directory, `${id}.json`));
    if (!path.startsWith(`${this.directory}/`)) {
      throw new Error(`ads-intelligence ${this.entityDirectory} record path escaped its store`);
    }
    return path;
  }

  private pathForTemporary(id: string): string {
    assertSafeIdentifier(id, `ads-intelligence ${this.entityDirectory} id`);
    const path = resolve(join(this.directory, `.${id}.${process.pid}.${randomUUID()}.tmp`));
    if (!path.startsWith(`${this.directory}/`)) {
      throw new Error(`ads-intelligence ${this.entityDirectory} temporary path escaped its store`);
    }
    return path;
  }
}

async function assertNotSymlink(path: string, entity: string, allowMissing: boolean): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`ads-intelligence ${entity} record path must not be a symlink`);
    if (!metadata.isFile()) throw new Error(`ads-intelligence ${entity} record path must be a regular file`);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

const defaultRoot = (): string => resolve(process.cwd(), "workspace");

export class FileAdAccountStore extends FileEntityStore<AdAccountValue, AdAccountFilter> implements AdAccountStore {
  constructor(root: string = defaultRoot()) {
    super(root, "accounts", AdAccount);
  }

  protected matches(value: AdAccountValue, filter: AdAccountFilter): boolean {
    return (!filter.workspaceId || value.workspaceId === filter.workspaceId)
      && (!filter.platform || value.platform === filter.platform);
  }
}

export class FileCampaignStore extends FileEntityStore<CampaignEntityValue, CampaignFilter> implements CampaignStore {
  constructor(root: string = defaultRoot()) {
    super(root, "campaigns", CampaignEntity);
  }

  protected matches(value: CampaignEntityValue, filter: CampaignFilter): boolean {
    return !filter.accountId || value.accountId === filter.accountId;
  }
}

export class FileAdvertisingDecisionStore
  extends FileEntityStore<AdvertisingDecisionValue, AdvertisingDecisionFilter>
  implements AdvertisingDecisionStore
{
  constructor(root: string = defaultRoot()) {
    super(root, "decisions", AdvertisingDecision);
  }

  protected matches(value: AdvertisingDecisionValue, filter: AdvertisingDecisionFilter): boolean {
    return (!filter.projectId || value.projectId === filter.projectId)
      && (!filter.campaignId || value.campaignId === filter.campaignId)
      && (!filter.status || value.status === filter.status);
  }
}

export class FileCreativeAssetStore extends FileEntityStore<CreativeAssetValue, CreativeAssetFilter> implements CreativeAssetStore {
  constructor(root: string = defaultRoot()) {
    super(root, "creatives", CreativeAsset);
  }

  protected matches(value: CreativeAssetValue, filter: CreativeAssetFilter): boolean {
    return (!filter.accountId || value.accountId === filter.accountId)
      && (!filter.lifecycle || value.lifecycle === filter.lifecycle);
  }
}

/**
 * Workspace-safe accessors for the legacy flat ads registry.
 *
 * Campaign and Creative JSON predates an explicit workspaceId. Rewriting those
 * files at read time would make a security fix destructive and race-prone, so
 * ownership is migrated logically instead: the referenced AdAccount is the
 * canonical owner. Existing valid records remain readable without an on-disk
 * migration; orphaned or cross-workspace references fail closed.
 */
export async function listAdAccountsForWorkspace(
  store: AdAccountStore,
  workspaceId: string
): Promise<AdAccountValue[]> {
  assertWorkspaceId(workspaceId);
  const accounts = await store.list({ workspaceId });
  for (const account of accounts) {
    if (account.workspaceId !== workspaceId) {
      throw scopeIntegrityError("account store returned a record outside the requested workspace");
    }
  }
  return accounts;
}

export async function requireAdAccountForWorkspace(
  store: AdAccountStore,
  workspaceId: string,
  accountId: string
): Promise<AdAccountValue> {
  assertWorkspaceId(workspaceId);
  const account = await store.get(accountId);
  if (!account || account.workspaceId !== workspaceId) {
    throw new AdsIntelligenceError(
      `ad account not found in workspace: ${accountId}`,
      "AD_ACCOUNT_NOT_FOUND"
    );
  }
  return account;
}

export async function listCampaignsForWorkspace(
  stores: WorkspaceCampaignStores,
  workspaceId: string,
  accountId?: string
): Promise<CampaignEntityValue[]> {
  const accounts = accountId !== undefined
    ? [await requireAdAccountForWorkspace(stores.accounts, workspaceId, accountId)]
    : await listAdAccountsForWorkspace(stores.accounts, workspaceId);
  const campaigns = await Promise.all(accounts.map(async (account) => {
    const records = await stores.campaigns.list({ accountId: account.id });
    for (const campaign of records) {
      if (campaign.accountId !== account.id) {
        throw scopeIntegrityError("campaign store returned a record outside the requested account");
      }
    }
    return records;
  }));
  return stableUnique(campaigns.flat());
}

export async function requireCampaignForWorkspace(
  stores: WorkspaceCampaignStores,
  workspaceId: string,
  campaignId: string
): Promise<CampaignEntityValue> {
  assertWorkspaceId(workspaceId);
  const campaign = await stores.campaigns.get(campaignId);
  if (!campaign) {
    throw new AdsIntelligenceError(
      `campaign not found in workspace: ${campaignId}`,
      "CAMPAIGN_NOT_FOUND"
    );
  }
  const account = await stores.accounts.get(campaign.accountId);
  if (!account || account.workspaceId !== workspaceId) {
    // Do not reveal whether the campaign exists in another workspace.
    throw new AdsIntelligenceError(
      `campaign not found in workspace: ${campaignId}`,
      "CAMPAIGN_NOT_FOUND"
    );
  }
  return campaign;
}

export async function listCreativesForWorkspace(
  stores: WorkspaceCreativeStores,
  workspaceId: string
): Promise<CreativeAssetValue[]> {
  const accounts = await listAdAccountsForWorkspace(stores.accounts, workspaceId);
  const creatives = await Promise.all(accounts.map(async (account) => {
    const records = await stores.creatives.list({ accountId: account.id });
    for (const creative of records) {
      if (creative.accountId !== account.id) {
        throw scopeIntegrityError("creative store returned a record outside the requested account");
      }
    }
    return records;
  }));
  return stableUnique(creatives.flat());
}

export async function requireCreativeForWorkspace(
  stores: WorkspaceCreativeStores,
  workspaceId: string,
  creativeId: string
): Promise<CreativeAssetValue> {
  assertWorkspaceId(workspaceId);
  const creative = await stores.creatives.get(creativeId);
  if (!creative) {
    throw new AdsIntelligenceError(
      `creative not found in workspace: ${creativeId}`,
      "CREATIVE_NOT_FOUND"
    );
  }
  const account = await stores.accounts.get(creative.accountId);
  if (!account || account.workspaceId !== workspaceId) {
    throw new AdsIntelligenceError(
      `creative not found in workspace: ${creativeId}`,
      "CREATIVE_NOT_FOUND"
    );
  }
  return creative;
}

export async function loadWorkspaceAdsSnapshot(
  stores: WorkspaceAdsStores,
  workspaceId: string
): Promise<WorkspaceAdsSnapshot> {
  const accounts = await listAdAccountsForWorkspace(stores.accounts, workspaceId);
  const [campaigns, creatives] = await Promise.all([
    listCampaignsForOwnedAccounts(stores.campaigns, accounts),
    listCreativesForOwnedAccounts(stores.creatives, accounts)
  ]);
  const campaignIds = new Set(campaigns.map((campaign) => campaign.id));
  for (const creative of creatives) {
    if (creative.campaignIds.some((campaignId) => !campaignIds.has(campaignId))) {
      throw scopeIntegrityError(
        "creative record references a campaign outside the requested workspace"
      );
    }
  }
  return { accounts, campaigns, creatives };
}

async function listCampaignsForOwnedAccounts(
  store: CampaignStore,
  accounts: readonly AdAccountValue[]
): Promise<CampaignEntityValue[]> {
  const campaigns = await Promise.all(accounts.map(async (account) => {
    const records = await store.list({ accountId: account.id });
    for (const campaign of records) {
      if (campaign.accountId !== account.id) {
        throw scopeIntegrityError("campaign store returned a record outside the requested account");
      }
    }
    return records;
  }));
  return stableUnique(campaigns.flat());
}

async function listCreativesForOwnedAccounts(
  store: CreativeAssetStore,
  accounts: readonly AdAccountValue[]
): Promise<CreativeAssetValue[]> {
  const creatives = await Promise.all(accounts.map(async (account) => {
    const records = await store.list({ accountId: account.id });
    for (const creative of records) {
      if (creative.accountId !== account.id) {
        throw scopeIntegrityError("creative store returned a record outside the requested account");
      }
    }
    return records;
  }));
  return stableUnique(creatives.flat());
}

function stableUnique<T extends { id: string; createdAt: string }>(records: readonly T[]): T[] {
  const unique = [...new Map(records.map((record) => [record.id, record])).values()];
  return unique.sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}

function assertWorkspaceId(workspaceId: string): void {
  if (workspaceId.trim().length === 0) {
    throw new AdsIntelligenceError("workspace id is required", "ADS_WORKSPACE_REQUIRED");
  }
}

function scopeIntegrityError(message: string): AdsIntelligenceError {
  return new AdsIntelligenceError(message, "ADS_STORE_SCOPE_DENIED");
}
