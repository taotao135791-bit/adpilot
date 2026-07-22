import { afterEach, describe, expect, it, vi } from "vitest";
import { computerUseCopy, localizeRuntimeRoute, localizeRuntimeValue } from "./ComputerUseSettings.js";
import {
  DesktopApiError,
  closeBrowserSession,
  getBrowserSession,
  getScreenshotAudits,
  resumeBrowserSession,
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
