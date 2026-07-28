import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Jimp } from "jimp";
import {
  FrontmostResultSchema,
  HelloResultSchema,
  PermissionsStatusSchema,
  type NativeComputerHost,
  type PermissionsStatus
} from "@adpilot/native-computer-host";
import {
  NativeHelperBrowserPageIdentity,
  type BrowserPageIdentityState
} from "@adpilot/computer-use";
import {
  DesktopNativeBindingError,
  DesktopNativeUnavailableError,
  DesktopPermissionCenter,
  DesktopPermissionTestResult,
  type DesktopLiveFrame,
  type DesktopNativeBridge,
  type DesktopNativeContext,
  type DesktopPermissionId,
  type DesktopPermissionItem,
  type DesktopPermissionStatus
} from "@adpilot/server";

export type SharedNativeComputerService = Pick<NativeComputerHost, "request" | "pid" | "closed">;

export interface ElectronDesktopNativeBridgeOptions {
  service?: SharedNativeComputerService;
  dataDirectory: string;
  processName: string;
  bundleId: string;
  openExternal: (url: string) => Promise<unknown>;
  keychainInUse: () => boolean;
  backgroundServiceEnabled: () => boolean;
  platform?: "darwin" | "win32" | "linux";
}

const SYSTEM_SETTINGS_URL: Record<DesktopPermissionId, string> = {
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "files-and-folders": "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
  "browser-control": "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  notifications: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
  keychain: "x-apple.systempreferences:com.apple.Passwords-Settings.extension",
  "native-helper": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  "background-service": "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"
};

const PERMISSION_DETAILS: Record<DesktopPermissionId, {
  reason: string;
  affectedFeatures: string[];
}> = {
  "screen-recording": {
    reason: "Captures only the bound browser window so AdPilot can ground and verify visible changes.",
    affectedFeatures: ["Computer Live View", "visual grounding", "before/after evidence"]
  },
  accessibility: {
    reason: "Allows the authenticated native Helper to focus the bound window and post approved mouse or keyboard input.",
    affectedFeatures: ["click", "scroll", "typing", "window focus"]
  },
  "files-and-folders": {
    reason: "The private app-data probe below verifies local persistence only; it does not claim macOS Files & Folders TCC access.",
    affectedFeatures: ["workspace persistence", "local evidence", "audit export"]
  },
  "browser-control": {
    reason: "Binds Computer Use to one managed browser Profile, process, and window.",
    affectedFeatures: ["Google Ads observation", "surface identity", "safe actions"]
  },
  notifications: {
    reason: "Shows approval and intervention alerts while AdPilot is in the background.",
    affectedFeatures: ["approval alerts", "takeover alerts"]
  },
  keychain: {
    reason: "Reserved for a future credential broker; the current credential store does not claim Keychain access.",
    affectedFeatures: ["credential storage", "provider sign-in"]
  },
  "native-helper": {
    reason: "Runs the signed, authenticated local process that owns capture and native input capabilities.",
    affectedFeatures: ["permissions", "window capture", "native input"]
  },
  "background-service": {
    reason: "Keeps explicitly enabled monitoring available after the main window closes.",
    affectedFeatures: ["scheduled monitoring", "background alerts"]
  }
};

/**
 * Electron-facing adapter for the single shared Helper service. It never
 * launches or owns a Helper process; application shutdown remains the shared
 * service owner's responsibility.
 */
export class ElectronDesktopNativeBridge implements DesktopNativeBridge {
  readonly #requested = new Set<DesktopPermissionId>();
  readonly #restartRequired = new Set<DesktopPermissionId>();
  readonly #platform: "darwin" | "win32" | "linux";

  constructor(private readonly options: ElectronDesktopNativeBridgeOptions) {
    this.#platform = options.platform ?? normalizedPlatform();
  }

