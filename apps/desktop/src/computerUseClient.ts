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
