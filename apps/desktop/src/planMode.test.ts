import { describe, expect, it } from "vitest";
import { normalizePlanMode, planModeEndpoint, planModeRequestBody } from "./planMode.js";

describe("planModeEndpoint", () => {
  it("builds the conversation-scoped endpoint with encoded ids", () => {
    expect(planModeEndpoint("client-a", "primary")).toBe("/api/clients/client-a/conversations/primary/plan-mode");
    expect(planModeEndpoint("client/a", "会话 1")).toBe(
      `/api/clients/${encodeURIComponent("client/a")}/conversations/${encodeURIComponent("会话 1")}/plan-mode`
    );
  });
});

describe("planModeRequestBody", () => {
  it("posts the desired state, never a toggle verb", () => {
    expect(JSON.parse(planModeRequestBody(true))).toEqual({ enabled: true });
    expect(JSON.parse(planModeRequestBody(false))).toEqual({ enabled: false });
  });
});

describe("normalizePlanMode", () => {
  it("passes through an enabled server payload", () => {
    expect(normalizePlanMode({ clientId: "c", conversationId: "p", enabled: true, updatedAt: "2026-07-27T00:00:00.000Z", actor: "workspace-owner" }))
      .toEqual({ enabled: true, updatedAt: "2026-07-27T00:00:00.000Z", actor: "workspace-owner" });
  });

  it("fails closed to off for disabled, missing or malformed payloads", () => {
    const off = { enabled: false, updatedAt: "", actor: "" };
    expect(normalizePlanMode({ enabled: false })).toEqual(off);
    expect(normalizePlanMode(undefined)).toEqual(off);
    expect(normalizePlanMode(null)).toEqual(off);
    expect(normalizePlanMode("enabled")).toEqual(off);
    expect(normalizePlanMode({ enabled: "yes" })).toEqual(off);
  });
});
