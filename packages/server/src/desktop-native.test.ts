import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import type { BrowserSession } from "@adpilot/computer-use";
import {
  DesktopPermissionId,
  type DesktopNativeBridge,
  type DesktopProjectRootSelection,
  type DesktopPermissionStatus
} from "./desktop-native.js";
import { createServer } from "./index.js";

const token = "native-test-token-that-is-longer-than-thirty-two-characters";
const cookie = `adpilot_native_instance=${encodeURIComponent(token)}`;
let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop native REST boundary", () => {
  it("requires the instance cookie and same-origin browser context", async () => {
    const { server, productSession } = await boot();
    const settingsWithoutCookie = await server.inject({ method: "GET", url: "/api/settings" });
    expect(settingsWithoutCookie.statusCode).toBe(403);
    expect(settingsWithoutCookie.json()).toMatchObject({ code: "DESKTOP_NATIVE_FORBIDDEN" });
    const settingsWithCookie = await server.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie, "sec-fetch-site": "same-origin" }
    });
    expect(settingsWithCookie.statusCode).toBe(200);
    const eventsWithoutCookie = await server.inject({ method: "GET", url: "/events" });
    expect(eventsWithoutCookie.statusCode).toBe(403);
    expect(eventsWithoutCookie.json()).toMatchObject({ code: "DESKTOP_NATIVE_FORBIDDEN" });
    const missing = await server.inject({ method: "GET", url: "/api/desktop-native/permissions" });
    expect(missing.statusCode).toBe(403);
    const crossSite = await server.inject({
      method: "GET",
      url: "/api/desktop-native/permissions",
      headers: { cookie, "sec-fetch-site": "cross-site" }
    });
    expect(crossSite.statusCode).toBe(403);
    const accepted = await server.inject({
      method: "GET",
      url: "/api/desktop-native/permissions",
      headers: { cookie, "sec-fetch-site": "same-origin" }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(accepted.json()).toMatchObject({ nativeDesktop: true, helperAvailable: true });
    const controlWithoutCookie = await server.inject({ method: "POST", url: "/api/computer/takeover" });
    expect(controlWithoutCookie.statusCode).toBe(403);
    const controlWithCookie = await server.inject({
      method: "POST",
      url: "/api/computer/takeover",
      headers: { cookie, "sec-fetch-site": "same-origin" }
    });
    expect(controlWithCookie.statusCode).toBe(409);
    expect(controlWithCookie.json()).toMatchObject({ code: "COMPUTER_USE_UNAVAILABLE" });
    const permissionGrantWithoutCookie = await server.inject({
      method: "PUT",
      url: `/api/clients/personal/sessions/${productSession.id}/computer-use`,
      payload: {
        revision: productSession.revision,
        browserProfile: "personal-google",
        computerUse: "observe",
        confirm: true
      }
    });
    expect(permissionGrantWithoutCookie.statusCode).toBe(403);
    expect(permissionGrantWithoutCookie.json()).toMatchObject({ code: "DESKTOP_NATIVE_FORBIDDEN" });
    await server.close();
  });

  it("protects conversation Stop with the desktop instance boundary and returns an explicit hit result", async () => {
    const { server, system } = await boot();
    const stopConversation = vi.spyOn(system.agent, "stopConversationRun")
      .mockReturnValueOnce({ stopped: false, status: "not_found" })
      .mockReturnValueOnce({ stopped: true, status: "stopped" });
    const url = "/api/clients/client-a/conversations/conversation-42/stop";
    const firstRunId = crypto.randomUUID();
    const secondRunId = crypto.randomUUID();

    const missing = await server.inject({ method: "POST", url });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: "DESKTOP_NATIVE_FORBIDDEN" });
    const crossSite = await server.inject({
      method: "POST",
      url,
      headers: { cookie, "sec-fetch-site": "cross-site" }
    });
    expect(crossSite.statusCode).toBe(403);
    expect(stopConversation).not.toHaveBeenCalled();

    const idle = await server.inject({
      method: "POST",
      url,
      headers: { cookie, "sec-fetch-site": "same-origin" },
      payload: { runId: firstRunId }
    });
    expect(idle.statusCode).toBe(200);
    expect(idle.headers["cache-control"]).toBe("no-store");
    expect(idle.json()).toEqual({ stopped: false, status: "not_found" });

    const stopped = await server.inject({
      method: "POST",
      url,
      headers: { cookie, "sec-fetch-site": "same-origin" },
      payload: { runId: secondRunId }
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual({ stopped: true, status: "stopped" });
    expect(stopConversation).toHaveBeenNthCalledWith(1, "client-a", "conversation-42", firstRunId);
    expect(stopConversation).toHaveBeenNthCalledWith(2, "client-a", "conversation-42", secondRunId);
    await server.close();
  });

  it("opens only the instance-bound project-directory chooser and leaves no audit payload", async () => {
    const { server, system, bridge } = await boot();
    const selectProjectRoot = vi.mocked(bridge.selectProjectRoot);
    const beforeAudit = await system.audit.list("personal");

    const missing = await server.inject({
      method: "POST",
      url: "/api/desktop-native/project-root/select"
    });
    expect(missing.statusCode).toBe(403);
    const crossSite = await server.inject({
      method: "POST",
      url: "/api/desktop-native/project-root/select",
      headers: { cookie, "sec-fetch-site": "cross-site" }
    });
    expect(crossSite.statusCode).toBe(403);
    expect(selectProjectRoot).not.toHaveBeenCalled();

    const callerSuppliedPath = await server.inject({
      method: "POST",
      url: "/api/desktop-native/project-root/select",
      headers: { cookie, "sec-fetch-site": "same-origin" },
      payload: { path: "/tmp/caller-controlled" }
    });
    expect(callerSuppliedPath.statusCode).toBe(400);
    expect(selectProjectRoot).not.toHaveBeenCalled();

    selectProjectRoot.mockResolvedValueOnce({ cancelled: false, path: "/tmp/example-project" });
    const selected = await server.inject({
      method: "POST",
      url: "/api/desktop-native/project-root/select",
      headers: { cookie, "sec-fetch-site": "same-origin" }
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.headers["cache-control"]).toContain("no-store");
    expect(selected.json()).toEqual({ cancelled: false, path: "/tmp/example-project" });

    selectProjectRoot.mockResolvedValueOnce({ cancelled: true });
    const cancelled = await server.inject({
      method: "POST",
      url: "/api/desktop-native/project-root/select",
      headers: { cookie, "sec-fetch-site": "same-origin" }
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ cancelled: true });
    expect(selectProjectRoot).toHaveBeenCalledTimes(2);
    expect(await system.audit.list("personal")).toEqual(beforeAudit);
    await server.close();
  });

  it("fails closed when no desktop instance credential is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-stop-no-native-auth-"));
    roots.push(root);
    const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
    const stopConversation = vi.spyOn(system.runtime, "stopConversation");
    const server = await createServer(system, { uiRoot: join(root, "missing-ui") });

    const response = await server.inject({
      method: "POST",
      url: "/api/clients/client-a/conversations/conversation-42/stop",
      headers: { "sec-fetch-site": "same-origin" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "DESKTOP_NATIVE_FORBIDDEN" });
    expect(stopConversation).not.toHaveBeenCalled();
    await server.close();
  });

  it("returns only a frame that matches the authoritative browser binding", async () => {
    const { server, system, bridge, productSession: disabledProductSession } = await boot();
    const browser = connectedBrowser();
    vi.spyOn(system.browserSessions, "recover").mockResolvedValue([]);
    vi.spyOn(system.browserSessions, "list").mockResolvedValue([browser]);
    const configured = await server.inject({
      method: "PUT",
      url: `/api/clients/personal/sessions/${disabledProductSession.id}/computer-use`,
      headers: { cookie, "sec-fetch-site": "same-origin" },
      payload: {
        revision: disabledProductSession.revision,
        browserProfile: browser.browserProfile,
        computerUse: "observe",
        confirm: true
      }
    });
    expect(configured.statusCode).toBe(200);
    const productSession = configured.json() as typeof disabledProductSession;
    expect(productSession.permissionProfile).toMatchObject({
      level: "OBSERVE",
      computerUse: "observe",
      browserProfile: browser.browserProfile,
      approvalRequired: true
    });
    expect((await system.audit.list("personal")).map((event) => event.action)).toEqual(expect.arrayContaining([
      "session_permission_escalation_reviewed",
      "session_permission_profile_update"
    ]));
    const staleReview = await server.inject({
      method: "PUT",
      url: `/api/clients/personal/sessions/${disabledProductSession.id}/computer-use`,
      headers: { cookie, "sec-fetch-site": "same-origin" },
      payload: {
        revision: disabledProductSession.revision,
        browserProfile: browser.browserProfile,
        computerUse: "interactive",
        confirm: true
      }
    });
    expect(staleReview.statusCode).toBe(409);
    expect(staleReview.json()).toMatchObject({ code: "REVISION_CONFLICT" });
    const unboundProductSession = await system.sessions.create({ clientId: "personal" });
    const crossSessionFrame = await server.inject({
      method: "GET",
      url: `/api/desktop-native/live-frame?clientId=personal&productSessionId=${unboundProductSession.id}&browserSessionId=${browser.sessionId}`,
      headers: { cookie, "sec-fetch-site": "same-origin" }
    });
    expect(crossSessionFrame.statusCode).toBe(409);
    expect(crossSessionFrame.json()).toMatchObject({ code: "DESKTOP_NATIVE_BINDING_MISMATCH" });

    const accepted = await server.inject({
      method: "GET",
      url: `/api/desktop-native/live-frame?clientId=personal&productSessionId=${productSession.id}&browserSessionId=${browser.sessionId}`,
      headers: { cookie, "sec-fetch-site": "same-origin" }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["cache-control"]).toContain("no-store");
    expect(accepted.json()).toMatchObject({
      clientId: "personal",
      browserSessionId: browser.sessionId,
      application: { pid: 777, bundleId: "com.google.Chrome" },
      window: { id: "77" }
    });

    vi.mocked(bridge.captureLiveFrame).mockResolvedValueOnce({
      ...liveFrame(),
      application: { pid: 778, bundleId: "com.google.Chrome", name: "Google Chrome" }
    });
    const mismatched = await server.inject({
      method: "GET",
      url: `/api/desktop-native/live-frame?clientId=personal&productSessionId=${productSession.id}&browserSessionId=${browser.sessionId}`,
      headers: { cookie, "sec-fetch-site": "same-origin" }
    });
    // Broker cache is identity-keyed and short-lived; wait beyond its bounded reuse window.
    await new Promise((resolve) => setTimeout(resolve, 220));
    const mismatchedFresh = mismatched.statusCode === 200
      ? await server.inject({
          method: "GET",
          url: `/api/desktop-native/live-frame?clientId=personal&productSessionId=${productSession.id}&browserSessionId=${browser.sessionId}`,
          headers: { cookie, "sec-fetch-site": "same-origin" }
        })
      : mismatched;
    expect(mismatchedFresh.statusCode).toBe(409);
    expect(mismatchedFresh.json()).toMatchObject({ code: "DESKTOP_NATIVE_BINDING_MISMATCH" });
    await server.close();
  });
});

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-desktop-native-"));
  roots.push(root);
  const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
  const bridge = fakeBridge();
  const server = await createServer(system, {
    uiRoot: join(root, "missing-ui"),
    desktopNative: bridge,
    desktopNativeAuthToken: token
  });
  const productSession = await system.sessions.create({ clientId: "personal" });
  return { server, system, bridge, productSession };
}

