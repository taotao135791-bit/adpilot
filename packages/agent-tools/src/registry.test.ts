import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentToolRegistry, type AgentToolDefinition } from "./registry.js";
import { succeed } from "./result.js";
import { buildAgentToolRegistry } from "./index.js";
import { makeCtx, makeTestDeps } from "./testing.js";

function dummy(overrides: Partial<AgentToolDefinition> = {}): AgentToolDefinition {
  const name = overrides.name ?? "project.ping";
  return {
    name,
    description: `Test double for ${name}.`,
    capabilityPack: "project",
    permission: "read",
    parameters: z.object({ value: z.string().optional() }),
    execute: async (_params, ctx) => succeed(name, ctx, { pong: true }),
    ...overrides
  };
}

describe("AgentToolRegistry", () => {
  it("rejects duplicate registrations", () => {
    const registry = new AgentToolRegistry();
    registry.register(dummy());
    expect(() => registry.register(dummy())).toThrow("duplicate agent tool registration");
  });

  it("filters by capability pack: always-on packs plus enabledCapabilityPacks", () => {
    const registry = new AgentToolRegistry();
    registry.register(dummy({ name: "project.ping" }));
    registry.register(dummy({ name: "goal.ping", capabilityPack: "goal" }));
    registry.register(dummy({ name: "git.ping", capabilityPack: "git" }));
    registry.register(dummy({ name: "ads.ping", capabilityPack: "ads" }));

    const withoutPacks = registry.list(makeCtx({ enabledCapabilityPacks: [] }));
    expect(withoutPacks.map((definition) => definition.name)).toEqual(["goal.ping", "project.ping"]);

    const withGit = registry.list(makeCtx({ enabledCapabilityPacks: ["git"] }));
    expect(withGit.map((definition) => definition.name)).toEqual(["git.ping", "goal.ping", "project.ping"]);
  });

  it("filters by permission: write needs write, destructive needs destructive, computer-use needs computerUse", () => {
    const registry = new AgentToolRegistry();
    registry.register(dummy({ name: "project.read", permission: "read" }));
    registry.register(dummy({ name: "project.write", permission: "write" }));
    registry.register(dummy({ name: "project.destructive", permission: "destructive" }));
    registry.register(dummy({ name: "project.computer", permission: "computer-use" }));

    const readOnly = registry.list(makeCtx({ permissions: { read: true, write: false, destructive: false, computerUse: false, network: false } }));
    expect(readOnly.map((definition) => definition.name)).toEqual(["project.read"]);

    const writable = registry.list(makeCtx({ permissions: { read: true, write: true, destructive: false, computerUse: false, network: false } }));
    expect(writable.map((definition) => definition.name)).toEqual(["project.read", "project.write"]);

    const destructive = registry.list(makeCtx({ permissions: { read: true, write: true, destructive: true, computerUse: true, network: false } }));
    expect(destructive.map((definition) => definition.name)).toEqual([
      "project.computer",
      "project.destructive",
      "project.read",
      "project.write"
    ]);
  });

  it("toPiTools produces pi-agent-core tools with JSON-schema parameters and lifecycle-backed execute", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-agent-tools-registry-"));
    const { deps, auditEvents } = makeTestDeps(root);
    const registry = new AgentToolRegistry();
    registry.register(dummy({ parameters: z.object({ value: z.string().min(1) }) }));
    const ctx = makeCtx();

    const tools = registry.toPiTools(ctx, deps);
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe("project.ping");
    expect(tool.label).toBe("project.ping");
    expect(tool.description).toContain("project.ping");
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: { value: { type: "string", minLength: 1 } },
      required: ["value"]
    });

    const outcome = await tool.execute("call-1", { value: "hello" });
    const details = outcome.details as { success: boolean; tool: string; data: unknown; auditEventId?: string };
    expect(details.success).toBe(true);
    expect(details.tool).toBe("project.ping");
    expect(details.data).toEqual({ pong: true });
    expect(details.auditEventId).toBe("audit-1");
    expect(outcome.content[0]).toMatchObject({ type: "text" });
    expect(auditEvents.map((event) => event.action)).toEqual(["agent_tool:project.ping"]);
  });

  it("the full registry registers every 0.3 capability group without name conflicts", () => {
    const registry = buildAgentToolRegistry();
    const names = registry.names();
    expect(names.length).toBe(new Set(names).size);
    for (const prefix of ["project.", "goal.", "task.", "terminal.", "git.", "artifact.", "ads.", "automation.", "workflow."]) {
      expect(names.some((name) => name.startsWith(prefix)), prefix).toBe(true);
    }
    // The dot-names never collide with the single-name general tools (read/write/bash...).
    for (const name of names) expect(name).toContain(".");
  });
});
