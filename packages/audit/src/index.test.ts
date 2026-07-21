import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "@adpilot/workspace";
import { AuditLog, redactSecrets } from "./index.js";

describe("audit", () => {
  it("redacts credentials recursively", () => {
    expect(redactSecrets({ apiKey: "secret", nested: { note: "Bearer abc.123" } })).toEqual({
      apiKey: "[REDACTED]",
      nested: { note: "Bearer [REDACTED]" }
    });
  });

  it("writes a verifiable hash chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-audit-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const audit = new AuditLog(workspace);
    await audit.append({ clientId: "client-a", actor: "agent", action: "capture_screen", status: "succeeded", details: {} });
    await audit.append({ clientId: "client-a", actor: "operator", action: "click", status: "attempted", details: {} });
    expect(await audit.verify("client-a")).toBe(true);
  });
});

