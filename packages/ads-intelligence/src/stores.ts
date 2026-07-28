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
