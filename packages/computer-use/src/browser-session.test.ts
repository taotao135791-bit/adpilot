import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSessionLostError,
  BrowserSessionBoundOperator,
  BrowserSessionManager,
  FileBrowserSessionStore,
  VisualComputerRuntime,
  browserProfileFingerprint,
  type BrowserProcessController,
  type BrowserProcessHandle,
  type BrowserProcessLaunchRequest,
  type NativeOperator,
  type NativeSurface,
  type NativeSurfaceIdentity,
  type Screenshot,
  type VisualMicroTask
} from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function nativePlatform(): "darwin" | "win32" | "linux" {
  return process.platform === "darwin" || process.platform === "win32" || process.platform === "linux" ? process.platform : "linux";
}

class FakeNativeIdentity implements NativeSurfaceIdentity {
  active: NativeSurface | undefined;
  registered: NativeSurface | undefined;

  async identifyActiveSurface(): Promise<NativeSurface> {
    if (!this.active) throw new Error("no active window");
    return this.active;
  }

  async identifySurfaceByProcess(processId: number): Promise<NativeSurface | undefined> {
    return this.registered?.pid === processId ? this.registered : undefined;
  }

  async captureActiveWindow(expected?: NativeSurface) {
    const surface = await this.identifyActiveSurface();
    if (expected?.windowId !== surface.windowId) throw new Error("window changed");
    return {
      base64: Buffer.from("capture").toString("base64"), width: 1000, height: 700, scaleFactor: 2,
      surface, surfaceFingerprint: "f".repeat(64)
    };
  }
}

class FakeBrowserController implements BrowserProcessController {
  readonly requests: BrowserProcessLaunchRequest[] = [];
  readonly alive = new Set<number>();
  nextPid = 401;
  onLaunch?: (handle: BrowserProcessHandle, request: BrowserProcessLaunchRequest) => void;

  async launch(request: BrowserProcessLaunchRequest): Promise<BrowserProcessHandle> {
    this.requests.push(request);
    const handle = {
      processId: this.nextPid++,
      applicationId: process.platform === "darwin" ? "com.google.Chrome" : "Google Chrome",
      appName: "Google Chrome",
      nativeProfileFingerprint: browserProfileFingerprint(request.profileDirectory, request.profileName)
    };
    this.alive.add(handle.processId);
    this.onLaunch?.(handle, request);
    return handle;
  }

  async isAlive(processId: number): Promise<boolean> { return this.alive.has(processId); }
  async terminate(processId: number): Promise<void> { this.alive.delete(processId); }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-browser-session-"));
  roots.push(root);
  const identity = new FakeNativeIdentity();
  const launcher = new FakeBrowserController();
  launcher.onLaunch = (handle) => {
    const surface: NativeSurface = {
      platform: nativePlatform(),
      app: "Google Chrome",
      ...(process.platform === "darwin" ? { bundleId: "com.google.Chrome" } : {}),
      browserProfile: handle.nativeProfileFingerprint,
      pid: handle.processId,
      title: "Google Ads",
      windowId: "window-77",
      bounds: { x: 40, y: 60, width: 1200, height: 800 },
      screenId: "display-1",
      screenBounds: { x: 0, y: 0, width: 1512, height: 982 },
      scaleFactor: 2
    };
    identity.active = surface;
    identity.registered = surface;
  };
  const store = new FileBrowserSessionStore(join(root, "browser-sessions"));
  const manager = new BrowserSessionManager(root, {
    store, launcher, surfaceIdentity: identity, pollAttempts: 1, pollIntervalMs: 0
  });
  return { root, identity, launcher, store, manager };
}

