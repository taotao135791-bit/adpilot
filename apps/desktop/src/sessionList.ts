import type { ProductSession, SessionStatus } from "./types.js";

/**
 * Sidebar session-list logic, kept React-free so every rule is unit-testable:
 * grouping/ordering, status-dot tone, SSE snapshot upserts, the revision
 * conflict guard, and the search-request parameter shaping.
 *
 * Ordering mirrors the server (packages/session-service compareSessions):
 * pinned sessions lead (most recently pinned first), everything else follows
 * by lastActivityAt descending. Archived sessions form their own group at the
 * bottom of the sidebar; deleted sessions never reach the list.
 */

export type SessionStatusTone = "live" | "attention" | "danger" | "quiet";

/**
 * Maps a session run status to the restrained dot language: one breathing
 * accent dot while work is in flight, a warning dot when the session waits
 * on a person, a danger dot for failure, and nothing otherwise.
 */
export function sessionStatusTone(status: SessionStatus | string): SessionStatusTone {
  if (status === "running" || status === "queued") return "live";
  if (status === "waiting_for_approval") return "attention";
  if (status === "failed") return "danger";
  return "quiet";
}

export type SessionGroups = {
  pinned: ProductSession[];
  active: ProductSession[];
  archived: ProductSession[];
};

export function isSessionArchived(session: Pick<ProductSession, "archivedAt">): boolean {
  return session.archivedAt !== undefined;
}

export function isSessionPinned(session: Pick<ProductSession, "pinnedAt">): boolean {
  return session.pinnedAt !== undefined;
}

function isDeleted(session: ProductSession): boolean {
  return session.deletedAt !== undefined || session.status === "deleted";
}

const byActivityDesc = (left: ProductSession, right: ProductSession) => right.lastActivityAt.localeCompare(left.lastActivityAt);

/** Splits the flat server list into the three sidebar sections. */
export function groupSessions(sessions: readonly ProductSession[]): SessionGroups {
  const pinned: ProductSession[] = [];
  const active: ProductSession[] = [];
  const archived: ProductSession[] = [];
  for (const session of sessions) {
    if (isDeleted(session)) continue;
    if (isSessionArchived(session)) { archived.push(session); continue; }
    if (isSessionPinned(session)) { pinned.push(session); continue; }
    active.push(session);
  }
  pinned.sort((left, right) => (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "") || byActivityDesc(left, right));
  active.sort(byActivityDesc);
  archived.sort(byActivityDesc);
  return { pinned, active, archived };
}

/**
 * Upserts a server snapshot into the local list. SSE `session` events and
 * mutation responses both carry the full entity (with the new revision), so
 * one code path keeps the revision chain current: the local list always
 * reflects the latest acknowledged revision.
 */
export function applySessionSnapshot(sessions: readonly ProductSession[], snapshot: ProductSession): ProductSession[] {
  const index = sessions.findIndex((session) => session.id === snapshot.id);
  if (index === -1) return [...sessions, snapshot];
  const next = sessions.slice();
  next[index] = snapshot;
  return next;
}

/**
 * The session to select when the current one leaves the active list
 * (archived or deleted): the first entry of the grouped order, ignoring the
 * removed one. Undefined means "nothing left — show the empty state".
 */
export function fallbackSession(sessions: readonly ProductSession[], excludeId: string): ProductSession | undefined {
  const groups = groupSessions(sessions.filter((session) => session.id !== excludeId));
  return groups.pinned[0] ?? groups.active[0];
}

/* ------------------------------------------------------------------ */
/* Revision conflicts                                                  */
/* ------------------------------------------------------------------ */

export type RevisionConflictPayload = {
  code: "REVISION_CONFLICT";
  error: string;
  expectedRevision?: number;
  actualRevision?: number;
};

/** Narrows an error response body to the 409 revision-conflict shape. */
export function isRevisionConflict(payload: unknown): payload is RevisionConflictPayload {
  return typeof payload === "object" && payload !== null && (payload as { code?: unknown }).code === "REVISION_CONFLICT";
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/** Sidebar search debounce: one request per typing pause, never per keystroke. */
export const SESSION_SEARCH_DEBOUNCE_MS = 250;

/** Trims and collapses whitespace; an empty result means "not searching". */
export function normalizeSessionQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Builds the session-list request. The query string is omitted entirely when
 * the search term normalizes to empty, so the plain list and the searched
 * list share one endpoint shape.
 */
export function buildSessionListUrl(clientId: string, options: { q?: string } = {}): string {
  const base = `/api/clients/${encodeURIComponent(clientId)}/sessions`;
  const q = options.q === undefined ? "" : normalizeSessionQuery(options.q);
  return q ? `${base}?q=${encodeURIComponent(q)}` : base;
}
