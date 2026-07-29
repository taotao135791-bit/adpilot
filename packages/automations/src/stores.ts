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
  AppNotification,
  Automation,
  AutomationRun,
  type AppNotification as AppNotificationValue,
  type Automation as AutomationValue,
  type AutomationRun as AutomationRunValue,
  type AutomationRunStatus,
  type AutomationState
} from "./entities.js";

/**
 * Persistence contract for the automation stores — same shape as the kernel
 * entity stores: whole-document, last-writer-wins, atomic temp-file + rename.
 */
export interface AutomationEntityStore<T, F> {
  save(value: T): Promise<void>;
  get(id: string): Promise<T | undefined>;
  list(filter?: F): Promise<T[]>;
  /** Returns true when a record existed and was removed. */
  delete(id: string): Promise<boolean>;
}

export type AutomationFilter = {
  workspaceId?: string;
  projectId?: string;
  state?: AutomationState;
};

export type AutomationRunFilter = {
  automationId?: string;
  idempotencyKey?: string;
  status?: AutomationRunStatus;
};

export type NotificationFilter = {
  workspaceId?: string;
  unread?: boolean;
};

export type AutomationStore = AutomationEntityStore<AutomationValue, AutomationFilter>;
export type AutomationRunStore = AutomationEntityStore<AutomationRunValue, AutomationRunFilter>;
export type NotificationStore = AutomationEntityStore<AppNotificationValue, NotificationFilter>;

interface EntitySchema<T> {
  parse(value: unknown): T;
}

/**
 * Private, atomic per-entity JSON store. Layout:
 *
 *   <root>/.adpilot/<entityDirectory>/<id>.json
 *
 * Mirrors the kernel FileStore discipline: directories are created 0o700,
 * record files 0o600, writes go through a private temporary file plus rename,
 * and symlinked roots, directories, or record targets fail closed. Records
 * are re-parsed through their zod schema on every read.
 */
abstract class FileEntityStore<T extends { id: string; createdAt: string }, F>
  implements AutomationEntityStore<T, F>
{
  readonly root: string;
  readonly directory: string;

  protected constructor(
    root: string,
    private readonly entityDirectory: string,
    private readonly schema: EntitySchema<T>
  ) {
    if (!root) throw new Error("automations store root is required");
    this.root = resolve(root);
    this.directory = resolve(this.root, ".adpilot", entityDirectory);
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
      throw new Error(`automations ${this.entityDirectory} store root must not be a symlink`);
    }
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`automations ${this.entityDirectory} directory must be a real private directory, not a symlink`);
    }
    await chmod(this.directory, 0o700);
  }

  private pathFor(id: string): string {
    assertSafeIdentifier(id, `automations ${this.entityDirectory} id`);
    const path = resolve(join(this.directory, `${id}.json`));
    if (!path.startsWith(`${this.directory}/`)) {
      throw new Error(`automations ${this.entityDirectory} record path escaped its store`);
    }
    return path;
  }

  private pathForTemporary(id: string): string {
    assertSafeIdentifier(id, `automations ${this.entityDirectory} id`);
    const path = resolve(join(this.directory, `.${id}.${process.pid}.${randomUUID()}.tmp`));
    if (!path.startsWith(`${this.directory}/`)) {
      throw new Error(`automations ${this.entityDirectory} temporary path escaped its store`);
    }
    return path;
  }
}

async function assertNotSymlink(path: string, entity: string, allowMissing: boolean): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`automations ${entity} record path must not be a symlink`);
    if (!metadata.isFile()) throw new Error(`automations ${entity} record path must be a regular file`);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

const defaultRoot = (): string => resolve(process.cwd(), "workspace");

export class FileAutomationStore extends FileEntityStore<AutomationValue, AutomationFilter> implements AutomationStore {
  constructor(root: string = defaultRoot()) {
    super(root, "automations", Automation);
  }

  protected matches(value: AutomationValue, filter: AutomationFilter): boolean {
    return (!filter.workspaceId || value.workspaceId === filter.workspaceId)
      && (!filter.projectId || value.projectId === filter.projectId)
      && (!filter.state || value.state === filter.state);
  }
}

export class FileAutomationRunStore extends FileEntityStore<AutomationRunValue, AutomationRunFilter> implements AutomationRunStore {
  constructor(root: string = defaultRoot()) {
    super(root, "automation-runs", AutomationRun);
  }

  protected matches(value: AutomationRunValue, filter: AutomationRunFilter): boolean {
    return (!filter.automationId || value.automationId === filter.automationId)
      && (!filter.idempotencyKey || value.idempotencyKey === filter.idempotencyKey)
      && (!filter.status || value.status === filter.status);
  }
}

export class FileNotificationStore extends FileEntityStore<AppNotificationValue, NotificationFilter> implements NotificationStore {
  constructor(root: string = defaultRoot()) {
    super(root, "notifications", AppNotification);
  }

  protected matches(value: AppNotificationValue, filter: NotificationFilter): boolean {
    return (!filter.workspaceId || value.workspaceId === filter.workspaceId)
      && (filter.unread === undefined || value.read === !filter.unread);
  }
}
