import { describe, expect, it } from "vitest";
import {
  classifyPluginActionError,
  formatLogTime,
  groupPlugins,
  isAdvertisingMutation,
  isCatalogUnavailable,
  permissionDiffRows,
  pluginActionBody,
  pluginActionUrl,
  pluginDetailsUrl,
  pluginPrimaryCategory,
  pluginReviewTone,
  pluginRisk,
  pluginStatusTone,
  riskTone,
  sortPermissionsByRisk,
  truncateFingerprint,
  type PluginCatalogItem,
  type PluginPermissionDto,
  type PluginUpdate
} from "./plugins.js";

function permission(overrides: Partial<PluginPermissionDto>): PluginPermissionDto {
  return {
    key: "storage",
    category: "storage",
    title: "Use isolated plugin storage",
    description: "",
    risk: "low",
    requiresReviewWhenAdded: true,
    ...overrides
  };
}

function item(overrides: Partial<PluginCatalogItem>): PluginCatalogItem {
  return {
    id: "acme.demo",
    name: "Demo",
    description: "",
    developer: "Acme",
    latestVersion: "1.0.0",
    tools: [],
    permissions: [],
    signature: { signed: true, keyId: "curated-ed25519" },
    review: { status: "approved" },
    installed: null,
    update: null,
    ...overrides
  };
}

const ADS_MUTATION = permission({
  key: "advertisingMutation",
  category: "advertising",
  title: "Change advertising data",
  risk: "critical"
});
const NETWORK = permission({ key: "network:api.example.com", category: "network", title: "Connect to api.example.com", risk: "high" });
const FS = permission({ key: "filesystem:read.text", category: "filesystem", title: "Read approved text files", risk: "medium" });
const STORAGE = permission({ key: "storage" });

describe("groupPlugins", () => {
  it("splits installed from curated and sorts each section", () => {
    const groups = groupPlugins([
      item({ id: "zeta.one", name: "Zeta" }),
      item({ id: "beta.two", name: "Beta", installed: { status: "active", version: "1.0.0" } }),
      item({ id: "alpha.three", name: "Alpha", installed: { status: "disabled", version: "1.0.0" } })
    ]);
    expect(groups.installed.map((plugin) => plugin.id)).toEqual(["alpha.three", "beta.two"]);
    expect(groups.curated.map((plugin) => plugin.id)).toEqual(["zeta.one"]);
  });

  it("floats plugins with an available update to the top of the installed section", () => {
    const update: PluginUpdate = {
      version: "2.0.0",
      permissionDiff: { added: [], removed: [], hasNewPermissions: false },
      requiresApproval: false
    };
    const groups = groupPlugins([
      item({ id: "a.one", name: "Aardvark", installed: { status: "active", version: "1.0.0" } }),
      item({ id: "z.two", name: "Zebra", installed: { status: "active", version: "1.0.0" }, update })
    ]);
    expect(groups.installed.map((plugin) => plugin.id)).toEqual(["z.two", "a.one"]);
  });

  it("handles an empty catalog", () => {
    expect(groupPlugins([])).toEqual({ installed: [], curated: [] });
  });
});

describe("pluginRisk", () => {
  it("returns the highest declared risk", () => {
    expect(pluginRisk([STORAGE, ADS_MUTATION, FS])).toBe("critical");
    expect(pluginRisk([STORAGE, FS])).toBe("medium");
    expect(pluginRisk([])).toBe("low");
  });
});

describe("riskTone", () => {
  it("maps risk levels onto badge tones", () => {
    expect(riskTone("critical")).toBe("danger");
    expect(riskTone("high")).toBe("warning");
    expect(riskTone("medium")).toBe("accent");
    expect(riskTone("low")).toBe("neutral");
    expect(riskTone("unknown")).toBe("neutral");
  });
});

describe("sortPermissionsByRisk", () => {
  it("orders most-dangerous-first with a stable title tiebreak, without mutating the input", () => {
    const input = [STORAGE, ADS_MUTATION, NETWORK];
    const sorted = sortPermissionsByRisk(input);
    expect(sorted.map((entry) => entry.key)).toEqual(["advertisingMutation", "network:api.example.com", "storage"]);
    expect(input.map((entry) => entry.key)).toEqual(["storage", "advertisingMutation", "network:api.example.com"]);
  });
});

describe("isAdvertisingMutation", () => {
  it("flags only the critical advertising grant", () => {
    expect(isAdvertisingMutation(ADS_MUTATION)).toBe(true);
    expect(isAdvertisingMutation(permission({ key: "advertisingRead", category: "advertising", risk: "medium" }))).toBe(false);
    expect(isAdvertisingMutation(permission({ key: "computerUse", category: "computer-use", risk: "critical" }))).toBe(false);
  });
});

describe("pluginPrimaryCategory", () => {
  it("derives the card category from the highest-risk permission", () => {
    expect(pluginPrimaryCategory([STORAGE, NETWORK, FS])).toBe("network");
    expect(pluginPrimaryCategory([])).toBeNull();
  });
});

