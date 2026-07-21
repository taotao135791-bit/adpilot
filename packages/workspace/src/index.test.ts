import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "./index.js";

describe("WorkspaceStore", () => {
  it("creates and reads an isolated client workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-workspace-"));
    const store = new WorkspaceStore(root);
    await store.initializeClient({
      profile: { id: "client-a", name: "Example", industry: "gaming", timezone: "Asia/Shanghai" },
      kpi: { primary: "CPA", target: 12, currency: "USD" },
      accounts: { accounts: [{ platform: "google_ads", accountRef: "acct-1", browserProfile: "client-a", allowedDomains: ["ads.google.com"] }] }
    });
    const client = await store.readClient("client-a");
    expect(client.kpi.target).toBe(12);
    expect((await store.listClients())[0]?.id).toBe("client-a");
  });

  it("rejects cross-client paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-workspace-"));
    const store = new WorkspaceStore(root);
    await expect(store.writeJson("../client-b", "x.json", {})).rejects.toThrow();
    await expect(store.writeJson("client-a", "../client-b/x.json", {})).rejects.toThrow();
  });
});

