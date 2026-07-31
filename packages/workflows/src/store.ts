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
  Workflow,
  WorkflowError,
  WorkflowRun,
  type Workflow as WorkflowValue,
  type WorkflowRun as WorkflowRunValue,
  type WorkflowStatus
} from "./model.js";

/**
 * Persistence contracts for workflows and their runs. Workflow definitions
 * retain whole-document saves. Run records use create + compare-and-swap:
 * transitions must name the revision they observed, and `cancelled` is an
 * immutable terminal state. File writes remain atomic via a private temporary
 * file plus rename.
 */
export interface WorkflowStore {
  save(workflow: WorkflowValue): Promise<void>;
  get(id: string): Promise<WorkflowValue | undefined>;
  list(filter?: WorkflowFilter): Promise<WorkflowValue[]>;
}

export interface WorkflowRunStore {
  /** Create revision 1. Refuses to replace an existing run. */
  create(run: WorkflowRunValue): Promise<void>;
  /**
   * Atomically replace exactly `expectedRevision` with the next revision.
   * A stale writer never wins, and no transition may leave `cancelled`.
   */
  compareAndSwap(run: WorkflowRunValue, expectedRevision: number): Promise<void>;
  get(id: string): Promise<WorkflowRunValue | undefined>;
  list(filter?: WorkflowRunFilter): Promise<WorkflowRunValue[]>;
}

export class WorkflowRunRevisionConflictError extends WorkflowError {
  constructor(
    readonly runId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `workflow run revision changed (${expectedRevision} -> ${actualRevision}): ${runId}`,
      "WORKFLOW_RUN_REVISION_CONFLICT"
    );
    this.name = "WorkflowRunRevisionConflictError";
  }
}

export class WorkflowRunTerminalStateError extends WorkflowError {
  constructor(
    readonly runId: string,
    readonly status: WorkflowRunValue["status"],
    readonly revision: number
  ) {
    super(
      `workflow run is in immutable terminal state ${status}: ${runId}`,
      "WORKFLOW_RUN_TERMINAL"
    );
    this.name = "WorkflowRunTerminalStateError";
  }
}

export type WorkflowFilter = {
  workspaceId?: string;
  status?: WorkflowStatus;
};

export type WorkflowRunFilter = {
  workspaceId?: string;
  workflowId?: string;
};

interface EntitySchema<T> {
  parse(value: unknown): T;
}

/**
 * Private, atomic per-entity JSON store. Layout:
 *
 *   <root>/.adpilot/workflows/<entityDirectory>/<id>.json
 *
 * Directories are created 0o700, record files 0o600, writes go through a
 * private temporary file plus rename, and symlinked roots, directories, or
 * record targets fail closed. Records are re-parsed through their zod schema
 * on every read.
 */
abstract class FileWorkflowEntityStore<T extends { id: string; createdAt: string }, F> {
  readonly root: string;
  readonly directory: string;

  protected constructor(
    root: string,
    private readonly entityDirectory: string,
    private readonly schema: EntitySchema<T>
  ) {
    if (!root) throw new Error("workflow store root is required");
    this.root = resolve(root);
    this.directory = resolve(this.root, ".adpilot", "workflows", entityDirectory);
  }

  protected async saveEntity(value: T): Promise<void> {
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

  protected abstract matches(value: T, filter: F): boolean;

  protected async ensureSafeDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const rootMetadata = await lstat(this.root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new Error(`workflow ${this.entityDirectory} store root must not be a symlink`);
    }
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`workflow ${this.entityDirectory} directory must be a real private directory, not a symlink`);
    }
    await chmod(this.directory, 0o700);
  }

  protected pathFor(id: string): string {
    assertSafeIdentifier(id, `workflow ${this.entityDirectory} id`);
    const path = resolve(join(this.directory, `${id}.json`));
    if (!path.startsWith(`${this.directory}/`)) {
      throw new Error(`workflow ${this.entityDirectory} record path escaped its store`);
    }
    return path;
  }

  protected pathForTemporary(id: string): string {
    assertSafeIdentifier(id, `workflow ${this.entityDirectory} id`);
    const path = resolve(join(this.directory, `.${id}.${process.pid}.${randomUUID()}.tmp`));
    if (!path.startsWith(`${this.directory}/`)) {
      throw new Error(`workflow ${this.entityDirectory} temporary path escaped its store`);
    }
    return path;
  }
}

async function assertNotSymlink(path: string, entity: string, allowMissing: boolean): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`workflow ${entity} record path must not be a symlink`);
    if (!metadata.isFile()) throw new Error(`workflow ${entity} record path must be a regular file`);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export class FileWorkflowStore
  extends FileWorkflowEntityStore<WorkflowValue, WorkflowFilter>
  implements WorkflowStore
{
  constructor(root: string) {
    super(root, "definitions", Workflow);
  }

  async save(workflow: WorkflowValue): Promise<void> {
    await this.saveEntity(workflow);
  }

  protected matches(value: WorkflowValue, filter: WorkflowFilter): boolean {
    return (!filter.workspaceId || value.workspaceId === filter.workspaceId)
      && (!filter.status || value.status === filter.status);
  }
}

