import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  lstat
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { WorkspaceStore } from "@adpilot/workspace";
import {
  LostWorkspaceWriterLeaseError,
  WorkspaceWriterLease
} from "./lease.js";
import { assertSafeWorkspacePath } from "./path-safety.js";
import {
  LegacyMappingRecord,
  LegacySessionMapping,
  MigrationRecord,
  Project,
  ProjectRecord,
  RecoveryRecord,
  SESSION_SCHEMA_VERSION,
  Session,
  SessionRecord,
  type LegacyMappingRecord as LegacyMappingRecordType,
  type LegacySessionMapping as LegacySessionMappingType,
  type MigrationRecord as MigrationRecordType,
  type Project as ProjectType,
  type RecoveryRecord as RecoveryRecordType,
  type Session as SessionType
} from "./schemas.js";

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export class RevisionConflictError extends Error {
  constructor(
    readonly entityId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `revision conflict for ${entityId}: expected ${expectedRevision}, actual ${actualRevision}`
    );
    this.name = "RevisionConflictError";
  }
}

export class DuplicateSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`session already exists: ${sessionId}`);
    this.name = "DuplicateSessionError";
  }
}

export class CorruptSessionRecordError extends Error {
  constructor(
    readonly recordPath: string,
    readonly quarantinePaths: string[],
    readonly causes: string[]
  ) {
    super(`session record is corrupt and could not be recovered: ${recordPath}`);
    this.name = "CorruptSessionRecordError";
  }
}

export class WriterLeaseRequiredError extends Error {
  constructor(readonly workspaceRoot: string) {
    super(`a held WorkspaceWriterLease is required to write: ${workspaceRoot}`);
    this.name = "WriterLeaseRequiredError";
  }
}

export interface RepositoryDurabilityWarning {
  operation: string;
  path: string;
  message: string;
  occurredAt: string;
}

export interface FileSessionRepositoryOptions {
  now?: () => Date;
  writerLease?: WorkspaceWriterLease;
}

type RecordKind = "session" | "project" | "legacy-mapping";

interface Candidate<T> {
  state: "missing" | "valid" | "invalid";
  raw?: string;
  value?: T;
  error?: string;
}

const UnrecoverableRecordMarker = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  id: z.string().uuid(),
  recordPath: z.string().min(1),
  quarantinePaths: z.array(z.string()),
  causes: z.array(z.string()),
  occurredAt: z.string().datetime({ offset: true })
}).strict();

// The workspace-level writer lease is the cross-process ownership boundary.
// This keyed queue additionally makes compare-and-swap revisions reliable when
// multiple repository/service instances exist inside the owning process.
const fileMutationTails = new Map<string, Promise<void>>();

async function withFileMutationLock<T>(
  path: string,
  operation: () => Promise<T>
): Promise<T> {
  const prior = fileMutationTails.get(path) ?? Promise.resolve();
  const settledPrior = prior.catch(() => undefined);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = settledPrior.then(() => gate);
  fileMutationTails.set(path, tail);
  await settledPrior;
  try {
    return await operation();
  } finally {
    release();
    if (fileMutationTails.get(path) === tail) fileMutationTails.delete(path);
  }
}

function migration(
  kind: MigrationRecordType["kind"],
  now: string,
  details: Record<string, string> = {}
): MigrationRecordType {
  return MigrationRecord.parse({
    id: crypto.randomUUID(),
    kind,
    fromSchemaVersion: 0,
    toSchemaVersion: SESSION_SCHEMA_VERSION,
    appliedAt: now,
    details
  });
}

export class FileSessionRepository {
  readonly workspaceRoot: string;
  readonly root: string;
  readonly recordsRoot: string;
  readonly projectsRoot: string;
  readonly quarantineRoot: string;
  readonly recoveriesRoot: string;
  readonly legacyMappingPath: string;

  private readonly now: () => Date;
  private readonly writerLease: WorkspaceWriterLease | undefined;
  private readonly durabilityWarnings: RepositoryDurabilityWarning[] = [];