describe("status and review tones", () => {
  it("maps installed status onto badge tones", () => {
    expect(pluginStatusTone("active")).toBe("success");
    expect(pluginStatusTone("needs_review")).toBe("warning");
    expect(pluginStatusTone("disabled")).toBe("neutral");
  });

  it("maps review status onto badge tones", () => {
    expect(pluginReviewTone("approved")).toBe("success");
    expect(pluginReviewTone("pending")).toBe("warning");
    expect(pluginReviewTone("rejected")).toBe("danger");
    expect(pluginReviewTone("other")).toBe("neutral");
  });
});

describe("permissionDiffRows", () => {
  it("sorts added permissions by risk and summarizes removals as a count", () => {
    const update: PluginUpdate = {
      version: "2.0.0",
      permissionDiff: { added: [STORAGE, ADS_MUTATION], removed: [FS, NETWORK], hasNewPermissions: true },
      requiresApproval: true
    };
    const rows = permissionDiffRows(update);
    expect(rows.added.map((entry) => entry.key)).toEqual(["advertisingMutation", "storage"]);
    expect(rows.removedCount).toBe(2);
    expect(rows.hasNewPermissions).toBe(true);
  });
});

describe("truncateFingerprint", () => {
  it("keeps head and tail with an ellipsis for long values", () => {
    const value = "sha256:" + "a".repeat(64);
    const truncated = truncateFingerprint(value);
    expect(truncated.startsWith("sha256:aaa")).toBe(true);
    expect(truncated.endsWith("aaaaaaaa")).toBe(true);
    expect(truncated).toContain("…");
    expect(truncated.length).toBeLessThan(value.length);
  });

  it("passes short values through untouched", () => {
    expect(truncateFingerprint("short")).toBe("short");
  });
});

describe("formatLogTime", () => {
  it("renders HH:MM:SS and passes malformed values through", () => {
    const rendered = formatLogTime("2026-07-27T14:05:09.000Z");
    expect(rendered).toMatch(/^\d{2}:\d{2}:09$/);
    expect(formatLogTime("not-a-date")).toBe("not-a-date");
  });
});

describe("request builders", () => {
  it("builds encoded detail and action URLs", () => {
    expect(pluginDetailsUrl("acme.demo")).toBe("/api/plugins/acme.demo");
    expect(pluginActionUrl("acme.demo", "update")).toBe("/api/plugins/acme.demo/update");
  });

  it("shapes the mutation body with workspace context and consent flags", () => {
    expect(JSON.parse(pluginActionBody({ clientId: "c-1" }))).toEqual({ clientId: "c-1", actor: "workspace-owner" });
    expect(JSON.parse(pluginActionBody({}))).toEqual({ actor: "workspace-owner" });
    expect(JSON.parse(pluginActionBody({ clientId: "c-1", allowUnsigned: true }))).toEqual({
      clientId: "c-1",
      actor: "workspace-owner",
      allowUnsigned: true
    });
    expect(JSON.parse(pluginActionBody({ clientId: "c-1", acceptPermissions: true }))).toEqual({
      clientId: "c-1",
      actor: "workspace-owner",
      acceptPermissions: true
    });
  });
});

describe("classifyPluginActionError", () => {
  const update: PluginUpdate = {
    version: "2.0.0",
    permissionDiff: { added: [ADS_MUTATION], removed: [], hasNewPermissions: true },
    requiresApproval: true
  };

  it("opens the permission-review consent flow on a 409 with an update diff", () => {
    const block = classifyPluginActionError(409, { code: "PLUGIN_PERMISSION_REVIEW_REQUIRED", error: "review required", update }, "fallback");
    expect(block).toEqual({ kind: "permission-review", update, message: "review required" });
  });

  it("opens the unsigned high-risk flow on a 403 UNSIGNED_REJECTED", () => {
    const block = classifyPluginActionError(403, { code: "UNSIGNED_REJECTED", error: "unsigned" }, "fallback");
    expect(block).toEqual({ kind: "unsigned", message: "unsigned" });
  });

  it("never offers a confirm path for other trust violations or malformed payloads", () => {
    expect(classifyPluginActionError(403, { code: "SIGNATURE_INVALID", error: "bad sig" }, "fallback"))
      .toEqual({ kind: "failed", message: "bad sig" });
    expect(classifyPluginActionError(409, { code: "PLUGIN_PERMISSION_REVIEW_REQUIRED", error: "no diff" }, "fallback"))
      .toEqual({ kind: "failed", message: "no diff" });
    expect(classifyPluginActionError(500, undefined, "fallback"))
      .toEqual({ kind: "failed", message: "fallback" });
  });
});

describe("isCatalogUnavailable", () => {
  it("detects the degraded subsystem response", () => {
    expect(isCatalogUnavailable(503, { code: "PLUGIN_CATALOG_UNAVAILABLE" })).toBe(true);
    expect(isCatalogUnavailable(503, { code: "CURATED_ROOT_MISSING" })).toBe(true);
    expect(isCatalogUnavailable(500, { code: "PLUGIN_CATALOG_UNAVAILABLE" })).toBe(false);
    expect(isCatalogUnavailable(503, undefined)).toBe(false);
  });
});