function fakeBridge() {
  const permissions = DesktopPermissionId.options.map((id) => permission(id, "granted"));
  return {
    permissionCenter: vi.fn(async () => ({
      platform: "darwin" as const,
      nativeDesktop: true,
      helperAvailable: true,
      helperVersion: "test",
      checkedAt: "2026-07-28T00:00:00.000Z",
      permissions
    })),
    requestPermissions: vi.fn(async () => ({
      platform: "darwin" as const,
      nativeDesktop: true,
      helperAvailable: true,
      helperVersion: "test",
      checkedAt: "2026-07-28T00:00:00.000Z",
      permissions
    })),
    openPermissionSettings: vi.fn(async () => undefined),
    testPermission: vi.fn(async (id) => ({
      permission: id,
      ok: true,
      status: "granted" as const,
      checkedAt: "2026-07-28T00:00:00.000Z",
      message: "passed"
    })),
    selectProjectRoot: vi.fn(async (): Promise<DesktopProjectRootSelection> => ({ cancelled: true })),
    captureLiveFrame: vi.fn(async (_context: Parameters<DesktopNativeBridge["captureLiveFrame"]>[0]) => liveFrame())
  } satisfies DesktopNativeBridge;
}

function permission(id: (typeof DesktopPermissionId.options)[number], status: DesktopPermissionStatus) {
  return {
    id,
    status,
    checkedAt: "2026-07-28T00:00:00.000Z",
    processName: "AdPilot Computer Helper",
    bundleId: "com.adpilot.computer-helper",
    reason: "test",
    affectedFeatures: ["test"],
    canRequest: false,
    canOpenSettings: true,
    canTest: true,
    requiresRestart: false
  };
}

