import { z } from "zod";

/**
 * Unified execution contract shared by the desktop, the server, and the Pi
 * agent runtime (0.3.1 Integration Release). One context carries the
 * workspace/project/goal/task scope, the filesystem roots the agent may
 * touch, the capability packs it may see, and the permission ceiling.
 */
export const AgentExecutionPermissions = z.object({
  read: z.literal(true),
  write: z.boolean(),
  destructive: z.boolean(),
  computerUse: z.boolean(),
  network: z.literal(false)
});
export type AgentExecutionPermissions = z.infer<typeof AgentExecutionPermissions>;

export const AgentExecutionContext = z.object({
  /** Owning workspace; identical concept to the existing clientId. */
  workspaceId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  goalId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  /** Product session or conversationId backing this run. */
  sessionId: z.string().min(1),
  /** Filesystem roots the agent is confined to (terminal cwd, git roots). */
  rootPaths: z.array(z.string().min(1)).default([]),
  /** Extra capability packs beyond the always-on project/goal/task packs. */
  enabledCapabilityPacks: z.array(z.string().min(1)).default([]),
  permissions: AgentExecutionPermissions,
  locale: z.string().min(1),
  createdAt: z.string().datetime()
});
export type AgentExecutionContext = z.infer<typeof AgentExecutionContext>;
