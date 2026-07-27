import { describe, expect, it } from "vitest";
import type { ProductSession, SessionStatus } from "./types.js";
import {
  SESSION_SEARCH_DEBOUNCE_MS,
  applySessionSnapshot,
  buildSessionListUrl,
  fallbackSession,
  groupSessions,
  isRevisionConflict,
  normalizeSessionQuery,
  sessionStatusTone
} from "./sessionList.js";

let counter = 0;
function session(overrides: Partial<ProductSession> = {}): ProductSession {
  counter += 1;
  const id = overrides.id ?? `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  return {
    id,
    clientId: "personal",
    runtimeConversationId: `conv-${id.slice(-4)}`,
    title: `Session ${counter}`,
    status: "idle",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    lastActivityAt: "2026-07-01T00:00:00.000Z",
    lastOpenedAt: "2026-07-01T00:00:00.000Z",
    revision: 1,
    ...overrides
  };
}

describe("sessionStatusTone", () => {
  it("maps the run lifecycle onto the restrained dot language", () => {
    expect(sessionStatusTone("running")).toBe("live");
    expect(sessionStatusTone("queued")).toBe("live");
    expect(sessionStatusTone("waiting_for_approval")).toBe("attention");
    expect(sessionStatusTone("failed")).toBe("danger");
  });

  it("keeps idle, paused, completed and unknown statuses quiet", () => {
    const quiet: SessionStatus[] = ["idle", "paused", "completed", "deleted"];
    for (const status of quiet) expect(sessionStatusTone(status)).toBe("quiet");
    expect(sessionStatusTone("something-else")).toBe("quiet");
  });
});

describe("groupSessions", () => {
  it("puts pinned sessions first, ordered by most recently pinned", () => {
    const older = session({ title: "older", pinnedAt: "2026-07-10T00:00:00.000Z" });
    const newer = session({ title: "newer", pinnedAt: "2026-07-12T00:00:00.000Z" });
    const plain = session({ title: "plain" });
    const groups = groupSessions([older, plain, newer]);
    expect(groups.pinned.map((item) => item.title)).toEqual(["newer", "older"]);
    expect(groups.active.map((item) => item.title)).toEqual(["plain"]);
    expect(groups.archived).toEqual([]);
  });

  it("orders active sessions by recent activity, descending", () => {
    const stale = session({ title: "stale", lastActivityAt: "2026-07-01T00:00:00.000Z" });
    const fresh = session({ title: "fresh", lastActivityAt: "2026-07-20T00:00:00.000Z" });
    const groups = groupSessions([stale, fresh]);
    expect(groups.active.map((item) => item.title)).toEqual(["fresh", "stale"]);
  });

  it("splits archived sessions into their own group even when pinned", () => {
    const archivedPinned = session({ title: "archived-pinned", pinnedAt: "2026-07-11T00:00:00.000Z", archivedAt: "2026-07-15T00:00:00.000Z" });
    const archived = session({ title: "archived", archivedAt: "2026-07-14T00:00:00.000Z" });
    const active = session({ title: "active" });
    const groups = groupSessions([archivedPinned, active, archived]);
    expect(groups.pinned).toEqual([]);
    expect(groups.active.map((item) => item.title)).toEqual(["active"]);
    expect(groups.archived.map((item) => item.title)).toEqual(["archived-pinned", "archived"]);
  });

  it("drops deleted sessions from every group", () => {
    const softDeleted = session({ deletedAt: "2026-07-16T00:00:00.000Z", status: "deleted" });
    const groups = groupSessions([softDeleted, session()]);
    expect(groups.pinned).toEqual([]);
    expect(groups.active).toHaveLength(1);
    expect(groups.archived).toEqual([]);
  });
});

describe("applySessionSnapshot", () => {
  it("inserts an unknown session at the end", () => {
    const existing = session();
    const incoming = session();
    const next = applySessionSnapshot([existing], incoming);
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual(incoming);
  });

  it("replaces the matching entity so the revision chain stays current", () => {
    const base = session({ revision: 3, title: "before" });
    const updated = { ...base, revision: 4, title: "after", status: "running" as const };
    const next = applySessionSnapshot([session(), base], updated);
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual(updated);
    expect(next[1]?.revision).toBe(4);
  });
});

describe("fallbackSession", () => {
  it("prefers pinned sessions, then the most recently active one", () => {
    const pinned = session({ pinnedAt: "2026-07-11T00:00:00.000Z" });
    const fresh = session({ lastActivityAt: "2026-07-20T00:00:00.000Z" });
    expect(fallbackSession([fresh, pinned], "missing")?.id).toBe(pinned.id);
    expect(fallbackSession([fresh], "missing")?.id).toBe(fresh.id);
  });

  it("ignores the excluded session and archived leftovers", () => {
    const leaving = session();
    const archived = session({ archivedAt: "2026-07-16T00:00:00.000Z" });
    expect(fallbackSession([leaving, archived], leaving.id)).toBeUndefined();
    expect(fallbackSession([], leaving.id)).toBeUndefined();
  });
});

describe("isRevisionConflict", () => {
  it("narrows the 409 payload shape", () => {
    expect(isRevisionConflict({ code: "REVISION_CONFLICT", error: "x", expectedRevision: 3, actualRevision: 4 })).toBe(true);
    expect(isRevisionConflict({ code: "SESSION_NOT_FOUND" })).toBe(false);
    expect(isRevisionConflict({ error: "boom" })).toBe(false);
    expect(isRevisionConflict(undefined)).toBe(false);
    expect(isRevisionConflict(null)).toBe(false);
  });
});

describe("normalizeSessionQuery", () => {
  it("trims and collapses whitespace, empty means not searching", () => {
    expect(normalizeSessionQuery("  meta   ads ")).toBe("meta ads");
    expect(normalizeSessionQuery("   ")).toBe("");
    expect(normalizeSessionQuery("")).toBe("");
  });
});

describe("buildSessionListUrl", () => {
  it("omits the query parameter when the search term normalizes to empty", () => {
    expect(buildSessionListUrl("personal")).toBe("/api/clients/personal/sessions");
    expect(buildSessionListUrl("personal", { q: "   " })).toBe("/api/clients/personal/sessions");
  });

  it("encodes both the client id and the debounced search term", () => {
    expect(buildSessionListUrl("client/a", { q: "cpa 异常" })).toBe(
      `/api/clients/${encodeURIComponent("client/a")}/sessions?q=${encodeURIComponent("cpa 异常")}`
    );
  });

  it("debounces at a quarter second", () => {
    expect(SESSION_SEARCH_DEBOUNCE_MS).toBe(250);
  });
});
