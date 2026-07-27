import { describe, expect, it } from "vitest";
import { autonomyEndpoint, autonomyRequestBody, normalizeAutonomy } from "./autonomy.js";

describe("autonomyEndpoint", () => {
  it("builds the workspace-scoped endpoint with an encoded id", () => {
    expect(autonomyEndpoint("client-a")).toBe("/api/clients/client-a/autonomy");
    expect(autonomyEndpoint("client/a")).toBe(`/api/clients/${encodeURIComponent("client/a")}/autonomy`);
  });
});

describe("autonomyRequestBody", () => {
  it("sends the desired mode, never a toggle verb", () => {
    expect(JSON.parse(autonomyRequestBody("guarded"))).toEqual({ mode: "guarded" });
    expect(JSON.parse(autonomyRequestBody("full_access"))).toEqual({ mode: "full_access" });
  });
});

describe("normalizeAutonomy", () => {
  it("passes through a full-access server payload", () => {
    expect(normalizeAutonomy({ mode: "full_access" })).toBe("full_access");
  });

  it("fails closed to guarded for guarded, missing or malformed payloads", () => {
    expect(normalizeAutonomy({ mode: "guarded" })).toBe("guarded");
    expect(normalizeAutonomy({ mode: "everything" })).toBe("guarded");
    expect(normalizeAutonomy({})).toBe("guarded");
    expect(normalizeAutonomy(undefined)).toBe("guarded");
    expect(normalizeAutonomy(null)).toBe("guarded");
    expect(normalizeAutonomy("full_access")).toBe("guarded");
  });
});
