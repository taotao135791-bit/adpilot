import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceWriterLease, WorkspaceWriterLeaseHeldError } from "@adpilot/session-service";
import { ConversationMessage } from "@adpilot/shared";
import { WorkspaceStore } from "@adpilot/workspace";
import { createAdPilotSystem } from "./index.js";

describe("session authority composition", () => {
  it("boots the Session authority, imports legacy conversations once, and stays idempotent across recompositions", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-session-authority-"));
    const seedWorkspace = new WorkspaceStore(root);
    await seedWorkspace.initializeClient({
      profile: { id: "client-a", name: "Client A" },
      kpi: { primary: "CPA", target: 10, currency: "USD" }
    });
    for (const [conversationId, content, at] of [
      ["primary", "hello", "2026-07-20T00:00:00.000Z"],
      ["campaign-review", "review me", "2026-07-21T00:00:00.000Z"]
    ] as const) {
      await seedWorkspace.appendJsonl("client-a", "conversation.jsonl", {
        id: crypto.randomUUID(),
        clientId: "client-a",
        conversationId,
        role: "user",
        content,
        at
      });
    }

    const first = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    expect(first.sessionAuthority.migration).toMatchObject({ created: 2, reused: 0, skippedPurged: 0 });
    const imported = await first.sessions.list({ clientId: "client-a" });
    expect(imported.map((session) => session.runtimeConversationId).sort()).toEqual(["campaign-review", "primary"]);
    expect(imported.every((session) => session.legacy?.clientId === "client-a" && session.status === "idle")).toBe(true);
    const importedIds = imported.map((session) => session.id).sort();

    // A second composition over the same workspace shares the process-wide
    // writer lease and the migration is a no-op: no duplicates, same ids.
    const second = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    expect(second.sessionAuthority.migration.created).toBe(0);
    expect(second.sessionAuthority.migration.reused).toBe(2);
    expect((await second.sessions.list({ clientId: "client-a" })).map((session) => session.id).sort()).toEqual(importedIds);
    // Legacy data is left untouched.
    const legacyRows = await second.workspace.readJsonl("client-a", "conversation.jsonl", ConversationMessage);
    expect(legacyRows).toHaveLength(2);
  });

  it("fails loudly when a live foreign process holds the workspace writer lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-session-lease-held-"));
    const foreign = await WorkspaceWriterLease.acquire(root, { owner: "foreign-daemon" });
    try {
      await expect(createAdPilotSystem({ workspaceRoot: root, env: {} })).rejects.toBeInstanceOf(WorkspaceWriterLeaseHeldError);
    } finally {
      await foreign.release();
    }
    // Once the foreign holder releases, the same workspace boots normally.
    const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    expect(system.sessions).toBeDefined();
  });

  it("resets sessions left running by a previous daemon life to failed with an audit record", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-session-interrupted-"));
    const first = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    await first.workspace.initializeClient({
      profile: { id: "client-a", name: "Client A" },
      kpi: { primary: "CPA", target: 10, currency: "USD" }
    });
    const running = await first.sessions.create({ clientId: "client-a", title: "in flight" });
    await first.sessions.setStatus(running.id, "running");
    const idle = await first.sessions.create({ clientId: "client-a", title: "calm" });

    const restarted = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    expect(restarted.sessionAuthority.interruptedSessionIds).toEqual([running.id]);
    expect((await restarted.sessions.require(running.id)).status).toBe("failed");
    expect((await restarted.sessions.require(idle.id)).status).toBe("idle");
    const audit = await restarted.audit.list("client-a");
    expect(audit).toContainEqual(expect.objectContaining({
      action: "session_run_interrupted",
      status: "failed",
      sessionId: running.id
    }));
  });
});
