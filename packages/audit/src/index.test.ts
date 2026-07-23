import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "@adpilot/workspace";
import { AuditLog, redactSecrets, type AuditEvent } from "./index.js";

async function makeAudit(): Promise<{ root: string; audit: AuditLog }> {
  const root = await mkdtemp(join(tmpdir(), "adpilot-audit-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
  return { root, audit: new AuditLog(workspace) };
}

async function rewriteAuditFile(root: string, events: AuditEvent[]): Promise<void> {
  const path = join(root, "clients", "client-a", "audit.jsonl");
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

describe("audit", () => {
  it("redacts credentials recursively", () => {
    expect(redactSecrets({ apiKey: "secret", nested: { note: "Bearer abc.123" } })).toEqual({
      apiKey: "[REDACTED]",
      nested: { note: "Bearer [REDACTED]" }
    });
  });

  it("writes a verifiable hash chain", async () => {
    const { audit } = await makeAudit();
    await audit.append({ clientId: "client-a", actor: "agent", action: "capture_screen", status: "succeeded", details: {} });
    await audit.append({ clientId: "client-a", actor: "operator", action: "click", status: "attempted", details: {} });
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("serializes concurrent appends so every event links to a distinct predecessor", async () => {
    const { audit } = await makeAudit();
    const count = 25;
    const appended = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        audit.append({ clientId: "client-a", actor: "agent", action: `action_${index}`, status: "succeeded", details: { index } }))
    );
    expect(new Set(appended.map((event) => event.id)).size).toBe(count);
    const events = await audit.list("client-a");
    expect(events).toHaveLength(count);
    expect(events[0]?.previousHash).toBeNull();
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]?.previousHash).toBe(events[index - 1]?.hash);
    }
    expect(new Set(events.map((event) => event.hash)).size).toBe(count);
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("keeps the chain writable after a rejected append", async () => {
    const { audit } = await makeAudit();
    await expect(audit.append({ clientId: "client-a", actor: "", action: "bad", status: "succeeded", details: {} })).rejects.toThrow();
    await audit.append({ clientId: "client-a", actor: "agent", action: "good", status: "succeeded", details: {} });
    const events = await audit.list("client-a");
    expect(events).toHaveLength(1);
    expect(events[0]?.previousHash).toBeNull();
    expect(await audit.verify("client-a")).toBe(true);
  });

  it("detects tampering with a recorded event payload", async () => {
    const { root, audit } = await makeAudit();
    await audit.append({ clientId: "client-a", actor: "agent", action: "capture_screen", status: "succeeded", details: { spend: 100 } });
    await audit.append({ clientId: "client-a", actor: "agent", action: "click", status: "succeeded", details: {} });
    const events = await audit.list("client-a");
    const tampered = [{ ...events[0]!, details: { spend: 1 } }, events[1]!];
    await rewriteAuditFile(root, tampered);
    expect(await audit.verify("client-a")).toBe(false);
  });

  it("detects tampering with the previousHash link", async () => {
    const { root, audit } = await makeAudit();
    await audit.append({ clientId: "client-a", actor: "agent", action: "capture_screen", status: "succeeded", details: {} });
    await audit.append({ clientId: "client-a", actor: "agent", action: "click", status: "succeeded", details: {} });
    const events = await audit.list("client-a");
    const tampered = [events[0]!, { ...events[1]!, previousHash: "0".repeat(64) }];
    await rewriteAuditFile(root, tampered);
    expect(await audit.verify("client-a")).toBe(false);
  });

  it("detects removal and reordering of chain events", async () => {
    const { root, audit } = await makeAudit();
    for (const action of ["first", "second", "third"]) {
      await audit.append({ clientId: "client-a", actor: "agent", action, status: "succeeded", details: {} });
    }
    const events = await audit.list("client-a");
    await rewriteAuditFile(root, [events[0]!, events[2]!]);
    expect(await audit.verify("client-a")).toBe(false);

    await rewriteAuditFile(root, [events[1]!, events[0]!, events[2]!]);
    expect(await audit.verify("client-a")).toBe(false);
  });

  it("detects a recomputed-hash forgery that breaks the link", async () => {
    const { root, audit } = await makeAudit();
    await audit.append({ clientId: "client-a", actor: "agent", action: "capture_screen", status: "succeeded", details: {} });
    await audit.append({ clientId: "client-a", actor: "agent", action: "click", status: "succeeded", details: {} });
    const path = join(root, "clients", "client-a", "audit.jsonl");
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace('"click"', '"click_into_conversion"'), "utf8");
    expect(await audit.verify("client-a")).toBe(false);
  });
});
