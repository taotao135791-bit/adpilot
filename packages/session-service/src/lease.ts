import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fileConstants } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  rename,
  rm
} from "node:fs/promises";
import { hostname as currentHostname } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { WorkspaceStore } from "@adpilot/workspace";
import {
  assertSafeWorkspacePath,
  UnsafeWorkspacePathError
} from "./path-safety.js";
import { SESSION_SCHEMA_VERSION } from "./schemas.js";

export const WorkspaceWriterLeaseRecord = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  id: z.string().uuid(),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  workspaceRoot: z.string().min(1),
  owner: z.string().min(1),
  acquiredAt: z.string().datetime({ offset: true })
}).strict();
export type WorkspaceWriterLeaseRecord = z.infer<typeof WorkspaceWriterLeaseRecord>;

interface LeaseSnapshot {
  record: WorkspaceWriterLeaseRecord;
  dev: number;
  ino: number;
}

export class WorkspaceWriterLeaseHeldError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holder: WorkspaceWriterLeaseRecord,
    readonly staleCheck: "alive" | "foreign-host" | "unverifiable" | "recovery-disabled"
  ) {
    super(
      `workspace writer lease is held by pid ${holder.pid} on ${holder.hostname}: ${lockPath}`
    );
    this.name = "WorkspaceWriterLeaseHeldError";
  }
}

export class CorruptWorkspaceWriterLeaseError extends Error {
  constructor(readonly lockPath: string, readonly causeMessage: string) {
    super(`workspace writer lease is corrupt and will not be removed automatically: ${lockPath}`);
    this.name = "CorruptWorkspaceWriterLeaseError";
  }
}

export class LostWorkspaceWriterLeaseError extends Error {
  constructor(readonly lockPath: string) {
    super(`workspace writer lease ownership was lost: ${lockPath}`);
    this.name = "LostWorkspaceWriterLeaseError";
  }
}

export interface WorkspaceWriterLeaseOptions {
  owner?: string;
  recoverStale?: boolean;
  now?: () => Date;
}

export class WorkspaceWriterLease {
  static readonly relativeLockPath = join(".adpilot", "writer.lock");
  static readonly relativeRecoveryGuardPath = join(
    ".adpilot",
    "writer.recovery.lock"
  );

  readonly workspaceRoot: string;
  readonly lockPath: string;
  readonly record: WorkspaceWriterLeaseRecord;

  private released = false;
  private readonly identity: Pick<LeaseSnapshot, "dev" | "ino">;
  private gateTail: Promise<void> = Promise.resolve();
  private readonly gateContext = new AsyncLocalStorage<boolean>();

  private constructor(
    workspaceRoot: string,
    lockPath: string,
    snapshot: LeaseSnapshot
  ) {
    this.workspaceRoot = workspaceRoot;
    this.lockPath = lockPath;
    this.record = snapshot.record;
    this.identity = { dev: snapshot.dev, ino: snapshot.ino };
  }

