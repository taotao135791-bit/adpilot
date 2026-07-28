import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  NativeComputerService,
  NativeResult,
  NativeWindow
} from "@adpilot/native-computer-host";

const PageIdentityBinding = z.object({
  browserSessionId: z.string().regex(/^[a-f0-9]{32}$/),
  clientId: z.string().min(1).max(256),
  browserProfile: z.string().min(1).max(1_024),
  nativeProfileFingerprint: z.string().min(1).max(1_024),
  processId: z.number().int().positive(),
  windowId: z.string().min(1).max(128),
  applicationId: z.string().min(1).max(1_024)
}).strict();
export type PageIdentityBinding = z.infer<typeof PageIdentityBinding>;

export const BrowserPageIdentityUnavailableCode = z.enum([
  "helper_unavailable",
  "accessibility_not_granted",
  "unsupported_browser",
  "binding_mismatch",
  "window_not_found",
  "accessibility_window_not_found",
  "address_bar_not_found",
  "invalid_address_bar_url",
  "identity_changed_during_read",
  "stale_after_control_change"
]);
export type BrowserPageIdentityUnavailableCode = z.infer<typeof BrowserPageIdentityUnavailableCode>;

const PageIdentityBase = PageIdentityBinding.extend({
  observedAt: z.string().datetime()
});

export const BrowserPageIdentity = PageIdentityBase.extend({
  status: z.literal("available"),
  source: z.literal("macos_accessibility"),
  url: z.string().url().max(8_192),
  origin: z.string().url().max(2_048),
  title: z.string().max(2_048),
  tabId: z.string().min(1).max(512).optional(),
  fingerprint: z.string().length(64)
}).strict();
export type BrowserPageIdentity = z.infer<typeof BrowserPageIdentity>;

export const BrowserPageIdentityUnavailable = PageIdentityBase.extend({
  status: z.literal("unavailable"),
  code: BrowserPageIdentityUnavailableCode,
  reason: z.string().min(1).max(2_048)
}).strict();
export type BrowserPageIdentityUnavailable = z.infer<typeof BrowserPageIdentityUnavailable>;

export const BrowserPageIdentityState = z.discriminatedUnion("status", [
  BrowserPageIdentity,
  BrowserPageIdentityUnavailable
]);
export type BrowserPageIdentityState = z.infer<typeof BrowserPageIdentityState>;

export interface BrowserPageIdentitySource {
  read(
    binding: PageIdentityBinding,
    options?: { requireFrontmost?: boolean }
  ): Promise<BrowserPageIdentityState>;
}

export class BrowserPageIdentityUnavailableError extends Error {
  readonly code = "BROWSER_PAGE_IDENTITY_UNAVAILABLE" as const;

  constructor(readonly identity: BrowserPageIdentityUnavailable) {
    super(identity.reason);
    this.name = "BrowserPageIdentityUnavailableError";
  }
}

export class BrowserPageIdentityChangedError extends Error {
  readonly code = "BROWSER_PAGE_IDENTITY_CHANGED" as const;

  constructor(
    readonly expected: BrowserPageIdentity,
    readonly actual: BrowserPageIdentity
  ) {
    super(`browser page changed before native input (${expected.url} -> ${actual.url})`);
    this.name = "BrowserPageIdentityChangedError";
  }
}

type AccessibilitySnapshot = NativeResult<"accessibility.snapshot">;
type AccessibilityNode = Omit<AccessibilitySnapshot["root"], "children"> & {
  children: AccessibilityNode[];
};

/**
 * Reads Chromium page identity through the authenticated native Helper.
 *
 * No remote-debugging socket is opened. The reader validates the exact
 * native PID/application/window both before and after the Accessibility read,
 * then accepts a URL only from an address-bar-like AX control inside the AX
 * window whose bounds match the authoritative CoreGraphics window.
 */
export class NativeHelperBrowserPageIdentity implements BrowserPageIdentitySource {
  constructor(
    private readonly host: Pick<NativeComputerService, "request" | "closed">,
    private readonly now: () => Date = () => new Date()
  ) {}

