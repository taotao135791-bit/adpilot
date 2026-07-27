import type { AuditLog } from "@adpilot/audit";
import {
  FileSessionRepository,
  SessionService,
  WorkspaceWriterLease,
  type LegacyMigrationResult
} from "@adpilot/session-service";
import type { WorkspaceStore } from "@adpilot/workspace";

export interface SessionAuthority {
  /** Product Session authority for this workspace; the daemon's single writer. */
  service: SessionService;
  repository: FileSessionRepository;
  lease: WorkspaceWriterLease;
  /** Result of the idempotent legacy conversation import that ran on boot. */
  migration: LegacyMigrationResult;
  /** Sessions whose persisted "running" status was reset to "failed" on boot. */
  interruptedSessionIds: string[];
}

/**
 * One process is one daemon: the workspace writer lease is shared process-wide
 * per workspace root. Recomposing the system over the same workspace inside one
 * process (a daemon restart pattern, or tests) therefore reuses the single
 * writer boundary instead of competing with itself, while a lease held by a
 * live foreign process still fails acquisition loudly with
 * WorkspaceWriterLeaseHeldError — never a silent downgrade to a second writer.
 */
const leasesByRoot = new Map<string, Promise<WorkspaceWriterLease>>();

export function acquireWorkspaceWriterLease(
  workspaceRoot: string,
  owner: string
): Promise<WorkspaceWriterLease> {
  const existing = leasesByRoot.get(workspaceRoot);
  if (existing) return existing;
  const acquiring = WorkspaceWriterLease.acquire(workspaceRoot, { owner });
  leasesByRoot.set(workspaceRoot, acquiring);
  void acquiring.catch(() => {
    if (leasesByRoot.get(workspaceRoot) === acquiring) leasesByRoot.delete(workspaceRoot);
  });
  return acquiring;
}

/**
 * Builds the product Session authority for the daemon: acquires the workspace
 * writer lease, opens the durable repository and service, imports legacy
 * clientId+conversationId pairs once (idempotently — Pi JSONL and
 * conversation.jsonl are left untouched), and resets sessions whose persisted
 * status is still "running" from a previous daemon life to "failed", since the
 * run that owned them died with the previous process.
 */
export async function createSessionAuthority(options: {
  workspace: WorkspaceStore;
  audit?: AuditLog;
  owner?: string;
}): Promise<SessionAuthority> {
  const { workspace } = options;
  const lease = await acquireWorkspaceWriterLease(
    workspace.root,
    options.owner ?? "adpilot-daemon"
  );
  const repository = new FileSessionRepository(workspace, { writerLease: lease });
  const service = new SessionService(repository);
  const migration = await service.migrateLegacy(workspace);
  const interruptedSessionIds: string[] = [];
  for (const session of await repository.listSessions()) {
    if (session.status !== "running" || session.deletedAt) continue;
    await service.setStatus(session.id, "failed");
    interruptedSessionIds.push(session.id);
    await options.audit?.append({
      clientId: session.clientId,
      sessionId: session.id,
      actor: "adpilot-daemon",
      action: "session_run_interrupted",
      status: "failed",
      details: { reason: "daemon restarted while the session run was active" }
    });
  }
  return { service, repository, lease, migration, interruptedSessionIds };
}
