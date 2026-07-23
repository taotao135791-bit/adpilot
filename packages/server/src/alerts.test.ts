import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "./index.js";

describe("monitoring alert endpoints", () => {
  async function boot() {
    const root = await mkdtemp(join(tmpdir(), "adpilot-server-alerts-"));
    const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
    return server;
  }

  const validAlert = {
    kind: "budget_overspend",
    severity: "critical",
    metrics: [{ metric: "spend", value: 123.45, unit: "USD", factId: "fact-spend-1" }],
    message: "Daily budget exceeded by 23%.",
    dedupeKey: "budget:campaign-42:2026-07-23"
  };

  it("accepts a valid alert, stamps identity, deduplicates, and lists pending", async () => {
    const server = await boot();
    const created = await server.inject({ method: "POST", url: "/api/clients/personal/alerts", payload: validAlert });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.status).toBe("pending");
    expect(body.alert).toMatchObject({
      clientId: "personal",
      kind: "budget_overspend",
      severity: "critical",
      dedupeKey: validAlert.dedupeKey,
      metrics: [{ metric: "spend", value: 123.45, unit: "USD", factId: "fact-spend-1" }]
    });
    expect(body.alert.alertId).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => Date.parse(body.alert.createdAt)).not.toThrow();

    const duplicate = await server.inject({ method: "POST", url: "/api/clients/personal/alerts", payload: validAlert });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().status).toBe("deduplicated");

    const pending = await server.inject({ method: "GET", url: "/api/clients/personal/alerts/pending" });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().clientId).toBe("personal");
    expect(pending.json().pending).toHaveLength(1);
    expect(pending.json().pending[0].alert.kind).toBe("budget_overspend");
    expect(pending.json().pending[0].status).toBe("pending");
    await server.close();
  });

  it("rejects invalid contracts and unknown clients", async () => {
    const server = await boot();
    const badKind = await server.inject({
      method: "POST", url: "/api/clients/personal/alerts",
      payload: { ...validAlert, kind: "everything_is_fine" }
    });
    expect(badKind.statusCode).toBe(400);

    const unboundMetric = await server.inject({
      method: "POST", url: "/api/clients/personal/alerts",
      payload: { ...validAlert, dedupeKey: "budget:campaign-42:unbound", metrics: [{ metric: "spend", value: 1, unit: "USD" }] }
    });
    expect(unboundMetric.statusCode).toBe(400);

    const unknownClient = await server.inject({
      method: "POST", url: "/api/clients/ghost/alerts",
      payload: { ...validAlert, dedupeKey: "budget:campaign-42:ghost" }
    });
    expect(unknownClient.statusCode).toBe(400);

    const pendingUnknown = await server.inject({ method: "GET", url: "/api/clients/ghost/alerts/pending" });
    expect(pendingUnknown.statusCode).toBe(400);
    await server.close();
  });
});
