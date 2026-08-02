import { describe, expect, it } from "vitest";
import type { NativeComputerService } from "@adpilot/native-computer-host";
import { createComputerTools } from "./groups/computer.js";
import { makeCtx, makeTestDeps } from "./testing.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromeWindow = {
  windowId: 42,
  ownerPid: 9001,
  ownerName: "Google Chrome",
  bundleId: "com.google.Chrome",
  title: "Example page",
  layer: 0,
  alpha: 1,
  onScreen: true,
  bounds: { x: 20, y: 30, width: 1200, height: 800 }
};

const surfaceLease = {
  generation: "00000000-0000-4000-8000-000000000042",
  sessionId: "session-1",
  target: "window" as const,
  windowId: 42,
  ownerPid: 9001,
  bundleId: "com.google.Chrome",
  bounds: chromeWindow.bounds,
  capturePixels: { width: 1200, height: 800 },
  capturedAtUnixMs: Date.now(),
  expiresAtUnixMs: Date.now() + 30_000
};

const capture = {
  format: "png",
  base64: "iVBORw0KGgo",
  width: 1200,
  height: 800,
  capturedAt: new Date().toISOString(),
  source: { target: "window" as const, windowId: 42 },
  surfaceLease
};

describe("computer tools", () => {
  it("rejects explicit background targeting of non-browser software before native access", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-computer-software-isolation-"));
    const { deps } = makeTestDeps(root);
    const calls: string[] = [];
    deps.computer = {
      host: {
        closed: false,
        pid: 1,
        request: async (method: string) => {
          calls.push(method);
          throw new Error(`unexpected method ${method}`);
        },
        close: async () => undefined
      } as NativeComputerService
    };
    const observe = createComputerTools().find((tool) => tool.name === "computer.observe")!;
    await expect(observe.execute(
      { bundleId: "com.apple.mail", includeImage: false },
      makeCtx({ enabledCapabilityPacks: ["computer-use"], permissions: { read: true, write: true, destructive: false, computerUse: true, network: false } }),
      deps
    )).rejects.toMatchObject({ code: "APPLICATION_NOT_ALLOWED" });
    expect(calls).toHaveLength(0);
  });

  it("observes the requested Chrome window even while another app is frontmost", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-computer-observe-"));
    const { deps } = makeTestDeps(root);
    const calls: string[] = [];
    deps.computer = {
      host: {
        closed: false,
        pid: 1,
        request: async (method: string) => {
          calls.push(method);
          if (method === "windows.list") return [chromeWindow];
          if (method === "capture") return capture;
          if (method === "permissions.status") {
            return {
              screenRecording: { granted: true, canRequest: false },
              accessibility: { granted: false, canRequest: true }
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
        close: async () => undefined
      } as NativeComputerService
    };
    const observe = createComputerTools().find((tool) => tool.name === "computer.observe")!;
    const result = await observe.execute(
      { bundleId: "com.google.Chrome", includeImage: false },
      makeCtx({ enabledCapabilityPacks: ["computer-use"], permissions: { read: true, write: true, destructive: false, computerUse: true, network: false } }),
      deps
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      app: "Google Chrome",
      bundleId: "com.google.Chrome",
      window: { id: 42, title: "Example page" },
      observationId: expect.any(String),
      isolation: {
        sessionId: "session-1",
        pid: 9001,
        bundleId: "com.google.Chrome",
        windowId: 42,
        oneTime: true
      }
    });
    expect(calls).toContain("windows.list");
    expect(calls).toContain("capture");
    expect(calls).not.toContain("frontmost");
  });

  it("closes only the exact previously observed window and verifies it disappeared", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-computer-close-"));
    const { deps } = makeTestDeps(root);
    const calls: Array<{ method: string; params: unknown }> = [];
    let listed = 0;
    deps.computer = {
      host: {
        closed: false,
        pid: 1,
        request: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "windows.list") return listed++ === 0 ? [chromeWindow] : [];
          if (method === "capture") return capture;
          if (method === "window.close") return { closed: true, windowId: 42, ownerPid: 9001, bundleId: "com.google.Chrome" };
          if (method === "wait") return { waited: true, durationMs: 300 };
          throw new Error(`unexpected method ${method}`);
        },
        close: async () => undefined
      } as NativeComputerService
    };
    const tools = createComputerTools();
    const observe = tools.find((tool) => tool.name === "computer.observe")!;
    const closeWindow = tools.find((tool) => tool.name === "computer.close_window")!;
    const observed = await observe.execute(
      { bundleId: "com.google.Chrome", includeImage: false },
      makeCtx({ enabledCapabilityPacks: ["computer-use"], permissions: { read: true, write: true, destructive: false, computerUse: true, network: false } }),
      deps
    );
    const observationId = (observed.data as { observationId: string }).observationId;
    const result = await closeWindow.execute(
      { observationId },
      makeCtx({ enabledCapabilityPacks: ["computer-use"], permissions: { read: true, write: true, destructive: false, computerUse: true, network: false } }),
      deps
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ closed: true, bundleId: "com.google.Chrome", windowId: 42 });
    expect(calls.find((call) => call.method === "window.close")?.params).toMatchObject({
      surfaceLease: {
        sessionId: "session-1",
        windowId: 42,
        ownerPid: 9001,
        bundleId: "com.google.Chrome"
      }
    });
  });

  it("rejects guessed, cross-session, and replayed observation ids before native action", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-computer-lease-"));
    const { deps } = makeTestDeps(root);
    const calls: string[] = [];
    let closed = false;
    deps.computer = {
      host: {
        closed: false,
        pid: 1,
        request: async (method: string) => {
          calls.push(method);
          if (method === "windows.list") return closed ? [] : [chromeWindow];
          if (method === "capture") return capture;
          if (method === "window.close") {
            closed = true;
            return { closed: true, windowId: 42, ownerPid: 9001, bundleId: "com.google.Chrome" };
          }
          if (method === "wait") return { waited: true, durationMs: 250 };
          throw new Error(`unexpected method ${method}`);
        },
        close: async () => undefined
      } as NativeComputerService
    };
    const tools = createComputerTools();
    const observe = tools.find((tool) => tool.name === "computer.observe")!;
    const closeWindow = tools.find((tool) => tool.name === "computer.close_window")!;
    const context = makeCtx({ enabledCapabilityPacks: ["computer-use"], permissions: { read: true, write: true, destructive: false, computerUse: true, network: false } });
    const observed = await observe.execute(
      { bundleId: "com.google.Chrome", includeImage: false },
      context,
      deps
    );
    const observationId = (observed.data as { observationId: string }).observationId;

    await expect(closeWindow.execute(
      { observationId },
      makeCtx({ sessionId: "other-session", enabledCapabilityPacks: ["computer-use"], permissions: context.permissions }),
      deps
    )).rejects.toMatchObject({ code: "OBSERVATION_REQUIRED" });

    await closeWindow.execute({ observationId }, context, deps);
    await expect(closeWindow.execute({ observationId }, context, deps))
      .rejects.toMatchObject({ code: "OBSERVATION_REQUIRED" });
    expect(calls.filter((method) => method === "window.close")).toHaveLength(1);
  });
});
