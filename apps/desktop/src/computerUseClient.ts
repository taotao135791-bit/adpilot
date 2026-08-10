import type { ProductSession } from "./types.js";

export type BrowserSessionStatus = "starting" | "connected" | "lost" | "closed";

export type BrowserSession = {
  sessionId: string;
  clientId: string;
  browserProfile: string;
  profileDirectory?: string;
  nativeProfileFingerprint?: string;
  processId?: number | null;
  windowId?: string | null;
  windowBounds?: { x: number; y: number; width: number; height: number } | null;
  platform: string;
  runtimePlatform: "darwin" | "win32" | "linux";
  browserApplicationId: string;
  browserApp: string;
  sessionStatus: BrowserSessionStatus;
  startedAt: string;
  updatedAt: string;
  lastValidatedAt?: string | null;
  lostAt?: string | null;
  lostReason?: string | null;
};

export type BrowserProfileOption = {
  browserProfile: string;
  platform: string;
  accountRef?: string;
};

export type BrowserSessionView = {
  session: BrowserSession | null;
  profiles: BrowserProfileOption[];
};

export type ScreenshotAudit = {
  auditId: string;
  clientId: string;
  taskId: string;
  purpose: "grounding" | "verification" | "table_read" | "account_identity" | "other";
  modelProvider: string;
  modelId: string;
  screenshotId: string;
  screenshotSha256: string;
  sentRoi: { x: number; y: number; width: number; height: number };
  masks: Array<{ category: string; region: { x: number; y: number; width: number; height: number }; reason: string }>;
  transmittedWidth?: number;
  transmittedHeight?: number;
  leftLocal: boolean;
  fullScreenshotLocalOnly: true;
  privacyMode: "minimized" | "local-only";
  dataRetentionPolicy: string;
  outcome: "prepared" | "blocked";
  createdAt: string;
};

export type DesktopPermissionId =
  | "screen-recording"
  | "accessibility"
  | "files-and-folders"
  | "browser-control"
  | "notifications"
  | "keychain"
  | "native-helper"
  | "background-service";

export type DesktopPermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "requires-restart"
  | "helper-unavailable"
  | "unknown";

export type DesktopPermissionItem = {
  id: DesktopPermissionId;
  status: DesktopPermissionStatus;
  checkedAt: string;
  processName: string;
  bundleId: string | null;
  reason: string;
  affectedFeatures: string[];
  canRequest: boolean;
  canOpenSettings: boolean;
  canTest: boolean;
  requiresRestart: boolean;
};

export type DesktopPermissionCenter = {
  platform: "darwin" | "win32" | "linux";
  nativeDesktop: boolean;
  helperAvailable: boolean;
  helperVersion: string | null;
  checkedAt: string;
  permissions: DesktopPermissionItem[];
};

export type DesktopPermissionTestResult = {
  permission: DesktopPermissionId;
  ok: boolean;
  status: DesktopPermissionStatus;
  checkedAt: string;
  message: string;
  preview?: {
    dataUrl: string;
    width: number;
    height: number;
    capturedAt: string;
  };
};

export type DesktopProjectRootSelection =
  | { cancelled: true }
  | { cancelled: false; path: string };

export type DesktopLiveFrame = {
  frameId: string;
  browserSessionId: string;
  clientId: string;
  dataUrl: string;
  width: number;
  height: number;
  source: { width: number; height: number };
  capturedAt: string;
  application: { pid: number; bundleId: string; name: string };
  window: {
    id: string;
    title?: string;
    bounds: { x: number; y: number; width: number; height: number };
  };
  browser: {
    profile: string;
    url?: string;
    title?: string;
    pageIdentity:
      | {
          status: "available";
          observedAt: string;
          url: string;
          origin: string;
          title: string;
          fingerprint: string;
        }
      | {
          status: "unavailable";
          observedAt: string;
          code: string;
          reason: string;
        };
  };
  cursor?: { x: number; y: number };
};

export class DesktopApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "DesktopApiError";
  }
}

export async function getBrowserSession(clientId: string, signal?: AbortSignal): Promise<BrowserSessionView> {
  const payload = await requestJson(`/api/browser-session?clientId=${encodeURIComponent(clientId)}`, { ...(signal ? { signal } : {}) });
  return normalizeSessionView(payload);
}

export async function startBrowserSession(input: {
  clientId: string;
  browserProfile?: string;
  platform?: string;
}, signal?: AbortSignal): Promise<BrowserSession | null> {
  const payload = await requestJson("/api/browser-session/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: input.clientId,
      ...(input.browserProfile ? { browserProfile: input.browserProfile } : {}),
      platform: input.platform ?? "google_ads"
    }),
    ...(signal ? { signal } : {})
  });
  return normalizeSessionView(payload).session;
}

export async function resumeBrowserSession(input: {
  clientId: string;
  browserProfile?: string;
}, signal?: AbortSignal): Promise<BrowserSession | null> {
  const payload = await requestJson("/api/browser-session/resume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: input.clientId, ...(input.browserProfile ? { browserProfile: input.browserProfile } : {}) }),
    ...(signal ? { signal } : {})
  });
  return normalizeSessionView(payload).session;
}

export async function closeBrowserSession(input: {
  clientId: string;
  browserProfile?: string;
}, signal?: AbortSignal): Promise<BrowserSession | null> {
  const payload = await requestJson("/api/browser-session/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: input.clientId, ...(input.browserProfile ? { browserProfile: input.browserProfile } : {}) }),
    ...(signal ? { signal } : {})
  });
  return normalizeSessionView(payload).session;
}

