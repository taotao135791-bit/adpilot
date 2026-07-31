import { z } from "zod";
import { Jimp } from "jimp";
import { randomUUID } from "node:crypto";
import { NativeHelperBrowserPageIdentity } from "@adpilot/computer-use";
import type {
  NativeWindow,
  NativeWindowSurfaceLease
} from "@adpilot/native-computer-host";
import type { AgentToolDefinition, AgentToolDeps } from "../index.js";
import { succeed } from "../result.js";
import { toolError } from "../errors.js";

const BROWSER_BUNDLE_HINTS = ["chrome", "edge", "brave", "arc", "firefox", "safari", "chromium", "opera", "vivaldi", "dia", "zen"];
const MAX_IMAGE_EDGE = 1280;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

type FrontmostResult = {
  ownerPid: number;
  ownerName: string;
  bundleId: string;
  window: NativeWindow | null;
};

type CaptureResult = {
  format: string;
  base64: string;
  width: number;
  height: number;
  capturedAt: string;
  source: { target: "window"; windowId: number };
  surfaceLease: NativeWindowSurfaceLease;
};

type ObservedWindow = {
  observationId: string;
  window: NativeWindow;
  surfaceLease: NativeWindowSurfaceLease;
};

const OBSERVATION_LEASE_MS = 30_000;
const MAX_OBSERVATIONS_PER_SESSION = 8;

function requireHost(deps: AgentToolDeps) {
  const host = deps.computer?.host;
  if (!host || host.closed) {
    throw toolError("COMPUTER_UNAVAILABLE", "the authenticated native Helper is not running on this machine");
  }
  return host;
}

function isBrowser(bundleId: string): boolean {
  const value = bundleId.toLowerCase();
  return BROWSER_BUNDLE_HINTS.some((hint) => value.includes(hint));
}

function windowArea(window: NativeWindow): number {
  return window.bounds.width * window.bounds.height;
}

async function visibleWindowForBundle(
  host: ReturnType<typeof requireHost>,
  bundleId: string,
  sessionId: string,
  windowId?: number
): Promise<NativeWindow> {
  const windows = await host.request(
    "windows.list",
    { includeOffscreen: false },
    { sessionId }
  ) as NativeWindow[];
  const candidates = windows
    .filter((window) => window.bundleId === bundleId && window.layer === 0 && window.onScreen && window.alpha > 0)
    .filter((window) => windowId === undefined || window.windowId === windowId)
    .sort((left, right) => windowArea(right) - windowArea(left));
  const selected = candidates[0];
  if (!selected) {
    throw toolError(
      "WINDOW_NOT_FOUND",
      windowId === undefined
        ? `no visible window exists for ${bundleId}`
        : `window ${windowId} is not a visible window owned by ${bundleId}`
    );
  }
  return selected;
}

async function previewJpeg(base64Png: string): Promise<{ data: string; mimeType: string; width: number; height: number }> {
  const image = await Jimp.read(Buffer.from(base64Png, "base64"));
  if (image.width > MAX_IMAGE_EDGE) image.scaleToFit({ w: MAX_IMAGE_EDGE, h: MAX_IMAGE_EDGE });
  const buffer = await image.getBuffer("image/jpeg", { quality: 68 });
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    image.scaleToFit({ w: 896, h: 896 });
    const smaller = await image.getBuffer("image/jpeg", { quality: 60 });
    return { data: smaller.toString("base64"), mimeType: "image/jpeg", width: image.width, height: image.height };
  }
  return { data: buffer.toString("base64"), mimeType: "image/jpeg", width: image.width, height: image.height };
}

/**
 * computer.observe — the agent's eyes. Captures the current frontmost window
 * through the authenticated native Helper and returns structured metadata
 * (app, bundle id, title, bounds, browser URL when readable) plus a
 * downscaled JPEG handed to the model as an image content block, so a
 * vision-capable code model can literally answer "what is on my screen".
 * No pixels are stored; the image lives only inside the tool result.
 */