function connectedBrowser(): BrowserSession {
  return {
    sessionId: "b".repeat(32),
    clientId: "personal",
    browserProfile: "personal-google",
    profileDirectory: "/private/profile",
    nativeProfileFingerprint: "profile-fingerprint",
    processId: 777,
    windowId: "77",
    windowBounds: { x: 20, y: 40, width: 1280, height: 800 },
    platform: "google_ads",
    runtimePlatform: "darwin",
    browserApplicationId: "com.google.Chrome",
    browserApp: "Google Chrome",
    sessionStatus: "connected",
    startedAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    lastValidatedAt: "2026-07-28T00:00:00.000Z"
  };
}

function liveFrame() {
  return {
    frameId: "a".repeat(64),
    browserSessionId: "b".repeat(32),
    clientId: "personal",
    dataUrl: "data:image/jpeg;base64,/9j/2Q==",
    width: 1280,
    height: 800,
    source: { width: 2560, height: 1600 },
    capturedAt: "2026-07-28T00:00:00.000Z",
    application: { pid: 777, bundleId: "com.google.Chrome", name: "Google Chrome" },
    window: {
      id: "77",
      bounds: { x: 20, y: 40, width: 1280, height: 800 }
    },
    browser: {
      profile: "personal-google",
      pageIdentity: {
        status: "unavailable" as const,
        observedAt: "2026-07-28T00:00:00.000Z",
        code: "accessibility_not_granted" as const,
        reason: "Accessibility is unavailable in this fixture"
      }
    }
  };
}
