import type { AdPilotSystem } from "@adpilot/application";
import { ProjectExistsError, type Session as ProductSessionEntity } from "@adpilot/session-service";

/**
 * Project → Session binding. A kernel project owns a durable, resumable
 * product Session: the first ensure creates it (and links it into the kernel
 * project's sessionIds), later ensures hand back the most recent active one,
 * so the project workbench always resumes where it left off instead of
 * dropping into an anonymous chat.
 */
export interface EnsureProjectSessionInput {
  workspaceId: string;
  projectId: string;
  title?: string;
  /** Create a fresh session even when an active one exists (the "new session" action). */
  force?: boolean;
}

export async function ensureProjectSession(
  system: AdPilotSystem,
  input: EnsureProjectSessionInput
): Promise<{ session: ProductSessionEntity; created: boolean }> {
  if (input.force !== true) {
    const candidates = await system.sessions.list({
      clientId: input.workspaceId,
      projectId: input.projectId,
      archived: false
    });
    const latest = [...candidates].sort((left, right) =>
      right.lastActivityAt.localeCompare(left.lastActivityAt)
    )[0];
    if (latest) return { session: latest, created: false };
  }
  // Projects created before the shadow binding may lack a session-service
  // project; create it lazily so session.create's same-client check passes.
  const shadow = await system.sessions.getProject(input.projectId);
  if (!shadow) {
    try {
      await system.sessions.createProject({
        id: input.projectId,
        clientId: input.workspaceId,
        name: input.title ?? "Project"
      });
    } catch (error) {
      // A concurrent creator won the race — the shadow is identical by contract.
      if (!(error instanceof ProjectExistsError)) throw error;
    }
  }
  const session = await system.sessions.create({
    clientId: input.workspaceId,
    projectId: input.projectId,
    ...(input.title ? { title: input.title } : {})
  });
  await system.kernel.linkSession(input.projectId, session.id);
  return { session, created: true };
}

/**
 * Mission complexity rule: a mission becomes a kernel goal when it is long
 * enough to carry success criteria (≥ 80 chars) or names one explicitly
 * (连续/稳定/目标/修复/报告/审计/分析/生成 or build/report/audit/fix).
 * Short small-talk stays a plain conversation turn.
 */
const MISSION_KEYWORDS = /连续|稳定|目标|修复|报告|审计|分析|生成|build|report|audit|fix/i;

export const MISSION_GOAL_TITLE_LENGTH = 80;

export function isComplexMission(message: string): boolean {
  return message.length >= MISSION_GOAL_TITLE_LENGTH || MISSION_KEYWORDS.test(message);
}
