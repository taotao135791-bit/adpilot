import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStore } from "@adpilot/workspace";
import { KeyedSessionActor } from "./actors.js";
import {
  DuplicateSessionError,
  FileSessionRepository,
  ProjectNotFoundError,
  RevisionConflictError,
  SessionNotFoundError
} from "./repository.js";
import {
  LegacySessionMapping,
  PermissionEscalationApproval,
  Project,
  Session,
  SessionModelBinding,
  SessionPlatform,
  SessionPlatforms,
  SessionPermissionProfile,
  SessionStatus,
  SessionUsage,
  SESSION_SCHEMA_VERSION,
  type LegacySessionMapping as LegacySessionMappingType,
  type PermissionEscalationApproval as PermissionEscalationApprovalType,
  type PermissionEscalationApprovalInput,
  type Project as ProjectType,
  type Session as SessionType,
  type SessionBranchMetadata,
  type SessionModelBindingInput,
  type SessionPermissionProfileInput,
  type SessionPlatform as SessionPlatformType,
  type SessionStatus as SessionStatusType,
  type SessionUsage as SessionUsageType,
  type SessionUsageInput
} from "./schemas.js";

const ClientId = z.string().trim().min(1).max(256);
const Title = z.string().trim().min(1).max(200);
const Tag = z.string().trim().min(1).max(64);

export class DeletedSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`session is deleted: ${sessionId}`);
    this.name = "DeletedSessionError";
  }
}

export class SessionMustBeSoftDeletedError extends Error {
  constructor(readonly sessionId: string) {
    super(`session must be soft-deleted before permanent purge: ${sessionId}`);
    this.name = "SessionMustBeSoftDeletedError";
  }
}

/** Thrown when createProject is given an explicit id that is already taken. */
export class ProjectExistsError extends Error {
  readonly code = "PROJECT_EXISTS" as const;
  constructor(readonly projectId: string) {
    super(`project already exists: ${projectId}`);
    this.name = "ProjectExistsError";
  }
}

export class LegacyConversationLogCorruptError extends Error {
  constructor(
    readonly clientId: string,
    readonly line: number,
    readonly sourcePath: string
  ) {
    super(`legacy conversation log is corrupt at ${sourcePath}:${line}`);
    this.name = "LegacyConversationLogCorruptError";
  }
}

export interface CreateSessionInput {
  clientId: string;
  title?: string;
  projectId?: string;
  agentProfileId?: string;
  advertisingWorkspaceId?: string;
  platforms?: SessionPlatformType[];
  modelBinding?: SessionModelBindingInput;
  permissionProfile?: SessionPermissionProfileInput;
  permissionApproval?: PermissionEscalationApprovalInput;
  tags?: string[];
}

export interface DuplicateSessionInput {
  title?: string;
  projectId?: string | null;
  tags?: string[];
}

export interface BranchSessionInput {
  title?: string;
  projectId?: string | null;
  sourceMessageId?: string;
  sourceRunId?: string;
  tags?: string[];
}

export interface SetBranchMetadataInput {
  parentSessionId: string;
  sourceMessageId?: string;
  sourceRunId?: string;
}

export interface SessionFilter {
  clientId?: string;
  projectId?: string | null;
  statuses?: SessionStatusType[];
  archived?: boolean;
  deleted?: boolean;
  pinned?: boolean;
  modelMode?: "router" | "pinned";
  providerId?: string;
  permissionLevel?: "OBSERVE" | "PREPARE" | "EXECUTE";
  platform?: SessionPlatformType;
  tags?: string[];
}

export interface CreateProjectInput {
  /** Explicit id (uuid). Used to shadow a kernel project 1:1; conflicts throw ProjectExistsError. */
  id?: string;
  clientId: string;
  name: string;
  description?: string;
}

export interface LegacyMigrationWarning {
  clientId: string;
  sourcePath: string;
  kind: "partial-tail-ignored";
  line: number;
}

export interface LegacyMigrationResult {
  created: number;
  reused: number;
  skippedPurged: number;
  mappings: LegacySessionMappingType[];
  warnings: LegacyMigrationWarning[];
}

export interface SessionServiceOptions {
  now?: () => Date;
  actor?: KeyedSessionActor;
  verifyPermissionEscalation?: (
    request: PermissionEscalationVerificationRequest
  ) => Promise<boolean> | boolean;
}

export interface PermissionEscalationVerificationRequest {
  session: SessionType;
  requestedProfile: z.infer<typeof SessionPermissionProfile>;
  approval: PermissionEscalationApprovalType;
}

export class PermissionEscalationRequiresApprovalError extends Error {
  constructor(readonly sessionId: string) {
    super(`permission escalation requires a verified approval: ${sessionId}`);
    this.name = "PermissionEscalationRequiresApprovalError";
  }
}

interface ParsedLegacyConversation {
  runtimeConversationId: string;
  lastActivityAt?: string;
}

