import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { ProductEventBus, createAdPilotSystem, identitySafeRoi, identitySensitiveMasks, sanitizeVisualRuntimeEvent } from "./index.js";
import { SettingsStore } from "@adpilot/configuration";

const identityExpectation = {
  clientId: "client-a",
  taskId: "task-a",
  platform: "google_ads" as const,
  browserProfile: "Default",
  applicationId: "com.google.Chrome",
  windowId: "window-1",
  pageType: "campaign settings",
  accountName: "Acme",
  accountId: "123",
  campaignName: "Brand Search",
  campaignId: "456",
  currency: "USD",
  currentValue: 100,
  operation: "set budget",
  proposedValue: 110,
  target: "budget input",
  evidenceRegions: {
    account: { x: 100, y: 100, width: 200, height: 40 },
    campaign: { x: 100, y: 200, width: 300, height: 40 },
    currentValue: { x: 700, y: 200, width: 100, height: 40 },
    target: { x: 700, y: 500, width: 200, height: 60 }
  }
};

describe("application visual table assembly", () => {
  it("scopes UI events per client and strips full screenshot bytes", () => {
    const event = sanitizeVisualRuntimeEvent({
      type: "screenshot",
      phase: "before",
      clientId: "client-a",
      taskId: "task-a",
      screenshot: { base64: "sensitive-image", width: 100, height: 80, scaleFactor: 2, capturedAt: "2026-07-22T00:00:00.000Z", sha256: "a".repeat(64) }
    });
    expect(JSON.stringify(event)).not.toContain("sensitive-image");
    const bus = new ProductEventBus();
    bus.publish({ type: "computer", clientId: "client-a", taskId: "task-a", event });
    bus.publish({ type: "task", clientId: "client-b", status: "running", message: "private-b" });
    expect(bus.history("client-a")).toHaveLength(1);
    expect(JSON.stringify(bus.history("client-a"))).not.toContain("private-b");
  });

  it("publishes only screenshot-space overlay geometry for the live renderer", () => {
    const event = sanitizeVisualRuntimeEvent({
      type: "grounded",
      attempt: 1,
      tier: "gui",
      clientId: "client-a",
      taskId: "task-a",
      action: {
        action: "click",
        x: 720,
        y: 420,
        target: "budget input",
        reason: "visible target",
        confidence: 0.98,
        expected_result: "budget editor opens",
        risk_level: "observe",
        allowedRegion: {
          x: 600,
          y: 300,
          width: 240,
          height: 180,
          coordinateSpace: "screenshot_pixels"
        }
      }
    });

    expect(event.overlay).toEqual({
      coordinateSpace: "screenshot_pixels",
      targetBox: { x: 600, y: 300, width: 240, height: 180 },
      pointer: { x: 720, y: 420 }
    });
    expect(JSON.stringify(event)).not.toContain("\"text\"");
  });

  it("transmits a tight identity ROI and masks every non-evidence cell", () => {
    const roi = identitySafeRoi(identityExpectation, 1200, 800);
    expect(roi).toEqual({ x: 100, y: 100, width: 800, height: 460 });
    const masks = identitySensitiveMasks(identityExpectation, 1200, 800);
    expect(new Set(masks.map((mask) => mask.category))).toEqual(new Set(["other_campaign", "unrelated_financial_data"]));
    for (const evidence of Object.values(identityExpectation.evidenceRegions)) {
      expect(masks.some((mask) => intersects(mask.region, evidence))).toBe(false);
    }
  });

  it("fails identity disclosure closed without four explicit local regions", () => {
    expect(identitySafeRoi({ ...identityExpectation, evidenceRegions: undefined }, 1200, 800))
      .toEqual({ x: 0, y: 96, width: 1200, height: 704 });
  });

  it("keeps table reading available when Fast and Deep use the same vision-capable code model", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-application-table-"));
    const faux = fauxProvider({
      provider: "local-code",
      models: [{ id: "code-vision", input: ["text", "image"], reasoning: true }]
    });
    const models = createModels();
    models.setProvider(faux.provider);

    const system = await createAdPilotSystem({
      workspaceRoot: root,
      models,
      env: {
        ADPILOT_FAST_PROVIDER: "local-code",
        ADPILOT_FAST_MODEL: "code-vision",
        ADPILOT_STRONG_PROVIDER: "local-code",
        ADPILOT_STRONG_MODEL: "code-vision",
        ADPILOT_PRIVACY_MODE: "local-only"
      }
    });

    expect(system.visualTableReader).toBeDefined();
    expect(system.tools.visualTables).toMatchObject({
      readerModel: { provider: "local-code", modelId: "code-vision", location: "local" },
      verifierModel: { provider: "local-code", modelId: "code-vision", location: "local" },
      privacyMode: "local-only"
    });
  });

  it("marks Computer Use configured when a single stored vision model fills both roles", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-application-single-vision-"));
    const settings = new SettingsStore(root, {});
    // Single-model mode: only the fast selection is stored; the strong role follows it.
    await settings.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "openai", model: "gpt-5" } },
      env: { OPENAI_API_KEY: "test-openai-key" }
    });

    const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });

    expect(system.modelStatus.fast).toBe("openai/gpt-5");
    expect(system.modelStatus.strong).toBe("openai/gpt-5");
    expect(system.modelStatus.chatConfigured).toBe(true);
    expect(system.modelStatus.strongConfigured).toBe(true);
    expect(system.modelStatus.guiConfigured).toBe(true);
    expect(system.modelStatus.route).toBe("Fast Vision → Deep Vision");
  });

  it("keeps Computer Use unconfigured when the single stored model cannot see images", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-application-single-text-"));
    const settings = new SettingsStore(root, {});
    await settings.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "deepseek", model: "deepseek-v4-pro" } },
      env: { DEEPSEEK_API_KEY: "test-deepseek-key" }
    });

    const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });

    expect(system.modelStatus.fast).toBe("deepseek/deepseek-v4-pro");
    expect(system.modelStatus.strong).toBe("deepseek/deepseek-v4-pro");
    expect(system.modelStatus.chatConfigured).toBe(true);
    expect(system.modelStatus.strongConfigured).toBe(true);
    expect(system.modelStatus.guiConfigured).toBe(false);
    expect(system.modelStatus.route).toBe("not configured");
  });
});

function intersects(left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }) {
  return Math.max(left.x, right.x) < Math.min(left.x + left.width, right.x + right.width)
    && Math.max(left.y, right.y) < Math.min(left.y + left.height, right.y + right.height);
}
