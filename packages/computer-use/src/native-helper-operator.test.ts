import { describe, expect, it, vi } from "vitest";
import {
  NativeHelperSurfaceIdentity,
  NativeInputActivityMonitor,
  NativeHelperOperator,
  nativeRequestContext,
  type NativeComputerService,
  type VisualMicroTask
} from "./index.js";

const task: VisualMicroTask = {
  clientId: "client-a",
  taskId: "11111111-1111-4111-8111-111111111111",
  stepId: "step-1",
  planId: "22222222-2222-4222-8222-222222222222",
  platform: "google_ads",
  instruction: "click one visible control",
  target: "date selector",
  expectedResult: "date selector is open",
  riskLevel: "interact",
  permission: "INTERACT",
  surface: {
    app: "Google Chrome",
    applicationId: "com.google.Chrome",
    processId: 42,
    windowId: "77",
    browserProfile: "primary",
    nativeProfileFingerprint: "Default@0123456789abcdef",
    allowedApps: ["Google Chrome", "com.google.Chrome"],
    allowedDomains: ["ads.google.com"],
    domain: "ads.google.com"
  }
};

function service() {
  const calls: Array<{ method: string; params: unknown; options: unknown }> = [];
  let captureCount = 0;
  const request = vi.fn(async (method: string, params: any, options: any): Promise<any> => {
    calls.push({ method, params, options });
    if (method === "frontmost") {
      return {
        ownerPid: 42,
        ownerName: "Google Chrome",
        bundleId: "com.google.Chrome",
        window: {
          windowId: 77,
          ownerPid: 42,
          ownerName: "Google Chrome",
          bundleId: "com.google.Chrome",
          title: "Google Ads",
          layer: 0,
          alpha: 1,
          onScreen: true,
          bounds: { x: 100, y: 50, width: 800, height: 600 }
        }
      };
    }
    if (method === "displays.list") {
      return [{
        displayId: 1,
        isMain: true,
        isBuiltin: true,
        rotationDegrees: 0,
        scaleFactor: 2,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        pixels: { width: 2880, height: 1800 }
      }];
    }
    if (method === "windows.list") {
      return [{
        windowId: 77,
        ownerPid: 42,
        ownerName: "Google Chrome",
        bundleId: "com.google.Chrome",
        title: "Google Ads",
        layer: 0,
        alpha: 1,
        onScreen: true,
        bounds: { x: 100, y: 50, width: 800, height: 600 }
      }];
    }
    if (method === "input.activity") {
      return {
        sampledAtUnixMs: Date.now(),
        cursor: { x: 0, y: 0 },
        counters: {},
        helperPostedCounters: {}
      };
    }
    if (method === "capture") {
      captureCount += 1;
      return {
        format: "png",
        base64: "iVBORw0KGgoAAA==",
        width: 1600,
        height: 1200,
        capturedAt: new Date(Date.parse("2026-07-28T00:00:00.000Z") + captureCount).toISOString(),
        source: { target: "window", windowId: 77 },
        surfaceLease: {
          generation: "33333333-3333-4333-8333-333333333333",
          sessionId: options.sessionId,
          target: "window",
          windowId: 77,
          ownerPid: 42,
          bundleId: "com.google.Chrome",
          bounds: { x: 100, y: 50, width: 800, height: 600 },
          capturePixels: { width: 1600, height: 1200 },
          capturedAtUnixMs: Date.now(),
          expiresAtUnixMs: Date.now() + 30_000
        }
      };
    }
    if (method === "input.click") return { posted: true, eventCount: 2 };
    throw new Error(`unexpected method ${method}`);
  });
  return {
    host: { closed: false, request } as unknown as NativeComputerService,
    calls,
    request
  };
}