export class SessionService {
  readonly repository: FileSessionRepository;
  readonly actor: KeyedSessionActor;

  private readonly now: () => Date;
  private readonly verifyPermissionEscalation:
    | SessionServiceOptions["verifyPermissionEscalation"]
    | undefined;
  private migrationTail: Promise<void> = Promise.resolve();

  constructor(
    repository: FileSessionRepository,
    options: SessionServiceOptions = {}
  ) {
    this.repository = repository;
    this.actor = options.actor ?? new KeyedSessionActor();
    this.now = options.now ?? (() => new Date());
    this.verifyPermissionEscalation = options.verifyPermissionEscalation;
  }

  async create(input: CreateSessionInput): Promise<SessionType> {
    await this.repository.assertWriterLease();
    const clientId = ClientId.parse(input.clientId);
    const projectId = input.projectId
      ? z.string().uuid().parse(input.projectId)
      : undefined;
    if (projectId) await this.assertProjectForClient(projectId, clientId);
    const title = Title.parse(input.title ?? "New session");
    const agentProfileId = ClientId.parse(input.agentProfileId ?? "adpilot");
    const advertisingWorkspaceId = input.advertisingWorkspaceId
      ? ClientId.parse(input.advertisingWorkspaceId)
      : undefined;
    const platforms = normalizePlatforms(input.platforms ?? []);
    const modelBinding = SessionModelBinding.parse(
      input.modelBinding ?? { mode: "router", route: "fast" }
    );
    const permissionProfile = normalizePermission(input.permissionProfile ?? {});
    const tags = normalizeTags(input.tags ?? []);

    return this.createWithUniqueIds(async (id, runtimeConversationId) => {
      const now = this.timestamp();
      const session = Session.parse({
        schemaVersion: SESSION_SCHEMA_VERSION,
        id,
        clientId,
        ...(projectId ? { projectId } : {}),
        agentProfileId,
        ...(advertisingWorkspaceId ? { advertisingWorkspaceId } : {}),
        platforms,
        runtimeConversationId,
        title,
        status: "idle",
        modelBinding,
        permissionProfile,
        usage: SessionUsage.parse({}),
        tags,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        lastOpenedAt: now,
        revision: 1
      });
      if (!samePermissionProfile(permissionProfile, safeDefaultPermission())) {
        await this.requirePermissionApproval(
          session,
          permissionProfile,
          input.permissionApproval
        );
      }
      return session;
    });
  }

  async get(
    sessionId: string,
    options: { includeDeleted?: boolean } = {}
  ): Promise<SessionType | undefined> {
    const session = await this.repository.getSession(sessionId);
    if (session?.deletedAt && options.includeDeleted !== true) return undefined;
    return session;
  }

  async require(
    sessionId: string,
    options: { includeDeleted?: boolean } = {}
  ): Promise<SessionType> {
    const session = await this.repository.requireSession(sessionId);
    if (session.deletedAt && options.includeDeleted !== true) {
      throw new DeletedSessionError(session.id);
    }
    return session;
  }

  async list(filter: SessionFilter = {}): Promise<SessionType[]> {
    const sessions = await this.repository.listSessions();
    return sessions
      .filter((session) => matchesFilter(session, filter))
      .sort(compareSessions);
  }

  async search(query: string, filter: SessionFilter = {}): Promise<SessionType[]> {
    const needle = query.trim().toLocaleLowerCase();
    const sessions = await this.list(filter);
    if (!needle) return sessions;
    return sessions.filter((session) =>
      [
        session.title,
        session.runtimeConversationId,
        session.clientId,
        session.agentProfileId,
        session.advertisingWorkspaceId ?? "",
        ...session.platforms,
        ...session.tags
      ].some((value) => value.toLocaleLowerCase().includes(needle))
    );
  }

  async rename(
    sessionId: string,
    title: string,
    expectedRevision?: number
  ): Promise<SessionType> {
    const value = Title.parse(title);
    return this.mutate(sessionId, expectedRevision, (current, now) => ({
      ...current,
      title: value,
      updatedAt: now
    }));
  }

  async pin(sessionId: string, expectedRevision?: number): Promise<SessionType> {
    return this.mutate(sessionId, expectedRevision, (current, now) => ({
      ...current,
      pinnedAt: now,
      updatedAt: now
    }));
  }

  async unpin(sessionId: string, expectedRevision?: number): Promise<SessionType> {
    return this.mutate(sessionId, expectedRevision, (current, now) => {
      const { pinnedAt: _pinnedAt, ...rest } = current;
      return { ...rest, updatedAt: now };
    });
  }

  async archive(
    sessionId: string,
    expectedRevision?: number
  ): Promise<SessionType> {
    return this.mutate(sessionId, expectedRevision, (current, now) => ({
      ...current,
      archivedAt: now,
      updatedAt: now
    }));
  }

