import { createHash } from "node:crypto";
import type {
  NativeComputerHost,
  NativeDisplay,
  NativeResult,
  NativeWindow,
  NativeWindowSurfaceLease
} from "@adpilot/native-computer-host";
import {
  NativeSurface,
  fingerprintSurface,
  SurfaceCaptureChangedError,
  type NativeSurfaceIdentity,
  type NativeWindowCapture
} from "./surface.js";
import type {
  NativeOperator,
  Screenshot,
  VisualAction,
  VisualComputerSessionBinding,
  VisualMicroTask
} from "./index.js";

export type NativeComputerService = Pick<NativeComputerHost, "request" | "closed"> & {
  readonly epoch?: number;
};

type LeaseEntry = {
  lease: NativeWindowSurfaceLease;
  used: boolean;
  helperEpoch: number | undefined;
};

/**
 * The only production macOS NativeOperator. It translates already-policy-
 * checked atomic actions into authenticated Helper requests and requires the
 * single-use surface lease returned by the exact before-action capture.
 */
export class NativeHelperOperator implements NativeOperator {
  private readonly leases = new Map<string, LeaseEntry>();
  private readonly activeControllers = new Map<string, Set<AbortController>>();
  private userInputHandler:
    | ((binding: VisualComputerSessionBinding, reason: "physical_input" | "activity_monitor_unavailable") => void | Promise<void>)
    | undefined;
  private readonly activityMonitors = new Map<
    string,
    { binding: VisualComputerSessionBinding; monitor: NativeInputActivityMonitor }
  >();

  constructor(private readonly host: NativeComputerService) {}

  setUserInputHandler(
    handler?: (binding: VisualComputerSessionBinding, reason: "physical_input" | "activity_monitor_unavailable") => void | Promise<void>
  ): void {
    this.userInputHandler = handler;
    if (!handler) {
      for (const { monitor } of this.activityMonitors.values()) monitor.stop();
      this.activityMonitors.clear();
    }
  }

  async capture(task?: VisualMicroTask): Promise<Screenshot> {
    this.assertHostAvailable();
    const requestContext = nativeRequestContext(task);
    await this.activateActivityMonitor(task, requestContext.sessionId);
    const { surface, window } = await this.resolveActiveSurface(task, requestContext.sessionId);
    const captured = await this.host.request("capture", {
      target: "window",
      windowId: window.windowId,
      includeCursor: false,
      leaseDurationMs: 30_000
    }, { sessionId: requestContext.sessionId });
    if (captured.source.target !== "window" || !captured.surfaceLease) {
      throw new NativeHelperOperatorError("CAPTURE_NOT_WINDOW_BOUND", "native Helper did not return a window surface lease");
    }
    assertLeaseMatchesSurface(captured.surfaceLease, surface, captured.width, captured.height, requestContext.sessionId);
    const base64 = captured.base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
    const screenshot = {
      base64,
      width: captured.width,
      height: captured.height,
      scaleFactor: surface.scaleFactor,
      capturedAt: captured.capturedAt,
      sha256: createHash("sha256").update(base64, "base64").digest("hex"),
      surface,
      surfaceFingerprint: fingerprintSurface(surface)
    };
    const parsed = ScreenshotSchema(screenshot);
    this.leases.set(leaseKey(parsed), {
      lease: captured.surfaceLease,
      used: false,
      helperEpoch: this.host.epoch
    });
    this.pruneExpiredLeases();
    return parsed;
  }

  async identifySurface(task?: VisualMicroTask): Promise<{ surface: NativeSurface; fingerprint: string }> {
    this.assertHostAvailable();
    const { surface } = await this.resolveActiveSurface(task, nativeRequestContext(task).sessionId);
    return { surface, fingerprint: fingerprintSurface(surface) };
  }

