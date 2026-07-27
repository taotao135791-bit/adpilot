import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { SkillRegistry } from "@adpilot/skills";
import { AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { PiAgentRuntime } from "./index.js";

describe("PiAgentRuntime session model override", () => {
  it("pins the primary model, forces the strong route, and leaves default routing untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-runtime-model-override-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const global = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong" }] });
    const pinned = fauxProvider({ provider: "pinned", models: [{ id: "pinned-model" }] });
    const models = createModels();
    models.setProvider(global.provider);
    models.setProvider(pinned.provider);
    const router = new ModelRouter({
      fast: { provider: "test", model: "fast" },
      strong: { provider: "test", model: "strong" },
      gui: { provider: "test", model: "fast" }
    });
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
    const base = { clientId: "client-a", taskId: crypto.randomUUID(), actor: "adpilot_agent", permission: "OBSERVE" as const, role: "adpilot_agent" };

    pinned.setResponses([fauxAssistantMessage("pinned reply")]);
    const pinnedRun = await runtime.run({
      context: { ...base, sessionId: crypto.randomUUID() },
      systemPrompt: "Reply briefly.", prompt: "hi", signals: { task: "conversation" },
      modelOverride: { ref: { provider: "pinned", model: "pinned-model" } }
    });
    expect(pinnedRun.text).toBe("pinned reply");
    expect(pinnedRun.model).toEqual({ provider: "pinned", id: "pinned-model", tier: "session" });
    expect(global.state.callCount).toBe(0);
    expect(pinned.state.callCount).toBe(1);

    global.setResponses([fauxAssistantMessage("strong reply")]);
    const strongRun = await runtime.run({
      context: { ...base, sessionId: crypto.randomUUID() },
      systemPrompt: "Reply briefly.", prompt: "hi", signals: { task: "conversation" },
      modelOverride: { route: "strong" }
    });
    expect(strongRun.text).toBe("strong reply");
    expect(strongRun.model).toEqual({ provider: "test", id: "strong", tier: "strong" });

    global.setResponses([fauxAssistantMessage("fast reply")]);
    const defaultRun = await runtime.run({
      context: { ...base, sessionId: crypto.randomUUID() },
      systemPrompt: "Reply briefly.", prompt: "hi", signals: { task: "conversation" }
    });
    expect(defaultRun.text).toBe("fast reply");
    expect(defaultRun.model).toEqual({ provider: "test", id: "fast", tier: "fast" });
  });
});