  async unarchive(
    sessionId: string,
    expectedRevision?: number
  ): Promise<SessionType> {
    return this.mutate(sessionId, expectedRevision, (current, now) => {
      const { archivedAt: _archivedAt, ...rest } = current;
      return { ...rest, updatedAt: now };
    });
  }

  async softDelete(
    sessionId: string,
    expectedRevision?: number
  ): Promise<SessionType> {
    return this.mutate(
      sessionId,
      expectedRevision,
      (current, now) => ({
        ...current,
        statusBeforeDelete:
          current.status === "deleted" ? current.statusBeforeDelete ?? "idle" : current.status,
        status: "deleted",
        deletedAt: current.deletedAt ?? now,
        updatedAt: now
      }),
      true
    );
  }

  async restore(
    sessionId: string,
    expectedRevision?: number
  ): Promise<SessionType> {
    return this.mutate(
      sessionId,
      expectedRevision,
      (current, now) => {
        if (!current.deletedAt) return { ...current, updatedAt: now };
        const {
          deletedAt: _deletedAt,
          statusBeforeDelete,
          ...rest
        } = current;
        return {
          ...rest,
          status: statusBeforeDelete ?? "idle",
          updatedAt: now
        };
      },
      true
    );
  }

  async permanentPurge(
    sessionId: string,
    expectedRevision?: number
  ): Promise<void> {
    await this.repository.assertWriterLease();
    await this.actor.run(sessionId, async () => {
      await this.repository.assertWriterLease();
      const current = await this.repository.requireSession(sessionId);
      if (!current.deletedAt) throw new SessionMustBeSoftDeletedError(sessionId);
      const revision = expectedRevision ?? current.revision;
      if (revision !== current.revision) {
        throw new RevisionConflictError(sessionId, revision, current.revision);
      }
      if (current.legacy) {
        await this.repository.markLegacyMappingPurged(sessionId, this.timestamp());
      }
      await this.repository.purgeSession(
        sessionId,
        revision
      );
    });
  }

  async duplicate(
    sourceSessionId: string,
    input: DuplicateSessionInput = {}
  ): Promise<SessionType> {
    await this.repository.assertWriterLease();
    const source = await this.require(sourceSessionId);
    const projectId = resolveProjectOverride(source.projectId, input.projectId);
    if (projectId) await this.assertProjectForClient(projectId, source.clientId);
    const title = Title.parse(input.title ?? `${source.title} (copy)`);
    const tags = normalizeTags(input.tags ?? source.tags);
    return this.createWithUniqueIds((id, runtimeConversationId) => {
      const now = this.timestamp();
      return Session.parse({
        schemaVersion: SESSION_SCHEMA_VERSION,
        id,
        clientId: source.clientId,
        ...(projectId ? { projectId } : {}),
        agentProfileId: source.agentProfileId,
        ...(source.advertisingWorkspaceId
          ? { advertisingWorkspaceId: source.advertisingWorkspaceId }
          : {}),
        platforms: source.platforms,
        runtimeConversationId,
        title,
        status: "idle",
        modelBinding: source.modelBinding,
        permissionProfile: safeDefaultPermission(),
        usage: SessionUsage.parse({}),
        tags,
        duplicatedFromSessionId: source.id,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        lastOpenedAt: now,
        revision: 1
      });
    });
  }

  async branch(
    sourceSessionId: string,
    input: BranchSessionInput = {}
  ): Promise<SessionType> {
    await this.repository.assertWriterLease();
    const source = await this.require(sourceSessionId);
    const projectId = resolveProjectOverride(source.projectId, input.projectId);
    if (projectId) await this.assertProjectForClient(projectId, source.clientId);
    const title = Title.parse(input.title ?? `${source.title} (branch)`);
    const tags = normalizeTags(input.tags ?? source.tags);
    const sourceMessageId = input.sourceMessageId
      ? z.string().trim().min(1).max(256).parse(input.sourceMessageId)
      : undefined;
    const sourceRunId = input.sourceRunId
      ? z.string().uuid().parse(input.sourceRunId)
      : undefined;

    return this.createWithUniqueIds((id, runtimeConversationId) => {
      const now = this.timestamp();
      const branch: SessionBranchMetadata = {
        parentSessionId: source.id,
        rootSessionId: source.branch?.rootSessionId ?? source.id,
        ...(sourceMessageId ? { sourceMessageId } : {}),
        ...(sourceRunId ? { sourceRunId } : {}),
        branchedAt: now
      };
      return Session.parse({
        schemaVersion: SESSION_SCHEMA_VERSION,
        id,
        clientId: source.clientId,
        ...(projectId ? { projectId } : {}),
        agentProfileId: source.agentProfileId,
        ...(source.advertisingWorkspaceId
          ? { advertisingWorkspaceId: source.advertisingWorkspaceId }
          : {}),
        platforms: source.platforms,
        runtimeConversationId,
        title,
        status: "idle",
        modelBinding: source.modelBinding,
        permissionProfile: safeDefaultPermission(),
        usage: SessionUsage.parse({}),
        tags,
        branch,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        lastOpenedAt: now,
        revision: 1
      });
    });
  }

