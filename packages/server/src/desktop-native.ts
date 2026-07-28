import { z } from "zod";

export const DesktopBrowserPageIdentity = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    source: z.literal("macos_accessibility"),
    observedAt: z.string().datetime(),
    url: z.string().url().max(8_192),
    origin: z.string().url().max(2_048),
    title: z.string().max(2_048),
    fingerprint: z.string().length(64),
    tabId: z.string().min(1).max(512).optional()
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    observedAt: z.string().datetime(),
    code: z.string().min(1).max(128),
    reason: z.string().min(1).max(2_048)
  }).strict()
]);
export type DesktopBrowserPageIdentity = z.infer<typeof DesktopBrowserPageIdentity>;

export const DesktopPermissionId = z.enum([
  "screen-recording",
  "accessibility",
  "files-and-folders",
  "browser-control",
  "notifications",
  "keychain",
  "native-helper",
  "background-service"
]);
export type DesktopPermissionId = z.infer<typeof DesktopPermissionId>;

export const DesktopPermissionStatus = z.enum([
  "granted",
  "denied",
  "not-determined",
  "restricted",
  "requires-restart",
  "helper-unavailable",
  "unknown"
]);
export type DesktopPermissionStatus = z.infer<typeof DesktopPermissionStatus>;

export const DesktopPermissionItem = z.object({
  id: DesktopPermissionId,
  status: DesktopPermissionStatus,
  checkedAt: z.string().datetime(),
  processName: z.string().min(1).max(256),
  bundleId: z.string().min(1).max(1_024).nullable(),
  reason: z.string().min(1).max(2_000),
  affectedFeatures: z.array(z.string().min(1).max(256)).max(16),
  canRequest: z.boolean(),
  canOpenSettings: z.boolean(),
  canTest: z.boolean(),
  requiresRestart: z.boolean()
}).strict();
export type DesktopPermissionItem = z.infer<typeof DesktopPermissionItem>;

export const DesktopPermissionCenter = z.object({
  platform: z.enum(["darwin", "win32", "linux"]),
  nativeDesktop: z.boolean(),
  helperAvailable: z.boolean(),
  helperVersion: z.string().min(1).max(256).nullable(),
  checkedAt: z.string().datetime(),
  permissions: z.array(DesktopPermissionItem).length(DesktopPermissionId.options.length)
}).strict().superRefine((value, context) => {
  const ids = new Set(value.permissions.map((permission) => permission.id));
  if (ids.size !== DesktopPermissionId.options.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["permissions"], message: "permission center must contain each permission exactly once" });
  }
});
export type DesktopPermissionCenter = z.infer<typeof DesktopPermissionCenter>;

export const DesktopNativeContext = z.object({
  clientId: z.string().min(1).max(256).optional(),
  productSessionId: z.string().uuid().optional(),
  browserSession: z.object({
    sessionId: z.string().regex(/^[a-f0-9]{32}$/),
    clientId: z.string().min(1).max(256),
    processId: z.number().int().positive(),
    windowId: z.string().min(1).max(128),
    bundleId: z.string().min(1).max(1_024),
    applicationName: z.string().min(1).max(256),
    browserProfile: z.string().min(1).max(1_024),
    nativeProfileFingerprint: z.string().min(1).max(1_024)
  }).strict().optional()
}).strict();
export type DesktopNativeContext = z.infer<typeof DesktopNativeContext>;

/** Eight binary MiB plus the base64 expansion and a short data-URL prefix. */
export const MAX_DESKTOP_IMAGE_DATA_URL_CHARS = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 64;

const ImageDataUrl = z.string()
  .max(MAX_DESKTOP_IMAGE_DATA_URL_CHARS)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);

export const DesktopPermissionTestResult = z.object({
  permission: DesktopPermissionId,
  ok: z.boolean(),
  status: DesktopPermissionStatus,
  checkedAt: z.string().datetime(),
  message: z.string().min(1).max(2_000),
  preview: z.object({
    dataUrl: ImageDataUrl,
    width: z.number().int().positive().max(4_096),
    height: z.number().int().positive().max(4_096),
    capturedAt: z.string().datetime()
  }).strict().optional()
}).strict();
export type DesktopPermissionTestResult = z.infer<typeof DesktopPermissionTestResult>;