  async read(
    rawBinding: PageIdentityBinding,
    options: { requireFrontmost?: boolean } = {}
  ): Promise<BrowserPageIdentityState> {
    const binding = PageIdentityBinding.parse(rawBinding);
    if (this.host.closed) {
      return unavailableBrowserPageIdentity(binding, "helper_unavailable", "the authenticated native Helper is unavailable", this.now());
    }
    if (!isSupportedChromiumApplication(binding.applicationId)) {
      return unavailableBrowserPageIdentity(
        binding,
        "unsupported_browser",
        "page identity is supported only for the managed Chrome, Edge, Brave, or Chromium browser",
        this.now()
      );
    }

    const requestSessionId = `page-${binding.browserSessionId}`;
    const permissions = await this.host.request(
      "permissions.status",
      {},
      { sessionId: requestSessionId }
    );
    if (!permissions.accessibility.granted) {
      return unavailableBrowserPageIdentity(
        binding,
        "accessibility_not_granted",
        "macOS Accessibility is required to read the bound browser address bar",
        this.now()
      );
    }

    const before = await this.nativeBinding(binding, requestSessionId, options.requireFrontmost === true);
    if ("unavailable" in before) return before.unavailable;

    let snapshot: AccessibilitySnapshot;
    try {
      snapshot = await this.host.request(
        "accessibility.snapshot",
        { pid: binding.processId, maxDepth: 12, maxNodes: 3_000 },
        { sessionId: requestSessionId }
      );
    } catch (error) {
      if (nativeErrorCode(error) === "ACCESSIBILITY_PERMISSION_REQUIRED") {
        return unavailableBrowserPageIdentity(
          binding,
          "accessibility_not_granted",
          "macOS Accessibility was revoked while reading the browser address bar",
          this.now()
        );
      }
      throw error;
    }
    if (snapshot.pid !== binding.processId) {
      return unavailableBrowserPageIdentity(
        binding,
        "binding_mismatch",
        "Accessibility returned a different browser process",
        this.now()
      );
    }

    const after = await this.nativeBinding(binding, requestSessionId, options.requireFrontmost === true);
    if ("unavailable" in after) return after.unavailable;
    if (!sameNativeWindow(before.window, after.window)) {
      return unavailableBrowserPageIdentity(
        binding,
        "identity_changed_during_read",
        "the bound browser window changed while page identity was being read",
        this.now()
      );
    }

    const axWindow = findAccessibilityWindow(
      snapshot.root as AccessibilityNode,
      before.window
    );
    if (!axWindow) {
      return unavailableBrowserPageIdentity(
        binding,
        "accessibility_window_not_found",
        "Accessibility did not expose the exact bound browser window",
        this.now()
      );
    }
    const address = findAddressBarUrl(axWindow, before.window);
    if (!address) {
      return unavailableBrowserPageIdentity(
        binding,
        "address_bar_not_found",
        "Accessibility did not expose an address-bar URL for the bound browser window",
        this.now()
      );
    }
    const parsed = parseAddressBarUrl(address);
    if (!parsed) {
      return unavailableBrowserPageIdentity(
        binding,
        "invalid_address_bar_url",
        "the bound browser address bar did not contain an HTTP(S) page URL",
        this.now()
      );
    }

    const observedAt = this.now().toISOString();
    const title = axWindow.title || before.window.title;
    const fingerprint = createHash("sha256")
      .update([
        binding.browserSessionId,
        binding.nativeProfileFingerprint,
        String(binding.processId),
        binding.windowId,
        binding.applicationId,
        parsed.href,
        parsed.origin
      ].join("\u0000"))
      .digest("hex");
    return BrowserPageIdentity.parse({
      ...binding,
      status: "available",
      source: "macos_accessibility",
      observedAt,
      url: parsed.href,
      origin: parsed.origin,
      title,
      fingerprint
    });
  }

  private async nativeBinding(
    binding: PageIdentityBinding,
    sessionId: string,
    requireFrontmost: boolean
  ): Promise<
    | { window: NativeWindow }
    | { unavailable: BrowserPageIdentityUnavailable }
  > {
    const [windows, frontmost] = await Promise.all([
      this.host.request(
        "windows.list",
        { owningPid: binding.processId },
        { sessionId }
      ),
      this.host.request("frontmost", {}, { sessionId })
    ]);
    const window = windows.find((candidate) => String(candidate.windowId) === binding.windowId);
    if (!window) {
      return {
        unavailable: unavailableBrowserPageIdentity(
          binding,
          "window_not_found",
          "the exact bound browser window no longer exists",
          this.now()
        )
      };
    }
    if (
      window.ownerPid !== binding.processId
      || window.bundleId !== binding.applicationId
    ) {
      return {
        unavailable: unavailableBrowserPageIdentity(
          binding,
          "binding_mismatch",
          "the browser PID, application, and window binding no longer agree",
          this.now()
        )
      };
    }
    if (
      requireFrontmost
      && (
        frontmost.ownerPid !== binding.processId
        || frontmost.bundleId !== binding.applicationId
        || String(frontmost.window?.windowId ?? "") !== binding.windowId
      )
    ) {
      return {
        unavailable: unavailableBrowserPageIdentity(
          binding,
          "binding_mismatch",
          "the exact bound browser window is not frontmost",
          this.now()
        )
      };
    }
    return { window };
  }
}

export function staleBrowserPageIdentity(
  binding: PageIdentityBinding,
  now: Date = new Date()
): BrowserPageIdentityUnavailable {
  return unavailableBrowserPageIdentity(
    PageIdentityBinding.parse({
      browserSessionId: binding.browserSessionId,
      clientId: binding.clientId,
      browserProfile: binding.browserProfile,
      nativeProfileFingerprint: binding.nativeProfileFingerprint,
      processId: binding.processId,
      windowId: binding.windowId,
      applicationId: binding.applicationId
    }),
    "stale_after_control_change",
    "page identity is stale after a user control change; a fresh observation is required",
    now
  );
}