  static async acquire(
    workspace: WorkspaceStore | string,
    options: WorkspaceWriterLeaseOptions = {}
  ): Promise<WorkspaceWriterLease> {
    const workspaceRoot = resolve(
      typeof workspace === "string" ? workspace : workspace.root
    );
    const controlRoot = join(workspaceRoot, ".adpilot");
    const lockPath = join(workspaceRoot, WorkspaceWriterLease.relativeLockPath);
    const recoveryGuardPath = join(
      workspaceRoot,
      WorkspaceWriterLease.relativeRecoveryGuardPath
    );
    await assertSafeWorkspacePath(workspaceRoot, workspaceRoot, {
      finalType: "directory",
      requireExisting: true
    });
    await assertSafeWorkspacePath(workspaceRoot, controlRoot);
    try {
      await mkdir(controlRoot, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertSafeWorkspacePath(workspaceRoot, controlRoot, {
      finalType: "directory",
      requireExisting: true
    });
    await chmod(controlRoot, 0o700);
    await assertSafeWorkspacePath(workspaceRoot, controlRoot, {
      finalType: "directory",
      requireExisting: true
    });

    const record = WorkspaceWriterLeaseRecord.parse({
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: crypto.randomUUID(),
      pid: process.pid,
      hostname: currentHostname(),
      workspaceRoot,
      owner: options.owner?.trim() || "adpilot-daemon",
      acquiredAt: (options.now ?? (() => new Date()))().toISOString()
    });

    let staleRecoveries = 0;
    while (true) {
      const guard = await readLeaseSnapshotIfPresent(
        workspaceRoot,
        recoveryGuardPath
      );
      if (guard) {
        throw heldForGuard(recoveryGuardPath, guard.record);
      }

      try {
        await createExclusiveLease(workspaceRoot, lockPath, record);
        const postPublishGuard = await readLeaseSnapshotIfPresent(
          workspaceRoot,
          recoveryGuardPath
        );
        if (postPublishGuard) {
          await withdrawOwnedLease(workspaceRoot, lockPath, record.id);
          throw heldForGuard(recoveryGuardPath, postPublishGuard.record);
        }
        const published = await readLeaseSnapshot(workspaceRoot, lockPath);
        if (!sameRecord(published.record, record)) {
          throw new LostWorkspaceWriterLeaseError(lockPath);
        }
        await syncDirectoryBestEffort(controlRoot);
        return new WorkspaceWriterLease(workspaceRoot, lockPath, published);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      let observed: LeaseSnapshot;
      try {
        observed = await readLeaseSnapshot(workspaceRoot, lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const staleState = definitelyStale(observed.record);
      if (staleState !== "stale") {
        throw new WorkspaceWriterLeaseHeldError(
          lockPath,
          observed.record,
          staleState
        );
      }
      if (options.recoverStale === false) {
        throw new WorkspaceWriterLeaseHeldError(
          lockPath,
          observed.record,
          "recovery-disabled"
        );
      }
      if (staleRecoveries >= 3) {
        throw new WorkspaceWriterLeaseHeldError(
          lockPath,
          observed.record,
          "unverifiable"
        );
      }

      const guardRecord = WorkspaceWriterLeaseRecord.parse({
        ...record,
        id: crypto.randomUUID(),
        owner: `${record.owner}:stale-recovery`,
        acquiredAt: new Date().toISOString()
      });
      try {
        await createExclusiveLease(
          workspaceRoot,
          recoveryGuardPath,
          guardRecord
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const currentGuard = await readLeaseSnapshotIfPresent(
          workspaceRoot,
          recoveryGuardPath
        );
        // The guard owner can finish between link(2) reporting EEXIST and
        // this observation. Re-enter the outer acquisition loop so both the
        // primary lease and guard are observed from a fresh state.
        if (!currentGuard) continue;
        throw heldForGuard(recoveryGuardPath, currentGuard.record);
      }

      try {
        const guarded = await readLeaseSnapshotIfPresent(
          workspaceRoot,
          lockPath
        );
        if (!guarded || !sameSnapshot(guarded, observed)) continue;
        const guardedState = definitelyStale(guarded.record);
        if (guardedState !== "stale") {
          throw new WorkspaceWriterLeaseHeldError(
            lockPath,
            guarded.record,
            guardedState
          );
        }
        const immediatelyBeforeMove = await readLeaseSnapshot(
          workspaceRoot,
          lockPath
        );
        if (!sameSnapshot(immediatelyBeforeMove, observed)) continue;

        const stalePath = `${lockPath}.stale.${crypto.randomUUID()}.json`;
        await assertSafeWorkspacePath(workspaceRoot, stalePath);
        await rename(lockPath, stalePath);
        staleRecoveries += 1;
        await assertSafeWorkspacePath(workspaceRoot, stalePath, {
          requireExisting: true
        });
        await chmod(stalePath, 0o600);
        await syncDirectoryBestEffort(controlRoot);
        const moved = await readLeaseSnapshot(workspaceRoot, stalePath);
        if (!sameSnapshot(moved, observed)) {
          await restoreLeaseIfAbsent(
            workspaceRoot,
            stalePath,
            lockPath,
            controlRoot
          );
          throw new LostWorkspaceWriterLeaseError(lockPath);
        }
      } finally {
        await releaseOwnedLeaseRecord(
          workspaceRoot,
          recoveryGuardPath,
          guardRecord.id,
          controlRoot
        );
      }
    }
  }

  async runWhileHeld<T>(operation: () => Promise<T>): Promise<T> {
    if (this.gateContext.getStore()) {
      await this.assertHeldUnlocked();
      return operation();
    }
    return this.withGate(async () => {
      await this.assertHeldUnlocked();
      return operation();
    });
  }

  async assertHeld(): Promise<void> {
    if (this.gateContext.getStore()) {
      await this.assertHeldUnlocked();
      return;
    }
    await this.runWhileHeld(async () => undefined);
  }

  async release(): Promise<void> {
    if (this.gateContext.getStore()) {
      throw new LostWorkspaceWriterLeaseError(this.lockPath);
    }
    await this.withGate(async () => {
      if (this.released) return;
      if (this.record.pid !== process.pid) {
        throw new LostWorkspaceWriterLeaseError(this.lockPath);
      }
      let current: LeaseSnapshot;
      try {
        current = await readLeaseSnapshot(this.workspaceRoot, this.lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.released = true;
          return;
        }
        throw error;
      }
      if (
        !sameRecord(current.record, this.record) ||
        current.dev !== this.identity.dev ||
        current.ino !== this.identity.ino
      ) {
        throw new LostWorkspaceWriterLeaseError(this.lockPath);
      }
      await releaseOwnedLeaseRecord(
        this.workspaceRoot,
        this.lockPath,
        this.record.id,
        join(this.workspaceRoot, ".adpilot")
      );
      this.released = true;
    });
  }

  private async assertHeldUnlocked(): Promise<void> {
    if (this.released || this.record.pid !== process.pid) {
      throw new LostWorkspaceWriterLeaseError(this.lockPath);
    }
    const current = await readLeaseSnapshot(this.workspaceRoot, this.lockPath);
    if (
      !sameRecord(current.record, this.record) ||
      current.dev !== this.identity.dev ||
      current.ino !== this.identity.ino
    ) {
      throw new LostWorkspaceWriterLeaseError(this.lockPath);
    }
  }

  private async withGate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.gateTail.catch(() => undefined);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    this.gateTail = previous.then(() => gate);
    await previous;
    try {
      return await this.gateContext.run(true, operation);
    } finally {
      release();
    }
  }
}

async function createExclusiveLease(
  workspaceRoot: string,
  path: string,
  record: WorkspaceWriterLeaseRecord
): Promise<void> {
  const pendingPath = `${path}.pending.${process.pid}.${crypto.randomUUID()}`;
  await assertSafeWorkspacePath(workspaceRoot, path);
  await assertSafeWorkspacePath(workspaceRoot, pendingPath);
  let handle;
  try {
    handle = await open(pendingPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertSafeWorkspacePath(workspaceRoot, pendingPath, {
      requireExisting: true
    });
    await assertSafeWorkspacePath(workspaceRoot, path);
    await link(pendingPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(pendingPath, { force: true }).catch(() => undefined);
  }
}

async function readLeaseSnapshot(
  workspaceRoot: string,
  path: string
): Promise<LeaseSnapshot> {
  await assertSafeWorkspacePath(workspaceRoot, path);
  const handle = await open(
    path,
    fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const [stats, raw] = await Promise.all([
      handle.stat(),
      handle.readFile("utf8")
    ]);
    if (!stats.isFile()) {
      throw new UnsafeWorkspacePathError(
        workspaceRoot,
        path,
        "lease-not-regular-file"
      );
    }
    try {
      return {
        record: WorkspaceWriterLeaseRecord.parse(JSON.parse(raw)),
        dev: stats.dev,
        ino: stats.ino
      };
    } catch (error) {
      throw new CorruptWorkspaceWriterLeaseError(
        path,
        error instanceof Error ? error.message : String(error)
      );
    }
  } finally {
    await handle.close();
  }
}

async function readLeaseSnapshotIfPresent(
  workspaceRoot: string,
  path: string
): Promise<LeaseSnapshot | undefined> {
  try {
    return await readLeaseSnapshot(workspaceRoot, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (
      error instanceof UnsafeWorkspacePathError &&
      error.reason === "target-missing"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function releaseOwnedLeaseRecord(
  workspaceRoot: string,
  lockPath: string,
  expectedId: string,
  controlRoot: string
): Promise<void> {
  const current = await readLeaseSnapshot(workspaceRoot, lockPath);
  if (current.record.id !== expectedId) {
    throw new LostWorkspaceWriterLeaseError(lockPath);
  }
  const releasedPath = `${lockPath}.released.${expectedId}.${crypto.randomUUID()}`;
  await assertSafeWorkspacePath(workspaceRoot, releasedPath);
  await assertSafeWorkspacePath(workspaceRoot, lockPath, {
    requireExisting: true
  });
  await rename(lockPath, releasedPath);
  await syncDirectoryBestEffort(controlRoot);
  const moved = await readLeaseSnapshot(workspaceRoot, releasedPath);
  if (!sameSnapshot(moved, current)) {
    await restoreLeaseIfAbsent(
      workspaceRoot,
      releasedPath,
      lockPath,
      controlRoot
    );
    throw new LostWorkspaceWriterLeaseError(lockPath);
  }
  await rm(releasedPath, { force: true });
  await syncDirectoryBestEffort(controlRoot);
}

async function withdrawOwnedLease(
  workspaceRoot: string,
  lockPath: string,
  expectedId: string
): Promise<void> {
  await releaseOwnedLeaseRecord(
    workspaceRoot,
    lockPath,
    expectedId,
    join(workspaceRoot, ".adpilot")
  );
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(
      path,
      fileConstants.O_RDONLY |
        (fileConstants.O_DIRECTORY ?? 0) |
        (fileConstants.O_NOFOLLOW ?? 0)
    );
    await handle.sync();
  } catch {
    // Some filesystems do not support directory fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function restoreLeaseIfAbsent(
  workspaceRoot: string,
  sourcePath: string,
  lockPath: string,
  controlRoot: string
): Promise<void> {
  try {
    await assertSafeWorkspacePath(workspaceRoot, sourcePath, {
      requireExisting: true
    });
    await assertSafeWorkspacePath(workspaceRoot, lockPath);
    await link(sourcePath, lockPath);
    await syncDirectoryBestEffort(controlRoot);
    await rm(sourcePath, { force: true });
    await syncDirectoryBestEffort(controlRoot);
  } catch {
    // Preserve both records when restoration cannot be proven safe.
  }
}

function heldForGuard(
  guardPath: string,
  holder: WorkspaceWriterLeaseRecord
): WorkspaceWriterLeaseHeldError {
  const state = definitelyStale(holder);
  return new WorkspaceWriterLeaseHeldError(
    guardPath,
    holder,
    state === "stale" ? "unverifiable" : state
  );
}

function sameRecord(
  left: WorkspaceWriterLeaseRecord,
  right: WorkspaceWriterLeaseRecord
): boolean {
  return (
    left.id === right.id &&
    left.pid === right.pid &&
    left.hostname === right.hostname &&
    left.workspaceRoot === right.workspaceRoot
  );
}

function sameSnapshot(left: LeaseSnapshot, right: LeaseSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    sameRecord(left.record, right.record)
  );
}

function definitelyStale(
  holder: WorkspaceWriterLeaseRecord
): "stale" | "alive" | "foreign-host" | "unverifiable" {
  if (holder.hostname !== currentHostname()) return "foreign-host";
  try {
    process.kill(holder.pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "stale";
    if (code === "EPERM") return "alive";
    return "unverifiable";
  }
}
