import { z } from "zod";

/**
 * Universal Workspace kernel domain entities.
 *
 * Every entity is persistable on its own: a UUID primary key, ISO-8601
 * createdAt/updatedAt timestamps, and a monotonically increasing `revision`
 * (starts at 1, bumped by the writer on each mutation) for optimistic
 * concurrency reasoning and audit ordering.
 */

const IsoTimestamp = z.string().datetime();
const Uuid = z.string().uuid();
const Revision = z.number().int().min(1);

const EntityBase = {
  id: Uuid,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  revision: Revision
} as const;

/* ------------------------------------------------------------------------ */
/* Project                                                                   */
/* ------------------------------------------------------------------------ */

export const ProjectType = z.enum(["general", "advertising", "development", "research", "creative"]);
export type ProjectType = z.infer<typeof ProjectType>;

export const ProjectStatus = z.enum(["active", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Project = z.object({
  ...EntityBase,
  /** Owning workspace; identical concept to the existing clientId. */
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  type: ProjectType.default("general"),
  /** Normalized (trimmed, de-duplicated) filesystem roots the project works on. */
  rootPaths: z.array(z.string().min(1)).default([]),
  goalIds: z.array(Uuid).default([]),
  sessionIds: z.array(Uuid).default([]),
  artifactIds: z.array(Uuid).default([]),
  enabledCapabilityPacks: z.array(z.string().min(1)).default([]),
  status: ProjectStatus.default("active")
});
export type Project = z.infer<typeof Project>;

/* ------------------------------------------------------------------------ */
/* Goal                                                                      */
/* ------------------------------------------------------------------------ */

export const GoalStatus = z.enum(["draft", "active", "blocked", "waiting_approval", "completed", "failed"]);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const Goal = z.object({
  ...EntityBase,
  projectId: Uuid,
  title: z.string().min(1),
  // A success measure is useful but intentionally optional in the desktop
  // goal form and HTTP contract. Keep the persisted shape stable as a string
  // while allowing the empty-string sentinel used by those callers.
  objective: z.string().default(""),
  successCriteria: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  verificationPlan: z.array(z.string().min(1)).default([]),
  progress: z.number().min(0).max(1).default(0),
  status: GoalStatus.default("draft")
});
export type Goal = z.infer<typeof Goal>;

/* ------------------------------------------------------------------------ */
/* TaskNode                                                                  */
/* ------------------------------------------------------------------------ */

export const TaskNodeStatus = z.enum(["queued", "running", "blocked", "waiting_approval", "completed", "failed"]);
export type TaskNodeStatus = z.infer<typeof TaskNodeStatus>;

export const TaskNode = z.object({
  ...EntityBase,
  goalId: Uuid.optional(),
  parentId: Uuid.optional(),
  title: z.string().min(1),
  description: z.string().default(""),
  assignedAgentId: z.string().min(1).optional(),
  /** Ids of tasks that must reach `completed` before this task can run. */
  dependencies: z.array(Uuid).default([]),
  status: TaskNodeStatus.default("queued"),
  evidenceIds: z.array(z.string().min(1)).default([])
});
export type TaskNode = z.infer<typeof TaskNode>;

/* ------------------------------------------------------------------------ */
/* Artifact                                                                  */
/* ------------------------------------------------------------------------ */

export const ArtifactType = z.enum([
  "code",
  "document",
  "slides",
  "spreadsheet",
  "pdf",
  "website",
  "image",
  "video",
  "interactive",
  "report"
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

export const ArtifactStatus = z.enum(["draft", "rendering", "ready", "failed"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

export const Artifact = z.object({
  ...EntityBase,
  projectId: Uuid,
  sessionId: Uuid.optional(),
  type: ArtifactType,
  title: z.string().min(1),
  sourceFiles: z.array(z.string().min(1)).default([]),
  previewUrl: z.string().min(1).optional(),
  exportFormats: z.array(z.string().min(1)).default([]),
  version: z.number().int().min(1).default(1),
  status: ArtifactStatus.default("draft")
});
export type Artifact = z.infer<typeof Artifact>;