  async permissionCenter(context: DesktopNativeContext) {
    const checkedAt = new Date().toISOString();
    const service = this.liveService();
    let helperVersion: string | null = null;
    let helperProcessName = "AdPilot Computer Helper";
    let helperBundleId: string | null = null;
    let nativePermissions: PermissionsStatus | undefined;
    if (service) {
      try {
        const hello = HelloResultSchema.parse(await service.request("hello", {}));
        helperVersion = hello.helperVersion;
        helperProcessName = hello.identity.bundleName || hello.identity.executableName;
        helperBundleId = hello.identity.bundleIdentifier || null;
        nativePermissions = PermissionsStatusSchema.parse(await service.request("permissions.status", {}));
      } catch {
        helperVersion = null;
        nativePermissions = undefined;
      }
    }
    const helperAvailable = Boolean(helperVersion && nativePermissions);
    const items: DesktopPermissionItem[] = [
      this.nativePermissionItem("screen-recording", nativePermissions?.screenCapture, checkedAt, helperAvailable, helperAvailable, helperProcessName, helperBundleId),
      this.nativePermissionItem("accessibility", nativePermissions?.accessibility, checkedAt, helperAvailable, helperAvailable && Boolean(context.browserSession), helperProcessName, helperBundleId),
      this.item("files-and-folders", "not-determined", checkedAt, {
        processName: this.options.processName,
        bundleId: this.options.bundleId,
        canTest: true
      }),
      this.item("browser-control", context.browserSession ? "granted" : "not-determined", checkedAt, {
        processName: context.browserSession?.applicationName ?? this.options.processName,
        bundleId: context.browserSession?.bundleId ?? this.options.bundleId,
        canTest: Boolean(context.browserSession)
      }),
      this.item("notifications", "unknown", checkedAt, {
        processName: this.options.processName,
        bundleId: this.options.bundleId,
        canTest: false
      }),
      this.item("keychain", this.options.keychainInUse() ? "granted" : "not-determined", checkedAt, {
        processName: this.options.processName,
        bundleId: this.options.bundleId,
        canTest: false
      }),
      this.item("native-helper", helperAvailable ? "granted" : "helper-unavailable", checkedAt, {
        processName: helperProcessName,
        bundleId: helperBundleId,
        canOpenSettings: false,
        canTest: helperAvailable
      }),
      this.item("background-service", this.options.backgroundServiceEnabled() ? "granted" : "not-determined", checkedAt, {
        processName: this.options.processName,
        bundleId: this.options.bundleId,
        canTest: false
      })
    ];
    return DesktopPermissionCenter.parse({
      platform: this.#platform,
      nativeDesktop: true,
      helperAvailable,
      helperVersion,
      checkedAt,
      permissions: items
    });
  }

  async requestPermissions(
    permissions: readonly DesktopPermissionId[],
    context: DesktopNativeContext
  ) {
    const service = this.requireService();
    const selected = permissions.filter((permission) =>
      permission === "screen-recording" || permission === "accessibility"
    );
    if (!selected.length) throw new Error("no requestable native permission was selected");
    for (const permission of selected) this.#requested.add(permission);
    const requestSessionId = `permission-test-${randomUUID()}`;
    const result = await service.request("permissions.request", {
      permissions: selected.map((permission) =>
        permission === "screen-recording" ? "screenCapture" as const : "accessibility" as const
      )
    }, { sessionId: requestSessionId });
    if (result.restartRecommended) {
      for (const permission of selected) this.#restartRequired.add(permission);
    }
    return this.permissionCenter(context);
  }

  async openPermissionSettings(permission: DesktopPermissionId): Promise<void> {
    if (this.#platform !== "darwin") {
      throw new DesktopNativeUnavailableError("system privacy settings links are only available on macOS");
    }
    if (permission === "screen-recording" || permission === "accessibility") {
      const nativePermission = permission === "screen-recording" ? "screenCapture" as const : "accessibility" as const;
      await this.requireService().request(
        "permissions.openSettings",
        { permission: nativePermission },
        { sessionId: `permission-settings-${randomUUID()}` }
      );
      return;
    }
    await this.options.openExternal(SYSTEM_SETTINGS_URL[permission]);
  }