  async setBranchMetadata(
    sessionId: string,
    input: SetBranchMetadataInput,
    expectedRevision?: number
  ): Promise<SessionType> {
    await this.repository.assertWriterLease();
    const parent = await this.require(input.parentSessionId);
    if (parent.id === sessionId) throw new Error("a session cannot branch from itself");
    const sourceMessageId = input.sourceMessageId
      ? z.string().trim().min(1).max(256).parse(input.sourceMessageId)
      : undefined;
    const sourceRunId = input.sourceRunId
      ? z.string().uuid().parse(input.sourceRunId)
      : undefined;
    return this.mutate(sessionId, expectedRevision, (current, now) => {
      if (current.clientId !== parent.clientId) {
        throw new Error("branch parent must belong to the same client");
      }
      return {
        ...current,
        branch: {
          parentSessionId: parent.id,
          rootSessionId: parent.branch?.rootSessionId ?? parent.id,
          ...(sourceMessageId ? { sourceMessageId } : {}),
          ...(sourceRunId ? { sourceRunId } : {}),
          branchedAt: now
        },
        updatedAt: now
      };
    });
  }

  async touch(
    sessionId: string,
    expectedRevision?: number
  ): Promise<SessionType> {
    return this.mutate(sessionId, expectedRevision, (current, now) => ({
      ...current,
      updatedAt: now,
      lastActivityAt: now
    }));
  }

  async markOpened(
    sessionId: string,
    expectedRevision?: number
  ): Promise<SessionType> {
    return this.mutate(sessionId, expectedRevision, (current, now) => ({
      ...current,
      lastOpenedAt: now,
      updatedAt: now
    }));
  }

  async setModelBinding(
    sessionId: string,
    binding: SessionModelBindingInput,
    expectedRevision?: number
  ): Promise<SessionType> {
    const value = SessionModelBinding.parse(binding);
    return this.mutate(sessionId, expectedRevision, (current, now) => ({
      ...current,
      modelBinding: value,
      updatedAt: now
    }));
  }

  async setPermissionProfile(
    sessionId: string,
    profile: SessionPermissionProfileInput,
    expectedRevision?: number,
    approvalInput?: PermissionEscalationApprovalInput
  ): Promise<SessionType> {
    await this.repository.assertWriterLease();
    const value = normalizePermission(profile);
    const approval = approvalInput
      ? PermissionEscalationApproval.parse(approvalInput)
      : undefined;
    return this.actor.run(sessionId, async () => {
      await this.repository.assertWriterLease();
      const current = await this.repository.requireSession(sessionId);
      if (current.deletedAt) throw new DeletedSessionError(sessionId);
      if (isPermissionEscalation(current.permissionProfile, value)) {
        await this.requirePermissionApproval(current, value, approval);
      }
      return this.repository.updateSession(
        sessionId,
        expectedRevision ?? current.revision,
        (latest) => {
          const next = { ...latest };
          next.permissionProfile = value;
          next.updatedAt = this.timestamp();
          return next;
        }
      );
    });
  }

  async setAgentProfileId(
    sessionId: string,
    agentProfileId: string,
    expectedRevision?: number
  ): Promise<SessionType> {
    const value = ClientId.parse(agentProfileId);
    return this.mutate(sessionId, expectedRevision, (current, now) => ({
      ...current,
      agentProfileId: value,
      updatedAt: now
    }));
  }

  async setAdvertisingWorkspaceId(
    sessionId: string,
    advertisingWorkspaceId: string | null,
    expectedRevision?: number
  ): Promise<SessionType> {
    const value =
      advertisingWorkspaceId === null
        ? undefined
        : ClientId.parse(advertisingWorkspaceId);
    return this.mutate(sessionId, expectedRevision, (current, now) => {
      const {
        advertisingWorkspaceId: _advertisingWorkspaceId,
        ...rest
      } = current;
      return {
        ...rest,
        ...(value ? { advertisingWorkspaceId: value } : {}),
        updatedAt: now
      };
    });
  }

  async setPlatforms(
    sessionId: string,
    platforms: SessionPlatformType[],
    expectedRevision?: number
  ): Promise<SessionType> {
    const value = normalizePlatforms(platforms);
    return this.mutate(sessionId, expectedRevision, (current, now) => ({
      ...current,
      platforms: value,
      updatedAt: now
    }));
  }

  async setUsage(
    sessionId: string,
    usage: SessionUsageInput,
    expectedRevision?: number
  ): Promise<SessionType> {
    const value = SessionUsage.parse(usage);
    return this.mutate(sessionId, expectedRevision, (current, now) => ({
      ...current,
      usage: value,
      updatedAt: now
    }));
  }