  constructor(workspace: WorkspaceStore | string, options: FileSessionRepositoryOptions = {}) {
    this.workspaceRoot = resolve(typeof workspace === "string" ? workspace : workspace.root);
    this.root = join(this.workspaceRoot, ".adpilot", "sessions");
    this.recordsRoot = join(this.root, "records");
    this.projectsRoot = join(this.root, "projects");
    this.quarantineRoot = join(this.root, "quarantine");
    this.recoveriesRoot = join(this.root, "recoveries");
    this.legacyMappingPath = join(this.root, "legacy-mapping.json");
    this.now = options.now ?? (() => new Date());
    if (
      options.writerLease &&
      options.writerLease.workspaceRoot !== this.workspaceRoot
    ) {
      throw new LostWorkspaceWriterLeaseError(options.writerLease.lockPath);
    }
    this.writerLease = options.writerLease;
  }

  async initialize(): Promise<void> {
    await this.withWriterLease(async () => {
      await this.assertSafePath(this.workspaceRoot, "directory", true);
      const directories = [
        join(this.workspaceRoot, ".adpilot"),
        this.root,
        this.recordsRoot,
        this.projectsRoot,
        this.quarantineRoot,
        this.recoveriesRoot
      ];
      for (const directory of directories) {
        await this.assertSafePath(directory, "directory");
        try {
          await mkdir(directory, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        await this.assertSafePath(directory, "directory", true);
        await chmod(directory, 0o700);
        await this.assertSafePath(directory, "directory", true);
        await this.syncDirectory(dirname(directory), "initialize-directory");
      }
    });
  }

  async assertWriterLease(): Promise<void> {
    if (!this.writerLease) throw new WriterLeaseRequiredError(this.workspaceRoot);
    if (this.writerLease.workspaceRoot !== this.workspaceRoot) {
      throw new LostWorkspaceWriterLeaseError(this.writerLease.lockPath);
    }
    await this.writerLease.assertHeld();
  }

  private async withWriterLease<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.writerLease) throw new WriterLeaseRequiredError(this.workspaceRoot);
    if (this.writerLease.workspaceRoot !== this.workspaceRoot) {
      throw new LostWorkspaceWriterLeaseError(this.writerLease.lockPath);
    }
    return this.writerLease.runWhileHeld(operation);
  }

  private async assertSafePath(
    path: string,
    finalType: "any" | "directory" = "any",
    requireExisting = false
  ): Promise<void> {
    await assertSafeWorkspacePath(this.workspaceRoot, path, {
      finalType,
      requireExisting
    });
  }

  listDurabilityWarnings(): RepositoryDurabilityWarning[] {
    return this.durabilityWarnings.map((warning) => ({ ...warning }));
  }

  async createSession(
    session: SessionType,
    migrationKind: MigrationRecordType["kind"] = "native-create"
  ): Promise<SessionType> {
    await this.initialize();
    const value = Session.parse(session);
    if (value.revision !== 1) throw new Error("new sessions must start at revision 1");
    const path = this.sessionPath(value.id);
    return withFileMutationLock(path, async () => {
      await this.assertWriterLease();
      if (await this.pathExists(path)) throw new DuplicateSessionError(value.id);
      const record = SessionRecord.parse({
        schemaVersion: SESSION_SCHEMA_VERSION,
        recordKind: "session",
        migrations: [
          migration(migrationKind, value.createdAt, {
            ...(value.legacy
              ? {
                  clientId: value.legacy.clientId,
                  runtimeConversationId: value.legacy.conversationId
                }
              : {})
          })
        ],
        session: value
      });
      await this.writeRecoverable(path, record);
      return record.session;
    });
  }

  async getSession(sessionId: string): Promise<SessionType | undefined> {
    const record = await this.readRecoverable(
      this.sessionPath(sessionId),
      SessionRecord,
      "session"
    );
    return record?.session;
  }

