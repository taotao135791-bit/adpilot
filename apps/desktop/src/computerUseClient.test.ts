import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computerUseCopy,
  isComputerUseReady,
  localizeRuntimeRoute,
  localizeRuntimeValue
} from "./ComputerUseSettings.js";
import {
  DesktopApiError,
  closeBrowserSession,
  configureProductSessionComputerUse,
  getDesktopLiveFrame,
  getDesktopPermissions,
  getBrowserSession,
  getScreenshotAudits,
  resumeBrowserSession,
  selectDesktopProjectRoot,
  startBrowserSession,
  type BrowserSession
} from "./computerUseClient.js";

const session: BrowserSession = {
  sessionId: "a".repeat(32),
  clientId: "client/上海",
  browserProfile: "work-profile",
  profileDirectory: "/workspace/browser-profiles/client",
  nativeProfileFingerprint: "fingerprint",
  processId: 42,
  windowId: "7",
  windowBounds: { x: 20, y: 40, width: 1200, height: 800 },
  platform: "google_ads",
  runtimePlatform: "darwin",
  browserApplicationId: "com.google.Chrome",
  browserApp: "Google Chrome",
  sessionStatus: "connected",
  startedAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:01:00.000Z",
  lastValidatedAt: "2026-07-22T00:01:00.000Z"
};

afterEach(() => vi.unstubAllGlobals());

describe("desktop Computer Use API client", () => {
  it("loads a wrapped managed-browser session and encodes the client id", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ session, profiles: [{ browserProfile: "work-profile", platform: "google_ads", accountRef: "123-456" }] }));
    vi.stubGlobal("fetch", request);
    const result = await getBrowserSession("client/上海");
    expect(request.mock.calls[0]?.[0]).toBe("/api/browser-session?clientId=client%2F%E4%B8%8A%E6%B5%B7");
    expect(result.session).toEqual(session);
    expect(result.profiles).toEqual([{ browserProfile: "work-profile", platform: "google_ads", accountRef: "123-456" }]);
  });

  it("calls start, resume, and close with explicit product actions", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ session }));
    vi.stubGlobal("fetch", request);
    await startBrowserSession({ clientId: "client-a", browserProfile: "ads-work", platform: "google_ads" });
    await resumeBrowserSession({ clientId: "client-a", browserProfile: "ads-work" });
    await closeBrowserSession({ clientId: "client-a", browserProfile: "ads-work" });
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "/api/browser-session/start",
      "/api/browser-session/resume",
      "/api/browser-session/close"
    ]);
    expect(JSON.parse(String((request.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ clientId: "client-a", browserProfile: "ads-work", platform: "google_ads" });
    expect(request.mock.calls.every((call) => (call[1] as RequestInit).method === "POST")).toBe(true);
  });

  it("loads privacy audit envelopes without screenshot bytes", async () => {
    const audit = {
      auditId: crypto.randomUUID(), clientId: "client-a", taskId: "task-a", purpose: "grounding",
      modelProvider: "openai", modelId: "gpt-5", screenshotId: crypto.randomUUID(), screenshotSha256: "b".repeat(64),
      sentRoi: { x: 1, y: 2, width: 300, height: 200 }, masks: [], leftLocal: true, fullScreenshotLocalOnly: true,
      privacyMode: "minimized", dataRetentionPolicy: "local-session", outcome: "prepared", createdAt: "2026-07-22T00:00:00.000Z"
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ audits: [audit] })));
    await expect(getScreenshotAudits("client-a")).resolves.toEqual([audit]);
  });

  it("returns a typed API error for contextual UI recovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "conflict", code: "BROWSER_SESSION_LOST" }, 409)));
    await expect(resumeBrowserSession({ clientId: "client-a" })).rejects.toEqual(expect.objectContaining<Partial<DesktopApiError>>({ status: 409, code: "BROWSER_SESSION_LOST" }));
  });

  it("sends an explicit revision-bound Product Session Computer Use review", async () => {
    const productSessionId = "11111111-1111-4111-8111-111111111111";
    const updated = {
      id: productSessionId,
      clientId: "client/上海",
      revision: 2,
      permissionProfile: {
        level: "PREPARE",
        computerUse: "interactive",
        browserProfile: "work-profile",
        approvalRequired: true
      }
    };
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(updated));
    vi.stubGlobal("fetch", request);
    await expect(configureProductSessionComputerUse("client/上海", productSessionId, {
      revision: 1,
      browserProfile: "work-profile",
      computerUse: "interactive",
      confirm: true
    })).resolves.toEqual(updated);
    expect(request.mock.calls[0]?.[0]).toBe(
      `/api/clients/client%2F%E4%B8%8A%E6%B5%B7/sessions/${productSessionId}/computer-use`
    );
    expect(JSON.parse(String((request.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      revision: 1,
      browserProfile: "work-profile",
      computerUse: "interactive",
      confirm: true
    });
  });

  it("requests permission state and a session-bound native live frame", async () => {
    const productSessionId = "11111111-1111-4111-8111-111111111111";
    const center = {
      platform: "darwin", nativeDesktop: true, helperAvailable: true, helperVersion: "3",
      checkedAt: "2026-07-28T00:00:00.000Z", permissions: []
    };
    const frame = {
      frameId: "f".repeat(64), browserSessionId: "b".repeat(32), clientId: "client/上海",
      dataUrl: "data:image/jpeg;base64,/9j/2Q==", width: 1280, height: 800,
      source: { width: 2560, height: 1600 }, capturedAt: "2026-07-28T00:00:00.000Z",
      application: { pid: 42, bundleId: "com.google.Chrome", name: "Google Chrome" },
      window: { id: "7", bounds: { x: 0, y: 0, width: 1280, height: 800 } },
      browser: { profile: "work-profile" }
    };
    const request = vi.fn(async (input: RequestInfo | URL) =>
      jsonResponse(String(input).includes("live-frame") ? frame : center)
    );
    vi.stubGlobal("fetch", request);

    await expect(getDesktopPermissions("client/上海")).resolves.toEqual(center);
    await expect(getDesktopLiveFrame("client/上海", productSessionId, "b".repeat(32))).resolves.toEqual(frame);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "/api/desktop-native/permissions?clientId=client%2F%E4%B8%8A%E6%B5%B7",
      `/api/desktop-native/live-frame?clientId=client%2F%E4%B8%8A%E6%B5%B7&productSessionId=${productSessionId}&browserSessionId=${"b".repeat(32)}`
    ]);
  });

  it("requests the narrow native project-root chooser and preserves cancellation", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ cancelled: false, path: "/tmp/example-project" }))
      .mockResolvedValueOnce(jsonResponse({ cancelled: true }));
    vi.stubGlobal("fetch", request);

    await expect(selectDesktopProjectRoot()).resolves.toEqual({
      cancelled: false,
      path: "/tmp/example-project"
    });
    await expect(selectDesktopProjectRoot()).resolves.toEqual({ cancelled: true });
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "/api/desktop-native/project-root/select",
      "/api/desktop-native/project-root/select"
    ]);
    expect(request.mock.calls.every((call) => (call[1] as RequestInit).method === "POST")).toBe(true);
  });
});