  async testPermission(
    permission: DesktopPermissionId,
    context: DesktopNativeContext
  ) {
    const center = await this.permissionCenter(context);
    const current = center.permissions.find((item) => item.id === permission)!;
    const checkedAt = new Date().toISOString();
    if (permission === "screen-recording") {
      if (current.status !== "granted") {
        return DesktopPermissionTestResult.parse({
          permission,
          ok: false,
          status: current.status,
          checkedAt,
          message: "Screen Recording is not granted to the AdPilot Computer Helper."
        });
      }
      const service = this.requireService();
      const target = context.browserSession
        ? { windowId: nativeWindowId(context.browserSession.windowId) }
        : await frontmostWindow(service, `permission-test-${randomUUID()}`, this.options.bundleId);
      const sessionId = `permission-test-${randomUUID()}`;
      const capture = await service.request("capture", {
        target: "window",
        windowId: target.windowId,
        includeCursor: true
      }, { sessionId });
      const preview = await previewImage(capture.base64);
      return DesktopPermissionTestResult.parse({
        permission,
        ok: true,
        status: "granted",
        checkedAt,
        message: "A fresh native window frame was captured successfully.",
        preview: { ...preview, capturedAt: capture.capturedAt }
      });
    }
    if (permission === "accessibility" && context.browserSession) {
      if (current.status !== "granted") {
        return DesktopPermissionTestResult.parse({
          permission,
          ok: false,
          status: current.status,
          checkedAt,
          message: "Accessibility is not granted to the AdPilot Computer Helper; no focus event was posted."
        });
      }
      const service = this.requireService();
      const sessionId = `permission-test-${randomUUID()}`;
      await service.request("window.focus", {
        windowId: nativeWindowId(context.browserSession.windowId),
        ownerPid: context.browserSession.processId,
        bundleId: context.browserSession.bundleId
      }, {
        sessionId,
        actionId: `focus-test-${randomUUID()}`
      });
      const frontmost = FrontmostResultSchema.parse(await service.request("frontmost", {}, { sessionId }));
      const ok = frontmost.ownerPid === context.browserSession.processId
        && frontmost.bundleId === context.browserSession.bundleId
        && String(frontmost.window?.windowId) === context.browserSession.windowId;
      return DesktopPermissionTestResult.parse({
        permission,
        ok,
        status: ok ? "granted" : current.status,
        checkedAt,
        message: ok
          ? "The bound browser window was focused and independently confirmed; no click or text input was posted."
          : "The Helper could not confirm focus on the bound browser window."
      });
    }
    if (permission === "files-and-folders") {
      const ok = await probeDataDirectory(this.options.dataDirectory);
      return DesktopPermissionTestResult.parse({
        permission,
        ok,
        status: ok ? "not-determined" : "restricted",
        checkedAt,
        message: ok
          ? "The private AdPilot app-data read/write probe passed. This does not prove or claim macOS Files & Folders TCC access."
          : "The private AdPilot app-data read/write probe failed. This test does not inspect broad macOS Files & Folders TCC access."
      });
    }
    const ok = current.status === "granted";
    return DesktopPermissionTestResult.parse({
      permission,
      ok,
      status: current.status,
      checkedAt,
      message: ok
        ? `${permission} capability check passed.`
        : `${permission} is not ready; no native input was posted.`
    });
  }

