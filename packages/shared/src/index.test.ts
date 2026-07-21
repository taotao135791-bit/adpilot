import { describe, expect, it } from "vitest";
import { assertSafeIdentifier, PermissionLevel, stableJson, TaskState } from "./index.js";

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
});

