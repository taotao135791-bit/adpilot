import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  ElectronDesktopNativeBridge,
  cursorInCapturedWindow,
  nativePermissionDisplayStatus,
  type SharedNativeComputerService
} from "../apps/electron/src/desktop-native-bridge.js";

describe("Electron desktop native bridge coordinates", () => {
  const lease = {
    bounds: { x: -1_200, y: 100, width: 1_200, height: 800 },
    capturePixels: { width: 2_400, height: 1_600 }
  };

  it("maps negative-origin global points through the actual Retina pixel ratio", () => {
    expect(cursorInCapturedWindow({ x: -600, y: 500 }, lease)).toEqual({ x: 1_200, y: 800 });
  });

  it("does not expose cursor coordinates from another window", () => {
    expect(cursorInCapturedWindow({ x: 100, y: 500 }, lease)).toBeUndefined();
    expect(cursorInCapturedWindow({ x: -600, y: 950 }, lease)).toBeUndefined();
  });
});

describe("Electron native permission presentation", () => {
  it("keeps a Helper restart recommendation visible after TCC reports a grant", () => {
    expect(nativePermissionDisplayStatus({
      helperAvailable: true,
      value: { granted: true },
      requested: true,
      restartRequired: true
    })).toBe("requires-restart");
  });

  it("does not label an unrequested native denial as a definitive denial", () => {
    expect(nativePermissionDisplayStatus({
      helperAvailable: true,
      value: { granted: false },
      requested: false,
      restartRequired: false
    })).toBe("not-determined");
  });

  it("reports only the private app-data probe and never claims Files & Folders TCC", async () => {
    const bridge = permissionBridge();
    const center = await bridge.permissionCenter({});
    expect(center.permissions.find((item) => item.id === "files-and-folders")).toMatchObject({
      status: "not-determined",
      canTest: true
    });
    const result = await bridge.testPermission("files-and-folders", {});
    expect(result).toMatchObject({ ok: true, status: "not-determined" });
    expect(result.message).toContain("does not prove or claim macOS Files & Folders TCC access");
  });

  it("opens Screen Recording and Accessibility panes through the shared Helper", async () => {
    const request = vi.fn(async () => ({ opened: true, permission: "screenCapture" }));
    const openExternal = vi.fn(async () => undefined);
    const bridge = permissionBridge({
      service: {
        pid: 123,
        closed: false,
        request
      } as unknown as SharedNativeComputerService,
      openExternal
    });
    await bridge.openPermissionSettings("screen-recording");
    expect(request).toHaveBeenCalledWith(
      "permissions.openSettings",
      { permission: "screenCapture" },
      expect.objectContaining({ sessionId: expect.stringMatching(/^permission-settings-/) })
    );
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("Electron native project-root selection", () => {
  it("returns only the directory path explicitly chosen by the OS dialog", async () => {
    const selectProjectRoot = vi.fn(async () => "/tmp/example-project");
    const bridge = permissionBridge({ selectProjectRoot });

    await expect(bridge.selectProjectRoot()).resolves.toEqual({
      cancelled: false,
      path: "/tmp/example-project"
    });
    expect(selectProjectRoot).toHaveBeenCalledOnce();
  });

  it("models cancellation without a path and rejects unsafe path framing", async () => {
    const bridge = permissionBridge({ selectProjectRoot: async () => undefined });
    await expect(bridge.selectProjectRoot()).resolves.toEqual({ cancelled: true });

    const malformed = permissionBridge({ selectProjectRoot: async () => "/tmp/project\nother" });
    await expect(malformed.selectProjectRoot()).rejects.toThrow("unsupported control characters");
  });
});

function permissionBridge(overrides: Partial<ConstructorParameters<typeof ElectronDesktopNativeBridge>[0]> = {}) {
  return new ElectronDesktopNativeBridge({
    dataDirectory: tmpdir(),
    processName: "AdPilot",
    bundleId: "com.adpilot.desktop",
    openExternal: async () => undefined,
    keychainInUse: () => false,
    backgroundServiceEnabled: () => false,
    platform: "darwin",
    ...overrides
  });
}