  async recordUsage(
    sessionId: string,
    delta: Partial<SessionUsageType>,
    expectedRevision?: number
  ): Promise<SessionType> {
    const value = SessionUsage.partial().strict().parse(delta);
    return this.mutate(sessionId, expectedRevision, (current, now) => ({
      ...current,
      usage: SessionUsage.parse({
        inputTokens: current.usage.inputTokens + (value.inputTokens ?? 0),
        outputTokens: current.usage.outputTokens + (value.outputTokens ?? 0),
        cacheReadTokens:
          current.usage.cacheReadTokens + (value.cacheReadTokens ?? 0),
        cacheWriteTokens:
          current.usage.cacheWriteTokens + (value.cacheWriteTokens ?? 0),
        toolCalls: current.usage.toolCalls + (value.toolCalls ?? 0),
        computerUseSteps:
          current.usage.computerUseSteps + (value.computerUseSteps ?? 0),
        runCount: current.usage.runCount + (value.runCount ?? 0),
        costUsd: current.usage.costUsd + (value.costUsd ?? 0)
      }),
      updatedAt: now
    }));
  }

  async setStatus(
    sessionId: string,
    status: Exclude<SessionStatusType, "deleted">,
    expectedRevision?: number
  ): Promise<SessionType> {
    const value = SessionStatus.exclude(["deleted"]).parse(status);
    return this.mutate(sessionId, expectedRevision, (current, now) => ({
      ...current,
      status: value,
      updatedAt: now,
      ...(value === "running" ? { lastActivityAt: now } : {})
    }));
  }

  async setTags(
    sessionId: string,
    tags: string[],
    expectedRevision?: number
  ): Promise<SessionType> {
    const value = normalizeTags(tags);
    return this.mutate(sessionId, expectedRevision, (current, now) => ({
      ...current,
      tags: value,
      updatedAt: now
    }));
  }

  async moveToProject(
    sessionId: string,
    projectId: string | null,
    expectedRevision?: number
  ): Promise<SessionType> {
    await this.repository.assertWriterLease();
    const current = await this.require(sessionId);
    const normalizedProjectId =
      projectId === null ? undefined : z.string().uuid().parse(projectId);
    if (normalizedProjectId) {
      await this.assertProjectForClient(normalizedProjectId, current.clientId);
    }
    return this.mutate(sessionId, expectedRevision, (value, now) => {
      const { projectId: _projectId, ...rest } = value;
      return {
        ...rest,
        ...(normalizedProjectId ? { projectId: normalizedProjectId } : {}),
        updatedAt: now
      };
    });
  }

  async createProject(input: CreateProjectInput): Promise<ProjectType> {
    await this.repository.assertWriterLease();
    const now = this.timestamp();
    const id = input.id ? z.string().uuid().parse(input.id) : crypto.randomUUID();
    if (input.id && (await this.repository.getProject(id))) {
      throw new ProjectExistsError(id);
    }
    return this.repository.createProject(
      Project.parse({
        schemaVersion: SESSION_SCHEMA_VERSION,
        id,
        clientId: ClientId.parse(input.clientId),
        name: Title.parse(input.name),
        ...(input.description
          ? { description: z.string().trim().max(2_000).parse(input.description) }
          : {}),
        status: "active",
        createdAt: now,
        updatedAt: now,
        revision: 1
      })
    );
  }

  async getProject(projectId: string): Promise<ProjectType | undefined> {
    return this.repository.getProject(projectId);
  }