export function createComputerTools(): AgentToolDefinition[] {
  const observations = new Map<string, Map<string, ObservedWindow>>();

  const rememberObservation = (
    sessionId: string,
    window: NativeWindow,
    surfaceLease: NativeWindowSurfaceLease
  ): ObservedWindow => {
    const now = Date.now();
    const session = observations.get(sessionId) ?? new Map<string, ObservedWindow>();
    for (const [id, observation] of session) {
      if (observation.surfaceLease.expiresAtUnixMs < now) session.delete(id);
    }
    while (session.size >= MAX_OBSERVATIONS_PER_SESSION) {
      const oldest = session.keys().next().value as string | undefined;
      if (!oldest) break;
      session.delete(oldest);
    }
    const observation = {
      observationId: randomUUID(),
      window,
      surfaceLease
    };
    session.set(observation.observationId, observation);
    observations.set(sessionId, session);
    return observation;
  };

  const consumeObservation = (
    sessionId: string,
    observationId: string
  ): ObservedWindow => {
    const session = observations.get(sessionId);
    const observation = session?.get(observationId);
    if (!observation) {
      throw toolError(
        "OBSERVATION_REQUIRED",
        "the window observation is missing, belongs to another session, or was already used; call computer.observe again"
      );
    }
    session!.delete(observationId);
    if (observation.surfaceLease.expiresAtUnixMs < Date.now()) {
      throw toolError(
        "OBSERVATION_EXPIRED",
        "the exact-window observation expired; call computer.observe again before acting"
      );
    }
    return observation;
  };

  return [
    {
      name: "computer.observe",
      description: "Capture the user's frontmost window or a visible window owned by bundleId and report the app, exact windowId, title, bounds, browser URL when available, a short-lived observationId, plus a JPEG for inspection. This is read-only and requires NO approval or approvalId. When the user names Chrome, pass bundleId \"com.google.Chrome\" so AdPilot being frontmost does not hide the browser. Any later window action must use the returned observationId.",
      capabilityPack: "computer-use",
      permission: "computer-use",
      parameters: z.object({
        bundleId: z.string().min(1).max(1_024).optional(),
        includeImage: z.boolean().optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({
          bundleId: z.string().min(1).max(1_024).optional(),
          includeImage: z.boolean().optional()
        }).parse(raw);
        const host = requireHost(deps);
        const frontmost = params.bundleId
          ? null
          : await host.request("frontmost", {}, { sessionId: ctx.sessionId }) as FrontmostResult;
        const selected = params.bundleId
          ? await visibleWindowForBundle(host, params.bundleId, ctx.sessionId)
          : frontmost?.window;
        if (!selected) {
          throw toolError("WINDOW_NOT_FOUND", `the frontmost application ${frontmost?.ownerName ?? "unknown"} has no capturable window`);
        }
        const metadata: Record<string, unknown> = {
          app: selected.ownerName,
          bundleId: selected.bundleId,
          pid: selected.ownerPid,
          window: {
            id: selected.windowId,
            title: selected.title || null,
            bounds: selected.bounds
          }
        };
        if (isBrowser(selected.bundleId)) {
          try {
            const identity = await new NativeHelperBrowserPageIdentity(host).read({
              browserSessionId: "0".repeat(32),
              clientId: ctx.workspaceId,
              browserProfile: "observe",
              nativeProfileFingerprint: "observe",
              processId: selected.ownerPid,
              windowId: String(selected.windowId),
              applicationId: selected.bundleId
            });
            if (identity.status === "available") {
              metadata.browser = { url: identity.url, title: identity.title, origin: identity.origin };
            } else {
              metadata.browser = { unavailable: identity.reason };
            }
          } catch (error) {
            metadata.browser = { unavailable: error instanceof Error ? error.message : String(error) };
          }
        }
        const capture = await host.request("capture", {
          target: "window",
          windowId: selected.windowId,
          includeCursor: false,
          leaseDurationMs: OBSERVATION_LEASE_MS
        }, { sessionId: ctx.sessionId, timeoutMs: 30_000 }) as CaptureResult;
        if (
          capture.source.target !== "window"
          || capture.source.windowId !== selected.windowId
          || capture.surfaceLease.windowId !== selected.windowId
          || capture.surfaceLease.ownerPid !== selected.ownerPid
          || capture.surfaceLease.bundleId !== selected.bundleId
        ) {
          throw toolError(
            "SURFACE_CHANGED",
            "the captured surface did not match the selected application window"
          );
        }
        const observation = rememberObservation(ctx.sessionId, selected, capture.surfaceLease);
        metadata.observationId = observation.observationId;
        metadata.observationExpiresAt = new Date(capture.surfaceLease.expiresAtUnixMs).toISOString();
        metadata.isolation = {
          sessionId: ctx.sessionId,
          pid: selected.ownerPid,
          bundleId: selected.bundleId,
          windowId: selected.windowId,
          bounds: selected.bounds,
          oneTime: true
        };
        let image: { data: string; mimeType: string } | undefined;
        if (params.includeImage !== false) {
          const preview = await previewJpeg(capture.base64);
          image = { data: preview.data, mimeType: preview.mimeType };
          metadata.image = { width: preview.width, height: preview.height, mimeType: preview.mimeType, sourceWidth: capture.width, sourceHeight: capture.height, capturedAt: capture.capturedAt };
        }
        const result = succeed("computer.observe", ctx, metadata, {
          evidenceIds: [`computer-observe:${selected.bundleId}:${selected.windowId}`]
        });
        if (image) result.image = image;
        return result;
      }
    },
    {
      name: "computer.close_window",
      description: "Close the exact local app window represented by a fresh observationId from computer.observe. The observation is session-bound, expires after 30 seconds, and can be used only once; bundle, PID, window, and bounds are revalidated by the native Helper. This is a routine local UI write: it is blocked in guarded mode and allowed when the user enabled Full Access.",
      capabilityPack: "computer-use",
      permission: "computer-use",
      parameters: z.object({
        observationId: z.string().uuid()
      }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({
          observationId: z.string().uuid()
        }).parse(raw);
        const host = requireHost(deps);
        const observation = consumeObservation(ctx.sessionId, params.observationId);
        const selected = observation.window;
        await host.request("window.close", {
          surfaceLease: observation.surfaceLease
        }, { sessionId: ctx.sessionId });
        let closed = false;
        for (const durationMs of [250, 500, 750, 1_000]) {
          await host.request("wait", { durationMs }, { sessionId: ctx.sessionId });
          const remaining = await host.request(
            "windows.list",
            { includeOffscreen: true },
            { sessionId: ctx.sessionId }
          ) as NativeWindow[];
          if (!remaining.some((window) => window.windowId === selected.windowId && window.ownerPid === selected.ownerPid)) {
            closed = true;
            break;
          }
        }
        if (!closed) {
          throw toolError("EXECUTION_FAILED", `window ${selected.windowId} is still open after the close command`);
        }
        return succeed("computer.close_window", ctx, {
          closed: true,
          app: selected.ownerName,
          bundleId: selected.bundleId,
          windowId: selected.windowId,
          title: selected.title || null
        }, {
          evidenceIds: [`computer-window-closed:${selected.bundleId}:${selected.windowId}`]
        });
      }
    }
  ];
}
