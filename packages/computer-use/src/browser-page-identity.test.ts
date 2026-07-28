import { describe, expect, it, vi } from "vitest";
import type { NativeComputerService, NativeMethod } from "@adpilot/native-computer-host";
import {
  BrowserPageIdentityChangedError,
  BrowserPageIdentityUnavailableError,
  BrowserSessionBoundOperator,
  BrowserSessionManager,
  NativeHelperBrowserPageIdentity,
  type BrowserPageIdentity,
  type BrowserPageIdentitySource,
  type BrowserProcessController,
  type BrowserSession,
  type BrowserSessionStore,
  type NativeOperator,
  type NativeSurface,
  type NativeSurfaceIdentity,
  type PageIdentityBinding,
  type Screenshot,
  type VisualMicroTask
} from "./index.js";

const SESSION_ID = "b".repeat(32);
const PROFILE_PROOF = "Default@profile-proof";
const NOW = "2026-07-28T10:00:00.000Z";

describe("authenticated browser page identity", () => {
  it("reads the actual Chromium address bar without opening a CDP endpoint", async () => {
    const host = nativeHost();
    const reader = new NativeHelperBrowserPageIdentity(host.service, () => new Date(NOW));
    const identity = await reader.read(binding(), { requireFrontmost: true });

    expect(identity).toMatchObject({
      status: "available",
      source: "macos_accessibility",
      url: "https://ads.google.com/aw/campaigns?ocid=123",
      origin: "https://ads.google.com",
      title: "Campaigns - Google Ads",
      processId: 777,
      windowId: "77"
    });
    expect(host.methods).toEqual([
      "permissions.status",
      "windows.list",
      "frontmost",
      "accessibility.snapshot",
      "windows.list",
      "frontmost"
    ]);
    expect(host.methods.some((method) => method.includes("debug") || method.includes("cdp"))).toBe(false);
  });

  it("reports no-Accessibility as unavailable for observation and fail-closed for capture", async () => {
    const source = new NativeHelperBrowserPageIdentity(
      nativeHost({ accessibility: false }).service,
      () => new Date(NOW)
    );
    const harness = managerHarness(source);
    const observed = await harness.manager.observePageIdentity("client-a", "profile-a", "google_ads");
    expect(observed).toMatchObject({
      status: "unavailable",
      code: "accessibility_not_granted"
    });

    const capture = vi.fn(async () => harness.screenshot);
    const guarded = new BrowserSessionBoundOperator(
      { capture, execute: vi.fn(async () => undefined) },
      harness.manager
    );
    await expect(guarded.capture(harness.task)).rejects.toBeInstanceOf(
      BrowserPageIdentityUnavailableError
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    ["PID", { ownerPid: 778, windowId: 77 }],
    ["window", { ownerPid: 777, windowId: 78 }]
  ])("rejects an Accessibility read bound to the wrong %s", async (_label, override) => {
    const host = nativeHost({ window: override });
    const reader = new NativeHelperBrowserPageIdentity(host.service, () => new Date(NOW));
    const identity = await reader.read(binding(), { requireFrontmost: true });
    expect(identity).toMatchObject({
      status: "unavailable",
      code: override.windowId === 78 ? "window_not_found" : "binding_mismatch"
    });
    expect(host.methods).not.toContain("accessibility.snapshot");
  });

  it("blocks native input when the address-bar URL changes after capture", async () => {
    const source = mutablePageSource();
    const harness = managerHarness(source);
    const execute = vi.fn(async () => undefined);
    const guarded = new BrowserSessionBoundOperator(
      { capture: async () => harness.screenshot, execute },
      harness.manager
    );

    await guarded.capture(harness.task);
    source.url = "https://ads.google.com/aw/settings/account";
    await expect(
      guarded.execute(clickAction(), harness.screenshot, harness.task)
    ).rejects.toBeInstanceOf(BrowserPageIdentityChangedError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("invalidates capture-time page evidence on takeover until a fresh capture", async () => {
    const source = mutablePageSource();
    const harness = managerHarness(source);
    const execute = vi.fn(async () => undefined);
    const cancelPendingInput = vi.fn();
    const guarded = new BrowserSessionBoundOperator(
      {
        capture: async () => harness.screenshot,
        execute,
        cancelPendingInput
      },
      harness.manager
    );

    await guarded.capture(harness.task);
    guarded.cancelPendingInput({
      adPilotSessionId: harness.task.adPilotSessionId!,
      browserSessionId: SESSION_ID
    });
    expect((await harness.manager.list())[0]?.pageIdentity).toMatchObject({
      status: "unavailable",
      code: "stale_after_control_change"
    });
    await expect(
      guarded.execute(clickAction(), harness.screenshot, harness.task)
    ).rejects.toMatchObject({
      code: "BROWSER_PAGE_IDENTITY_UNAVAILABLE",
      identity: { code: "stale_after_control_change" }
    });
    expect(execute).not.toHaveBeenCalled();
    expect(cancelPendingInput).toHaveBeenCalledOnce();
  });
});

function nativeHost(options: {
  accessibility?: boolean;
  window?: Partial<ReturnType<typeof nativeWindow>>;
} = {}) {
  const methods: string[] = [];
  const window = nativeWindow(options.window);
  const frontmost = {
    ownerPid: window.ownerPid,
    ownerName: "Google Chrome",
    bundleId: window.bundleId,
    window
  };
  const request = vi.fn(async (method: NativeMethod) => {
    methods.push(method);
    if (method === "permissions.status") {
      return {
        screenCapture: { state: "granted", granted: true },
        accessibility: options.accessibility === false
          ? { state: "notGranted", granted: false }
          : { state: "granted", granted: true }
      };
    }
    if (method === "windows.list") return [window];
    if (method === "frontmost") return frontmost;
    if (method === "accessibility.snapshot") return accessibilitySnapshot();
    throw new Error(`unexpected native method: ${method}`);
  });
  return {
    methods,
    service: {
      closed: false,
      request
    } as unknown as Pick<NativeComputerService, "request" | "closed">
  };
}

function nativeWindow(overrides: Partial<{
  windowId: number;
  ownerPid: number;
  ownerName: string;
  bundleId: string;
  title: string;
}> = {}) {
  return {
    windowId: 77,
    ownerPid: 777,
    ownerName: "Google Chrome",
    bundleId: "com.google.Chrome",
    title: "Campaigns - Google Ads",
    layer: 0,
    alpha: 1,
    onScreen: true,
    bounds: { x: 20, y: 40, width: 1280, height: 800 },
    ...overrides
  };
}

function accessibilitySnapshot() {
  return {
    pid: 777,
    generatedAt: NOW,
    nodeCount: 4,
    truncated: false,
    root: axNode({
      role: "AXApplication",
      children: [
        axNode({
          role: "AXWindow",
          title: "Campaigns - Google Ads",
          bounds: { x: 20, y: 40, width: 1280, height: 800 },
          children: [
            axNode({
              role: "AXTextField",
              description: "Address and search bar",
              value: "https://ads.google.com/aw/campaigns?ocid=123",
              focused: true,
              bounds: { x: 220, y: 83, width: 850, height: 34 }
            })
          ]
        })
      ]
    })
  };
}

function axNode(overrides: Partial<{
  role: string;
  subrole: string;
  title: string;
  description: string;
  enabled: boolean;
  focused: boolean;
  redacted: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
  value: string | number | boolean | null;
  children: unknown[];
}> = {}) {
  return {
    role: "",
    subrole: "",
    title: "",
    description: "",
    enabled: true,
    focused: false,
    redacted: false,
    bounds: null,
    value: null,
    children: [],
    ...overrides
  };
}

function binding(): PageIdentityBinding {
  return {
    browserSessionId: SESSION_ID,
    clientId: "client-a",
    browserProfile: "profile-a",
    nativeProfileFingerprint: PROFILE_PROOF,
    processId: 777,
    windowId: "77",
    applicationId: "com.google.Chrome"
  };
}

function mutablePageSource(): BrowserPageIdentitySource & { url: string } {
  return {
    url: "https://ads.google.com/aw/campaigns?ocid=123",
    async read(input) {
      const url = new URL(this.url);
      return pageIdentity(input, url.href);
    }
  };
}

function pageIdentity(
  input: PageIdentityBinding,
  url = "https://ads.google.com/aw/campaigns?ocid=123"
): BrowserPageIdentity {
  return {
    ...input,
    status: "available",
    source: "macos_accessibility",
    observedAt: NOW,
    url,
    origin: new URL(url).origin,
    title: "Campaigns - Google Ads",
    fingerprint: Buffer.from(url).toString("hex").padEnd(64, "0").slice(0, 64)
  };
}

function managerHarness(pageIdentity: BrowserPageIdentitySource) {
  const session: BrowserSession = {
    ...binding(),
    sessionId: SESSION_ID,
    profileDirectory: "/private/browser-profile",
    platform: "google_ads",
    runtimePlatform: nativePlatform(),
    browserApplicationId: "com.google.Chrome",
    browserApp: "Google Chrome",
    sessionStatus: "connected",
    startedAt: NOW,
    updatedAt: NOW,
    windowBounds: { x: 20, y: 40, width: 1280, height: 800 }
  };
  const surface: NativeSurface = {
    platform: nativePlatform(),
    app: "Google Chrome",
    bundleId: "com.google.Chrome",
    browserProfile: PROFILE_PROOF,
    pid: 777,
    title: "Campaigns - Google Ads",
    windowId: "77",
    bounds: { x: 20, y: 40, width: 1280, height: 800 },
    screenId: "1",
    screenBounds: { x: 0, y: 0, width: 1512, height: 982 },
    scaleFactor: 2
  };
  const screenshot: Screenshot = {
    base64: "screen",
    width: 1280,
    height: 800,
    scaleFactor: 2,
    capturedAt: NOW,
    sha256: "a".repeat(64),
    surface,
    surfaceFingerprint: "b".repeat(64)
  };
  const store = memoryStore(session);
  const launcher: BrowserProcessController = {
    launch: async () => {
      throw new Error("not used");
    },
    isAlive: async (pid) => pid === 777,
    terminate: async () => undefined
  };
  const surfaceIdentity: NativeSurfaceIdentity = {
    identifyActiveSurface: async () => surface,
    identifySurfaceByProcess: async (pid) => pid === 777 ? surface : undefined,
    captureActiveWindow: async () => ({
      base64: "screen",
      width: 1280,
      height: 800,
      scaleFactor: 2,
      surface,
      surfaceFingerprint: "b".repeat(64)
    })
  };
  const manager = new BrowserSessionManager("/private/test", {
    store,
    launcher,
    surfaceIdentity,
    pageIdentity,
    now: () => new Date(NOW),
    pollAttempts: 1,
    pollIntervalMs: 0
  });
  const task: VisualMicroTask = {
    clientId: "client-a",
    adPilotSessionId: "product-session-a",
    browserSessionId: SESSION_ID,
    taskId: "task-a",
    stepId: "step-a",
    platform: "google_ads",
    instruction: "inspect campaigns",
    target: "campaign table",
    expectedResult: "campaign table visible",
    riskLevel: "interact",
    permission: "INTERACT",
    surface: {
      app: "Google Chrome",
      applicationId: "com.google.Chrome",
      processId: 777,
      windowId: "77",
      domain: "ads.google.com",
      browserProfile: "profile-a",
      nativeProfileFingerprint: PROFILE_PROOF,
      allowedApps: ["Google Chrome", "com.google.Chrome"],
      allowedDomains: ["ads.google.com"]
    }
  };
  return { manager, screenshot, task };
}

function memoryStore(initial: BrowserSession): BrowserSessionStore {
  let current = structuredClone(initial);
  return {
    load: async (sessionId) => sessionId === current.sessionId
      ? structuredClone(current)
      : undefined,
    list: async () => [structuredClone(current)],
    save: async (session) => {
      current = structuredClone(session);
    }
  };
}

function clickAction() {
  return {
    action: "click" as const,
    x: 100,
    y: 100,
    target: "campaign",
    reason: "open",
    confidence: 1,
    expected_result: "opened",
    risk_level: "interact" as const
  };
}

function nativePlatform(): "darwin" | "win32" | "linux" {
  return process.platform === "darwin" || process.platform === "win32" || process.platform === "linux"
    ? process.platform
    : "linux";
}