  async execute(
    action: VisualAction,
    screenshot: Screenshot,
    task?: VisualMicroTask,
    outerSignal?: AbortSignal
  ): Promise<void> {
    this.assertHostAvailable();
    if (outerSignal?.aborted) throw new NativeHelperOperatorError("CONTROL_INTERRUPTED", "native input was cancelled before dispatch");
    if (action.action === "done" || action.action === "fail" || action.action === "screenshot") return;
    const context = nativeRequestContext(task, action);
    const controller = linkedAbortController(outerSignal);
    const controllers = this.activeControllers.get(context.sessionId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.activeControllers.set(context.sessionId, controllers);
    try {
      if (action.action === "wait") {
        await this.host.request(
          "wait",
          { durationMs: action.milliseconds },
          { sessionId: context.sessionId, signal: controller.signal }
        );
        return;
      }
      assertScreenshotMatchesTask(screenshot, task);
      const lease = this.consumeLease(screenshot, context.sessionId);
      const options = {
        sessionId: context.sessionId,
        actionId: context.actionId,
        signal: controller.signal
      };
      switch (action.action) {
        case "move":
          await this.host.request("input.move", {
            pixelX: action.x,
            pixelY: action.y,
            surfaceLease: lease
          }, options);
          return;
        case "click":
        case "double_click":
        case "right_click":
          await this.host.request("input.click", {
            pixelX: action.x,
            pixelY: action.y,
            button: action.action === "right_click" ? "right" : "left",
            clickCount: action.action === "double_click" ? 2 : 1,
            surfaceLease: lease
          }, options);
          return;
        case "drag":
          await this.host.request("input.drag", {
            fromPixelX: action.x,
            fromPixelY: action.y,
            toPixelX: action.end_x,
            toPixelY: action.end_y,
            button: "left",
            durationMs: 300,
            surfaceLease: lease
          }, options);
          return;
        case "type":
          await this.host.request("input.type", {
            text: action.text,
            surfaceLease: lease
          }, options);
          return;
        case "hotkey": {
          throw new NativeHelperOperatorError(
            "EXACT_KEY_TARGET_UNAVAILABLE",
            "native hotkeys are disabled because macOS cannot bind a key event to the exact captured Accessibility element"
          );
        }
        case "scroll": {
          const point = {
            x: action.x ?? Math.floor(screenshot.width / 2),
            y: action.y ?? Math.floor(screenshot.height / 2)
          };
          const delta = scrollDelta(action.direction);
          await this.host.request("input.scroll", {
            pixelX: point.x,
            pixelY: point.y,
            ...delta,
            unit: "pixel",
            surfaceLease: lease
          }, options);
          return;
        }
      }
    } finally {
      controllers.delete(controller);
      if (!controllers.size) this.activeControllers.delete(context.sessionId);
    }
  }

  cancelPendingInput(binding?: VisualComputerSessionBinding): void {
    const sessionId = binding ? nativeSessionId(binding) : undefined;
    const targets = sessionId
      ? [this.activeControllers.get(sessionId)].filter((entry): entry is Set<AbortController> => Boolean(entry))
      : [...this.activeControllers.values()];
    for (const controllers of targets) {
      for (const controller of controllers) controller.abort("Computer Use control changed");
      controllers.clear();
    }
    if (sessionId) this.activeControllers.delete(sessionId);
    else this.activeControllers.clear();
    if (binding) {
      this.activityMonitors.get(sessionId!)?.monitor.stop();
      this.activityMonitors.delete(sessionId!);
    } else {
      for (const { monitor } of this.activityMonitors.values()) monitor.stop();
      this.activityMonitors.clear();
    }
  }

  private async activateActivityMonitor(task: VisualMicroTask | undefined, sessionId: string): Promise<void> {
    const handler = this.userInputHandler;
    const binding = taskComputerBinding(task);
    if (!handler || !binding) return;
    const existing = this.activityMonitors.get(sessionId);
    if (existing) {
      if (!sameComputerBinding(existing.binding, binding)) {
        existing.monitor.stop();
        this.activityMonitors.delete(sessionId);
        throw new NativeHelperOperatorError(
          "COMPUTER_SESSION_COLLISION",
          "different Computer bindings resolved to one native session"
        );
      }
      if (!existing.monitor.running) await existing.monitor.start();
      return;
    }
    const monitor = new NativeInputActivityMonitor(
      this.host,
      sessionId,
      async (reason) => handler(binding, reason)
    );
    this.activityMonitors.set(sessionId, { binding, monitor });
    await monitor.start();
  }

  private async resolveActiveSurface(
    task: VisualMicroTask | undefined,
    sessionId: string
  ): Promise<{ surface: NativeSurface; window: NativeWindow }> {
    const [frontmost, displays] = await Promise.all([
      this.host.request("frontmost", {}, { sessionId }),
      this.host.request("displays.list", {}, { sessionId })
    ]);
    if (!frontmost.window) {
      throw new NativeHelperOperatorError("NATIVE_SURFACE_UNAVAILABLE", "frontmost application has no capturable window");
    }
    const window = frontmost.window;
    if (window.ownerPid !== frontmost.ownerPid || window.bundleId !== frontmost.bundleId) {
      throw new NativeHelperOperatorError("NATIVE_SURFACE_INVALID", "frontmost application and window identity disagree");
    }
    const display = displayForWindow(window, displays);
    const surface = NativeSurface.parse({
      platform: "darwin",
      app: frontmost.ownerName,
      bundleId: frontmost.bundleId,
      ...(task?.surface.nativeProfileFingerprint
        ? { browserProfile: task.surface.nativeProfileFingerprint }
        : {}),
      pid: frontmost.ownerPid,
      title: window.title,
      windowId: String(window.windowId),
      bounds: window.bounds,
      screenId: String(display.displayId),
      screenBounds: display.bounds,
      scaleFactor: display.scaleFactor
    });
    assertSurfaceMatchesTask(surface, task);
    return { surface, window };
  }

  private consumeLease(screenshot: Screenshot, sessionId: string): NativeWindowSurfaceLease {
    const key = leaseKey(screenshot);
    const entry = this.leases.get(key);
    if (!entry) {
      throw new NativeHelperOperatorError(
        "SURFACE_LEASE_MISSING",
        "native input requires the exact fresh Helper window capture"
      );
    }
    if (entry.used) {
      throw new NativeHelperOperatorError("SURFACE_LEASE_REPLAYED", "surface lease was already consumed by one atomic action");
    }
    if (entry.helperEpoch !== this.host.epoch) {
      this.leases.delete(key);
      throw new NativeHelperOperatorError(
        "SURFACE_LEASE_STALE",
        "native Helper restarted after capture; a fresh window capture is required"
      );
    }
    if (entry.lease.sessionId !== sessionId) {
      throw new NativeHelperOperatorError("SESSION_MISMATCH", "surface lease belongs to another Computer Session");
    }
    if (entry.lease.expiresAtUnixMs <= Date.now()) {
      this.leases.delete(key);
      throw new NativeHelperOperatorError("SURFACE_LEASE_EXPIRED", "surface lease expired before native input");
    }
    entry.used = true;
    this.leases.delete(key);
    return entry.lease;
  }

  private pruneExpiredLeases(): void {
    const now = Date.now();
    for (const [key, entry] of this.leases) {
      if (entry.used || entry.lease.expiresAtUnixMs <= now) this.leases.delete(key);
    }
  }

  private assertHostAvailable(): void {
    if (this.host.closed) {
      throw new NativeHelperOperatorError("NATIVE_HELPER_UNAVAILABLE", "native Helper host is closed");
    }
  }
}

export type NativeInputActivityTakeoverReason = "physical_input" | "activity_monitor_unavailable";
type InputActivitySample = NativeResult<"input.activity">;

/**
 * One Helper-session activity watcher. `input.activity.counters` comes from
 * CoreGraphics `hidSystemState`, so it contains physical input only. Helper-
 * posted telemetry must not be subtracted: if the user and Helper emit the
 * same event type concurrently, subtraction would hide the user takeover.
 */
export class NativeInputActivityMonitor {
  private baseline: InputActivitySample | undefined;
  private baselineEpoch: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private active = false;

