import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { ProductEventBus, createAdPilotSystem, identitySafeRoi, identitySensitiveMasks, sanitizeVisualRuntimeEvent } from "./index.js";

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

  it("keeps advertising identity headers visible while masking browser and personal chrome", () => {
    expect(identitySafeRoi(1200, 800)).toEqual({ x: 0, y: 56, width: 1200, height: 744 });
    const masks = identitySensitiveMasks(1200, 800);
    expect(masks.map((mask) => mask.category)).toEqual(["browser_tabs", "system_menu_bar", "top_personal_info"]);
    expect(masks[2]!.region).toEqual({ x: 1032, y: 80, width: 168, height: 56 });
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
});