describe("NativeHelperOperator", () => {
  it("fails closed for focus-routed hotkeys without calling the Helper", async () => {
    const fixture = service();
    const operator = new NativeHelperOperator(fixture.host);
    const screenshot = await operator.capture(task);

    await expect(operator.execute({
      action: "hotkey",
      keys: "CMD+S",
      target: "save",
      reason: "requested shortcut",
      confidence: 1,
      expected_result: "save is requested",
      risk_level: "interact"
    }, screenshot, task)).rejects.toMatchObject({ code: "EXACT_KEY_TARGET_UNAVAILABLE" });

    expect(fixture.calls.some((call) => call.method === "input.keypress")).toBe(false);
  });

  it("captures one bound window and consumes its lease for exactly one atomic click", async () => {
    const fixture = service();
    const operator = new NativeHelperOperator(fixture.host);
    const screenshot = await operator.capture(task);
    expect(screenshot).toMatchObject({
      width: 1600,
      height: 1200,
      scaleFactor: 2,
      surface: {
        app: "Google Chrome",
        bundleId: "com.google.Chrome",
        browserProfile: "Default@0123456789abcdef",
        pid: 42,
        windowId: "77",
        screenId: "1"
      }
    });
    await operator.execute({
      action: "click",
      x: 100,
      y: 120,
      target: "date selector",
      reason: "visible",
      confidence: 1,
      expected_result: "date selector is open",
      risk_level: "interact"
    }, screenshot, task);
    const nativeInput = fixture.calls.find((call) => call.method === "input.click");
    expect(nativeInput).toMatchObject({
      params: {
        pixelX: 100,
        pixelY: 120,
        button: "left",
        clickCount: 1,
        surfaceLease: { windowId: 77, ownerPid: 42 }
      },
      options: {
        sessionId: expect.stringMatching(/^session_[a-f0-9]{40}$/),
        actionId: expect.stringMatching(/^action_[a-f0-9]{40}$/)
      }
    });
    await expect(operator.execute({
      action: "click",
      x: 100,
      y: 120,
      target: "date selector",
      reason: "duplicate",
      confidence: 1,
      expected_result: "date selector is open",
      risk_level: "interact"
    }, screenshot, task)).rejects.toMatchObject({ code: "SURFACE_LEASE_MISSING" });
    expect(fixture.calls.filter((call) => call.method === "input.click")).toHaveLength(1);
  });

  it("fails closed before capture when the active native window differs from the task binding", async () => {
    const fixture = service();
    fixture.request.mockImplementationOnce(async () => ({
      ownerPid: 99,
      ownerName: "Notes",
      bundleId: "com.apple.Notes",
      window: {
        windowId: 12,
        ownerPid: 99,
        ownerName: "Notes",
        bundleId: "com.apple.Notes",
        title: "Notes",
        layer: 0,
        alpha: 1,
        onScreen: true,
        bounds: { x: 0, y: 0, width: 500, height: 500 }
      }
    }));
    const operator = new NativeHelperOperator(fixture.host);
    await expect(operator.capture(task)).rejects.toMatchObject({ code: "SURFACE_CHANGED" });
    expect(fixture.calls.some((call) => call.method === "capture")).toBe(false);
  });

  it("aborts a pending Helper input request when control changes", async () => {
    const fixture = service();
    const operator = new NativeHelperOperator(fixture.host);
    const screenshot = await operator.capture(task);
    fixture.request.mockImplementation(async (method: string, _params: unknown, options: any) => {
      if (method !== "input.click") throw new Error(`unexpected method ${method}`);
      await new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const pending = operator.execute({
      action: "click",
      x: 100,
      y: 120,
      target: "date selector",
      reason: "visible",
      confidence: 1,
      expected_result: "date selector is open",
      risk_level: "interact"
    }, screenshot, task);
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalled());
    operator.cancelPendingInput();
    await expect(pending).rejects.toThrow("aborted");
  });

  it("derives a stable Helper session from Product+Browser sessions, not task ids", () => {
    const first = nativeRequestContext({
      ...task,
      adPilotSessionId: "product-session",
      browserSessionId: "browser-session",
      taskId: "task-one"
    });
    const second = nativeRequestContext({
      ...task,
      adPilotSessionId: "product-session",
      browserSessionId: "browser-session",
      taskId: "task-two"
    });
    expect(first.sessionId).toBe(second.sessionId);
    expect(first.actionId).not.toBe(second.actionId);
  });

  it("cancels only the selected Helper session while another action stays live", async () => {
    const fixture = service();
    const operator = new NativeHelperOperator(fixture.host);
    const taskA = { ...task, adPilotSessionId: "product-a", browserSessionId: "browser-a", taskId: "task-a" };
    const taskB = { ...task, adPilotSessionId: "product-b", browserSessionId: "browser-b", taskId: "task-b" };
    const screenshotA = await operator.capture(taskA);
    const screenshotB = await operator.capture(taskB);
    const resolvers = new Map<string, () => void>();
    const signals = new Map<string, AbortSignal>();
    fixture.request.mockImplementation(async (method: string, _params: unknown, options: any) => {
      if (method !== "input.click") throw new Error(`unexpected method ${method}`);
      signals.set(options.sessionId, options.signal);
      await new Promise<void>((resolve, reject) => {
        resolvers.set(options.sessionId, resolve);
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { posted: true, eventCount: 2 };
    });
    const action = {
      action: "click" as const,
      x: 100,
      y: 120,
      target: "date selector",
      reason: "visible",
      confidence: 1,
      expected_result: "date selector is open",
      risk_level: "interact" as const
    };
    const pendingA = operator.execute(action, screenshotA, taskA);
    const pendingB = operator.execute(action, screenshotB, taskB);
    await vi.waitFor(() => expect(resolvers.size).toBe(2));

    operator.cancelPendingInput({ adPilotSessionId: "product-a", browserSessionId: "browser-a" });
    await expect(pendingA).rejects.toThrow("aborted");
    const sessionB = nativeRequestContext(taskB).sessionId;
    expect(signals.get(sessionB)?.aborted).toBe(false);
    resolvers.get(sessionB)!();
    await expect(pendingB).resolves.toBeUndefined();
  });

  it("keeps independent physical-input monitors armed for overlapping sessions", async () => {
    const fixture = service();
    const operator = new NativeHelperOperator(fixture.host);
    operator.setUserInputHandler(async () => undefined);
    const taskA = { ...task, adPilotSessionId: "product-a", browserSessionId: "browser-a", taskId: "task-a" };
    const taskB = { ...task, adPilotSessionId: "product-b", browserSessionId: "browser-b", taskId: "task-b" };
    await operator.capture(taskA);
    await operator.capture(taskB);
    await operator.capture(taskB);
    expect(fixture.calls.filter((call) => call.method === "input.activity")).toHaveLength(2);

    operator.cancelPendingInput({ adPilotSessionId: "product-a", browserSessionId: "browser-a" });
    await operator.capture(taskB);
    expect(fixture.calls.filter((call) => call.method === "input.activity")).toHaveLength(2);
    await operator.capture(taskA);
    expect(fixture.calls.filter((call) => call.method === "input.activity")).toHaveLength(3);
    operator.setUserInputHandler(undefined);
  });

  it("ignores Helper telemetry but detects concurrent same-type physical input", async () => {
    const samples = [
      {
        sampledAtUnixMs: 1,
        cursor: { x: 10, y: 10 },
        counters: { leftMouseDown: 10, leftMouseUp: 10 },
        helperPostedCounters: { leftMouseDown: 4, leftMouseUp: 4 }
      },
      {
        sampledAtUnixMs: 2,
        cursor: { x: 20, y: 20 },
        // Helper synthetic click telemetry advances, but physical HID counters
        // do not. This must not trigger takeover.
        counters: { leftMouseDown: 10, leftMouseUp: 10 },
        helperPostedCounters: { leftMouseDown: 5, leftMouseUp: 5 }
      },
      {
        sampledAtUnixMs: 3,
        cursor: { x: 20, y: 20 },
        // The user and Helper both click in the same interval. Subtracting the
        // matching Helper delta would hide this physical takeover.
        counters: { leftMouseDown: 11, leftMouseUp: 11 },
        helperPostedCounters: { leftMouseDown: 6, leftMouseUp: 6 }
      }
    ];
    const onTakeover = vi.fn(async () => undefined);
    const activityHost = {
      closed: false,
      request: vi.fn(async () => samples.shift()!)
    } as unknown as NativeComputerService;
    const monitor = new NativeInputActivityMonitor(activityHost, "session-activity", onTakeover, 5_000);
    await monitor.start();
    await expect(monitor.sampleOnce()).resolves.toBe(false);
    expect(onTakeover).not.toHaveBeenCalled();
    await expect(monitor.sampleOnce()).resolves.toBe(true);
    expect(onTakeover).toHaveBeenCalledOnce();
    expect(onTakeover).toHaveBeenCalledWith("physical_input");
    expect(monitor.running).toBe(false);
  });

  it("fails closed when the supervised Helper epoch changes and activity counters reset", async () => {
    let epoch = 1;
    let requestCount = 0;
    const onTakeover = vi.fn(async () => undefined);
    const activityHost = {
      closed: false,
      get epoch() { return epoch; },
      request: vi.fn(async () => {
        requestCount += 1;
        if (requestCount === 2) epoch = 2;
        return {
          sampledAtUnixMs: requestCount,
          cursor: { x: 0, y: 0 },
          counters: {},
          helperPostedCounters: {}
        };
      })
    } as unknown as NativeComputerService;
    const monitor = new NativeInputActivityMonitor(activityHost, "session-restarted", onTakeover, 5_000);

    await monitor.start();
    await expect(monitor.sampleOnce()).resolves.toBe(true);
    expect(onTakeover).toHaveBeenCalledOnce();
    expect(onTakeover).toHaveBeenCalledWith("activity_monitor_unavailable");
    expect(monitor.running).toBe(false);
  });

  it("uses the same Helper actor for active and process-bound browser identity", async () => {
    const fixture = service();
    const identity = new NativeHelperSurfaceIdentity(fixture.host);
    identity.registerBrowserProfile(42, "Default@0123456789abcdef");
    await expect(identity.identifyActiveSurface()).resolves.toMatchObject({
      pid: 42,
      windowId: "77",
      browserProfile: "Default@0123456789abcdef"
    });
    await expect(identity.identifySurfaceByProcess(42)).resolves.toMatchObject({
      pid: 42,
      windowId: "77",
      browserProfile: "Default@0123456789abcdef"
    });
    expect(fixture.calls.map((call) => call.method)).toEqual(expect.arrayContaining([
      "frontmost",
      "windows.list",
      "displays.list"
    ]));
  });

  it("requires a fresh capture after the supervised Helper epoch changes", async () => {
    const fixture = service();
    let epoch = 1;
    Object.defineProperty(fixture.host, "epoch", { get: () => epoch });
    const operator = new NativeHelperOperator(fixture.host);
    const screenshot = await operator.capture(task);
    epoch = 2;
    await expect(operator.execute({
      action: "click",
      x: 100,
      y: 120,
      target: "date selector",
      reason: "visible",
      confidence: 1,
      expected_result: "date selector is open",
      risk_level: "interact"
    }, screenshot, task)).rejects.toMatchObject({ code: "SURFACE_LEASE_STALE" });
    expect(fixture.calls.filter((call) => call.method === "input.click")).toHaveLength(0);
  });
});
