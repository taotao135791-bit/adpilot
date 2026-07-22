import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { createAdPilotSystem } from "./index.js";

describe("application visual table assembly", () => {
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