describe("AdPilot managed browser sessions", () => {
  it("launches a dedicated fixed Profile and persists PID/window/bounds/platform metadata", async () => {
    const { manager, launcher } = await fixture();
    const session = await manager.start({ clientId: "client-a", browserProfile: "google-primary", platform: "google_ads" });
    expect(session).toMatchObject({
      clientId: "client-a",
      browserProfile: "google-primary",
      processId: 401,
      windowId: "window-77",
      windowBounds: { x: 40, y: 60, width: 1200, height: 800 },
      platform: "google_ads",
      sessionStatus: "connected"
    });
    expect(launcher.requests[0]).toMatchObject({ profileName: "Default", startUrl: "https://ads.google.com/" });
    expect(launcher.requests[0]?.profileDirectory).toContain("browser-profiles");
    expect(await manager.get("client-a", "google-primary")).toEqual(session);
  });

  it("uses different local data directories for different clients", async () => {
    const { manager, launcher } = await fixture();
    await manager.start({ clientId: "client-a", browserProfile: "primary", platform: "google_ads" });
    await manager.start({ clientId: "client-b", browserProfile: "primary", platform: "google_ads" });
    expect(launcher.requests).toHaveLength(2);
    expect(launcher.requests[0]?.profileDirectory).not.toBe(launcher.requests[1]?.profileDirectory);
  });

  it("rejects a foreground-window switch and durably marks the session lost", async () => {
    const { manager, identity } = await fixture();
    await manager.start({ clientId: "client-a", browserProfile: "primary", platform: "google_ads" });
    identity.active = { ...identity.active!, app: "Notes", ...(process.platform === "darwin" ? { bundleId: "com.apple.Notes" } : {}), pid: 999, windowId: "notes-1" };
    await expect(manager.assertActive("client-a", "primary")).rejects.toMatchObject({ code: "BROWSER_SESSION_LOST" });
    expect(await manager.get("client-a", "primary")).toMatchObject({ sessionStatus: "lost", lostReason: expect.stringContaining("foreground window") });
  });

  it("rejects a closed managed window", async () => {
    const { manager, identity } = await fixture();
    await manager.start({ clientId: "client-a", browserProfile: "primary", platform: "google_ads" });
    identity.registered = undefined;
    await expect(manager.assertActive("client-a", "primary")).rejects.toBeInstanceOf(BrowserSessionLostError);
    expect(await manager.get("client-a", "primary")).toMatchObject({ sessionStatus: "lost", lostReason: "managed browser window is closed" });
  });

  it.each([
    ["PID", (surface: NativeSurface) => ({ ...surface, pid: surface.pid + 1 })],
    ["Window ID", (surface: NativeSurface) => ({ ...surface, windowId: "replacement-window" })],
    ["Profile", (surface: NativeSurface) => ({ ...surface, browserProfile: "Default@replacement" })],
    ["bounds", (surface: NativeSurface) => ({ ...surface, bounds: { ...surface.bounds, width: surface.bounds.width - 20 } })]
  ])("rejects changed %s without rebinding", async (_label, change) => {
    const { manager, identity } = await fixture();
    const session = await manager.start({ clientId: "client-a", browserProfile: "primary", platform: "google_ads" });
    identity.registered = change(identity.registered!);
    if (identity.registered.pid !== session.processId) {
      identity.identifySurfaceByProcess = vi.fn(async () => identity.registered);
    }
    await expect(manager.assertActive("client-a", "primary")).rejects.toMatchObject({ code: "BROWSER_SESSION_LOST" });
    expect(await manager.get("client-a", "primary")).toMatchObject({ sessionStatus: "lost" });
  });

  it("recovers the exact durable session across application restart", async () => {
    const { root, identity, launcher, store, manager } = await fixture();
    const started = await manager.start({ clientId: "client-a", browserProfile: "primary", platform: "google_ads" });
    const restarted = new BrowserSessionManager(root, { store, launcher, surfaceIdentity: identity, pollAttempts: 1, pollIntervalMs: 0 });
    await expect(restarted.recover()).resolves.toEqual([expect.objectContaining({ sessionId: started.sessionId, sessionStatus: "connected" })]);
    await expect(restarted.assertActive("client-a", "primary", "google_ads")).resolves.toMatchObject({ processId: started.processId, windowId: started.windowId });
  });

  it("does not adopt a replacement process during restart recovery", async () => {
    const { root, identity, launcher, store, manager } = await fixture();
    const started = await manager.start({ clientId: "client-a", browserProfile: "primary", platform: "google_ads" });
    launcher.alive.delete(started.processId!);
    identity.registered = { ...identity.registered!, pid: 999 };
    const restarted = new BrowserSessionManager(root, { store, launcher, surfaceIdentity: identity, pollAttempts: 1, pollIntervalMs: 0 });
    await expect(restarted.recover()).resolves.toEqual([expect.objectContaining({ sessionStatus: "lost", lostReason: expect.stringContaining("did not survive") })]);
  });

  it("guards capture/action races and surfaces a typed runtime blocker", async () => {
    const { manager, identity } = await fixture();
    await manager.start({ clientId: "client-a", browserProfile: "primary", platform: "google_ads" });
    const wrongSurface = { ...identity.active!, windowId: "window-raced" };
    const execute = vi.fn(async () => undefined);
    const guarded = new BrowserSessionBoundOperator({
      capture: async () => ({
        base64: "screen", width: 100, height: 100, scaleFactor: 1,
        capturedAt: "2026-07-22T08:00:00.000Z", sha256: "a".repeat(64),
        surface: wrongSurface, surfaceFingerprint: "b".repeat(64)
      }),
      execute,
      identifySurface: async () => ({ surface: identity.active!, fingerprint: "a".repeat(64) })
    }, manager, "client-a", "primary", "google_ads");
    const runtime = new VisualComputerRuntime(guarded, {
      ground: async () => ({ action: "done", target: "task", reason: "done", confidence: 1, expected_result: "done", risk_level: "observe" })
    }, { verify: async () => ({ matched: true, confidence: 1, reason: "done" }) });
    await expect(runtime.runMicroTask({
      instruction: "inspect", target: "campaign", expectedResult: "visible", riskLevel: "observe", permission: "OBSERVE",
      surface: { app: "Google Chrome", browserProfile: identity.active!.browserProfile!, allowedApps: ["Google Chrome"], allowedDomains: [] }
    })).resolves.toMatchObject({ status: "failed", blockerCode: "BROWSER_SESSION_LOST" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps concurrent task bindings explicit instead of sharing mutable client/Profile state", async () => {
    const calls: string[] = [];
    const sessions = {
      assertActive: vi.fn(async (clientId: string, profile: string, platform: string) => {
        calls.push(`active:${clientId}:${profile}:${platform}`);
        return {};
      }),
      assertCapturedSurface: vi.fn(async (clientId: string, _surface: NativeSurface | undefined, profile: string, platform: string) => {
        calls.push(`captured:${clientId}:${profile}:${platform}`);
        return {};
      })
    } as unknown as BrowserSessionManager;
    const screenshot: Screenshot = {
      base64: "screen",
      width: 100,
      height: 100,
      scaleFactor: 1,
      capturedAt: "2026-07-22T08:00:00.000Z",
      sha256: "a".repeat(64)
    };
    const underlying: NativeOperator = {
      capture: async () => screenshot,
      execute: async (_action, _screenshot, task) => {
        calls.push(`execute:${task?.clientId}:${task?.surface.browserProfile}:${task?.platform}`);
      }
    };
    const guarded = new BrowserSessionBoundOperator(underlying, sessions);
    const taskA: VisualMicroTask = {
      instruction: "A",
      target: "A",
      expectedResult: "A",
      riskLevel: "interact",
      permission: "INTERACT",
      clientId: "client-a",
      platform: "google_ads",
      surface: {
        app: "Google Chrome",
        browserProfile: "profile-a",
        allowedApps: ["Google Chrome"],
        allowedDomains: []
      }
    };
    const taskB: VisualMicroTask = {
      ...taskA,
      instruction: "B",
      target: "B",
      expectedResult: "B",
      clientId: "client-b",
      platform: "meta_ads",
      surface: { ...taskA.surface, browserProfile: "profile-b" }
    };
    guarded.bindTask(taskA);
    guarded.bindTask(taskB);
    await Promise.all([guarded.capture(taskA), guarded.capture(taskB)]);
    await Promise.all([
      guarded.execute({
        action: "click", x: 1, y: 1, target: "A", reason: "A", confidence: 1,
        expected_result: "A", risk_level: "interact"
      }, screenshot, taskA),
      guarded.execute({
        action: "click", x: 2, y: 2, target: "B", reason: "B", confidence: 1,
        expected_result: "B", risk_level: "interact"
      }, screenshot, taskB)
    ]);
    expect(calls).toEqual(expect.arrayContaining([
      "active:client-a:profile-a:google_ads",
      "captured:client-a:profile-a:google_ads",
      "active:client-b:profile-b:meta_ads",
      "captured:client-b:profile-b:meta_ads",
      "execute:client-a:profile-a:google_ads",
      "execute:client-b:profile-b:meta_ads"
    ]));
  });

  it("requires an exact Profile when a client has multiple sessions", async () => {
    const { manager } = await fixture();
    await manager.start({ clientId: "client-a", browserProfile: "google", platform: "google_ads" });
    await manager.start({ clientId: "client-a", browserProfile: "meta", platform: "meta_ads" });
    await expect(manager.get("client-a")).rejects.toMatchObject({ code: "BROWSER_SESSION_LOST" });
  });
});