  async requireSession(sessionId: string): Promise<SessionType> {
    const session = await this.getSession(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  async listSessions(): Promise<SessionType[]> {
    const files = await this.readDirectory(this.recordsRoot);
    const sessions: SessionType[] = [];
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      if (!z.string().uuid().safeParse(id).success) continue;
      const session = await this.getSession(id);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  async updateSession(
    sessionId: string,
    expectedRevision: number,
    updater: (current: SessionType) => SessionType
  ): Promise<SessionType> {
    await this.initialize();
    const id = z.string().uuid().parse(sessionId);
    const path = this.sessionPath(id);
    return withFileMutationLock(path, async () => {
      await this.assertWriterLease();
      const currentRecord = await this.readRecoverable(
        path,
        SessionRecord,
        "session"
      );
      if (!currentRecord) throw new SessionNotFoundError(id);
      if (currentRecord.session.revision !== expectedRevision) {
        throw new RevisionConflictError(id, expectedRevision, currentRecord.session.revision);
      }
      const candidate = updater(currentRecord.session);
      const next = Session.parse({
        ...candidate,
        id,
        revision: currentRecord.session.revision + 1
      });
      const nextRecord = SessionRecord.parse({
        ...currentRecord,
        session: next
      });
      await this.writeRecoverable(path, nextRecord);
      return next;
    });
  }

  async purgeSession(sessionId: string, expectedRevision: number): Promise<void> {
    await this.initialize();
    const id = z.string().uuid().parse(sessionId);
    const path = this.sessionPath(id);
    await withFileMutationLock(path, async () => {
      await this.assertWriterLease();
      const current = await this.readRecoverable(path, SessionRecord, "session");
      if (!current) throw new SessionNotFoundError(id);
      if (current.session.revision !== expectedRevision) {
        throw new RevisionConflictError(id, expectedRevision, current.session.revision);
      }
      await this.withWriterLease(async () => {
        const purgingPath = join(this.quarantineRoot, `${id}.${crypto.randomUUID()}.purging`);
        const backupPath = `${path}.bak`;
        const backupPurgingPath = `${purgingPath}.bak`;
        let backupMoved = false;
        await this.assertSafePath(path, "any", true);
        await this.assertSafePath(purgingPath);
        await this.assertSafePath(backupPath);
        await this.assertSafePath(backupPurgingPath);
        try {
          await rename(backupPath, backupPurgingPath);
          backupMoved = true;
          await this.syncDirectory(dirname(backupPath), "purge-backup-source");
          await this.syncDirectory(dirname(backupPurgingPath), "purge-backup-target");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try {
          await this.assertSafePath(path, "any", true);
          await this.assertSafePath(purgingPath);
          await rename(path, purgingPath);
        } catch (error) {
          if (backupMoved) {
            try {
              await this.assertSafePath(backupPurgingPath, "any", true);
              await this.assertSafePath(backupPath);
              await rename(backupPurgingPath, backupPath);
              await this.syncDirectory(dirname(backupPath), "purge-backup-rollback");
            } catch (rollbackError) {
              this.recordDurabilityWarning(
                "purge-backup-rollback",
                backupPath,
                rollbackError
              );
            }
          }
          throw error;
        }
        await this.syncDirectory(dirname(path), "purge-primary-source");
        await this.syncDirectory(dirname(purgingPath), "purge-primary-target");
        await this.removeAfterCommit(purgingPath, "purge-primary-cleanup");
        if (backupMoved) {
          await this.removeAfterCommit(
            backupPurgingPath,
            "purge-backup-cleanup"
          );
        }
      });
    });
  }

  async createProject(project: ProjectType): Promise<ProjectType> {
    await this.initialize();
    const value = Project.parse(project);
    if (value.revision !== 1) throw new Error("new projects must start at revision 1");
    const path = this.projectPath(value.id);
    return withFileMutationLock(path, async () => {
      await this.assertWriterLease();
      if (await this.pathExists(path)) throw new Error(`project already exists: ${value.id}`);
      const record = ProjectRecord.parse({
        schemaVersion: SESSION_SCHEMA_VERSION,
        recordKind: "project",
        migrations: [migration("native-create", value.createdAt)],
        project: value
      });
      await this.writeRecoverable(path, record);
      return record.project;
    });
  }

  async getProject(projectId: string): Promise<ProjectType | undefined> {
    const record = await this.readRecoverable(
      this.projectPath(projectId),
      ProjectRecord,
      "project"
    );
    return record?.project;
  }

  async listProjects(): Promise<ProjectType[]> {
    const files = await this.readDirectory(this.projectsRoot);
    const projects: ProjectType[] = [];
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      if (!z.string().uuid().safeParse(id).success) continue;
      const project = await this.getProject(id);
      if (project) projects.push(project);
    }
    return projects;
  }

  async updateProject(
    projectId: string,
    expectedRevision: number,
    updater: (current: ProjectType) => ProjectType
  ): Promise<ProjectType> {
    await this.initialize();
    const id = z.string().uuid().parse(projectId);
    const path = this.projectPath(id);
    return withFileMutationLock(path, async () => {
      await this.assertWriterLease();
      const current = await this.readRecoverable(path, ProjectRecord, "project");
      if (!current) throw new ProjectNotFoundError(id);
      if (current.project.revision !== expectedRevision) {
        throw new RevisionConflictError(id, expectedRevision, current.project.revision);
      }
      const next = Project.parse({
        ...updater(current.project),
        id,
        revision: current.project.revision + 1
      });
      await this.writeRecoverable(
        path,
        ProjectRecord.parse({ ...current, project: next })
      );
      return next;
    });
  }

  async getLegacyMappingRecord(): Promise<LegacyMappingRecordType | undefined> {
    return this.readRecoverable(
      this.legacyMappingPath,
      LegacyMappingRecord,
      "legacy-mapping"
    );
  }

  async listLegacyMappings(): Promise<LegacySessionMappingType[]> {
    return (await this.getLegacyMappingRecord())?.mappings ?? [];
  }

  async findLegacyMapping(
    clientId: string,
    runtimeConversationId: string
  ): Promise<LegacySessionMappingType | undefined> {
    return (await this.listLegacyMappings()).find(
      (entry) =>
        entry.clientId === clientId &&
        entry.runtimeConversationId === runtimeConversationId
    );
  }

  async withLegacyMigrationLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    return withFileMutationLock(`${this.legacyMappingPath}.migration`, async () => {
      await this.assertWriterLease();
      return operation();
    });
  }

  async upsertLegacyMapping(
    mappingValue: LegacySessionMappingType,
    expectedRevision?: number
  ): Promise<LegacySessionMappingType> {
    await this.initialize();
    const value = LegacySessionMapping.parse(mappingValue);
    return withFileMutationLock(this.legacyMappingPath, async () => {
      await this.assertWriterLease();
      const current = await this.getLegacyMappingRecord();
      if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) {
        throw new RevisionConflictError(
          "legacy-session-mapping",
          expectedRevision,
          current?.revision ?? 0
        );
      }
      const existing = current?.mappings.find(
        (entry) =>
          entry.clientId === value.clientId &&
          entry.runtimeConversationId === value.runtimeConversationId
      );
      if (existing) {
        if (existing.sessionId !== value.sessionId) {
          throw new Error(
            `legacy conversation already maps to a different session: ${value.clientId}/${value.runtimeConversationId}`
          );
        }
        return existing;
      }
      const now = this.now().toISOString();
      const next = LegacyMappingRecord.parse(
        current
          ? {
              ...current,
              revision: current.revision + 1,
              mappings: [...current.mappings, value]
            }
          : {
              schemaVersion: SESSION_SCHEMA_VERSION,
              recordKind: "legacy-session-mapping",
              revision: 1,
              migrations: [
                migration("legacy-conversation", now, {
                  purpose: "conversation-to-session-id-map"
                })
              ],
              mappings: [value]
            }
      );
      await this.writeRecoverable(this.legacyMappingPath, next);
      return value;
    });
  }

  async markLegacyMappingPurged(
    sessionId: string,
    purgedAt: string
  ): Promise<LegacySessionMappingType | undefined> {
    const id = z.string().uuid().parse(sessionId);
    const timestamp = z.string().datetime({ offset: true }).parse(purgedAt);
    await this.initialize();
    return withFileMutationLock(this.legacyMappingPath, async () => {
      await this.assertWriterLease();
      const current = await this.getLegacyMappingRecord();
      if (!current) return undefined;
      const index = current.mappings.findIndex((entry) => entry.sessionId === id);
      if (index < 0) return undefined;
      const existing = current.mappings[index];
      if (!existing) return undefined;
      if (existing.purgedAt) return existing;
      const updated = LegacySessionMapping.parse({
        ...existing,
        purgedAt: timestamp
      });
      const mappings = [...current.mappings];
      mappings[index] = updated;
      await this.writeCriticalRecoverable(
        this.legacyMappingPath,
        LegacyMappingRecord.parse({
          ...current,
          revision: current.revision + 1,
          mappings
        })
      );
      return updated;
    });
  }

  async recordRecovery(
    value: Omit<RecoveryRecordType, "schemaVersion" | "id" | "occurredAt">
  ): Promise<RecoveryRecordType> {
    await this.initialize();
    const event = RecoveryRecord.parse({
      ...value,
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: crypto.randomUUID(),
      occurredAt: this.now().toISOString()
    });
    await this.atomicReplace(
      join(this.recoveriesRoot, `${event.id}.json`),
      `${JSON.stringify(event, null, 2)}\n`
    );
    return event;
  }

  async listRecoveryRecords(): Promise<RecoveryRecordType[]> {
    const files = await this.readDirectory(this.recoveriesRoot);
    const records: RecoveryRecordType[] = [];
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const recordPath = join(this.recoveriesRoot, entry.name);
      await this.assertSafePath(recordPath, "any", true);
      const raw = await readFile(recordPath, "utf8");
      records.push(RecoveryRecord.parse(JSON.parse(raw)));
    }
    return records.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }

  private sessionPath(sessionId: string): string {
    return join(this.recordsRoot, `${z.string().uuid().parse(sessionId)}.json`);
  }

  private projectPath(projectId: string): string {
    return join(this.projectsRoot, `${z.string().uuid().parse(projectId)}.json`);
  }

  private async writeRecoverable(path: string, value: unknown): Promise<void> {
    await this.withWriterLease(async () => {
      await this.assertSafePath(path);
      const content = `${JSON.stringify(value, null, 2)}\n`;
      const previous = await this.readTextIfExists(path);
      if (previous !== undefined) {
        // The backup is the last committed primary. It is prepared before the
        // new primary so no post-commit backup failure can turn a successful
        // state change into a rejected operation.
        await this.atomicReplace(`${path}.bak`, previous);
      } else {
        const backupPath = `${path}.bak`;
        await this.assertSafePath(backupPath);
        await rm(backupPath, { force: true });
        await this.syncDirectory(dirname(path), "remove-stale-backup");
      }
      await this.atomicReplace(path, content);
    });
  }

  private async writeCriticalRecoverable(
    path: string,
    value: unknown
  ): Promise<void> {
    await this.withWriterLease(async () => {
      await this.assertSafePath(path);
      const content = `${JSON.stringify(value, null, 2)}\n`;
      // Security/deletion tombstones are conservative: the recoverable copy is
      // prepared first and the primary remains the final commit. If the primary
      // commit fails, its previous valid value remains authoritative.
      await this.atomicReplace(`${path}.bak`, content);
      await this.atomicReplace(path, content);
    });
  }

