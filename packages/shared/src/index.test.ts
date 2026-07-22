import { describe, expect, it } from "vitest";
import { assertSafeIdentifier, PermissionLevel, SharedFact, SharedFactStatus, stableJson, TaskState } from "./index.js";

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
      "observed", "verified", "disputed", "rejected", "superseded", "expired"
    ]);
    const taskId = crypto.randomUUID();
    expect(SharedFact.parse({
      fact_id: "measurement.purchase_count",
      source: "backend_export",
      evidence: ["export:payments-2026-07-21.csv"],
      confidence: 0.98,
      status: "verified",
      created_by: "measurement_reviewer",
      verified_by: ["root_agent"],
      task_id: taskId,
      expires_at: null,
      value: 42
    })).toMatchObject({ task_id: taskId, status: "verified", value: 42 });
    expect(() => SharedFact.parse({
      fact_id: "measurement.purchase_count",
      source: "backend_export",
      evidence: ["export:payments-2026-07-21.csv"],
      confidence: 0.98,
      status: "verified",
      created_by: "measurement_reviewer",
      verified_by: [],
      task_id: taskId,
      expires_at: null,
      value: 42
    })).toThrow("verified facts require at least one verifier");
  });
});