export async function getScreenshotAudits(clientId: string, signal?: AbortSignal): Promise<ScreenshotAudit[]> {
  const payload = await requestJson(`/api/privacy/screenshot-audits?clientId=${encodeURIComponent(clientId)}`, { ...(signal ? { signal } : {}) });
  if (Array.isArray(payload)) return payload as ScreenshotAudit[];
  if (isRecord(payload) && Array.isArray(payload.audits)) return payload.audits as ScreenshotAudit[];
  return [];
}

export async function configureProductSessionComputerUse(
  clientId: string,
  productSessionId: string,
  input: {
    revision: number;
    browserProfile: string;
    computerUse: "disabled" | "observe" | "interactive" | "execute";
    confirm: true;
  },
  signal?: AbortSignal
): Promise<ProductSession> {
  return await requestJson(
    `/api/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(productSessionId)}/computer-use`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {})
    }
  ) as ProductSession;
}

export async function getDesktopPermissions(
  clientId?: string,
  productSessionId?: string,
  browserSessionId?: string,
  signal?: AbortSignal
): Promise<DesktopPermissionCenter> {
  const params = new URLSearchParams();
  if (clientId) params.set("clientId", clientId);
  if (productSessionId) params.set("productSessionId", productSessionId);
  if (browserSessionId) params.set("browserSessionId", browserSessionId);
  const serialized = params.toString();
  const query = serialized ? `?${serialized}` : "";
  return await requestJson(`/api/desktop-native/permissions${query}`, {
    ...(signal ? { signal } : {})
  }) as DesktopPermissionCenter;
}

export async function requestDesktopPermissions(
  permissions: Array<"screen-recording" | "accessibility">,
  clientId?: string,
  productSessionId?: string,
  browserSessionId?: string,
  signal?: AbortSignal
): Promise<DesktopPermissionCenter> {
  return await requestJson("/api/desktop-native/permissions/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      permissions,
      ...(clientId ? { clientId } : {}),
      ...(productSessionId ? { productSessionId } : {}),
      ...(browserSessionId ? { browserSessionId } : {})
    }),
    ...(signal ? { signal } : {})
  }) as DesktopPermissionCenter;
}

export async function openDesktopPermissionSettings(
  permission: DesktopPermissionId,
  signal?: AbortSignal
): Promise<void> {
  await requestJson("/api/desktop-native/permissions/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ permission }),
    ...(signal ? { signal } : {})
  });
}

export async function testDesktopPermission(
  permission: DesktopPermissionId,
  clientId?: string,
  productSessionId?: string,
  browserSessionId?: string,
  signal?: AbortSignal
): Promise<DesktopPermissionTestResult> {
  return await requestJson("/api/desktop-native/permissions/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      permission,
      ...(clientId ? { clientId } : {}),
      ...(productSessionId ? { productSessionId } : {}),
      ...(browserSessionId ? { browserSessionId } : {})
    }),
    ...(signal ? { signal } : {})
  }) as DesktopPermissionTestResult;
}

/**
 * Opens the native app's single-purpose OS directory chooser. Browser builds
 * do not call this endpoint and keep the manual absolute-path field instead.
 */
export async function selectDesktopProjectRoot(signal?: AbortSignal): Promise<DesktopProjectRootSelection> {
  const payload = await requestJson("/api/desktop-native/project-root/select", {
    method: "POST",
    ...(signal ? { signal } : {})
  });
  if (!isRecord(payload) || typeof payload.cancelled !== "boolean") {
    throw new DesktopApiError(502, "Native project-directory chooser returned an invalid response");
  }
  if (payload.cancelled) return { cancelled: true };
  if (typeof payload.path !== "string" || payload.path.length === 0) {
    throw new DesktopApiError(502, "Native project-directory chooser returned an invalid response");
  }
  return { cancelled: false, path: payload.path };
}

export async function getDesktopLiveFrame(
  clientId: string,
  productSessionId: string,
  browserSessionId: string,
  signal?: AbortSignal
): Promise<DesktopLiveFrame> {
  const query = new URLSearchParams({ clientId, productSessionId, browserSessionId });
  return await requestJson(`/api/desktop-native/live-frame?${query.toString()}`, {
    ...(signal ? { signal } : {})
  }) as DesktopLiveFrame;
}

export function normalizeSessionView(payload: unknown): BrowserSessionView {
  if (payload === null || payload === undefined) return { session: null, profiles: [] };
  if (Array.isArray(payload)) {
    const sessions = payload.filter(isBrowserSession);
    return { session: sessions.at(-1) ?? null, profiles: [] };
  }
  if (!isRecord(payload)) return { session: null, profiles: [] };
  const profiles = Array.isArray(payload.profiles) ? payload.profiles.filter(isBrowserProfileOption) : [];
  if (payload.session === null) return { session: null, profiles };
  if (isBrowserSession(payload.session)) return { session: payload.session, profiles };
  if (Array.isArray(payload.sessions)) {
    const sessions = payload.sessions.filter(isBrowserSession);
    return { session: sessions.at(-1) ?? null, profiles };
  }
  return { session: isBrowserSession(payload) ? payload : null, profiles };
}

function isBrowserSession(value: unknown): value is BrowserSession {
  if (!isRecord(value)) return false;
  return typeof value.sessionId === "string"
    && typeof value.clientId === "string"
    && typeof value.browserProfile === "string"
    && typeof value.platform === "string"
    && typeof value.browserApp === "string"
    && ["starting", "connected", "lost", "closed"].includes(String(value.sessionStatus));
}

function isBrowserProfileOption(value: unknown): value is BrowserProfileOption {
  return isRecord(value) && typeof value.browserProfile === "string" && typeof value.platform === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) {
    const record = isRecord(payload) ? payload : undefined;
    throw new DesktopApiError(
      response.status,
      typeof record?.error === "string" ? record.error : `Request failed with status ${response.status}`,
      typeof record?.code === "string" ? record.code : undefined
    );
  }
  return payload;
}