describe("Computer Use localization", () => {
  it("keeps Chinese and English product copy separate", () => {
    expect(computerUseCopy("zh-CN").managedBrowser).toBe("受管浏览器");
    expect(computerUseCopy("en").managedBrowser).toBe("Managed browser");
    expect(localizeRuntimeRoute("Built-in GUI → Fast Vision → Deep Vision", "zh-CN")).toBe("内置 GUI 定位 → 快速视觉模型 → 深度视觉模型");
    expect(localizeRuntimeRoute("Built-in GUI → Fast Vision → Deep Vision", "en")).toBe("Built-in GUI → Fast Vision → Deep Vision");
    expect(localizeRuntimeValue("not configured", "zh-CN")).toBe("未配置");
    expect(localizeRuntimeValue("not configured", "en")).toBe("Not configured");
  });
});

describe("Computer Use readiness", () => {
  const visualRuntime = { guiConfigured: true };

  it("requires a loaded and connected managed-browser session", () => {
    expect(isComputerUseReady(visualRuntime, "ready", "connected")).toBe(true);
    expect(isComputerUseReady(visualRuntime, "loading", "connected")).toBe(false);
    expect(isComputerUseReady(visualRuntime, "ready", "starting")).toBe(false);
    expect(isComputerUseReady(visualRuntime, "ready", "lost")).toBe(false);
    expect(isComputerUseReady(visualRuntime, "ready", "closed")).toBe(false);
    expect(isComputerUseReady(visualRuntime, "ready", null)).toBe(false);
  });

  it("does not report readiness without a configured visual runtime", () => {
    expect(isComputerUseReady({ guiConfigured: false }, "ready", "connected")).toBe(false);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
