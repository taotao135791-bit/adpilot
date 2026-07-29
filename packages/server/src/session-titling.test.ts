import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "./index.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session auto-titling on first exchange", () => {
  it("renames a default-titled session from the first user message", async () => {
    const { system, server } = await setup();
    const session = await system.sessions.create({ clientId: "personal" });
    expect(session.title).toBe("New session");

    const response = await server.inject({
      method: "POST",
      url: "/api/messages",
      payload: { clientId: "personal", sessionId: session.id, message: "诊断美国 Android 的 CPA 异常并给出预算建议", locale: "zh-CN" }
    });
    expect(response.statusCode).toBe(201);

    const renamed = await system.sessions.get(session.id);
    expect(renamed?.title).toBe("诊断美国 Android 的 CPA 异常并给出预算建议");
  });

  it("re-titles a raw-UUID legacy session and leaves a custom title alone", async () => {
    const { system, server } = await setup();
    const legacy = await system.sessions.create({ clientId: "personal" });
    await system.sessions.rename(legacy.id, "0ca77eae-27c6-4a64-a2c9-aacc380ffc88");

    await server.inject({
      method: "POST",
      url: "/api/messages",
      payload: { clientId: "personal", sessionId: legacy.id, message: "生成投放日报", locale: "zh-CN" }
    });
    expect((await system.sessions.get(legacy.id))?.title).toBe("生成投放日报");

    const custom = await system.sessions.create({ clientId: "personal", title: "Northwind 周会" });
    await server.inject({
      method: "POST",
      url: "/api/messages",
      payload: { clientId: "personal", sessionId: custom.id, message: "把这段改成英文", locale: "zh-CN" }
    });
    expect((await system.sessions.get(custom.id))?.title).toBe("Northwind 周会");
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-titling-"));
  roots.push(root);
  const faux = fauxProvider({ provider: "test", models: [{ id: "code", input: ["text", "image"] }] });
  faux.setResponses([fauxAssistantMessage('{"mode":"answer","reply":"好的。","goal":null}')]);
  const models = createModels();
  models.setProvider(faux.provider);
  const system = await createAdPilotSystem({
    workspaceRoot: root,
    adpilotHome: join(root, "home"),
    env: { ADPILOT_FAST_PROVIDER: "test", ADPILOT_FAST_MODEL: "code", ADPILOT_STRONG_PROVIDER: "test", ADPILOT_STRONG_MODEL: "code" },
    models
  });
  const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
  return { system, server };
}
