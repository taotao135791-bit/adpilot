import { z } from "zod";

export const SESSION_SCHEMA_VERSION = 1 as const;

const IsoDateTime = z.string().datetime({ offset: true });
const NonEmptyId = z.string().trim().min(1).max(256);

export const SessionStatus = z.enum([
  "idle",
  "queued",
  "running",
  "waiting_for_approval",
  "paused",
  "failed",
  "completed",
  "deleted"
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionPlatform = z.enum([
  "google_ads",
  "meta_ads",
  "tiktok_ads",
  "apple_ads",
  "microsoft_ads",
  "amazon_ads",
  "linkedin_ads",
  "youtube_ads",
  "other"
]);
export type SessionPlatform = z.infer<typeof SessionPlatform>;

export const SessionPlatforms = z.array(SessionPlatform)
  .max(SessionPlatform.options.length)
  .superRefine((value, context) => {
    const normalized = [...new Set(value)].sort((left, right) =>
      left.localeCompare(right)
    );
    if (
      normalized.length !== value.length ||
      normalized.some((platform, index) => platform !== value[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "platforms must be unique and sorted"
      });
    }
  });

export const SessionModelBinding = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("router"),
    route: z.enum(["fast", "strong", "gui"]).default("fast")
  }).strict(),
  z.object({
    mode: z.literal("pinned"),
    providerId: NonEmptyId,
    modelId: NonEmptyId,
    fallbackRoute: z.enum(["fast", "strong", "gui"]).optional()
  }).strict()
]);
export type SessionModelBinding = z.infer<typeof SessionModelBinding>;
export type SessionModelBindingInput = z.input<typeof SessionModelBinding>;

export const SessionPermissionProfile = z.object({
  level: z.enum(["OBSERVE", "PREPARE", "EXECUTE"]).default("OBSERVE"),
  allowedToolNames: z.array(NonEmptyId).default([]),
  blockedToolNames: z.array(NonEmptyId).default([]),
  accountRefs: z.array(NonEmptyId).default([]),
  browserProfile: NonEmptyId.optional(),
  computerUse: z.enum(["disabled", "observe", "interactive", "execute"]).default("disabled"),
  approvalRequired: z.boolean().default(true)
}).strict().superRefine((value, context) => {
  const blocked = new Set(value.blockedToolNames);
  for (const toolName of value.allowedToolNames) {
    if (blocked.has(toolName)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `tool cannot be both allowed and blocked: ${toolName}`,
        path: ["allowedToolNames"]
      });
    }
  }
  if (value.level === "OBSERVE" && value.computerUse === "execute") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OBSERVE permission cannot execute computer-use actions",
      path: ["computerUse"]
    });
  }
  if (value.level === "OBSERVE" && value.approvalRequired === false) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OBSERVE permission must remain approval-gated",
      path: ["approvalRequired"]
    });
  }
  if (value.computerUse === "execute" && value.level !== "EXECUTE") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "computer-use execution requires EXECUTE permission",
      path: ["computerUse"]
    });
  }
  if (value.computerUse === "interactive" && value.level === "OBSERVE") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "interactive computer-use requires PREPARE or EXECUTE permission",
      path: ["computerUse"]
    });
  }
});
export type SessionPermissionProfile = z.infer<typeof SessionPermissionProfile>;
export type SessionPermissionProfileInput = z.input<typeof SessionPermissionProfile>;

export const PermissionEscalationApproval = z.object({
  approvalId: z.string().uuid(),
  approvedBy: NonEmptyId,
  approvedAt: IsoDateTime
}).strict();
export type PermissionEscalationApproval = z.infer<
  typeof PermissionEscalationApproval
>;
export type PermissionEscalationApprovalInput = z.input<
  typeof PermissionEscalationApproval
>;

export const SessionUsage = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  computerUseSteps: z.number().int().nonnegative().default(0),
  runCount: z.number().int().nonnegative().default(0),
  costUsd: z.number().finite().nonnegative().default(0)
}).strict();
export type SessionUsage = z.infer<typeof SessionUsage>;
export type SessionUsageInput = z.input<typeof SessionUsage>;

export const SessionBranchMetadata = z.object({
  parentSessionId: z.string().uuid(),
  rootSessionId: z.string().uuid(),
  sourceMessageId: NonEmptyId.optional(),
  sourceRunId: z.string().uuid().optional(),
  branchedAt: IsoDateTime
}).strict();
export type SessionBranchMetadata = z.infer<typeof SessionBranchMetadata>;

export const SessionLegacyMetadata = z.object({
  clientId: NonEmptyId,
  conversationId: NonEmptyId,
  migratedAt: IsoDateTime,
  sourcePath: z.string().min(1)
}).strict();
export type SessionLegacyMetadata = z.infer<typeof SessionLegacyMetadata>;