  constructor(
    private readonly host: NativeComputerService,
    readonly sessionId: string,
    private readonly onTakeover: (reason: NativeInputActivityTakeoverReason) => void | Promise<void>,
    private readonly pollIntervalMs = 150
  ) {
    if (!sessionId.trim()) throw new Error("activity monitor sessionId is required");
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 25 || pollIntervalMs > 5_000) {
      throw new Error("activity monitor poll interval must be 25-5000ms");
    }
  }

  get running(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.generation += 1;
    this.active = true;
    try {
      const epochBefore = this.host.epoch;
      this.baseline = await this.host.request("input.activity", {}, { sessionId: this.sessionId });
      const epochAfter = this.host.epoch;
      if (epochBefore !== undefined && epochAfter !== epochBefore) {
        throw new Error("native Helper restarted while physical-input monitoring was armed");
      }
      this.baselineEpoch = epochAfter;
    } catch (error) {
      this.stop();
      await this.onTakeover("activity_monitor_unavailable");
      throw new NativeHelperOperatorError(
        "INPUT_ACTIVITY_UNAVAILABLE",
        `physical-input monitoring is unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.schedule(this.generation);
  }

  stop(): void {
    this.active = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.baseline = undefined;
    this.baselineEpoch = undefined;
  }

  /** Public deterministic sample hook used by tests and diagnostics. */
  async sampleOnce(): Promise<boolean> {
    if (!this.active) return false;
    let current: InputActivitySample;
    const epochBefore = this.host.epoch;
    try {
      current = await this.host.request("input.activity", {}, { sessionId: this.sessionId });
    } catch {
      this.stop();
      await this.onTakeover("activity_monitor_unavailable");
      return true;
    }
    const epochAfter = this.host.epoch;
    if (
      (epochBefore !== undefined && epochAfter !== epochBefore)
      || (this.baselineEpoch !== undefined && epochAfter !== this.baselineEpoch)
    ) {
      this.stop();
      await this.onTakeover("activity_monitor_unavailable");
      return true;
    }
    const previous = this.baseline;
    this.baseline = current;
    this.baselineEpoch = epochAfter;
    if (!previous || !hasPhysicalHidDelta(previous, current)) return false;
    this.stop();
    await this.onTakeover("physical_input");
    return true;
  }

  private schedule(generation: number): void {
    if (!this.active || generation !== this.generation) return;
    this.timer = setTimeout(() => {
      void this.sampleOnce()
        .catch(() => undefined)
        .finally(() => this.schedule(generation));
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }
}

/**
 * Browser/session identity through the exact authenticated Helper actor used
 * for capture and input. No Swift subprocess or AppleScript fallback exists in
 * this adapter.
 */
export class NativeHelperSurfaceIdentity implements NativeSurfaceIdentity {
  private readonly browserProfiles = new Map<number, string>();

  constructor(
    private readonly host: NativeComputerService,
    private readonly sessionId = "adpilot-native-surface-identity"
  ) {}

  registerBrowserProfile(processId: number, nativeProfileFingerprint: string): void {
    if (!Number.isInteger(processId) || processId <= 0) throw new Error("processId must be a positive integer");
    if (!nativeProfileFingerprint.trim()) throw new Error("nativeProfileFingerprint is required");
    this.browserProfiles.set(processId, nativeProfileFingerprint);
  }

  forgetBrowserProfile(processId: number): void {
    this.browserProfiles.delete(processId);
  }

  async identifyActiveSurface(): Promise<NativeSurface> {
    this.assertHostAvailable();
    const [frontmost, displays] = await Promise.all([
      this.host.request("frontmost", {}, { sessionId: this.sessionId }),
      this.host.request("displays.list", {}, { sessionId: this.sessionId })
    ]);
    if (!frontmost.window) {
      throw new NativeHelperOperatorError("NATIVE_SURFACE_UNAVAILABLE", "frontmost application has no capturable window");
    }
    if (
      frontmost.window.ownerPid !== frontmost.ownerPid
      || frontmost.window.bundleId !== frontmost.bundleId
    ) {
      throw new NativeHelperOperatorError("NATIVE_SURFACE_INVALID", "frontmost application and window identity disagree");
    }
    return nativeSurfaceForWindow(frontmost.window, displays, this.browserProfiles.get(frontmost.ownerPid));
  }

  async identifySurfaceByProcess(processId: number): Promise<NativeSurface | undefined> {
    this.assertHostAvailable();
    if (!Number.isInteger(processId) || processId <= 0) throw new Error("processId must be a positive integer");
    const [windows, displays] = await Promise.all([
      this.host.request("windows.list", { owningPid: processId, includeOffscreen: false }, { sessionId: this.sessionId }),
      this.host.request("displays.list", {}, { sessionId: this.sessionId })
    ]);
    const window = [...windows]
      .filter((candidate) => candidate.ownerPid === processId && candidate.layer === 0 && candidate.onScreen)
      .sort((left, right) => rectangleArea(right.bounds) - rectangleArea(left.bounds))[0];
    return window
      ? nativeSurfaceForWindow(window, displays, this.browserProfiles.get(processId))
      : undefined;
  }

  async captureActiveWindow(expected?: NativeSurface): Promise<NativeWindowCapture> {
    const surface = await this.identifyActiveSurface();
    if (expected && fingerprintSurface(expected) !== fingerprintSurface(surface)) {
      throw new SurfaceCaptureChangedError(expected, surface);
    }
    const captured = await this.host.request("capture", {
      target: "window",
      windowId: Number(surface.windowId),
      includeCursor: false,
      leaseDurationMs: 30_000
    }, { sessionId: this.sessionId });
    if (captured.source.target !== "window" || !captured.surfaceLease) {
      throw new NativeHelperOperatorError("CAPTURE_NOT_WINDOW_BOUND", "native Helper did not return a window surface lease");
    }
    assertLeaseMatchesSurface(captured.surfaceLease, surface, captured.width, captured.height, this.sessionId);
    return {
      base64: captured.base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, ""),
      width: captured.width,
      height: captured.height,
      scaleFactor: surface.scaleFactor,
      surface,
      surfaceFingerprint: fingerprintSurface(surface)
    };
  }

  private assertHostAvailable(): void {
    if (this.host.closed) {
      throw new NativeHelperOperatorError("NATIVE_HELPER_UNAVAILABLE", "native Helper host is closed");
    }
  }
}

export class NativeHelperOperatorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativeHelperOperatorError";
  }
}

export function nativeRequestContext(
  task?: VisualMicroTask,
  action?: VisualAction
): { sessionId: string; actionId: string } {
  const binding = taskComputerBinding(task) ?? {
    adPilotSessionId: task?.clientId ?? "unbound-product-session",
    browserSessionId: task?.surface.nativeProfileFingerprint
      ?? task?.surface.browserProfile
      ?? "unbound-browser-session"
  };
  const sessionId = nativeSessionId(binding);
  const actionMaterial = JSON.stringify({
    sessionId,
    taskId: action?.task_id ?? task?.taskId ?? null,
    stepId: action?.step_id ?? task?.stepId ?? null,
    planId: action?.planId ?? task?.planId ?? null,
    action: action?.action ?? null
  });
  return {
    sessionId,
    actionId: `action_${createHash("sha256").update(actionMaterial).digest("hex").slice(0, 40)}`
  };
}

function nativeSessionId(binding: VisualComputerSessionBinding): string {
  return `session_${createHash("sha256")
    .update(`${binding.adPilotSessionId.trim()}\u0000${binding.browserSessionId.trim()}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function taskComputerBinding(task?: VisualMicroTask): VisualComputerSessionBinding | undefined {
  const adPilotSessionId = task?.adPilotSessionId?.trim();
  const browserSessionId = task?.browserSessionId?.trim();
  return adPilotSessionId && browserSessionId ? { adPilotSessionId, browserSessionId } : undefined;
}

function sameComputerBinding(
  left: VisualComputerSessionBinding | undefined,
  right: VisualComputerSessionBinding
): boolean {
  return left?.adPilotSessionId === right.adPilotSessionId
    && left.browserSessionId === right.browserSessionId;
}

function hasPhysicalHidDelta(previous: InputActivitySample, current: InputActivitySample): boolean {
  const eventTypes = new Set([
    ...Object.keys(previous.counters),
    ...Object.keys(current.counters)
  ]);
  for (const eventType of eventTypes) {
    const hidDelta = monotonicDelta(previous.counters[eventType], current.counters[eventType]);
    if (hidDelta > 0) return true;
  }
  return false;
}

function monotonicDelta(previous = 0, current = 0): number {
  return current >= previous ? current - previous : 0;
}

function nativeSurfaceForWindow(
  window: NativeWindow,
  displays: NativeDisplay[],
  browserProfile?: string
): NativeSurface {
  const display = displayForWindow(window, displays);
  return NativeSurface.parse({
    platform: "darwin",
    app: window.ownerName,
    bundleId: window.bundleId,
    ...(browserProfile ? { browserProfile } : {}),
    pid: window.ownerPid,
    title: window.title,
    windowId: String(window.windowId),
    bounds: window.bounds,
    screenId: String(display.displayId),
    screenBounds: display.bounds,
    scaleFactor: display.scaleFactor
  });
}

function rectangleArea(rectangle: { width: number; height: number }): number {
  return rectangle.width * rectangle.height;
}

function assertSurfaceMatchesTask(surface: NativeSurface, task?: VisualMicroTask): void {
  if (!task) return;
  const mismatches: string[] = [];
  const applicationId = surface.bundleId ?? surface.app;
  if (task.surface.app !== surface.app) mismatches.push("application name");
  if (task.surface.applicationId && task.surface.applicationId !== applicationId) mismatches.push("application ID");
  if (task.surface.processId && task.surface.processId !== surface.pid) mismatches.push("process ID");
  if (task.surface.windowId && task.surface.windowId !== surface.windowId) mismatches.push("window ID");
  const expectedProfile = task.surface.nativeProfileFingerprint;
  if (expectedProfile && surface.browserProfile !== expectedProfile) mismatches.push("browser Profile");
  if (mismatches.length) {
    throw new NativeHelperOperatorError("SURFACE_CHANGED", `native surface differs from task binding: ${mismatches.join(", ")}`);
  }
}

function assertScreenshotMatchesTask(screenshot: Screenshot, task?: VisualMicroTask): void {
  if (!screenshot.surface || !screenshot.surfaceFingerprint) {
    throw new NativeHelperOperatorError("SURFACE_IDENTITY_MISSING", "native input requires a window-bound screenshot");
  }
  if (fingerprintSurface(screenshot.surface) !== screenshot.surfaceFingerprint) {
    throw new NativeHelperOperatorError("SURFACE_FINGERPRINT_INVALID", "screenshot surface metadata does not match its fingerprint");
  }
  assertSurfaceMatchesTask(screenshot.surface, task);
}

function assertLeaseMatchesSurface(
  lease: NativeWindowSurfaceLease,
  surface: NativeSurface,
  width: number,
  height: number,
  sessionId: string
): void {
  if (
    lease.sessionId !== sessionId
    || String(lease.windowId) !== surface.windowId
    || lease.ownerPid !== surface.pid
    || lease.bundleId !== surface.bundleId
    || lease.capturePixels.width !== width
    || lease.capturePixels.height !== height
    || !sameRectangle(lease.bounds, surface.bounds)
  ) {
    throw new NativeHelperOperatorError("SURFACE_LEASE_INVALID", "capture lease does not match the active native surface");
  }
}

function displayForWindow(window: NativeWindow, displays: NativeDisplay[]): NativeDisplay {
  const center = {
    x: window.bounds.x + window.bounds.width / 2,
    y: window.bounds.y + window.bounds.height / 2
  };
  const display = displays.find((candidate) =>
    center.x >= candidate.bounds.x
    && center.y >= candidate.bounds.y
    && center.x < candidate.bounds.x + candidate.bounds.width
    && center.y < candidate.bounds.y + candidate.bounds.height
  ) ?? displays.find((candidate) => candidate.isMain);
  if (!display) throw new NativeHelperOperatorError("DISPLAY_UNAVAILABLE", "native Helper returned no display for the active window");
  return display;
}

function scrollDelta(direction: "up" | "down" | "left" | "right"): { deltaX: number; deltaY: number } {
  if (direction === "up") return { deltaX: 0, deltaY: 600 };
  if (direction === "down") return { deltaX: 0, deltaY: -600 };
  if (direction === "left") return { deltaX: 600, deltaY: 0 };
  return { deltaX: -600, deltaY: 0 };
}

function linkedAbortController(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else if (signal) {
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller;
}

function leaseKey(screenshot: Screenshot): string {
  return [
    screenshot.sha256,
    screenshot.surfaceFingerprint ?? "",
    screenshot.capturedAt,
    screenshot.width,
    screenshot.height
  ].join(":");
}

function sameRectangle(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function ScreenshotSchema(value: Screenshot): Screenshot {
  // Imported as a type through the circular public index; use the existing
  // operator contract's structural invariants here to keep this adapter small.
  if (!value.base64 || value.width <= 0 || value.height <= 0 || !value.surface) {
    throw new NativeHelperOperatorError("CAPTURE_INVALID", "native Helper returned an invalid screenshot");
  }
  return value;
}
