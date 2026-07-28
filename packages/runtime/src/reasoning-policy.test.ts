import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, type FauxModelDefinition } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { SkillRegistry } from "@adpilot/skills";
import { AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { PiAgentRuntime, type ReasoningPolicy, type RuntimeRequest } from "./index.js";

describe("PiAgentRuntime reasoning policy", () => {
  async function setup(options: { policy?: ReasoningPolicy; models?: FauxModelDefinition[]; routeModel?: string } = {}) {
    const root = await mkdtemp(join(tmpdir(), "adpilot-runtime-reasoning-"));
    const workspace = new WorkspaceStore(root);
    await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
    const routeModel = options.routeModel ?? "thinker";
    const captured: Array<SimpleStreamOptions | undefined> = [];
    const faux = fauxProvider({
      provider: "test",
      models: options.models ?? [{ id: "thinker", reasoning: true }]
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const router = new ModelRouter({
      fast: { provider: "test", model: routeModel },
      strong: { provider: "test", model: routeModel },
      gui: { provider: "test", model: routeModel }
    });
    const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
    const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools, [], options.policy ? { reasoning: options.policy } : {});
    const run = (request: Partial<RuntimeRequest> = {}) => {
      captured.length = 0;
      faux.setResponses([(_context, streamOptions) => { captured.push(streamOptions as SimpleStreamOptions | undefined); return fauxAssistantMessage("ok"); }]);
      return runtime.run({
        context: { clientId: "client-a", taskId: crypto.randomUUID(), actor: "adpilot_agent", permission: "OBSERVE", role: "adpilot_agent", sessionId: crypto.randomUUID() },
        systemPrompt: "Reply briefly.", prompt: "hi", signals: { task: "conversation" },
        ...request
      });
    };
    return { run, captured };
  }

  it("sends the effort on strong-tier runs and keeps fast runs plain with the default scope", async () => {
    const { run, captured } = await setup({ policy: { effort: "high", scope: "strong" } });

    const fast = await run();
    expect(fast.model.tier).toBe("fast");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.reasoning).toBeUndefined();

    const strong = await run({ signals: { task: "risk_review" } });
    expect(strong.model.tier).toBe("strong");
    expect(captured[0]?.reasoning).toBe("high");

    // Session-pinned runs count as the strong role.
    const pinned = await run({ modelOverride: { ref: { provider: "test", model: "thinker" } } });
    expect(pinned.model.tier).toBe("session");
    expect(captured[0]?.reasoning).toBe("high");
  });

  it("sends the effort on fast runs too when the scope is all", async () => {
    const { run, captured } = await setup({ policy: { effort: "medium", scope: "all" } });
    const fast = await run();
    expect(fast.model.tier).toBe("fast");
    expect(captured[0]?.reasoning).toBe("medium");
  });

  it("silently drops the effort for models without reasoning support", async () => {
    const { run, captured } = await setup({
      policy: { effort: "high", scope: "all" },
      models: [{ id: "plain", reasoning: false }],
      routeModel: "plain"
    });
    const result = await run({ signals: { task: "risk_review" } });
    expect(result.model.tier).toBe("strong");
    expect(result.text).toBe("ok");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.reasoning).toBeUndefined();
  });

  it("leaves calls untouched when no policy is configured", async () => {
    const { run, captured } = await setup();
    await run({ signals: { task: "risk_review" } });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.reasoning).toBeUndefined();
  });
});