  async captureLiveFrame(
    context: DesktopNativeContext & {
      browserSession: NonNullable<DesktopNativeContext["browserSession"]>;
    }
  ): Promise<DesktopLiveFrame> {
    const service = this.requireService();
    const expected = context.browserSession;
    const pageIdentity = await new NativeHelperBrowserPageIdentity(service).read({
      browserSessionId: expected.sessionId,
      clientId: expected.clientId,
      browserProfile: expected.browserProfile,
      nativeProfileFingerprint: expected.nativeProfileFingerprint,
      processId: expected.processId,
      windowId: expected.windowId,
      applicationId: expected.bundleId
    });
    const capture = await service.request("capture", {
      target: "window",
      windowId: nativeWindowId(expected.windowId),
      includeCursor: true,
      leaseDurationMs: 3_000
    }, { sessionId: expected.sessionId });
    if (capture.source.target !== "window" || !capture.surfaceLease) {
      throw new DesktopNativeBindingError("native Helper did not return a window-bound frame");
    }
    const lease = capture.surfaceLease;
    const mismatches: string[] = [];
    if (String(lease.windowId) !== expected.windowId) mismatches.push("window");
    if (lease.ownerPid !== expected.processId) mismatches.push("process");
    if (lease.bundleId !== expected.bundleId) mismatches.push("application");
    if (mismatches.length) {
      throw new DesktopNativeBindingError(`captured frame differs from the ${mismatches.join(", ")} binding`);
    }
    const preview = await previewImage(capture.base64);
    const activity = await service.request("input.activity", {}, { sessionId: expected.sessionId });
    const cursor = cursorInCapturedWindow(activity.cursor, lease);
    return {
      frameId: createHash("sha256").update(preview.buffer).digest("hex"),
      browserSessionId: expected.sessionId,
      clientId: expected.clientId,
      dataUrl: preview.dataUrl,
      width: preview.width,
      height: preview.height,
      source: { width: capture.width, height: capture.height },
      capturedAt: capture.capturedAt,
      application: {
        pid: lease.ownerPid,
        bundleId: lease.bundleId,
        name: expected.applicationName
      },
      window: {
        id: String(lease.windowId),
        ...(pageIdentity.status === "available" && pageIdentity.title
          ? { title: pageIdentity.title }
          : {}),
        bounds: lease.bounds
      },
      browser: {
        profile: expected.browserProfile,
        ...(pageIdentity.status === "available"
          ? { url: pageIdentity.url, title: pageIdentity.title }
          : {}),
        pageIdentity: publicPageIdentity(pageIdentity)
      },
      ...(cursor ? { cursor } : {})
    };
  }

  private liveService(): SharedNativeComputerService | undefined {
    return this.options.service && !this.options.service.closed ? this.options.service : undefined;
  }

  private requireService(): SharedNativeComputerService {
    const service = this.liveService();
    if (!service) throw new DesktopNativeUnavailableError("the shared AdPilot Computer Helper service is unavailable");
    return service;
  }

  private nativePermissionItem(
    id: "screen-recording" | "accessibility",
    value: { granted: boolean } | undefined,
    checkedAt: string,
    helperAvailable: boolean,
    canTest = helperAvailable,
    processName = "AdPilot Computer Helper",
    bundleId: string | null = null
  ): DesktopPermissionItem {
    const status = nativePermissionDisplayStatus({
      helperAvailable,
      value,
      requested: this.#requested.has(id),
      restartRequired: this.#restartRequired.has(id)
    });
    return this.item(id, status, checkedAt, {
      processName,
      bundleId,
      canRequest: helperAvailable && !value?.granted,
      canTest
    });
  }

  private item(
    id: DesktopPermissionId,
    status: DesktopPermissionStatus,
    checkedAt: string,
    overrides: Partial<Pick<DesktopPermissionItem,
      "processName" | "bundleId" | "canRequest" | "canOpenSettings" | "canTest" | "requiresRestart"
    >> = {}
  ): DesktopPermissionItem {
    return {
      id,
      status,
      checkedAt,
      processName: overrides.processName ?? this.options.processName,
      bundleId: overrides.bundleId === undefined ? this.options.bundleId : overrides.bundleId,
      ...PERMISSION_DETAILS[id],
      canRequest: overrides.canRequest ?? false,
      canOpenSettings: overrides.canOpenSettings ?? this.#platform === "darwin",
      canTest: overrides.canTest ?? false,
      requiresRestart: overrides.requiresRestart ?? status === "requires-restart"
    };
  }
}

