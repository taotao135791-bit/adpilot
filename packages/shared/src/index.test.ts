import { describe, expect, it } from "vitest";
import {
  assertSafeIdentifier,
  InMemorySharedFactRepository,
  migrateLegacyFactDispatch,
  PermissionLevel,
  SharedFact,
  SharedFactLedger,
  SharedFactStatus,
  stableJson,
  TaskState
} from "./index.js";

describe("shared contracts", () => {
  it("accepts only explicit permission levels", () => {
    expect(PermissionLevel.parse("OBSERVE")).toBe("OBSERVE");
    expect(() => PermissionLevel.parse("ADMIN")).toThrow();
  });

  it("prevents workspace path traversal", () => {
    expect(assertSafeIdentifier("client_01-prod")).toBe("client_01-prod");
    expect(() => assertSafeIdentifier("../other-client")).toThrow();
  });

  it("serializes equivalent objects deterministically", () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it("rejects incomplete task state", () => {
    expect(() => TaskState.parse({ goal: "Improve CPA" })).toThrow();
  });

  it("defines the complete shared-fact lifecycle and verifier contract", () => {
    expect(SharedFactStatus.options).toEqual([
      "hypothesis", "observed", "verified", "rejected", "stale", "superseded"
    ]);
    const taskId = crypto.randomUUID();
    expect(SharedFact.parse({
      factId: "measurement.purchase_count",
      clientId: "client-a",
      taskId,
      subject: "campaign-a",
      predicate: "purchase_count",
      value: 42,
      unit: "conversions",
      sourceType: "visual_table",
      sourceScreenshotId: "screen-1",
      sourceBoundingBox: [10, 20, 30, 40],
      evidenceIds: ["screenshot:screen-1"],
      confidence: 0.98,
      status: "verified",
      createdBy: "visual_table_reader",
      verifiedBy: ["visual_verifier"],
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:01.000Z",
      verifiedAt: "2026-07-22T00:00:01.000Z",
      expiresAt: null
    })).toMatchObject({ taskId, status: "verified", value: 42, sourceScreenshotId: "screen-1" });
    expect(() => SharedFact.parse({
      factId: "measurement.purchase_count",
      clientId: "client-a",
      taskId,
      subject: "campaign-a",
      predicate: "purchase_count",
      value: 42,
      unit: "conversions",
      sourceType: "visual_table",
      sourceScreenshotId: "screen-1",
      sourceBoundingBox: [10, 20, 30, 40],
      confidence: 0.98,
      status: "verified",
      createdBy: "visual_table_reader",
      verifiedBy: [],
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:01.000Z",
      expiresAt: null
    })).toThrow("verified facts require at least one verifier");
  });

  it("moves observed facts through verified, superseded, stale, and expiry states", async () => {
    let now = new Date("2026-07-22T00:00:00.000Z");
    const repository = new InMemorySharedFactRepository();
    const ledger = new SharedFactLedger(repository, { now: () => now });
    const taskId = crypto.randomUUID();
    const draft = {
      clientId: "client-a", taskId, subject: "campaign-a", predicate: "daily_budget", value: 100, unit: "USD",
      sourceType: "visual_table" as const, sourceScreenshotId: "screen-1", sourceBoundingBox: [10, 20, 30, 40] as [number, number, number, number],
      evidenceIds: ["screenshot:screen-1"], confidence: 0.96, createdBy: "visual_table_reader", expiresAt: "2026-07-22T00:10:00.000Z"
    };
    const first = await ledger.observe(draft);
    expect(first.status).toBe("observed");
    const verified = await ledger.verify("client-a", first.factId, { verifier: "visual_verifier", confidence: 0.93 });
    expect(verified).toMatchObject({ status: "verified", verifiedBy: ["visual_verifier"] });
    expect(await ledger.usable("client-a", { taskId })).toHaveLength(1);

    now = new Date("2026-07-22T00:01:00.000Z");
    const second = await ledger.observe({ ...draft, sourceScreenshotId: "screen-2", evidenceIds: ["screenshot:screen-2"], value: 110 });
    await ledger.verify("client-a", second.factId, { verifier: "visual_verifier", confidence: 0.94 });
    const afterReplacement = await ledger.list("client-a", { taskId, includeTerminal: true });
    expect(afterReplacement.find((fact) => fact.factId === first.factId)).toMatchObject({ status: "superseded", supersededByFactId: second.factId });

    now = new Date("2026-07-22T00:11:00.000Z");
    expect(await ledger.usable("client-a", { taskId })).toHaveLength(0);
    expect((await ledger.list("client-a", { taskId, includeTerminal: true })).find((fact) => fact.factId === second.factId)).toMatchObject({ status: "stale", statusReason: "fact expired" });
  });

  it("marks a previously verified fact stale when its visual surface changes", async () => {
    const ledger = new SharedFactLedger();
    const taskId = crypto.randomUUID();
    const observed = await ledger.observe({
      clientId: "client-a", taskId, subject: "campaign-a", predicate: "bid", value: 2.5, unit: "USD",
      sourceType: "visual_table", sourceScreenshotId: "screen-1", sourceBoundingBox: [10, 20, 30, 40],
      evidenceIds: ["screenshot:screen-1"], confidence: 0.96, createdBy: "visual_table_reader", expiresAt: null
    });
    await ledger.verify("client-a", observed.factId, { verifier: "visual_verifier", confidence: 0.95 });
    const [stale] = await ledger.invalidateVisualEvidence("client-a", {
      taskId, sourceScreenshotIds: ["screen-1"], reason: "bound browser surface changed"
    });
    expect(stale).toMatchObject({ status: "stale", statusReason: "bound browser surface changed" });
    expect(await ledger.usable("client-a", { taskId })).toEqual([]);
  });

  it("keeps legacy fact dispatch in a migration-only observed state", async () => {
    const taskId = crypto.randomUUID();
    const migrated = migrateLegacyFactDispatch({ targetCpa: 10, messages: ["private transcript"] }, {
      clientId: "client-a", taskId, now: "2026-07-22T00:00:00.000Z"
    });
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ factId: "legacy.targetCpa", sourceType: "migration", status: "observed", value: 10 });
    const ledger = new SharedFactLedger();
    await ledger.observe({
      clientId: "client-a", taskId, subject: "legacy", predicate: "value", value: 10, unit: "",
      sourceType: "migration", sourceScreenshotId: null, sourceBoundingBox: null, evidenceIds: [], confidence: 0.5,
      createdBy: "migration", expiresAt: null
    });
    const stored = await ledger.list("client-a", { taskId });
    await expect(ledger.verify("client-a", stored[0]!.factId, { verifier: "reviewer", confidence: 0.9 })).rejects.toThrow("cannot enter");
    expect(await ledger.usable("client-a", { taskId })).toEqual([]);
  });
});