  private async atomicReplace(path: string, content: string): Promise<void> {
    await this.withWriterLease(async () => {
      const parent = dirname(path);
      await this.assertSafePath(parent, "directory");
      try {
        await mkdir(parent, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await this.assertSafePath(parent, "directory", true);
      await chmod(parent, 0o700);
      await this.assertSafePath(parent, "directory", true);
      await this.assertSafePath(path);
      const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await this.assertSafePath(temp);
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        // Path confinement and lease ownership are checked under the same
        // gate as the atomic commit, so release cannot interleave here.
        await this.assertSafePath(temp, "any", true);
        await this.assertSafePath(path);
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      await this.syncDirectory(parent, "atomic-rename");
    });
  }

  private async readRecoverable<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    kind: RecordKind
  ): Promise<z.output<S> | undefined> {
    const primary = await this.readCandidate(path, schema);
    if (primary.state === "valid") return primary.value;
    const backupPath = `${path}.bak`;
    const backup = await this.readCandidate(backupPath, schema);
    if (primary.state === "missing" && backup.state === "missing") {
      const marker = await this.readUnrecoverableMarker(path);
      if (marker) {
        throw new CorruptSessionRecordError(
          marker.recordPath,
          marker.quarantinePaths,
          marker.causes
        );
      }
      return undefined;
    }

    if (backup.state === "valid" && backup.raw !== undefined) {
      const quarantinePaths: string[] = [];
      if (primary.state === "invalid") {
        quarantinePaths.push(await this.quarantine(path, kind));
      }
      await this.atomicReplace(path, backup.raw);
      await this.removeAfterCommit(
        this.unrecoverableMarkerPath(path),
        "remove-recovery-marker"
      );
      await this.recordRecovery({
        kind: "record-restored-from-backup",
        path,
        details: {
          recordKind: kind,
          ...(quarantinePaths[0] ? { quarantinedAs: quarantinePaths[0] } : {})
        }
      }).catch((error) => {
        this.recordDurabilityWarning("record-recovery-event", path, error);
      });
      return backup.value;
    }

    const quarantinePaths: string[] = [];
    const causes: string[] = [];
    if (primary.state === "invalid") {
      causes.push(primary.error ?? "invalid primary record");
      quarantinePaths.push(await this.quarantine(path, kind));
    }
    if (backup.state === "invalid") {
      causes.push(backup.error ?? "invalid backup record");
      quarantinePaths.push(await this.quarantine(backupPath, `${kind}-backup`));
    }
    await this.atomicReplace(
      this.unrecoverableMarkerPath(path),
      `${JSON.stringify(
        UnrecoverableRecordMarker.parse({
          schemaVersion: SESSION_SCHEMA_VERSION,
          id: crypto.randomUUID(),
          recordPath: path,
          quarantinePaths,
          causes,
          occurredAt: this.now().toISOString()
        }),
        null,
        2
      )}\n`
    );
    await this.recordRecovery({
      kind: "record-quarantined",
      path,
      details: {
        recordKind: kind,
        quarantinedPaths: quarantinePaths.join(",")
      }
    });
    throw new CorruptSessionRecordError(path, quarantinePaths, causes);
  }

  private async readUnrecoverableMarker(
    path: string
  ): Promise<z.infer<typeof UnrecoverableRecordMarker> | undefined> {
    try {
      const markerPath = this.unrecoverableMarkerPath(path);
      await this.assertSafePath(markerPath);
      const raw = await readFile(markerPath, "utf8");
      return UnrecoverableRecordMarker.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private unrecoverableMarkerPath(path: string): string {
    return `${path}.unrecoverable.json`;
  }

  private async readCandidate<S extends z.ZodTypeAny>(
    path: string,
    schema: S
  ): Promise<Candidate<z.output<S>>> {
    let raw: string;
    try {
      await this.assertSafePath(path);
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
      throw error;
    }
    try {
      return { state: "valid", raw, value: schema.parse(JSON.parse(raw)) };
    } catch (error) {
      return {
        state: "invalid",
        raw,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async quarantine(path: string, kind: string): Promise<string> {
    const target = join(
      this.quarantineRoot,
      `${kind}.${crypto.randomUUID()}.corrupt`
    );
    return this.withWriterLease(async () => {
      await this.assertSafePath(path, "any", true);
      await this.assertSafePath(target);
      await chmod(path, 0o600);
      await this.assertSafePath(path, "any", true);
      await this.assertSafePath(target);
      await rename(path, target);
      await this.syncDirectory(dirname(path), "quarantine-source");
      if (dirname(target) !== dirname(path)) {
        await this.syncDirectory(dirname(target), "quarantine-target");
      }
      return target;
    });
  }

  private async readDirectory(path: string) {
    await this.assertSafePath(path, "directory");
    return readdir(path, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    );
  }

  private async readTextIfExists(path: string): Promise<string | undefined> {
    await this.assertSafePath(path);
    return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  }

  private async syncDirectory(path: string, operation: string): Promise<void> {
    let handle;
    try {
      await this.assertSafePath(path, "directory", true);
      handle = await open(path, "r");
      await handle.sync();
    } catch (error) {
      this.recordDurabilityWarning(operation, path, error);
    } finally {
      await handle?.close().catch((error) => {
        this.recordDurabilityWarning(`${operation}-close`, path, error);
      });
    }
  }

  private async removeAfterCommit(path: string, operation: string): Promise<void> {
    try {
      await this.withWriterLease(async () => {
        await this.assertSafePath(path);
        await rm(path, { force: true });
        await this.syncDirectory(dirname(path), operation);
      });
    } catch (error) {
      this.recordDurabilityWarning(operation, path, error);
    }
  }

  private recordDurabilityWarning(
    operation: string,
    path: string,
    error: unknown
  ): void {
    this.durabilityWarnings.push({
      operation,
      path,
      message: error instanceof Error ? error.message : String(error),
      occurredAt: this.now().toISOString()
    });
    if (this.durabilityWarnings.length > 1_000) this.durabilityWarnings.shift();
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await this.assertSafePath(path);
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