export class FileWorkflowRunStore
  extends FileWorkflowEntityStore<WorkflowRunValue, WorkflowRunFilter>
  implements WorkflowRunStore
{
  constructor(root: string) {
    super(root, "runs", WorkflowRun);
  }

  protected matches(value: WorkflowRunValue, filter: WorkflowRunFilter): boolean {
    return (!filter.workspaceId || value.workspaceId === filter.workspaceId)
      && (!filter.workflowId || value.workflowId === filter.workflowId);
  }

  async create(run: WorkflowRunValue): Promise<void> {
    const parsed = WorkflowRun.parse(run);
    assertInitialRunRevision(parsed);
    await withFileRunLock(this.pathFor(parsed.id), async () => {
      const existing = await this.get(parsed.id);
      if (existing) {
        throw new WorkflowRunRevisionConflictError(parsed.id, 0, existing.revision);
      }
      await this.saveEntity(parsed);
    });
  }

  async compareAndSwap(run: WorkflowRunValue, expectedRevision: number): Promise<void> {
    const parsed = WorkflowRun.parse(run);
    await withFileRunLock(this.pathFor(parsed.id), async () => {
      const current = await this.get(parsed.id);
      if (!current) {
        throw new WorkflowError(`workflow run not found: ${parsed.id}`, "WORKFLOW_RUN_NOT_FOUND");
      }
      assertRunTransition(current, parsed, expectedRevision);
      await this.saveEntity(parsed);
    });
  }
}

export class MemoryWorkflowStore implements WorkflowStore {
  private readonly records = new Map<string, WorkflowValue>();

  async save(workflow: WorkflowValue): Promise<void> {
    this.records.set(workflow.id, Workflow.parse(workflow));
  }

  async get(id: string): Promise<WorkflowValue | undefined> {
    return this.records.get(id);
  }

  async list(filter?: WorkflowFilter): Promise<WorkflowValue[]> {
    const records = [...this.records.values()].sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
    return records.filter(
      (record) =>
        (!filter?.workspaceId || record.workspaceId === filter.workspaceId)
        && (!filter?.status || record.status === filter.status)
    );
  }
}

export class MemoryWorkflowRunStore implements WorkflowRunStore {
  private readonly records = new Map<string, WorkflowRunValue>();

  async create(run: WorkflowRunValue): Promise<void> {
    const parsed = WorkflowRun.parse(run);
    assertInitialRunRevision(parsed);
    const existing = this.records.get(parsed.id);
    if (existing) {
      throw new WorkflowRunRevisionConflictError(parsed.id, 0, existing.revision);
    }
    this.records.set(parsed.id, parsed);
  }

  async compareAndSwap(run: WorkflowRunValue, expectedRevision: number): Promise<void> {
    const parsed = WorkflowRun.parse(run);
    const current = this.records.get(parsed.id);
    if (!current) {
      throw new WorkflowError(`workflow run not found: ${parsed.id}`, "WORKFLOW_RUN_NOT_FOUND");
    }
    assertRunTransition(current, parsed, expectedRevision);
    this.records.set(parsed.id, parsed);
  }

  async get(id: string): Promise<WorkflowRunValue | undefined> {
    return this.records.get(id);
  }

  async list(filter?: WorkflowRunFilter): Promise<WorkflowRunValue[]> {
    const records = [...this.records.values()].sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
    return records.filter(
      (record) =>
        (!filter?.workspaceId || record.workspaceId === filter.workspaceId)
        && (!filter?.workflowId || record.workflowId === filter.workflowId)
    );
  }
}

function assertInitialRunRevision(run: WorkflowRunValue): void {
  if (run.revision !== 1) {
    throw new WorkflowRunRevisionConflictError(run.id, 0, run.revision);
  }
}

function assertRunTransition(
  current: WorkflowRunValue,
  next: WorkflowRunValue,
  expectedRevision: number
): void {
  if (current.status === "cancelled") {
    throw new WorkflowRunTerminalStateError(current.id, current.status, current.revision);
  }
  if (current.revision !== expectedRevision) {
    throw new WorkflowRunRevisionConflictError(current.id, expectedRevision, current.revision);
  }
  if (next.revision !== expectedRevision + 1) {
    throw new WorkflowRunRevisionConflictError(current.id, expectedRevision + 1, next.revision);
  }
}

/**
 * The product owns one workspace writer lease, so all live run writers are in
 * this process. Multiple FileWorkflowRunStore instances still share this
 * module-level queue, making the read-check-rename CAS indivisible between
 * route, agent-tool, and scheduler callers.
 */
const fileRunLocks = new Map<string, Promise<void>>();

async function withFileRunLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileRunLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const queued = previous.then(() => current);
  fileRunLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileRunLocks.get(key) === queued) fileRunLocks.delete(key);
  }
}