export function sameBrowserPage(
  left: BrowserPageIdentity,
  right: BrowserPageIdentity
): boolean {
  return left.browserSessionId === right.browserSessionId
    && left.clientId === right.clientId
    && left.browserProfile === right.browserProfile
    && left.nativeProfileFingerprint === right.nativeProfileFingerprint
    && left.processId === right.processId
    && left.windowId === right.windowId
    && left.applicationId === right.applicationId
    && left.url === right.url
    && left.origin === right.origin;
}

export function browserPageMatchesTask(
  identity: BrowserPageIdentity,
  expected: { domain?: string; url?: string; origin?: string }
): boolean {
  const parsed = new URL(identity.url);
  if (expected.domain && parsed.hostname.toLowerCase() !== expected.domain.toLowerCase()) return false;
  if (expected.url && normalizeExpectedUrl(expected.url) !== identity.url) return false;
  if (expected.origin && normalizeExpectedOrigin(expected.origin) !== identity.origin) return false;
  return true;
}

export function unavailableBrowserPageIdentity(
  binding: PageIdentityBinding,
  code: BrowserPageIdentityUnavailableCode,
  reason: string,
  now: Date = new Date()
): BrowserPageIdentityUnavailable {
  return BrowserPageIdentityUnavailable.parse({
    ...binding,
    status: "unavailable",
    observedAt: now.toISOString(),
    code,
    reason
  });
}

function findAccessibilityWindow(
  root: AccessibilityNode,
  window: NativeWindow
): AccessibilityNode | undefined {
  const candidates = flattenNodes(root).filter((node) =>
    node.role === "AXWindow"
    && node.bounds !== null
    && sameBounds(node.bounds, window.bounds)
  );
  if (candidates.length === 1) return candidates[0];
  const exactTitle = candidates.filter((node) =>
    Boolean(window.title) && node.title === window.title
  );
  return exactTitle.length === 1 ? exactTitle[0] : undefined;
}

function findAddressBarUrl(
  windowNode: AccessibilityNode,
  window: NativeWindow
): string | undefined {
  const maximumToolbarY = window.bounds.y + Math.min(180, window.bounds.height * 0.25);
  const candidates = flattenNodes(windowNode)
    .filter((node) => {
      if (node.redacted || typeof node.value !== "string" || !node.bounds) return false;
      if (!["AXTextField", "AXComboBox", "AXSearchField"].includes(node.role)) return false;
      if (!parseAddressBarUrl(node.value)) return false;
      const metadata = `${node.title} ${node.description}`.toLowerCase();
      const semantic = ADDRESS_BAR_HINTS.some((hint) => metadata.includes(hint));
      const inToolbar = node.bounds.y <= maximumToolbarY
        && node.bounds.width >= Math.min(240, window.bounds.width * 0.2);
      return semantic || inToolbar;
    })
    .map((node) => {
      const metadata = `${node.title} ${node.description}`.toLowerCase();
      const semantic = ADDRESS_BAR_HINTS.some((hint) => metadata.includes(hint));
      const score = (semantic ? 10 : 0)
        + (node.focused ? 2 : 0)
        + (node.bounds && node.bounds.y <= maximumToolbarY ? 3 : 0)
        + (node.bounds ? Math.min(2, node.bounds.width / Math.max(1, window.bounds.width)) : 0);
      return { value: node.value as string, score };
    })
    .sort((left, right) => right.score - left.score);
  if (!candidates.length) return undefined;
  if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) return undefined;
  return candidates[0]!.value;
}

function parseAddressBarUrl(raw: string): URL | undefined {
  const value = raw.trim();
  if (!value || value.length > 8_192 || /\s/.test(value)) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value)
    ? value
    : /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value)
      ? `https://${value}`
      : undefined;
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (!url.hostname || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function flattenNodes(root: AccessibilityNode): AccessibilityNode[] {
  const nodes: AccessibilityNode[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.shift()!;
    nodes.push(node);
    if (Array.isArray(node.children)) pending.unshift(...node.children);
  }
  return nodes;
}

function sameNativeWindow(left: NativeWindow, right: NativeWindow): boolean {
  return left.windowId === right.windowId
    && left.ownerPid === right.ownerPid
    && left.bundleId === right.bundleId
    && left.title === right.title
    && sameBounds(left.bounds, right.bounds);
}

function sameBounds(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return Math.abs(left.x - right.x) <= 1
    && Math.abs(left.y - right.y) <= 1
    && Math.abs(left.width - right.width) <= 1
    && Math.abs(left.height - right.height) <= 1;
}

function isSupportedChromiumApplication(applicationId: string): boolean {
  return [
    "com.google.Chrome",
    "com.microsoft.edgemac",
    "com.brave.Browser",
    "org.chromium.Chromium"
  ].includes(applicationId);
}

function normalizeExpectedUrl(value: string): string | undefined {
  return parseAddressBarUrl(value)?.href;
}

function normalizeExpectedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function nativeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : undefined;
}

const ADDRESS_BAR_HINTS = [
  "address and search",
  "address bar",
  "location bar",
  "omnibox",
  "地址和搜索",
  "地址栏",
  "網址列",
  "网址栏"
];
