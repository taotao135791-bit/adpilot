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
  Artifact,
  Goal,
  Project,
  TaskNode,
  type Artifact as ArtifactValue,
  type ArtifactStatus,
  type ArtifactType,
  type Goal as GoalValue,
  type GoalStatus,
  type Project as ProjectValue,
  type ProjectStatus,
  type TaskNode as TaskNodeValue,
  type TaskNodeStatus
} from "./entities.js";

/**
 * Persistence contract shared by every kernel entity store.
 *
 * Concurrency semantics are whole-document, last-writer-wins: each `save` is
 * an atomic temp-file-plus-rename replace of `<id>.json`, so concurrent saves
 * of the same id never interleave or corrupt the file — the record observed
 * afterwards is always one complete, schema-valid document written by one of
 * the racing callers (not necessarily the highest revision). Callers needing
 * optimistic concurrency must read, bump `revision`, and reconcile themselves.
 */
export interface KernelEntityStore<T, F> {
  save(value: T): Promise<void>;
  get(id: string): Promise<T | undefined>;
  list(filter?: F): Promise<T[]>;
  /** Returns true when a record existed and was removed. */
  delete(id: string): Promise<boolean>;
}

export type ProjectFilter = {
  workspaceId?: string;
  status?: ProjectStatus;
};

export type GoalFilter = {
  projectId?: string;
  status?: GoalStatus;
};

export type TaskNodeFilter = {
  goalId?: string;
  parentId?: string;
  status?: TaskNodeStatus;
};

export type ArtifactFilter = {
  projectId?: string;
  sessionId?: string;
  type?: ArtifactType;
  status?: ArtifactStatus;
};

export type ProjectStore = KernelEntityStore<ProjectValue, ProjectFilter>;
export type GoalStore = KernelEntityStore<GoalValue, GoalFilter>;
export type TaskGraphStore = KernelEntityStore<TaskNodeValue, TaskNodeFilter>;
export type ArtifactStore = KernelEntityStore<ArtifactValue, ArtifactFilter>;

interface EntitySchema<T> {
  parse(value: unknown): T;
}

/**
 * Private, atomic per-entity JSON store. Layout:
 *
 *   <root>/.adpilot/kernel/<entityDirectory>/<id>.json
 *
 * Mirrors the FileStore discipline from packages/computer-use: directories are
 * created 0o700, record files 0o600, writes go through a private temporary
 * file plus rename, and symlinked roots, directories, or record targets fail
 * closed. Records are re-parsed through their zod schema on every read.
 */
abstract class FileEntityStore<T extends { id: string; createdAt: string }, F>
  implements KernelEntityStore<T, F>
{
  readonly root: string;
  readonly directory: string;

  protected constructor(
    root: string,
    private readonly entityDirectory: string,
    private readonly schema: EntitySchema<T>
  ) {
    if (!root) throw new Error("kernel store root is required");
    this.root = resolve(root);
    this.directory = resolve(this.root, ".adpilot", "kernel", entityDirectory);
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
      throw new Error(`kernel ${this.entityDirectory} store root must not be a symlink`);
    }
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`kernel ${this.entityDirectory} directory must be a real private directory, not a symlink`);
    }
    await chmod(this.directory, 0o700);
  }

  private pathFor(id: string): string {
    assertSafeIdentifier(id, `kernel ${this.entityDirectory} id`);
    const path = resolve(join(this.directory, `${id}.json`));
    if (!path.startsWith(`${this.directory}/`)) {
      throw new Error(`kernel ${this.entityDirectory} record path escaped its store`);
    }
    return path;
  }

  private pathForTemporary(id: string): string {
    assertSafeIdentifier(id, `kernel ${this.entityDirectory} id`);
    const path = resolve(join(this.directory, `.${id}.${process.pid}.${randomUUID()}.tmp`));
    if (!path.startsWith(`${this.directory}/`)) {
      throw new Error(`kernel ${this.entityDirectory} temporary path escaped its store`);
    }
    return path;
  }
}

async function assertNotSymlink(path: string, entity: string, allowMissing: boolean): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`kernel ${entity} record path must not be a symlink`);
    if (!metadata.isFile()) throw new Error(`kernel ${entity} record path must be a regular file`);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

const defaultRoot = (): string => resolve(process.cwd(), "workspace");

export class FileProjectStore extends FileEntityStore<ProjectValue, ProjectFilter> implements ProjectStore {
  constructor(root: string = defaultRoot()) {
    super(root, "projects", Project);
  }

  protected matches(value: ProjectValue, filter: ProjectFilter): boolean {
    return (!filter.workspaceId || value.workspaceId === filter.workspaceId)
      && (!filter.status || value.status === filter.status);
  }
}

export class FileGoalStore extends FileEntityStore<GoalValue, GoalFilter> implements GoalStore {
  constructor(root: string = defaultRoot()) {
    super(root, "goals", Goal);
  }

  protected matches(value: GoalValue, filter: GoalFilter): boolean {
    return (!filter.projectId || value.projectId === filter.projectId)
      && (!filter.status || value.status === filter.status);
  }
}

export class FileTaskGraphStore extends FileEntityStore<TaskNodeValue, TaskNodeFilter> implements TaskGraphStore {
  constructor(root: string = defaultRoot()) {
    super(root, "tasks", TaskNode);
  }

  protected matches(value: TaskNodeValue, filter: TaskNodeFilter): boolean {
    return (!filter.goalId || value.goalId === filter.goalId)
      && (!filter.parentId || value.parentId === filter.parentId)
      && (!filter.status || value.status === filter.status);
  }
}

export class FileArtifactStore extends FileEntityStore<ArtifactValue, ArtifactFilter> implements ArtifactStore {
  constructor(root: string = defaultRoot()) {
    super(root, "artifacts", Artifact);
  }

  protected matches(value: ArtifactValue, filter: ArtifactFilter): boolean {
    return (!filter.projectId || value.projectId === filter.projectId)
      && (!filter.sessionId || value.sessionId === filter.sessionId)
      && (!filter.type || value.type === filter.type)
      && (!filter.status || value.status === filter.status);
  }
}