  async listProjects(clientId?: string): Promise<ProjectType[]> {
    const normalizedClientId =
      clientId === undefined ? undefined : ClientId.parse(clientId);
    return (await this.repository.listProjects())
      .filter(
        (project) =>
          normalizedClientId === undefined || project.clientId === normalizedClientId
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async renameProject(
    projectId: string,
    name: string,
    expectedRevision?: number
  ): Promise<ProjectType> {
    return this.mutateProject(projectId, expectedRevision, (project, now) => ({
      ...project,
      name: Title.parse(name),
      updatedAt: now
    }));
  }

  async archiveProject(
    projectId: string,
    expectedRevision?: number
  ): Promise<ProjectType> {
    return this.mutateProject(projectId, expectedRevision, (project, now) => ({
      ...project,
      status: "archived",
      archivedAt: now,
      updatedAt: now
    }));
  }

  async unarchiveProject(
    projectId: string,
    expectedRevision?: number
  ): Promise<ProjectType> {
    return this.mutateProject(projectId, expectedRevision, (project, now) => {
      const { archivedAt: _archivedAt, ...rest } = project;
      return { ...rest, status: "active", updatedAt: now };
    });
  }

  async migrateLegacy(workspace: WorkspaceStore): Promise<LegacyMigrationResult> {
    await this.repository.assertWriterLease();
    if (this.repository.workspaceRoot !== workspace.root) {
      throw new Error("legacy migration workspace does not match session repository");
    }
    return this.withMigrationLock(async () => {
      const clients = (await workspace.listClients()).sort((left, right) =>
        left.id.localeCompare(right.id)
      );
      const result: LegacyMigrationResult = {
        created: 0,
        reused: 0,
        skippedPurged: 0,
        mappings: [],
        warnings: []
      };
      let knownSessions = await this.repository.listSessions();

      for (const client of clients) {
        const clientWorkspace = await workspace.readClient(client.id).catch(() => undefined);
        const clientPlatforms = normalizePlatforms(
          (clientWorkspace?.accounts?.accounts ?? []).flatMap((account) => {
            const parsedPlatform = SessionPlatform.safeParse(account.platform);
            return parsedPlatform.success ? [parsedPlatform.data] : [];
          })
        );
        const sourcePath = `clients/${client.id}/conversation.jsonl`;
        const content = await workspace.readText(client.id, "conversation.jsonl");
        if (!content) continue;
        const parsed = parseLegacyConversationLog(client.id, sourcePath, content);
        for (const warning of parsed.warnings) {
          result.warnings.push(warning);
          const fingerprint = createHash("sha256")
            .update(`${sourcePath}\u0000${warning.line}\u0000${content}`)
            .digest("hex");
          const exists = (await this.repository.listRecoveryRecords()).some(
            (record) =>
              record.kind === "legacy-tail-ignored" &&
              record.path === sourcePath &&
              record.details.fingerprint === fingerprint
          );
          if (!exists) {
            await this.repository.recordRecovery({
              kind: "legacy-tail-ignored",
              path: sourcePath,
              details: {
                clientId: client.id,
                line: String(warning.line),
                fingerprint
              }
            });
          }
        }

        for (const legacy of parsed.conversations) {
          const existingMapping = await this.repository.findLegacyMapping(
            client.id,
            legacy.runtimeConversationId
          );
          if (existingMapping?.purgedAt) {
            result.skippedPurged += 1;
            continue;
          }
          let session: SessionType | undefined;
          if (existingMapping) {
            session = await this.repository.getSession(existingMapping.sessionId);
            if (!session) {
              session = await this.createLegacySession(
                existingMapping.sessionId,
                client.id,
                legacy,
                sourcePath,
                clientPlatforms
              );
              knownSessions.push(session);
              result.created += 1;
            } else {
              result.reused += 1;
            }
          } else {
            session = knownSessions.find(
              (candidate) =>
                candidate.legacy?.clientId === client.id &&
                candidate.legacy.conversationId === legacy.runtimeConversationId
            );
            if (!session) {
              session = await this.createLegacySession(
                crypto.randomUUID(),
                client.id,
                legacy,
                sourcePath,
                clientPlatforms
              );
              knownSessions.push(session);
              result.created += 1;
            } else {
              result.reused += 1;
            }
            await this.repository.upsertLegacyMapping(
              LegacySessionMapping.parse({
                clientId: client.id,
                runtimeConversationId: legacy.runtimeConversationId,
                sessionId: session.id,
                migratedAt: session.legacy?.migratedAt ?? this.timestamp()
              })
            );
          }
          const mapping =
            (await this.repository.findLegacyMapping(
              client.id,
              legacy.runtimeConversationId
            )) ??
            LegacySessionMapping.parse({
              clientId: client.id,
              runtimeConversationId: legacy.runtimeConversationId,
              sessionId: session.id,
              migratedAt: session.legacy?.migratedAt ?? this.timestamp()
            });
          result.mappings.push(mapping);
        }
      }
      return result;
    });
  }

  private async createLegacySession(
    sessionId: string,
    clientId: string,
    legacy: ParsedLegacyConversation,
    sourcePath: string,
    platforms: SessionPlatformType[]
  ): Promise<SessionType> {
    const now = this.timestamp();
    return this.repository.createSession(
      Session.parse({
        schemaVersion: SESSION_SCHEMA_VERSION,
        id: z.string().uuid().parse(sessionId),
        clientId,
        agentProfileId: "adpilot",
        advertisingWorkspaceId: clientId,
        platforms,
        runtimeConversationId: legacy.runtimeConversationId,
        title: legacy.runtimeConversationId,
        status: "idle",
        modelBinding: SessionModelBinding.parse({ mode: "router", route: "fast" }),
        permissionProfile: normalizePermission({}),
        usage: SessionUsage.parse({}),
        tags: [],
        legacy: {
          clientId,
          conversationId: legacy.runtimeConversationId,
          migratedAt: now,
          sourcePath
        },
        createdAt: now,
        updatedAt: now,
        lastActivityAt: legacy.lastActivityAt ?? now,
        lastOpenedAt: now,
        revision: 1
      }),
      "legacy-conversation"
    );
  }

  private async createWithUniqueIds(
    factory: (
      id: string,
      runtimeConversationId: string
    ) => SessionType | Promise<SessionType>
  ): Promise<SessionType> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = await factory(crypto.randomUUID(), crypto.randomUUID());
      try {
        return await this.repository.createSession(session);
      } catch (error) {
        if (!(error instanceof DuplicateSessionError)) throw error;
      }
    }
    throw new Error("could not allocate a globally unique session id");
  }

