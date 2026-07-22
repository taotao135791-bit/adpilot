import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Jimp } from "jimp";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const SurfaceBounds = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive()
});
export type SurfaceBounds = z.infer<typeof SurfaceBounds>;

export const NativeSurface = z.object({
  platform: z.enum(["darwin", "win32", "linux"]),
  app: z.string().min(1),
  bundleId: z.string().min(1).optional(),
  browserProfile: z.string().min(1).optional(),
  pid: z.number().int().positive(),
  title: z.string(),
  windowId: z.string().min(1),
  bounds: SurfaceBounds,
  screenId: z.string().min(1),
  screenBounds: SurfaceBounds,
  scaleFactor: z.number().finite().positive()
});
export type NativeSurface = z.infer<typeof NativeSurface>;

export interface NativeWindowCapture {
  base64: string;
  width: number;
  height: number;
  scaleFactor: number;
  surface: NativeSurface;
  surfaceFingerprint: string;
}

/** Cross-platform contract. Platform implementations must identify and capture the same active surface. */
export interface NativeSurfaceIdentity {
  identifyActiveSurface(): Promise<NativeSurface>;
  captureActiveWindow(expected?: NativeSurface): Promise<NativeWindowCapture>;
}

export function fingerprintSurface(surface: NativeSurface): string {
  const stable = {
    platform: surface.platform,
    app: surface.app,
    bundleId: surface.bundleId ?? "",
    browserProfile: surface.browserProfile ?? "",
    pid: surface.pid,
    title: surface.title,
    windowId: surface.windowId,
    bounds: surface.bounds,
    screenId: surface.screenId,
    screenBounds: surface.screenBounds,
    scaleFactor: surface.scaleFactor
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export class NativeSurfaceUnavailableError extends Error {
  readonly code = "NATIVE_SURFACE_UNAVAILABLE" as const;
}

export class MacOSNativeSurfaceIdentity implements NativeSurfaceIdentity {
  constructor(
    private readonly runNativeProbe: () => Promise<NativeSurface> = probeMacSurfaceNative,
    private readonly runAppleScriptProbe: () => Promise<NativeSurface> = probeMacSurfaceAppleScript
  ) {
    if (process.platform !== "darwin" && runNativeProbe === probeMacSurfaceNative) {
      throw new NativeSurfaceUnavailableError("macOS surface identity is only available on darwin");
    }
  }

  async identifyActiveSurface(): Promise<NativeSurface> {
    try {
      return await enrichBrowserProfile(NativeSurface.parse(await this.runNativeProbe()));
    } catch (nativeError) {
      try {
        return await enrichBrowserProfile(NativeSurface.parse(await this.runAppleScriptProbe()));
      } catch (fallbackError) {
        const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError);
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new NativeSurfaceUnavailableError(`unable to identify the active macOS window (native: ${nativeMessage}; fallback: ${fallbackMessage})`);
      }
    }
  }

  async captureActiveWindow(expected?: NativeSurface): Promise<NativeWindowCapture> {
    const surface = await this.identifyActiveSurface();
    if (expected && fingerprintSurface(expected) !== fingerprintSurface(surface)) {
      throw new SurfaceCaptureChangedError(expected, surface);
    }
    const directory = await mkdtemp(join(tmpdir(), "adpilot-window-"));
    const output = join(directory, "capture.png");
    try {
      const args = surface.windowId.startsWith("region:")
        ? ["-x", "-o", `-R${surface.bounds.x},${surface.bounds.y},${surface.bounds.width},${surface.bounds.height}`, output]
        : ["-x", "-o", `-l${surface.windowId}`, output];
      await execFileAsync("/usr/sbin/screencapture", args, { timeout: 10_000, maxBuffer: 1024 * 1024 });
      const buffer = await readFile(output);
      const image = await Jimp.fromBuffer(buffer);
      return {
        base64: buffer.toString("base64"),
        width: image.width,
        height: image.height,
        scaleFactor: surface.scaleFactor,
        surface,
        surfaceFingerprint: fingerprintSurface(surface)
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function enrichBrowserProfile(surface: NativeSurface): Promise<NativeSurface> {
  if (!/chrome|chromium|edge|brave|arc/i.test(`${surface.app} ${surface.bundleId ?? ""}`)) return surface;
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-ww", "-p", String(surface.pid), "-o", "command="], { timeout: 2_000, maxBuffer: 128 * 1024 });
    const profile = stdout.match(/--profile-directory=(?:"([^"]+)"|'([^']+)'|([^\s]+))/)?.slice(1).find(Boolean);
    const userData = stdout.match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/)?.slice(1).find(Boolean);
    const browserProfile = profile ?? (userData ? `user-data:${createHash("sha256").update(userData).digest("hex").slice(0, 16)}` : undefined);
    return browserProfile ? NativeSurface.parse({ ...surface, browserProfile }) : surface;
  } catch {
    return surface;
  }
}

export class SurfaceCaptureChangedError extends Error {
  readonly code = "SURFACE_CHANGED" as const;

  constructor(readonly expected: NativeSurface, readonly actual: NativeSurface) {
    super(`active surface changed from ${describeSurface(expected)} to ${describeSurface(actual)}`);
  }
}

function describeSurface(surface: NativeSurface): string {
  return `${surface.app}/${surface.pid}/${surface.windowId}/${surface.title || "untitled"}`;
}

const MAC_SURFACE_SWIFT = String.raw`
import AppKit
import CoreGraphics
import Foundation

func rectDictionary(_ rect: CGRect) -> [String: Double] {
  return ["x": rect.origin.x, "y": rect.origin.y, "width": rect.size.width, "height": rect.size.height]
}

guard let app = NSWorkspace.shared.frontmostApplication else {
  fputs("no frontmost application\n", stderr)
  exit(2)
}
let pid = app.processIdentifier
let entries = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
guard let entry = entries.first(where: { item in
  let owner = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
  let layer = (item[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
  guard owner == pid && layer == 0,
        let rawBounds = item[kCGWindowBounds as String] as? NSDictionary,
        let bounds = CGRect(dictionaryRepresentation: rawBounds) else { return false }
  return bounds.width > 1 && bounds.height > 1
}), let rawBounds = entry[kCGWindowBounds as String] as? NSDictionary,
    let bounds = CGRect(dictionaryRepresentation: rawBounds) else {
  fputs("frontmost application has no visible window\n", stderr)
  exit(3)
}

var count: UInt32 = 0
CGGetActiveDisplayList(0, nil, &count)
var displays = Array(repeating: CGDirectDisplayID(0), count: Int(count))
CGGetActiveDisplayList(count, &displays, &count)
let center = CGPoint(x: bounds.midX, y: bounds.midY)
let display = displays.first(where: { CGDisplayBounds($0).contains(center) }) ?? CGMainDisplayID()
let displayBounds = CGDisplayBounds(display)
let nativeScreen = NSScreen.screens.first(where: { screen in
  guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return false }
  return number.uint32Value == display
})
let scale = nativeScreen?.backingScaleFactor ?? 1.0
let payload: [String: Any] = [
  "platform": "darwin",
  "app": app.localizedName ?? "Unknown",
  "bundleId": app.bundleIdentifier ?? "unknown",
  "pid": Int(pid),
  "title": (entry[kCGWindowName as String] as? String) ?? "",
  "windowId": String((entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0),
  "bounds": rectDictionary(bounds),
  "screenId": String(display),
  "screenBounds": rectDictionary(displayBounds),
  "scaleFactor": scale
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
`;

async function probeMacSurfaceNative(): Promise<NativeSurface> {
  const { stdout } = await execFileAsync("/usr/bin/swift", ["-e", MAC_SURFACE_SWIFT], {
    timeout: 12_000,
    maxBuffer: 1024 * 1024
  });
  return NativeSurface.parse(JSON.parse(stdout));
}

const MAC_SURFACE_APPLESCRIPT = String.raw`
tell application "System Events"
  set activeProcess to first application process whose frontmost is true
  set appName to name of activeProcess
  set processId to unix id of activeProcess
  if (count of windows of activeProcess) is 0 then error "frontmost application has no window"
  set activeWindow to front window of activeProcess
  set windowTitle to name of activeWindow
  set windowPosition to position of activeWindow
  set windowSize to size of activeWindow
  return appName & tab & processId & tab & windowTitle & tab & (item 1 of windowPosition) & tab & (item 2 of windowPosition) & tab & (item 1 of windowSize) & tab & (item 2 of windowSize)
end tell
`;

async function probeMacSurfaceAppleScript(): Promise<NativeSurface> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", MAC_SURFACE_APPLESCRIPT], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024
  });
  const [app, rawPid, title, rawX, rawY, rawWidth, rawHeight] = stdout.trim().split("\t");
  if (!app || !rawPid || rawX === undefined || rawY === undefined || !rawWidth || !rawHeight) {
    throw new Error("AppleScript returned incomplete window metadata");
  }
  const bounds = SurfaceBounds.parse({
    x: Number(rawX), y: Number(rawY), width: Number(rawWidth), height: Number(rawHeight)
  });
  return NativeSurface.parse({
    platform: "darwin",
    app,
    pid: Number(rawPid),
    title: title ?? "",
    windowId: `region:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
    bounds,
    screenId: "fallback-main",
    screenBounds: bounds,
    scaleFactor: 1
  });
}
