import { z } from "zod";
import { Jimp } from "jimp";
import { NativeHelperBrowserPageIdentity } from "@adpilot/computer-use";
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
  window: {
    windowId: number;
    title?: string;
    bounds: { x: number; y: number; width: number; height: number };
  } | null;
};

type CaptureResult = {
  format: string;
  base64: string;
  width: number;
  height: number;
  capturedAt: string;
};

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
  return [
    {
      name: "computer.observe",
      description: "Capture the user's frontmost window (or the named app window) and report the app, title, bounds, browser URL when available, plus a JPEG of the window for you to inspect. This is a read-only observation: it requires NO approval and no approvalId — call it directly whenever the user asks what is on their screen or in their browser.",
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
        const frontmost = await host.request("frontmost", {}, { sessionId: ctx.sessionId }) as FrontmostResult;
        if (!frontmost.window) {
          throw toolError("WINDOW_NOT_FOUND", `the frontmost application ${frontmost.ownerName} has no capturable window`);
        }
        if (params.bundleId && frontmost.bundleId !== params.bundleId) {
          return succeed("computer.observe", ctx, {
            frontmostMismatch: true,
            expected: params.bundleId,
            actual: frontmost.bundleId,
            ownerName: frontmost.ownerName
          });
        }
        const metadata: Record<string, unknown> = {
          app: frontmost.ownerName,
          bundleId: frontmost.bundleId,
          pid: frontmost.ownerPid,
          window: {
            id: frontmost.window.windowId,
            title: frontmost.window.title ?? null,
            bounds: frontmost.window.bounds
          }
        };
        if (isBrowser(frontmost.bundleId)) {
          try {
            const identity = await new NativeHelperBrowserPageIdentity(host).read({
              browserSessionId: "0".repeat(32),
              clientId: ctx.workspaceId,
              browserProfile: "observe",
              nativeProfileFingerprint: "observe",
              processId: frontmost.ownerPid,
              windowId: String(frontmost.window.windowId),
              applicationId: frontmost.bundleId
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
        let image: { data: string; mimeType: string } | undefined;
        if (params.includeImage !== false) {
          const capture = await host.request("capture", {
            target: "window",
            windowId: frontmost.window.windowId,
            includeCursor: false
          }, { sessionId: ctx.sessionId, timeoutMs: 30_000 }) as CaptureResult;
          const preview = await previewJpeg(capture.base64);
          image = { data: preview.data, mimeType: preview.mimeType };
          metadata.image = { width: preview.width, height: preview.height, mimeType: preview.mimeType, sourceWidth: capture.width, sourceHeight: capture.height, capturedAt: capture.capturedAt };
        }
        const result = succeed("computer.observe", ctx, metadata, {
          evidenceIds: [`computer-observe:${frontmost.bundleId}:${frontmost.window.windowId}`]
        });
        if (image) result.image = image;
        return result;
      }
    }
  ];
}