  private async mutate(
    sessionId: string,
    expectedRevision: number | undefined,
    updater: (current: SessionType, now: string) => SessionType,
    allowDeleted = false
  ): Promise<SessionType> {
    await this.repository.assertWriterLease();
    return this.actor.run(sessionId, async () => {
      await this.repository.assertWriterLease();
      const current = await this.repository.requireSession(sessionId);
      if (current.deletedAt && !allowDeleted) {
        throw new DeletedSessionError(sessionId);
      }
      return this.repository.updateSession(
        sessionId,
        expectedRevision ?? current.revision,
        (latest) => updater(latest, this.timestamp())
      );
    });
  }

  private async mutateProject(
    projectId: string,
    expectedRevision: number | undefined,
    updater: (current: ProjectType, now: string) => ProjectType
  ): Promise<ProjectType> {
    await this.repository.assertWriterLease();
    return this.actor.run(projectId, async () => {
      await this.repository.assertWriterLease();
      const current = await this.repository.getProject(projectId);
      if (!current) throw new ProjectNotFoundError(projectId);
      return this.repository.updateProject(
        projectId,
        expectedRevision ?? current.revision,
        (latest) => updater(latest, this.timestamp())
      );
    });
  }

  private async assertProjectForClient(
    projectId: string,
    clientId: string
  ): Promise<void> {
    const project = await this.repository.getProject(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    if (project.clientId !== clientId) {
      throw new Error("project and session must belong to the same client");
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async requirePermissionApproval(
    session: SessionType,
    requestedProfile: z.infer<typeof SessionPermissionProfile>,
    approvalInput:
      | PermissionEscalationApprovalInput
      | PermissionEscalationApprovalType
      | undefined
  ): Promise<void> {
    const approval = approvalInput
      ? PermissionEscalationApproval.parse(approvalInput)
      : undefined;
    const verified =
      approval !== undefined &&
      this.verifyPermissionEscalation !== undefined &&
      (await this.verifyPermissionEscalation({
        session,
        requestedProfile,
        approval
      }));
    if (!verified) {
      throw new PermissionEscalationRequiresApprovalError(session.id);
    }
    // The verifier is an async trust boundary. A queued release must complete
    // before this check, and any subsequent repository commit takes the same
    // lease gate.
    await this.repository.assertWriterLease();
  }

  private async withMigrationLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.migrationTail.catch(() => undefined);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.migrationTail = prior.then(() => gate);
    await prior;
    try {
      return await this.repository.withLegacyMigrationLock(operation);
    } finally {
      release();
    }
  }
}

function parseLegacyConversationLog(
  clientId: string,
  sourcePath: string,
  content: string
): { conversations: ParsedLegacyConversation[]; warnings: LegacyMigrationWarning[] } {
  const lines = content.split("\n");
  const lastNonEmptyLine =
    lines.reduce((last, line, index) => (line.trim() ? index : last), -1) + 1;
  const conversations = new Map<string, ParsedLegacyConversation>();
  const warnings: LegacyMigrationWarning[] = [];

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      const lineNumber = index + 1;
      const partialTail =
        lineNumber === lastNonEmptyLine && !content.endsWith("\n");
      if (partialTail) {
        warnings.push({
          clientId,
          sourcePath,
          kind: "partial-tail-ignored",
          line: lineNumber
        });
        continue;
      }
      throw new LegacyConversationLogCorruptError(
        clientId,
        lineNumber,
        sourcePath
      );
    }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (
      typeof record.conversationId !== "string" ||
      !record.conversationId.trim()
    ) {
      continue;
    }
    const runtimeConversationId = record.conversationId.trim();
    const prior = conversations.get(runtimeConversationId);
    const timestamp =
      typeof record.at === "string" &&
      !Number.isNaN(Date.parse(record.at))
        ? new Date(record.at).toISOString()
        : undefined;
    const lastActivityAt =
      timestamp && (!prior?.lastActivityAt || timestamp > prior.lastActivityAt)
        ? timestamp
        : prior?.lastActivityAt;
    conversations.set(
      runtimeConversationId,
      lastActivityAt
        ? { runtimeConversationId, lastActivityAt }
        : { runtimeConversationId }
    );
  }

  return {
    conversations: [...conversations.values()].sort((left, right) =>
      left.runtimeConversationId.localeCompare(right.runtimeConversationId)
    ),
    warnings
  };
}

function normalizePermission(
  input: SessionPermissionProfileInput
): z.infer<typeof SessionPermissionProfile> {
  const parsed = SessionPermissionProfile.parse(input);
  return SessionPermissionProfile.parse({
    ...parsed,
    allowedToolNames: uniqueSorted(parsed.allowedToolNames),
    blockedToolNames: uniqueSorted(parsed.blockedToolNames),
    accountRefs: uniqueSorted(parsed.accountRefs)
  });
}