/**
 * A Helper restart recommendation intentionally wins over a newly observed
 * grant for the lifetime of this Electron process. The UI can therefore tell
 * the user that TCC changed but the current Helper must still be restarted.
 */
export function nativePermissionDisplayStatus(input: {
  helperAvailable: boolean;
  value: { granted: boolean } | undefined;
  requested: boolean;
  restartRequired: boolean;
}): DesktopPermissionStatus {
  if (!input.helperAvailable || !input.value) return "helper-unavailable";
  if (input.restartRequired) return "requires-restart";
  if (input.value.granted) return "granted";
  return input.requested ? "denied" : "not-determined";
}

function publicPageIdentity(identity: BrowserPageIdentityState) {
  if (identity.status === "unavailable") {
    return {
      status: identity.status,
      observedAt: identity.observedAt,
      code: identity.code,
      reason: identity.reason
    };
  }
  return {
    status: identity.status,
    source: identity.source,
    observedAt: identity.observedAt,
    url: identity.url,
    origin: identity.origin,
    title: identity.title,
    fingerprint: identity.fingerprint,
    ...(identity.tabId ? { tabId: identity.tabId } : {})
  };
}

function normalizedPlatform(): "darwin" | "win32" | "linux" {
  if (process.platform === "darwin" || process.platform === "win32") return process.platform;
  return "linux";
}

function nativeWindowId(value: string): number {
  if (!/^[1-9]\d{0,9}$/.test(value)) {
    throw new DesktopNativeBindingError("managed browser window ID is not a native CGWindowID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 4_294_967_295) {
    throw new DesktopNativeBindingError("managed browser window ID is outside the native range");
  }
  return parsed;
}

async function frontmostWindow(
  service: SharedNativeComputerService,
  sessionId: string,
  expectedBundleId: string
): Promise<{ windowId: number }> {
  const frontmost = FrontmostResultSchema.parse(await service.request("frontmost", {}, { sessionId }));
  if (!frontmost.window) throw new DesktopNativeBindingError("the frontmost application has no capturable window");
  if (frontmost.bundleId !== expectedBundleId) {
    throw new DesktopNativeBindingError("refusing a permission-test capture because AdPilot is no longer frontmost");
  }
  return { windowId: frontmost.window.windowId };
}

async function probeDataDirectory(dataDirectory: string): Promise<boolean> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(dataDirectory, ".permission-probe-"));
    const file = join(directory, "probe");
    const value = randomUUID();
    await writeFile(file, value, { encoding: "utf8", mode: 0o600 });
    return await readFile(file, "utf8") === value;
  } catch {
    return false;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function cursorInCapturedWindow(
  cursor: { x: number; y: number },
  lease: {
    bounds: { x: number; y: number; width: number; height: number };
    capturePixels: { width: number; height: number };
  }
): { x: number; y: number } | undefined {
  const localX = cursor.x - lease.bounds.x;
  const localY = cursor.y - lease.bounds.y;
  if (localX < 0 || localY < 0 || localX > lease.bounds.width || localY > lease.bounds.height) {
    return undefined;
  }
  return {
    x: localX / lease.bounds.width * lease.capturePixels.width,
    y: localY / lease.bounds.height * lease.capturePixels.height
  };
}

async function previewImage(base64: string): Promise<{
  dataUrl: string;
  width: number;
  height: number;
  buffer: Buffer;
}> {
  const image = await Jimp.read(Buffer.from(base64, "base64"));
  if (image.width > 1_920 || image.height > 1_080) {
    image.scaleToFit({ w: 1_920, h: 1_080 });
  }
  const buffer = await image.getBuffer("image/jpeg", { quality: 72 });
  if (buffer.byteLength > 8 * 1024 * 1024) {
    throw new Error("native preview exceeds the 8 MiB transport limit");
  }
  return {
    dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
    width: image.width,
    height: image.height,
    buffer
  };
}
