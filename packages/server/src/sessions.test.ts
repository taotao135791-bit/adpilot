import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { createAdPilotSystem, type AdPilotSystem, type ProductEvent } from "@adpilot/application";
import { resolvePiSessionId } from "@adpilot/runtime";
import { ConversationMessage } from "@adpilot/shared";
import { createServer } from "./index.js";

const answer = (reply: string) => fauxAssistantMessage(JSON.stringify({ mode: "answer", reply, goal: null }));

function sessionEventStatuses(system: AdPilotSystem, clientId: string, sessionId: string): string[] {
  return system.events
    .history(clientId)
    .filter((event): event is Extract<ProductEvent, { type: "session" }> => event.type === "session" && event.sessionId === sessionId)
    .map((event) => event.status);
}

async function createFauxSystem(root: string, options: { withClient?: boolean } = {}) {
  const faux = fauxProvider({ provider: "test", models: [{ id: "code", input: ["text", "image"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const system = await createAdPilotSystem({
    workspaceRoot: root,
    env: { ADPILOT_FAST_PROVIDER: "test", ADPILOT_FAST_MODEL: "code", ADPILOT_STRONG_PROVIDER: "test", ADPILOT_STRONG_MODEL: "code" },
    models
  });
  if (options.withClient !== false) {
    await system.workspace.initializeClient({ profile: { id: "client-a", name: "Example" }, kpi: { primary: "CPA", target: 10 } });
  }
  const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
  return { faux, models, system, server };
}

async function createSession(server: Awaited<ReturnType<typeof createServer>>, payload: Record<string, unknown> = {}) {
  const response = await server.inject({ method: "POST", url: "/api/clients/client-a/sessions", payload: { title: "Session", ...payload } });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function conversationRows(system: AdPilotSystem, clientId: string) {
  return system.workspace.readJsonl(clientId, "conversation.jsonl", ConversationMessage);
}

describe("session REST authority", () => {
  it("creates, lists with filters and search, reads, patches with optimistic revision, and audits", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-sessions-crud-"));
    const { system, server } = await createFauxSystem(root);

    const created = await createSession(server, { title: "Weekly review", tags: ["report"] });
    expect(created).toMatchObject({
      clientId: "client-a",
      title: "Weekly review",
      status: "idle",
      revision: 1,
      modelBinding: { mode: "router", route: "fast" },
      permissionProfile: { level: "OBSERVE" }
    });
    expect(created.pinnedAt ?? null).toBeNull();
    expect(created.runtimeConversationId).toBeTruthy();
    const persisted = await system.sessions.require(created.id);
    expect(persisted.title).toBe("Weekly review");

    const other = await createSession(server, { title: "Budget triage" });

    const list = await server.inject({ method: "GET", url: "/api/clients/client-a/sessions" });
    expect(list.json().sessions.map((session: { id: string }) => session.id).sort()).toEqual([created.id, other.id].sort());
    const searched = await server.inject({ method: "GET", url: "/api/clients/client-a/sessions?q=triage" });
    expect(searched.json().sessions.map((session: { id: string }) => session.id)).toEqual([other.id]);
    const idleOnly = await server.inject({ method: "GET", url: "/api/clients/client-a/sessions?status=idle" });
    expect(idleOnly.json().sessions).toHaveLength(2);
    const completedOnly = await server.inject({ method: "GET", url: "/api/clients/client-a/sessions?status=completed" });
    expect(completedOnly.json().sessions).toHaveLength(0);

    const fetched = await server.inject({ method: "GET", url: `/api/clients/client-a/sessions/${created.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().id).toBe(created.id);
    const missing = await server.inject({ method: "GET", url: `/api/clients/client-a/sessions/${crypto.randomUUID()}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("SESSION_NOT_FOUND");

    const stale = await server.inject({ method: "PATCH", url: `/api/clients/client-a/sessions/${created.id}`, payload: { revision: 99, title: "nope" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "REVISION_CONFLICT", expectedRevision: 99, actualRevision: 1 });

    const patched = await server.inject({ method: "PATCH", url: `/api/clients/client-a/sessions/${created.id}`, payload: { revision: 1, title: "Weekly review 2", pinned: true } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ title: "Weekly review 2", revision: 3 });
    expect(patched.json().pinnedAt).toBeTruthy();

    const pinnedOnly = await server.inject({ method: "GET", url: "/api/clients/client-a/sessions?pinned=true" });
    expect(pinnedOnly.json().sessions.map((session: { id: string }) => session.id)).toEqual([created.id]);
    const unpinnedOnly = await server.inject({ method: "GET", url: "/api/clients/client-a/sessions?pinned=false" });
    expect(unpinnedOnly.json().sessions.map((session: { id: string }) => session.id)).toEqual([other.id]);

    const emptyPatch = await server.inject({ method: "PATCH", url: `/api/clients/client-a/sessions/${created.id}`, payload: { revision: 3 } });
    expect(emptyPatch.statusCode).toBe(400);

    // A non-default permission profile is an escalation: without a verified
    // approval the create is rejected with the mapped 409.
    const escalation = await server.inject({ method: "POST", url: "/api/clients/client-a/sessions", payload: { title: "Escalated", permissionProfile: { level: "EXECUTE" } } });
    expect(escalation.statusCode).toBe(409);
    expect(escalation.json().code).toBe("PERMISSION_ESCALATION_REQUIRES_APPROVAL");

    const invalidPlatform = await server.inject({ method: "POST", url: "/api/clients/client-a/sessions", payload: { title: "Bad", platforms: ["not_a_platform"] } });
    expect(invalidPlatform.statusCode).toBe(400);

    const audit = await system.audit.list("client-a");
    expect(audit).toContainEqual(expect.objectContaining({ action: "session_create", sessionId: created.id, status: "succeeded" }));
    expect(audit).toContainEqual(expect.objectContaining({ action: "session_update", sessionId: created.id, status: "succeeded" }));
    await server.close();
  });

  it("hides cross-client sessions behind 404", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-sessions-cross-client-"));
    const { system, server } = await createFauxSystem(root);
    await system.workspace.initializeClient({ profile: { id: "client-b", name: "Other" }, kpi: { primary: "CPA", target: 5 } });
    const created = await createSession(server);
    const crossGet = await server.inject({ method: "GET", url: `/api/clients/client-b/sessions/${created.id}` });
    expect(crossGet.statusCode).toBe(404);
    const crossPatch = await server.inject({ method: "PATCH", url: `/api/clients/client-b/sessions/${created.id}`, payload: { revision: 1, title: "x" } });
    expect(crossPatch.statusCode).toBe(404);
    expect(crossPatch.json().code).toBe("SESSION_NOT_FOUND");
    await server.close();
  });

  it("archives, unarchives, soft-deletes and restores with filters and events", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-sessions-lifecycle-"));
    const { system, server } = await createFauxSystem(root);
    const session = await createSession(server);

    const archived = await server.inject({ method: "POST", url: `/api/clients/client-a/sessions/${session.id}/archive`, payload: {} });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archivedAt).toBeTruthy();
    const activeOnly = await server.inject({ method: "GET", url: "/api/clients/client-a/sessions?archived=false" });
    expect(activeOnly.json().sessions).toHaveLength(0);
    const archivedOnly = await server.inject({ method: "GET", url: "/api/clients/client-a/sessions?archived=true" });
    expect(archivedOnly.json().sessions.map((row: { id: string }) => row.id)).toEqual([session.id]);

    const unarchived = await server.inject({ method: "POST", url: `/api/clients/client-a/sessions/${session.id}/unarchive`, payload: {} });
    expect(unarchived.json().archivedAt ?? null).toBeNull();

    const deleted = await server.inject({ method: "DELETE", url: `/api/clients/client-a/sessions/${session.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ status: "deleted" });
    expect(deleted.json().deletedAt).toBeTruthy();
    const listed = await server.inject({ method: "GET", url: "/api/clients/client-a/sessions" });
    expect(listed.json().sessions).toHaveLength(0);
    const getDeleted = await server.inject({ method: "GET", url: `/api/clients/client-a/sessions/${session.id}` });
    expect(getDeleted.statusCode).toBe(404);
    const getDeletedIncluded = await server.inject({ method: "GET", url: `/api/clients/client-a/sessions/${session.id}?deleted=true` });
    expect(getDeletedIncluded.statusCode).toBe(200);

    const restored = await server.inject({ method: "POST", url: `/api/clients/client-a/sessions/${session.id}/restore`, payload: {} });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().status).toBe("idle");
    expect(restored.json().deletedAt ?? null).toBeNull();

    const staleArchive = await server.inject({ method: "POST", url: `/api/clients/client-a/sessions/${session.id}/archive`, payload: { revision: 1 } });
    expect(staleArchive.statusCode).toBe(409);
    expect(staleArchive.json().code).toBe("REVISION_CONFLICT");

    const events = sessionEventStatuses(system, "client-a", session.id);
    expect(events).toEqual(expect.arrayContaining(["created", "archived", "unarchived", "deleted", "restored"]));
    const audit = await system.audit.list("client-a");
    for (const action of ["session_archive", "session_unarchive", "session_delete", "session_restore"]) {
      expect(audit).toContainEqual(expect.objectContaining({ action, sessionId: session.id }));
    }
    await server.close();
  });

  it("duplicates a session with its Pi history and transcript into a fresh identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-sessions-duplicate-"));
    const { faux, system, server } = await createFauxSystem(root);
    const source = await createSession(server, { title: "Source" });
    faux.setResponses([answer("source reply")]);
    const sent = await server.inject({ method: "POST", url: "/api/messages", payload: { clientId: "client-a", sessionId: source.id, message: "remember ALPHA", locale: "en" } });
    expect(sent.statusCode).toBe(201);

    const duplicated = await server.inject({ method: "POST", url: `/api/clients/client-a/sessions/${source.id}/duplicate`, payload: {} });
    expect(duplicated.statusCode).toBe(201);
    const copy = duplicated.json();
    expect(copy.id).not.toBe(source.id);
    expect(copy.runtimeConversationId).not.toBe(source.runtimeConversationId);
    expect(copy).toMatchObject({ title: "Source (copy)", duplicatedFromSessionId: source.id, status: "idle" });

    const rows = (await conversationRows(system, "client-a")).filter((row) => row.conversationId === copy.runtimeConversationId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    const copiedHistory = await system.workspace.readText("client-a", `sessions/${resolvePiSessionId("client-a", copy.runtimeConversationId)}.jsonl`);
    expect(copiedHistory).toBeTruthy();

    // Duplicating an empty session works and skips the history copy.
    const empty = await createSession(server, { title: "Empty" });
    const emptyCopy = await server.inject({ method: "POST", url: `/api/clients/client-a/sessions/${empty.id}/duplicate`, payload: { title: "Empty copy" } });
    expect(emptyCopy.statusCode).toBe(201);
    expect(emptyCopy.json()).toMatchObject({ title: "Empty copy", duplicatedFromSessionId: empty.id });
    await server.close();
  });

  it("branches a session at a message into a new Session with fork provenance and history", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-sessions-branch-"));
    const { faux, system, server } = await createFauxSystem(root);
    const source = await createSession(server, { title: "Base" });
    faux.setResponses([answer("base reply")]);
    await server.inject({ method: "POST", url: "/api/messages", payload: { clientId: "client-a", sessionId: source.id, message: "branch from here", locale: "en" } });
    const rows = await conversationRows(system, "client-a");
    const userMessage = rows.find((row) => row.role === "user");
    expect(userMessage).toBeDefined();

    const branched = await server.inject({ method: "POST", url: `/api/clients/client-a/sessions/${source.id}/branch`, payload: { atMessageId: userMessage!.id } });
    expect(branched.statusCode).toBe(201);
    const branch = branched.json();
    expect(branch.id).not.toBe(source.id);
    expect(branch.runtimeConversationId).not.toBe(source.runtimeConversationId);
    expect(branch).toMatchObject({
      title: "Base (branch)",
      status: "idle",
      branch: { parentSessionId: source.id, rootSessionId: source.id, sourceMessageId: userMessage!.id }
    });

    const branchRows = (await conversationRows(system, "client-a")).filter((row) => row.conversationId === branch.runtimeConversationId);
    expect(branchRows).toHaveLength(1);
    expect(branchRows[0]).toMatchObject({ role: "user", content: "branch from here" });
    const branchHistory = await system.workspace.readText("client-a", `sessions/${resolvePiSessionId("client-a", branch.runtimeConversationId)}.jsonl`);
    expect(branchHistory).toBeTruthy();

    const audit = await system.audit.list("client-a");
    expect(audit).toContainEqual(expect.objectContaining({ action: "session_branch", sessionId: branch.id }));
    expect(audit).toContainEqual(expect.objectContaining({ action: "fork_conversation" }));

    // A branch pointing at an unknown message fails with 404 and leaves no orphan session.
    const before = (await system.sessions.list({ clientId: "client-a" })).length;
    const missing = await server.inject({ method: "POST", url: `/api/clients/client-a/sessions/${source.id}/branch`, payload: { atMessageId: crypto.randomUUID() } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("FORK_TARGET_NOT_FOUND");
    expect(await system.sessions.list({ clientId: "client-a" })).toHaveLength(before);
    await server.close();
  });
});

describe("session message flow", () => {
  it("maps sessionId to its runtimeConversationId and drives the status lifecycle with SSE events", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-session-messages-"));
    const { faux, system, server } = await createFauxSystem(root);
    const session = await createSession(server, { title: "Chat" });
    faux.setResponses([answer("session hello")]);

    const sent = await server.inject({ method: "POST", url: "/api/messages", payload: { clientId: "client-a", sessionId: session.id, message: "hello session", locale: "en" } });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().message).toMatchObject({ role: "assistant", content: "session hello", sessionId: session.id, conversationId: session.runtimeConversationId });

    const rows = (await conversationRows(system, "client-a")).filter((row) => row.conversationId === session.runtimeConversationId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows.every((row) => row.sessionId === session.id)).toBe(true);

    const after = await server.inject({ method: "GET", url: `/api/clients/client-a/sessions/${session.id}` });
    expect(after.json().status).toBe("completed");
    expect(sessionEventStatuses(system, "client-a", session.id)).toEqual(["created", "running", "completed"]);
    await server.close();
  });

  it("resolves the run model from the session binding and fails the session when the pinned model is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-session-model-binding-"));
    const global = fauxProvider({ provider: "test", models: [{ id: "code", input: ["text", "image"] }] });
    const pinned = fauxProvider({ provider: "pinned", models: [{ id: "pinned-model", input: ["text"] }] });
    const models = createModels();
    models.setProvider(global.provider);
    models.setProvider(pinned.provider);
    const system = await createAdPilotSystem({
      workspaceRoot: root,
      env: { ADPILOT_FAST_PROVIDER: "test", ADPILOT_FAST_MODEL: "code", ADPILOT_STRONG_PROVIDER: "test", ADPILOT_STRONG_MODEL: "code" },
      models
    });
    await system.workspace.initializeClient({ profile: { id: "client-a", name: "Example" }, kpi: { primary: "CPA", target: 10 } });
    const server = await createServer(system, { uiRoot: join(root, "missing-ui") });

    const pinnedSession = await createSession(server, { title: "Pinned", modelBinding: { mode: "pinned", providerId: "pinned", modelId: "pinned-model" } });
    global.setResponses([answer("from global model")]);
    pinned.setResponses([answer("from pinned model")]);
    const pinnedRun = await server.inject({ method: "POST", url: "/api/messages", payload: { clientId: "client-a", sessionId: pinnedSession.id, message: "which model?", locale: "en" } });
    expect(pinnedRun.statusCode).toBe(201);
    expect(pinnedRun.json().message.content).toBe("from pinned model");
    expect(global.state.callCount).toBe(0);
    expect(pinned.state.callCount).toBe(1);

    const brokenSession = await createSession(server, { title: "Broken", modelBinding: { mode: "pinned", providerId: "missing", modelId: "nope" } });
    const failed = await server.inject({ method: "POST", url: "/api/messages", payload: { clientId: "client-a", sessionId: brokenSession.id, message: "boom", locale: "en" } });
    expect(failed.statusCode).toBe(502);
    const failedSession = await server.inject({ method: "GET", url: `/api/clients/client-a/sessions/${brokenSession.id}` });
    expect(failedSession.json().status).toBe("failed");
    await server.close();
  });

  it("keeps legacy conversationId callers working and imports their conversation into exactly one Session", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-session-legacy-"));
    const { faux, system, server } = await createFauxSystem(root, { withClient: false });

    faux.setResponses([answer("first legacy reply")]);
    const first = await server.inject({ method: "POST", url: "/api/messages", payload: { conversationId: "legacy-x", message: "hello legacy", locale: "en" } });
    expect(first.statusCode).toBe(201);

    let state = (await server.inject({ method: "GET", url: "/api/state?clientId=personal&conversationId=legacy-x" })).json();
    expect(state.conversations).toContain("legacy-x");
    expect(state.selectedSessionId).toBeTruthy();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ runtimeConversationId: "legacy-x", clientId: "personal", status: "completed" });
    expect(state.sessions[0].legacy).toMatchObject({ clientId: "personal", conversationId: "legacy-x" });
    expect(state.messages[0].sessionId ?? null).toBeNull(); // first user message predates the import
    expect(state.messages[1].sessionId).toBe(state.selectedSessionId);

    faux.setResponses([answer("second legacy reply")]);
    const second = await server.inject({ method: "POST", url: "/api/messages", payload: { conversationId: "legacy-x", message: "still legacy", locale: "en" } });
    expect(second.statusCode).toBe(201);
    state = (await server.inject({ method: "GET", url: "/api/state?clientId=personal&conversationId=legacy-x" })).json();
    expect(state.sessions).toHaveLength(1);
    expect(state.messages).toHaveLength(4);
    expect(state.messages[2].sessionId).toBe(state.selectedSessionId);

    // An explicit sessionId still wins, and mismatched client/session ids are rejected.
    const unknown = await server.inject({ method: "POST", url: "/api/messages", payload: { sessionId: crypto.randomUUID(), message: "hi", locale: "en" } });
    expect(unknown.statusCode).toBe(404);
    const mismatch = await server.inject({ method: "POST", url: "/api/messages", payload: { clientId: "someone-else", sessionId: state.selectedSessionId, message: "hi", locale: "en" } });
    expect(mismatch.statusCode).toBe(404);
    expect(mismatch.json().code).toBe("SESSION_NOT_FOUND");
    await server.close();
  });

  it("exposes sessions alongside legacy conversations in /api/state without breaking existing fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-session-state-"));
    const { faux, server } = await createFauxSystem(root);
    const session = await createSession(server, { title: "State session" });
    faux.setResponses([answer("state reply")]);
    await server.inject({ method: "POST", url: "/api/messages", payload: { clientId: "client-a", sessionId: session.id, message: "state hello", locale: "en" } });

    const state = (await server.inject({ method: "GET", url: `/api/state?clientId=client-a&conversationId=${session.runtimeConversationId}` })).json();
    expect(state.selectedSessionId).toBe(session.id);
    expect(state.sessions.map((row: { id: string }) => row.id)).toEqual([session.id]);
    expect(state.conversations).toEqual([session.runtimeConversationId]);
    expect(state.messages).toHaveLength(2);
    expect(state.clients.map((client: { id: string }) => client.id)).toEqual(["client-a"]);
    await server.close();
  });
});