function safeDefaultPermission(): z.infer<typeof SessionPermissionProfile> {
  return normalizePermission({});
}

function samePermissionProfile(
  left: z.infer<typeof SessionPermissionProfile>,
  right: z.infer<typeof SessionPermissionProfile>
): boolean {
  return (
    left.level === right.level &&
    left.computerUse === right.computerUse &&
    left.approvalRequired === right.approvalRequired &&
    left.browserProfile === right.browserProfile &&
    left.allowedToolNames.length === right.allowedToolNames.length &&
    left.allowedToolNames.every(
      (toolName, index) => toolName === right.allowedToolNames[index]
    ) &&
    left.blockedToolNames.length === right.blockedToolNames.length &&
    left.blockedToolNames.every(
      (toolName, index) => toolName === right.blockedToolNames[index]
    ) &&
    left.accountRefs.length === right.accountRefs.length &&
    left.accountRefs.every(
      (accountRef, index) => accountRef === right.accountRefs[index]
    )
  );
}

function isPermissionEscalation(
  current: z.infer<typeof SessionPermissionProfile>,
  requested: z.infer<typeof SessionPermissionProfile>
): boolean {
  const levelRank = { OBSERVE: 0, PREPARE: 1, EXECUTE: 2 } as const;
  const computerUseRank = {
    disabled: 0,
    observe: 1,
    interactive: 2,
    execute: 3
  } as const;
  if (levelRank[requested.level] > levelRank[current.level]) return true;
  if (
    computerUseRank[requested.computerUse] >
    computerUseRank[current.computerUse]
  ) {
    return true;
  }
  if (current.approvalRequired && !requested.approvalRequired) return true;
  if (
    requested.allowedToolNames.some(
      (toolName) => !current.allowedToolNames.includes(toolName)
    )
  ) {
    return true;
  }
  if (
    current.blockedToolNames.some(
      (toolName) => !requested.blockedToolNames.includes(toolName)
    )
  ) {
    return true;
  }
  if (
    requested.accountRefs.some(
      (accountRef) => !current.accountRefs.includes(accountRef)
    )
  ) {
    return true;
  }
  if (
    requested.browserProfile !== undefined &&
    requested.browserProfile !== current.browserProfile
  ) {
    return true;
  }
  return false;
}

function normalizeTags(tags: string[]): string[] {
  return uniqueSorted(tags.map((tag) => Tag.parse(tag))).slice(0, 64);
}

function normalizePlatforms(platforms: SessionPlatformType[]): SessionPlatformType[] {
  return SessionPlatforms.parse(
    uniqueSorted(platforms.map((platform) => SessionPlatform.parse(platform)))
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function resolveProjectOverride(
  sourceProjectId: string | undefined,
  override: string | null | undefined
): string | undefined {
  if (override === null) return undefined;
  if (override === undefined) return sourceProjectId;
  return z.string().uuid().parse(override);
}

function matchesFilter(session: SessionType, filter: SessionFilter): boolean {
  if (filter.deleted === true) {
    if (!session.deletedAt) return false;
  } else if (session.deletedAt) {
    return false;
  }
  if (filter.clientId !== undefined && session.clientId !== filter.clientId) {
    return false;
  }
  if (filter.projectId !== undefined) {
    if (filter.projectId === null && session.projectId !== undefined) return false;
    if (filter.projectId !== null && session.projectId !== filter.projectId) {
      return false;
    }
  }
  if (filter.statuses && !filter.statuses.includes(session.status)) return false;
  if (
    filter.archived !== undefined &&
    Boolean(session.archivedAt) !== filter.archived
  ) {
    return false;
  }
  if (
    filter.pinned !== undefined &&
    Boolean(session.pinnedAt) !== filter.pinned
  ) {
    return false;
  }
  if (
    filter.modelMode !== undefined &&
    session.modelBinding.mode !== filter.modelMode
  ) {
    return false;
  }
  if (
    filter.providerId !== undefined &&
    (session.modelBinding.mode !== "pinned" ||
      session.modelBinding.providerId !== filter.providerId)
  ) {
    return false;
  }
  if (
    filter.permissionLevel !== undefined &&
    session.permissionProfile.level !== filter.permissionLevel
  ) {
    return false;
  }
  if (
    filter.platform !== undefined &&
    !session.platforms.includes(filter.platform)
  ) {
    return false;
  }
  if (
    filter.tags &&
    !filter.tags.every((tag) => session.tags.includes(tag))
  ) {
    return false;
  }
  return true;
}

function compareSessions(left: SessionType, right: SessionType): number {
  if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) {
    return left.pinnedAt ? -1 : 1;
  }
  if (left.pinnedAt && right.pinnedAt && left.pinnedAt !== right.pinnedAt) {
    return right.pinnedAt.localeCompare(left.pinnedAt);
  }
  return right.lastActivityAt.localeCompare(left.lastActivityAt);
}