export const Session = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  id: z.string().uuid(),
  clientId: NonEmptyId,
  projectId: z.string().uuid().optional(),
  agentProfileId: NonEmptyId,
  advertisingWorkspaceId: NonEmptyId.optional(),
  platforms: SessionPlatforms,
  runtimeConversationId: NonEmptyId,
  title: z.string().trim().min(1).max(200),
  /** One-line preview of the latest exchange, maintained by the message route. */
  preview: z.string().trim().max(280).optional(),
  status: SessionStatus,
  modelBinding: SessionModelBinding,
  permissionProfile: SessionPermissionProfile,
  usage: SessionUsage,
  tags: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
  branch: SessionBranchMetadata.optional(),
  duplicatedFromSessionId: z.string().uuid().optional(),
  legacy: SessionLegacyMetadata.optional(),
  pinnedAt: IsoDateTime.optional(),
  archivedAt: IsoDateTime.optional(),
  deletedAt: IsoDateTime.optional(),
  statusBeforeDelete: SessionStatus.exclude(["deleted"]).optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
  lastOpenedAt: IsoDateTime,
  revision: z.number().int().positive()
}).strict().superRefine((value, context) => {
  if (value.status === "deleted" && value.deletedAt === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "deleted sessions require deletedAt",
      path: ["deletedAt"]
    });
  }
  if (value.deletedAt !== undefined && value.status !== "deleted") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "deletedAt requires deleted status",
      path: ["status"]
    });
  }
});
export type Session = z.infer<typeof Session>;

export const ProjectStatus = z.enum(["active", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Project = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  id: z.string().uuid(),
  clientId: NonEmptyId,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).optional(),
  status: ProjectStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: IsoDateTime.optional(),
  revision: z.number().int().positive()
}).strict();
export type Project = z.infer<typeof Project>;

export const MigrationRecord = z.object({
  id: z.string().uuid(),
  kind: z.enum([
    "native-create",
    "legacy-conversation",
    "schema-upgrade",
    "corruption-recovery"
  ]),
  fromSchemaVersion: z.number().int().nonnegative(),
  toSchemaVersion: z.number().int().positive(),
  appliedAt: IsoDateTime,
  details: z.record(z.string()).default({})
}).strict();
export type MigrationRecord = z.infer<typeof MigrationRecord>;

export const SessionRecord = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  recordKind: z.literal("session"),
  migrations: z.array(MigrationRecord).min(1),
  session: Session
}).strict();
export type SessionRecord = z.infer<typeof SessionRecord>;

export const ProjectRecord = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  recordKind: z.literal("project"),
  migrations: z.array(MigrationRecord).min(1),
  project: Project
}).strict();
export type ProjectRecord = z.infer<typeof ProjectRecord>;

export const LegacySessionMapping = z.object({
  clientId: NonEmptyId,
  runtimeConversationId: NonEmptyId,
  sessionId: z.string().uuid(),
  migratedAt: IsoDateTime,
  purgedAt: IsoDateTime.optional()
}).strict();
export type LegacySessionMapping = z.infer<typeof LegacySessionMapping>;

export const LegacyMappingRecord = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  recordKind: z.literal("legacy-session-mapping"),
  revision: z.number().int().positive(),
  migrations: z.array(MigrationRecord).min(1),
  mappings: z.array(LegacySessionMapping)
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  const sessionIds = new Set<string>();
  for (const [index, mapping] of value.mappings.entries()) {
    const key = `${mapping.clientId}\u0000${mapping.runtimeConversationId}`;
    if (keys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate legacy conversation mapping",
        path: ["mappings", index]
      });
    }
    if (sessionIds.has(mapping.sessionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "legacy session id mapped more than once",
        path: ["mappings", index, "sessionId"]
      });
    }
    keys.add(key);
    sessionIds.add(mapping.sessionId);
  }
});
export type LegacyMappingRecord = z.infer<typeof LegacyMappingRecord>;

export const RecoveryRecord = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  id: z.string().uuid(),
  kind: z.enum([
    "record-restored-from-backup",
    "record-quarantined",
    "legacy-tail-ignored"
  ]),
  path: z.string().min(1),
  occurredAt: IsoDateTime,
  details: z.record(z.string()).default({})
}).strict();
export type RecoveryRecord = z.infer<typeof RecoveryRecord>;

export const RunStatus = z.enum(["queued", "running", "succeeded", "failed"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const CoordinatedRun = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  status: RunStatus,
  queuedAt: IsoDateTime,
  startedAt: IsoDateTime.optional(),
  completedAt: IsoDateTime.optional(),
  error: z.string().optional()
}).strict();
export type CoordinatedRun = z.infer<typeof CoordinatedRun>;