export const DesktopLiveFrame = z.object({
  frameId: z.string().regex(/^[a-f0-9]{64}$/),
  browserSessionId: z.string().regex(/^[a-f0-9]{32}$/),
  clientId: z.string().min(1).max(256),
  dataUrl: ImageDataUrl,
  width: z.number().int().positive().max(4_096),
  height: z.number().int().positive().max(4_096),
  source: z.object({
    width: z.number().int().positive().max(8_192),
    height: z.number().int().positive().max(8_192)
  }).strict(),
  capturedAt: z.string().datetime(),
  application: z.object({
    pid: z.number().int().positive(),
    bundleId: z.string().min(1).max(1_024),
    name: z.string().min(1).max(256)
  }).strict(),
  window: z.object({
    id: z.string().min(1).max(128),
    title: z.string().max(2_048).optional(),
    bounds: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().positive(),
      height: z.number().finite().positive()
    }).strict()
  }).strict(),
  browser: z.object({
    profile: z.string().min(1).max(1_024),
    url: z.string().url().optional(),
    title: z.string().max(512).optional(),
    pageIdentity: DesktopBrowserPageIdentity
  }).strict(),
  cursor: z.object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative()
  }).strict().optional()
}).strict().superRefine((value, context) => {
  if (value.width > value.source.width || value.height > value.source.height) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "preview frame cannot be larger than its native source" });
  }
  if (value.cursor && (value.cursor.x > value.source.width || value.cursor.y > value.source.height)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cursor"], message: "cursor must be inside the native source frame" });
  }
});
export type DesktopLiveFrame = z.infer<typeof DesktopLiveFrame>;

export interface DesktopNativeBridge {
  permissionCenter(context: DesktopNativeContext): Promise<DesktopPermissionCenter>;
  requestPermissions(
    permissions: readonly DesktopPermissionId[],
    context: DesktopNativeContext
  ): Promise<DesktopPermissionCenter>;
  openPermissionSettings(permission: DesktopPermissionId): Promise<void>;
  testPermission(
    permission: DesktopPermissionId,
    context: DesktopNativeContext
  ): Promise<DesktopPermissionTestResult>;
  captureLiveFrame(context: DesktopNativeContext & {
    browserSession: NonNullable<DesktopNativeContext["browserSession"]>;
  }): Promise<DesktopLiveFrame>;
}

/**
 * Deduplicates overlapping renderer polls. A slow native capture therefore
 * never creates an unbounded Helper queue, while a recently completed frame
 * can be reused for a very short interval without becoming stale evidence.
 */
export class DesktopLiveFrameBroker {
  readonly #inflight = new Map<string, Promise<DesktopLiveFrame>>();
  readonly #recent = new Map<string, { frame: DesktopLiveFrame; expiresAt: number }>();

  constructor(private readonly reuseMs = 200) {
    if (!Number.isInteger(reuseMs) || reuseMs < 0 || reuseMs > 1_000) {
      throw new Error("desktop live-frame reuseMs must be between 0 and 1000");
    }
  }

  async capture(
    key: string,
    capture: () => Promise<DesktopLiveFrame>
  ): Promise<DesktopLiveFrame> {
    const cached = this.#recent.get(key);
    if (cached && cached.expiresAt >= Date.now()) return cached.frame;
    const pending = this.#inflight.get(key);
    if (pending) return pending;
    const started = capture().then((value) => {
      const frame = DesktopLiveFrame.parse(value);
      this.#recent.set(key, { frame, expiresAt: Date.now() + this.reuseMs });
      return frame;
    }).finally(() => {
      this.#inflight.delete(key);
    });
    this.#inflight.set(key, started);
    return started;
  }

  clear(key?: string): void {
    if (key) this.#recent.delete(key);
    else this.#recent.clear();
  }
}

export class DesktopNativeUnavailableError extends Error {
  readonly code = "DESKTOP_NATIVE_UNAVAILABLE" as const;

  constructor(message = "native desktop bridge is unavailable") {
    super(message);
    this.name = "DesktopNativeUnavailableError";
  }
}

export class DesktopNativeBindingError extends Error {
  readonly code = "DESKTOP_NATIVE_BINDING_MISMATCH" as const;

  constructor(message: string) {
    super(message);
    this.name = "DesktopNativeBindingError";
  }
}
