import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "@adpilot/workspace";
import { FileSessionRepository } from "./repository.js";
import { SessionService } from "./service.js";
import { WorkspaceWriterLease } from "./lease.js";

describe("legacy session migration", () => {
  it("is idempotent, persists mappings, preserves runtime conversation ids and ignores only a partial tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-session-migration-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({
      profile: { id: "client-a", name: "Client A" },
      kpi: { primary: "CPA", target: 10, currency: "USD" },
      accounts: {
        accounts: [
          {
            platform: "meta_ads",
            accountRef: "meta-1",
            browserProfile: "meta",
            allowedDomains: ["business.facebook.com"]
          },
          {
            platform: "google_ads",
            accountRef: "google-1",
            browserProfile: "google",
            allowedDomains: ["ads.google.com"]
          }
        ]
      }
    });
    await workspace.appendJsonl("client-a", "conversation.jsonl", {
      id: crypto.randomUUID(),
      clientId: "client-a",
      conversationId: "primary",
      role: "user",
      content: "first",
      at: "2026-07-20T00:00:00.000Z"
    });
    await workspace.appendJsonl("client-a", "conversation.jsonl", {
      id: crypto.randomUUID(),
      clientId: "client-a",
      conversationId: "campaign-review",
      role: "assistant",
      content: "second",
      at: "2026-07-21T00:00:00.000Z"
    });
    await workspace.appendText(
      "client-a",
      "conversation.jsonl",
      "{\"conversationId\":\"partial"
    );
    await workspace.createText(
      "client-a",
      "sessions/pi-sentinel.jsonl",
      "PI-SESSION-MUST-NOT-CHANGE\n"
    );

    const writerLease = await WorkspaceWriterLease.acquire(root, {
      owner: "legacy-migration-test"
    });
    const repository = new FileSessionRepository(workspace, { writerLease });
    const service = new SessionService(repository);
    const first = await service.migrateLegacy(workspace);
    expect(first).toMatchObject({
      created: 2,
      reused: 0,
      warnings: [
        expect.objectContaining({
          clientId: "client-a",
          kind: "partial-tail-ignored",
          line: 3
        })
      ]
    });
    expect(first.mappings.map((mapping) => mapping.runtimeConversationId)).toEqual([
      "campaign-review",
      "primary"
    ]);
    expect(
      (await repository.listSessions()).map((session) => session.runtimeConversationId).sort()
    ).toEqual(["campaign-review", "primary"]);
    expect(
      (await repository.listSessions()).every(
        (session) =>
          session.legacy?.conversationId === session.runtimeConversationId &&
          session.agentProfileId === "adpilot" &&
          session.advertisingWorkspaceId === "client-a" &&
          session.platforms.join(",") === "google_ads,meta_ads" &&
          typeof session.lastOpenedAt === "string"
      )
    ).toBe(true);

    const mappingIds = first.mappings.map((mapping) => mapping.sessionId);
    const restarted = new SessionService(
      new FileSessionRepository(workspace, { writerLease })
    );
    const second = await restarted.migrateLegacy(workspace);
    expect(second.created).toBe(0);
    expect(second.reused).toBe(2);
    expect(second.mappings.map((mapping) => mapping.sessionId)).toEqual(mappingIds);
    expect(await repository.listRecoveryRecords()).toHaveLength(1);
    expect(
      await readFile(
        join(workspace.clientRoot("client-a"), "sessions/pi-sentinel.jsonl"),
        "utf8"
      )
    ).toBe("PI-SESSION-MUST-NOT-CHANGE\n");
    expect(
      (await readdir(repository.recordsRoot)).filter((name) => name.endsWith(".json"))
    ).toHaveLength(2);

    const persistedMapping = JSON.parse(
      await readFile(repository.legacyMappingPath, "utf8")
    ) as Record<string, unknown>;
    expect(persistedMapping).toMatchObject({
      schemaVersion: 1,
      recordKind: "legacy-session-mapping",
      revision: 2
    });
  });

  it("serializes idempotent migration across service instances in one writer process", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-concurrent-migration-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({
      profile: { id: "client-a", name: "Client A" },
      kpi: { primary: "CPA", target: 10, currency: "USD" }
    });
    await workspace.appendJsonl("client-a", "conversation.jsonl", {
      id: crypto.randomUUID(),
      clientId: "client-a",
      conversationId: "primary",
      role: "user",
      content: "hello",
      at: new Date().toISOString()
    });
    const writerLease = await WorkspaceWriterLease.acquire(root, {
      owner: "concurrent-legacy-migration-test"
    });
    const first = new SessionService(
      new FileSessionRepository(workspace, { writerLease })
    );
    const second = new SessionService(
      new FileSessionRepository(workspace, { writerLease })
    );
    const outcomes = await Promise.all([
      first.migrateLegacy(workspace),
      second.migrateLegacy(workspace)
    ]);
    expect(outcomes.reduce((total, outcome) => total + outcome.created, 0)).toBe(1);
    expect(outcomes.reduce((total, outcome) => total + outcome.reused, 0)).toBe(1);
    expect(outcomes[0]?.mappings[0]?.sessionId).toBe(
      outcomes[1]?.mappings[0]?.sessionId
    );
    await expect(first.list()).resolves.toHaveLength(1);
  });

  it("keeps a tombstone so permanent purge is not undone by migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-purged-migration-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({
      profile: { id: "client-a", name: "Client A" },
      kpi: { primary: "CPA", target: 10, currency: "USD" }
    });
    await workspace.appendJsonl("client-a", "conversation.jsonl", {
      id: crypto.randomUUID(),
      clientId: "client-a",
      conversationId: "primary",
      role: "user",
      content: "hello",
      at: new Date().toISOString()
    });
    const writerLease = await WorkspaceWriterLease.acquire(root, {
      owner: "legacy-purge-test"
    });
    const repository = new FileSessionRepository(workspace, { writerLease });
    const service = new SessionService(repository);
    const migrated = await service.migrateLegacy(workspace);
    const sessionId = migrated.mappings[0]!.sessionId;
    const session = await service.require(sessionId);
    const deleted = await service.softDelete(sessionId, session.revision);
    await service.permanentPurge(sessionId, deleted.revision);
    await writeFile(repository.legacyMappingPath, "{\"torn\":", "utf8");

    const rerun = await service.migrateLegacy(workspace);
    expect(rerun).toMatchObject({
      created: 0,
      reused: 0,
      skippedPurged: 1,
      mappings: []
    });
    await expect(repository.getSession(sessionId)).resolves.toBeUndefined();
    await expect(repository.findLegacyMapping("client-a", "primary")).resolves.toMatchObject({
      sessionId,
      purgedAt: expect.any(String)
    });
  });
});
