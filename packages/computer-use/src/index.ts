import { createHash } from "node:crypto";
import { Jimp } from "jimp";
import { NutJSOperator } from "@ui-tars/operator-nut-js";
import { actionParser } from "@ui-tars/action-parser";
import { parseBoxToScreenCoords, preprocessResizeImage, type ScreenshotOutput } from "@ui-tars/sdk/core";
import { UITarsModelVersion } from "@ui-tars/sdk";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { z } from "zod";
import { PermissionLevel, RiskLevel, type ModelTier, type PermissionLevel as Permission } from "@adpilot/shared";
import {
  MacOSNativeSurfaceIdentity,
  NativeSurface,
  NativeSurfaceUnavailableError,
  SurfaceCaptureChangedError,
  fingerprintSurface,
  type NativeSurfaceIdentity
} from "./surface.js";
import { BrowserSessionLostError } from "./browser-session.js";

export * from "./surface.js";
export * from "./browser-session.js";
export * from "./privacy.js";
export * from "./account-fingerprint.js";

export const VisualTaskAllowedRegion = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  coordinateSpace: z.enum(["screenshot_pixels", "screen_points"])
}).strict();
export type VisualTaskAllowedRegion = z.infer<typeof VisualTaskAllowedRegion>;

const common = {
  task_id: z.string().min(1).optional(),
  step_id: z.string().min(1).optional(),
  surface_fingerprint: z.string().length(64).optional(),
  taskId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  planId: z.string().min(1).optional(),
  surfaceFingerprint: z.string().length(64).optional(),
  accountFingerprint: z.string().length(64).optional(),
  allowedRegion: VisualTaskAllowedRegion.optional(),
  target: z.string().min(1),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  expected_result: z.string().min(1),
  risk_level: RiskLevel
};

const coordinate = { x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() };

export const VisualAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), ...coordinate, ...common }),
  z.object({ action: z.literal("double_click"), ...coordinate, ...common }),
  z.object({ action: z.literal("right_click"), ...coordinate, ...common }),
  z.object({ action: z.literal("move"), ...coordinate, ...common }),
  z.object({ action: z.literal("drag"), ...coordinate, end_x: z.number().finite().nonnegative(), end_y: z.number().finite().nonnegative(), ...common }),
  z.object({ action: z.literal("type"), text: z.string().min(1), ...common }),
  z.object({ action: z.literal("hotkey"), keys: z.string().min(1), ...common }),
  z.object({ action: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]), x: z.number().nonnegative().optional(), y: z.number().nonnegative().optional(), ...common }),
  z.object({ action: z.literal("wait"), milliseconds: z.number().int().min(100).max(10_000).default(1000), ...common }),
  z.object({ action: z.literal("screenshot"), ...common }),
  z.object({ action: z.literal("done"), ...common }),
  z.object({ action: z.literal("fail"), ...common })
]);
export type VisualAction = z.infer<typeof VisualAction>;
export type VisualActionKind = VisualAction["action"];

const VisualActionKind = z.enum([
  "click", "double_click", "right_click", "move", "drag", "type", "hotkey",
  "scroll", "wait", "screenshot", "done", "fail"
]);

/** Optional, strictly narrowing guard used by safety-critical validation flows. */
export const VisualExecutionConstraints = z.object({
  allowedActions: z.array(VisualActionKind).min(1)
}).strict();
export type VisualExecutionConstraints = z.infer<typeof VisualExecutionConstraints>;

/** Runtime execution schema. Provider candidates become executable only after these bindings are attached. */
export const ExecutableVisualAction = VisualAction.and(z.object({
  task_id: z.string().min(1),
  step_id: z.string().min(1),
  surface_fingerprint: z.string().length(64),
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  planId: z.string().min(1),
  surfaceFingerprint: z.string().length(64),
  accountFingerprint: z.string().length(64),
  allowedRegion: VisualTaskAllowedRegion
}));
export type ExecutableVisualAction = z.infer<typeof ExecutableVisualAction>;

export const Screenshot = z.object({
  base64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scaleFactor: z.number().positive(),
  capturedAt: z.string().datetime(),
  sha256: z.string().length(64),
  surface: NativeSurface.optional(),
  surfaceFingerprint: z.string().length(64).optional()
});
export type Screenshot = z.infer<typeof Screenshot>;

export interface SurfaceContext {
  app: string;
  applicationId?: string;
  processId?: number;
  windowId?: string;
  domain?: string;
  /** User-facing Profile binding used to locate the managed session. */
  browserProfile?: string;
  /** Non-reversible proof read from the native browser process command line. */
  nativeProfileFingerprint?: string;
  allowedApps: string[];
  allowedDomains: string[];
}

export interface VisualMicroTask {
  clientId?: string;
  taskId?: string;
  stepId?: string;
  planId?: string;
  platform?: string;
  accountFingerprint?: string;
  allowedRegion?: VisualTaskAllowedRegion;
  planCreatedAt?: string;
  planExpiresAt?: string;
  identity?: {
    accountName: string;
    accountId: string;
    campaignName: string;
    campaignId: string;
    pageType: string;
    currency: string | null;
    currentValue: string | number | boolean | null;
    proposedValue: string | number | boolean | null;
    operation: string;
  };
  instruction: string;
  target: string;
  expectedResult: string;
  riskLevel: z.infer<typeof RiskLevel>;
  permission: Permission;
  /** Additional least-privilege action boundary for tightly scoped micro-tasks. */
  allowedActions?: VisualAction["action"][];
  /** Optional exact direction boundary for scroll-only validation flows. */
  allowedScrollDirections?: Array<"up" | "down" | "left" | "right">;
  /** `none` permits exactly one grounding/execution attempt. */
  retryPolicy?: "default" | "none";
  surface: SurfaceContext;
}

export interface GroundingModel {
  ground(task: VisualMicroTask, screenshot: Screenshot, tier: ModelTier): Promise<VisualAction>;
}

export interface VisualGroundingProvider extends GroundingModel {
  readonly id: string;
  readonly kind: "dedicated" | "pi-vision";
}

export interface VisualVerifier {
  verify(expectedResult: string, before: Screenshot, after: Screenshot, task?: VisualMicroTask): Promise<{ matched: boolean; confidence: number; reason: string }>;
}

export interface NativeOperator {
  bindTask?(task: VisualMicroTask): void | Promise<void>;
  capture(): Promise<Screenshot>;
  execute(action: VisualAction, screenshot: Screenshot): Promise<void>;
  identifySurface?(): Promise<{ surface: NativeSurface; fingerprint: string }>;
}

type VisualRuntimeEventPayload =
  | { type: "screenshot"; phase: "before" | "after"; screenshot: Screenshot }
  | { type: "grounded"; attempt: number; tier: ModelTier; action: VisualAction }
  | { type: "executed"; attempt: number; action: VisualAction }
  | { type: "verified"; attempt: number; matched: boolean; confidence: number; reason: string }
  | { type: "blocked"; attempt: number; reason: string; code?: VisualBlockerCode };
export type VisualRuntimeEvent = VisualRuntimeEventPayload & { clientId?: string; taskId?: string };

export const VisualBlockerCode = z.enum([
  "SURFACE_CHANGED",
  "BROWSER_SESSION_LOST",
  "DUPLICATE_COORDINATE",
  "MUTATION_RETRY_FORBIDDEN",
  "TIMEOUT",
  "POLICY_BLOCKED",
  "GROUNDING_FAILED",
  "VERIFICATION_FAILED",
  "CANCELLED",
  "PAUSED"
]);
export type VisualBlockerCode = z.infer<typeof VisualBlockerCode>;

export class VisualRuntimeBlocker extends Error {
  constructor(readonly code: VisualBlockerCode, message: string) {
    super(message);
    this.name = "VisualRuntimeBlocker";
  }
}

export class SurfaceChangedBlocker extends VisualRuntimeBlocker {
  constructor(readonly expectedFingerprint: string, readonly actualFingerprint: string) {
    super("SURFACE_CHANGED", `active surface fingerprint changed (${expectedFingerprint} -> ${actualFingerprint})`);
    this.name = "SurfaceChangedBlocker";
  }
}

export type VisualStepResult =
  | { status: "done"; attempts: number; action: VisualAction; before: Screenshot; after: Screenshot }
  | { status: "failed"; attempts: number; blocker: string; blockerCode?: VisualBlockerCode; lastAction?: VisualAction };

export class VisualPolicy {
  check(action: VisualAction, screenshot: Screenshot, task: VisualMicroTask): void {
    this.checkSurface(task.surface);
    if (task.allowedActions && !task.allowedActions.includes(action.action)) {
      throw new Error(`action ${action.action} is outside this micro-task allowlist`);
    }
    if (action.action === "scroll") {
      if (task.allowedScrollDirections && !task.allowedScrollDirections.includes(action.direction)) {
        throw new Error(`scroll direction ${action.direction} is outside this micro-task allowlist`);
      }
      if (task.allowedRegion && (action.x === undefined || action.y === undefined)) {
        throw new Error("a region-bound scroll action requires visible in-region coordinates");
      }
    }
    if (screenshot.surfaceFingerprint && action.surface_fingerprint !== screenshot.surfaceFingerprint) {
      throw new SurfaceChangedBlocker(screenshot.surfaceFingerprint, action.surface_fingerprint ?? "missing");
    }
    if (task.taskId && action.task_id !== task.taskId) throw new Error("grounded action is not bound to the requested task");
    if (task.stepId && action.step_id !== task.stepId) throw new Error("grounded action is not bound to the requested step");
    if (action.taskId !== undefined && action.taskId !== action.task_id) throw new Error("grounded action task aliases are inconsistent");
    if (action.stepId !== undefined && action.stepId !== action.step_id) throw new Error("grounded action step aliases are inconsistent");
    if (action.surfaceFingerprint !== undefined && action.surfaceFingerprint !== action.surface_fingerprint) throw new Error("grounded action surface aliases are inconsistent");
    if (task.planId && action.planId !== task.planId) throw new Error("grounded action is not bound to the approved plan");
    if (task.accountFingerprint && action.accountFingerprint !== task.accountFingerprint) throw new Error("grounded action is not bound to the approved account fingerprint");
    if (task.allowedRegion && stableJsonValue(action.allowedRegion) !== stableJsonValue(task.allowedRegion)) throw new Error("grounded action changed the approved region");
    if (action.target !== task.target) throw new Error("grounded action changed the requested target");
    if (action.expected_result !== task.expectedResult) throw new Error("grounded action changed the expected result");
    if (screenshot.surface) {
      if (!task.surface.allowedApps.includes(screenshot.surface.app)) {
        throw new Error(`active application is not allowlisted: ${screenshot.surface.app}`);
      }
      if (task.surface.app !== screenshot.surface.app) {
        throw new Error(`active application does not match requested surface: ${screenshot.surface.app}`);
      }
      const applicationId = screenshot.surface.bundleId ?? screenshot.surface.app;
      if (task.surface.applicationId && task.surface.applicationId !== applicationId) {
        throw new Error(`active application identity does not match requested surface: ${applicationId}`);
      }
      if (task.surface.processId && task.surface.processId !== screenshot.surface.pid) {
        throw new Error(`active process does not match requested surface: ${screenshot.surface.pid}`);
      }
      if (task.surface.windowId && task.surface.windowId !== screenshot.surface.windowId) {
        throw new Error(`active window does not match requested surface: ${screenshot.surface.windowId}`);
      }
      const expectedNativeProfile = task.surface.nativeProfileFingerprint ?? task.surface.browserProfile;
      if (expectedNativeProfile && screenshot.surface.browserProfile && expectedNativeProfile !== screenshot.surface.browserProfile) {
        throw new Error(`active browser profile does not match requested surface: ${screenshot.surface.browserProfile}`);
      }
    }
    const permission = PermissionLevel.parse(task.permission);
    const permissionRank = { OBSERVE: 0, INTERACT: 1, MUTATE: 2, DESTRUCTIVE: 3 } as const;
    const riskPermission = { observe: "OBSERVE", interact: "INTERACT", mutate: "MUTATE", destructive: "DESTRUCTIVE" } as const;
    if (permissionRank[permission] < permissionRank[riskPermission[action.risk_level]]) {
      throw new Error(`${permission} does not allow ${action.risk_level} action`);
    }
    if ((action.risk_level === "mutate" || action.risk_level === "destructive")
      && (!task.planId || !task.accountFingerprint || !task.allowedRegion)) {
      throw new Error("mutating actions require plan, account fingerprint, and allowed-region bindings");
    }
    const terminalOrUtility = ["done", "fail", "screenshot", "wait"].includes(action.action);
    if (!terminalOrUtility && action.action !== "move" && permissionRank[permission] < permissionRank.INTERACT) {
      throw new Error(`${permission} does not allow native input action ${action.action}`);
    }
    if (!terminalOrUtility && action.risk_level !== task.riskLevel) throw new Error("grounded action changed the declared risk level");
    const points: Array<[number, number]> = [];
    if ("x" in action && action.x !== undefined && "y" in action && action.y !== undefined) points.push([action.x, action.y]);
    if (action.action === "drag") points.push([action.end_x, action.end_y]);
    for (const [x, y] of points) {
      if (x < 0 || y < 0 || x >= screenshot.width || y >= screenshot.height) throw new Error("action coordinates are outside the screenshot");
      if (action.allowedRegion && !pointInsideAllowedRegion(x, y, action.allowedRegion, screenshot.scaleFactor)) {
        throw new Error("action coordinates are outside the approved region");
      }
      if (screenshot.surface) {
        const logicalX = x / screenshot.scaleFactor;
        const logicalY = y / screenshot.scaleFactor;
        if (logicalX < 0 || logicalY < 0 || logicalX >= screenshot.surface.bounds.width || logicalY >= screenshot.surface.bounds.height) {
          throw new Error("action coordinates are outside the active window");
        }
      }
    }
    if (terminalOrUtility && action.risk_level !== "observe") {
      throw new Error(`${action.action} must be observe risk`);
    }
  }

  private checkSurface(surface: SurfaceContext): void {
    if (!surface.allowedApps.includes(surface.app)) throw new Error(`application is not allowlisted: ${surface.app}`);
    if (surface.domain) {
      const domain = surface.domain.toLowerCase();
      const allowed = surface.allowedDomains.some((candidate) => domain === candidate.toLowerCase() || domain.endsWith(`.${candidate.toLowerCase()}`));
      if (!allowed) throw new Error(`domain is not allowlisted: ${surface.domain}`);
    }
  }
}

export class VisualComputerRuntime {
  private paused = false;
  private cancelled = false;

  constructor(
    private readonly operator: NativeOperator,
    private readonly grounding: GroundingModel,
    private readonly verifier: VisualVerifier,
    private readonly policy = new VisualPolicy(),
    private readonly onEvent: (event: VisualRuntimeEvent) => void | Promise<void> = () => undefined,
    private readonly stepTimeoutMs = 20_000,
    private readonly maxAttempts = 3
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("visual max attempts must be between 1 and 3");
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  cancel(): void { this.cancelled = true; }

  /** Resolve the live execution surface through the same native operator used for actions. */
  async identifySurface(task?: VisualMicroTask): Promise<{ surface?: NativeSurface; fingerprint: string }> {
    if (task && this.operator.bindTask) await this.operator.bindTask(task);
    if (this.operator.identifySurface) return this.operator.identifySurface();
    const screenshot = await withTimeout(this.operator.capture(), this.stepTimeoutMs, "surface identity");
    return {
      ...(screenshot.surface ? { surface: screenshot.surface } : {}),
      fingerprint: surfaceFingerprintFor(screenshot)
    };
  }

  /** Read-only verifier preflight used before consuming a mutation approval. */
  async verifyVisible(expectedResult: string, task?: VisualMicroTask): Promise<{ matched: boolean; confidence: number; reason: string; screenshot: Screenshot }> {
    if (task && this.operator.bindTask) await this.operator.bindTask(task);
    const screenshot = await withTimeout(this.operator.capture(), this.stepTimeoutMs, "verification preflight screenshot");
    await this.onEvent(scopeVisualRuntimeEvent({ type: "screenshot", phase: "before", screenshot }, task));
    const result = await withTimeout(this.verifier.verify(expectedResult, screenshot, screenshot, task), this.stepTimeoutMs, "verification preflight");
    await this.onEvent(scopeVisualRuntimeEvent({ type: "verified", attempt: 0, ...result }, task));
    return { ...result, screenshot };
  }

  /** Capture one current native window after applying the task/session binding. */
  async captureForTask(task: VisualMicroTask): Promise<Screenshot> {
    if (this.operator.bindTask) await this.operator.bindTask(task);
    const screenshot = await withTimeout(this.operator.capture(), this.stepTimeoutMs, "task-bound screenshot capture");
    await this.onEvent(scopeVisualRuntimeEvent({ type: "screenshot", phase: "before", screenshot }, task));
    return screenshot;
  }

  async runMicroTask(
    task: VisualMicroTask,
    initialScreenshot?: Screenshot,
    constraintInput?: VisualExecutionConstraints
  ): Promise<VisualStepResult> {
    const constraints = constraintInput ? VisualExecutionConstraints.parse(constraintInput) : undefined;
    let lastAction: VisualAction | undefined;
    const executedCoordinates = new Set<string>();
    let mutationExecuted = false;
    const taskId = task.taskId ?? stableId("task", task.instruction, task.target);
    const stepId = task.stepId ?? stableId("step", taskId, task.expectedResult);
    const planId = task.planId ?? stableId("plan", taskId, task.instruction, task.target, task.expectedResult);
    const boundTask = { ...task, taskId, stepId, planId };
    const attemptLimit = task.retryPolicy === "none" ? 1 : this.maxAttempts;
    if (this.operator.bindTask) await this.operator.bindTask(boundTask);
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      if (this.cancelled) return failedResult(attempt - 1, "user cancelled", "CANCELLED", lastAction);
      if (this.paused) return failedResult(attempt - 1, "paused for user takeover", "PAUSED", lastAction);
      if (mutationExecuted) {
        return failedResult(attempt - 1, "mutating actions are never retried after execution", "MUTATION_RETRY_FORBIDDEN", lastAction);
      }
      const tier: ModelTier = task.retryPolicy === "none" ? "gui" : attempt >= attemptLimit ? "strong" : "gui";
      try {
        const before = attempt === 1 && initialScreenshot
          ? Screenshot.parse(initialScreenshot)
          : await withTimeout(this.operator.capture(), this.stepTimeoutMs, "screenshot capture");
        await this.onEvent(scopeVisualRuntimeEvent({ type: "screenshot", phase: "before", screenshot: before }, boundTask));
        const expectedFingerprint = surfaceFingerprintFor(before);
        const grounded = await withTimeout(this.grounding.ground(boundTask, before, tier), this.stepTimeoutMs, "visual grounding");
        const action = bindActionContext(grounded, boundTask, before, expectedFingerprint);
        lastAction = action;
        if (constraints && !constraints.allowedActions.includes(action.action)) {
          throw new VisualRuntimeBlocker("POLICY_BLOCKED", `action ${action.action} is outside this restricted execution step`);
        }
        try { this.policy.check(action, before, boundTask); }
        catch (error) {
          if (error instanceof VisualRuntimeBlocker) throw error;
          throw new VisualRuntimeBlocker("POLICY_BLOCKED", error instanceof Error ? error.message : String(error));
        }
        await this.onEvent(scopeVisualRuntimeEvent({ type: "grounded", attempt, tier, action }, boundTask));
        if (action.action === "fail") return { status: "failed", attempts: attempt, blocker: action.reason, lastAction: action };
        if (action.action === "done") return { status: "done", attempts: attempt, action, before, after: before };

        const coordinateKey = actionCoordinateKey(action);
        if (coordinateKey && executedCoordinates.has(coordinateKey)) {
          throw new VisualRuntimeBlocker("DUPLICATE_COORDINATE", `refusing to repeat coordinates for ${action.action}: ${coordinateKey}`);
        }
        await this.assertSurfaceUnchanged(expectedFingerprint);
        if (action.risk_level === "mutate" || action.risk_level === "destructive") {
          const immediate = await withTimeout(this.operator.capture(), this.stepTimeoutMs, "mutation state recheck");
          if (immediate.sha256 !== before.sha256) {
            throw new VisualRuntimeBlocker("SURFACE_CHANGED", "visible pixels changed after identity review and grounding; a new approval plan is required");
          }
        }
        if (coordinateKey) executedCoordinates.add(coordinateKey);
        await withTimeout(this.operator.execute(action, before), this.stepTimeoutMs, "native action");
        mutationExecuted = action.risk_level === "mutate" || action.risk_level === "destructive";
        await this.onEvent(scopeVisualRuntimeEvent({ type: "executed", attempt, action }, boundTask));
        const after = await withTimeout(this.operator.capture(), this.stepTimeoutMs, "verification screenshot");
        await this.onEvent(scopeVisualRuntimeEvent({ type: "screenshot", phase: "after", screenshot: after }, boundTask));
        const afterFingerprint = surfaceFingerprintFor(after);
        if (afterFingerprint !== expectedFingerprint && !(before.surface && after.surface && sameNativeWindow(before.surface, after.surface))) {
          throw new SurfaceChangedBlocker(expectedFingerprint, afterFingerprint);
        }
        const verified = await withTimeout(this.verifier.verify(action.expected_result, before, after, boundTask), this.stepTimeoutMs, "visual verification");
        await this.onEvent(scopeVisualRuntimeEvent({ type: "verified", attempt, ...verified }, boundTask));
        if (verified.matched) return { status: "done", attempts: attempt, action, before, after };
        if (mutationExecuted) {
          return failedResult(attempt, `mutation was executed but could not be visually verified: ${verified.reason}`, "MUTATION_RETRY_FORBIDDEN", action);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const code = blockerCode(error);
        await this.onEvent(scopeVisualRuntimeEvent({ type: "blocked", attempt, reason, ...(code ? { code } : {}) }, boundTask));
        if (error instanceof SurfaceCaptureChangedError || error instanceof NativeSurfaceUnavailableError) {
          return failedResult(attempt, reason, "SURFACE_CHANGED", lastAction);
        }
        if (error instanceof BrowserSessionLostError) {
          return failedResult(attempt, reason, "BROWSER_SESSION_LOST", lastAction);
        }
        if (error instanceof VisualRuntimeBlocker) {
          return failedResult(attempt, reason, error.code, lastAction);
        }
        if (error instanceof VisualTimeoutError) {
          return failedResult(attempt, `${reason}; stopped to avoid a duplicate or blind action`, "TIMEOUT", lastAction);
        }
        if (mutationExecuted) {
          return failedResult(attempt, `${reason}; mutating action will not be retried`, "MUTATION_RETRY_FORBIDDEN", lastAction);
        }
      }
    }
    return failedResult(attemptLimit, `visual action failed ${attemptLimit} time${attemptLimit === 1 ? "" : "s"}; blind operation stopped`, "VERIFICATION_FAILED", lastAction);
  }

  private async assertSurfaceUnchanged(expectedFingerprint: string): Promise<void> {
    if (!this.operator.identifySurface) return;
    const current = await withTimeout(this.operator.identifySurface(), this.stepTimeoutMs, "surface identity");
    if (current.fingerprint !== expectedFingerprint) throw new SurfaceChangedBlocker(expectedFingerprint, current.fingerprint);
  }
}

class VisualTimeoutError extends Error {}

function scopeVisualRuntimeEvent(event: VisualRuntimeEventPayload, task?: VisualMicroTask): VisualRuntimeEvent {
  return {
    ...event,
    ...(task?.clientId ? { clientId: task.clientId } : {}),
    ...(task?.taskId ? { taskId: task.taskId } : {})
  };
}

function failedResult(attempts: number, blocker: string, blockerCode: VisualBlockerCode, lastAction?: VisualAction): VisualStepResult {
  return { status: "failed", attempts, blocker, blockerCode, ...(lastAction ? { lastAction } : {}) };
}

function blockerCode(error: unknown): VisualBlockerCode | undefined {
  if (error instanceof VisualRuntimeBlocker) return error.code;
  if (error instanceof SurfaceCaptureChangedError) return "SURFACE_CHANGED";
  if (error instanceof BrowserSessionLostError) return "BROWSER_SESSION_LOST";
  if (error instanceof VisualTimeoutError) return "TIMEOUT";
  return undefined;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}

function surfaceFingerprintFor(screenshot: Screenshot): string {
  if (screenshot.surfaceFingerprint) return screenshot.surfaceFingerprint;
  if (screenshot.surface) return fingerprintSurface(screenshot.surface);
  return createHash("sha256").update(`legacy-surface:${screenshot.width}:${screenshot.height}:${screenshot.scaleFactor}`).digest("hex");
}

function sameNativeWindow(left: NativeSurface, right: NativeSurface): boolean {
  return left.platform === right.platform
    && left.app === right.app
    && left.bundleId === right.bundleId
    && left.browserProfile === right.browserProfile
    && left.pid === right.pid
    && left.windowId === right.windowId
    && left.screenId === right.screenId
    && left.scaleFactor === right.scaleFactor
    && stableJsonValue(left.bounds) === stableJsonValue(right.bounds);
}

function stableJsonValue(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));
}

function bindActionContext(
  action: VisualAction,
  task: VisualMicroTask & { taskId: string; stepId: string; planId: string },
  screenshot: Screenshot,
  surfaceFingerprint: string
): VisualAction {
  const allowedRegion = task.allowedRegion ?? {
    x: 0,
    y: 0,
    width: screenshot.width,
    height: screenshot.height,
    coordinateSpace: "screenshot_pixels" as const
  };
  return ExecutableVisualAction.parse({
    ...action,
    task_id: task.taskId,
    step_id: task.stepId,
    surface_fingerprint: surfaceFingerprint,
    taskId: task.taskId,
    stepId: task.stepId,
    planId: task.planId,
    surfaceFingerprint,
    accountFingerprint: task.accountFingerprint ?? screenshot.sha256,
    allowedRegion
  });
}

function pointInsideAllowedRegion(x: number, y: number, region: VisualTaskAllowedRegion, scaleFactor: number): boolean {
  const pointX = region.coordinateSpace === "screen_points" ? x / scaleFactor : x;
  const pointY = region.coordinateSpace === "screen_points" ? y / scaleFactor : y;
  return pointX >= region.x && pointY >= region.y && pointX < region.x + region.width && pointY < region.y + region.height;
}

function actionCoordinateKey(action: VisualAction): string | undefined {
  if (!("x" in action) || action.x === undefined || !("y" in action) || action.y === undefined) return undefined;
  return action.action === "drag"
    ? `${action.action}:${action.x}:${action.y}:${action.end_x}:${action.end_y}`
    : `${action.action}:${action.x}:${action.y}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new VisualTimeoutError(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class UiTarsNativeOperator implements NativeOperator {
  private lastCapture: Screenshot | undefined;

  constructor(
    private readonly operator = new NutJSOperator(),
    private readonly surfaceIdentity: NativeSurfaceIdentity | undefined = process.platform === "darwin" ? new MacOSNativeSurfaceIdentity() : undefined
  ) {}

  async capture(): Promise<Screenshot> {
    if (this.surfaceIdentity) {
      const captured = await this.surfaceIdentity.captureActiveWindow();
      const screenshot = Screenshot.parse({
        base64: captured.base64,
        width: captured.width,
        height: captured.height,
        scaleFactor: captured.scaleFactor,
        capturedAt: new Date().toISOString(),
        sha256: createHash("sha256").update(captured.base64).digest("hex"),
        surface: captured.surface,
        surfaceFingerprint: captured.surfaceFingerprint
      });
      this.lastCapture = screenshot;
      return screenshot;
    }
    const raw = await this.operator.screenshot();
    const image = await Jimp.fromBuffer(Buffer.from(raw.base64.replace(/^data:image\/\w+;base64,/, ""), "base64"));
    const screenshot = Screenshot.parse({
      base64: raw.base64.replace(/^data:image\/\w+;base64,/, ""),
      width: image.width,
      height: image.height,
      scaleFactor: raw.scaleFactor,
      capturedAt: new Date().toISOString(),
      sha256: createHash("sha256").update(raw.base64).digest("hex")
    });
    this.lastCapture = screenshot;
    return screenshot;
  }

  async identifySurface(): Promise<{ surface: NativeSurface; fingerprint: string }> {
    if (this.surfaceIdentity) {
      const surface = await this.surfaceIdentity.identifyActiveSurface();
      return { surface, fingerprint: fingerprintSurface(surface) };
    }
    if (!this.lastCapture) throw new Error("surface identity is unavailable before the first capture");
    const surface = NativeSurface.parse({
      platform: process.platform === "win32" ? "win32" : "linux",
      app: "Desktop",
      pid: process.pid,
      title: "",
      windowId: "fullscreen",
      bounds: { x: 0, y: 0, width: this.lastCapture.width / this.lastCapture.scaleFactor, height: this.lastCapture.height / this.lastCapture.scaleFactor },
      screenId: "primary",
      screenBounds: { x: 0, y: 0, width: this.lastCapture.width / this.lastCapture.scaleFactor, height: this.lastCapture.height / this.lastCapture.scaleFactor },
      scaleFactor: this.lastCapture.scaleFactor
    });
    return { surface, fingerprint: surfaceFingerprintFor(this.lastCapture) };
  }

  async execute(action: VisualAction, screenshot: Screenshot): Promise<void> {
    if (action.action === "screenshot") return;
    if (action.action === "wait") {
      await new Promise((resolve) => setTimeout(resolve, action.milliseconds));
      return;
    }
    if (action.action === "done" || action.action === "fail") return;
    const startBox = "x" in action && action.x !== undefined && "y" in action && action.y !== undefined
      ? operatorBox(action.x, action.y, screenshot)
      : "";
    const endBox = action.action === "drag" ? operatorBox(action.end_x, action.end_y, screenshot) : undefined;
    const actionType = ({ double_click: "left_double", right_click: "right_single", move: "mouse_move" } as Record<string, string>)[action.action] ?? action.action;
    const actionInputs: Record<string, string> = {};
    if (startBox) actionInputs.start_box = startBox;
    if (endBox) actionInputs.end_box = endBox;
    if (action.action === "type") actionInputs.content = action.text;
    if (action.action === "hotkey") actionInputs.key = action.keys;
    if (action.action === "scroll") actionInputs.direction = action.direction;
    await this.operator.execute({
      prediction: `${actionType}()`,
      parsedPrediction: { action_type: actionType, action_inputs: actionInputs, reflection: null, thought: action.reason },
      screenWidth: screenshot.width,
      screenHeight: screenshot.height,
      scaleFactor: screenshot.scaleFactor,
      factors: [1000, 1000]
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

function operatorBox(x: number, y: number, screenshot: Screenshot): string {
  const globalX = screenshot.surface ? screenshot.surface.bounds.x + x / screenshot.scaleFactor : x;
  const globalY = screenshot.surface ? screenshot.surface.bounds.y + y / screenshot.scaleFactor : y;
  return `[${globalX / screenshot.width},${globalY / screenshot.height},${globalX / screenshot.width},${globalY / screenshot.height}]`;
}

export interface OpenAICompatibleUiTarsConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
  strongModel?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
  uiTarsVersion?: UITarsModelVersion;
  protocol?: "ui-tars" | "adpilot-json";
  coordinateFormat?: "pixels" | "normalized" | "ui-tars-1000";
  normalization?: "screenshot" | "window";
}

/** Dedicated UI-TARS/OpenAI-compatible one-step grounding provider. It never owns a task loop. */
export class OpenAICompatibleUiTarsProvider implements VisualGroundingProvider {
  readonly id = "ui-tars-openai-compatible";
  readonly kind = "dedicated" as const;
  private readonly request: typeof fetch;

  constructor(private readonly config: OpenAICompatibleUiTarsConfig) {
    if (!config.baseURL || !config.model) throw new Error("dedicated GUI grounding endpoint and model are required");
    this.request = config.fetch ?? globalThis.fetch;
  }

  async ground(task: VisualMicroTask, screenshot: Screenshot, tier: ModelTier): Promise<VisualAction> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 20_000);
    try {
      const modelVersion = this.config.uiTarsVersion ?? UITarsModelVersion.V1_5;
      const maxPixels = modelVersion === UITarsModelVersion.V1_5 ? 16384 * 28 * 28 : 2700 * 28 * 28;
      const image = await preprocessResizeImage(screenshot.base64, maxPixels);
      const response = await this.request(`${this.config.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
          ...this.config.headers
        },
        body: JSON.stringify({
          model: tier === "strong" ? this.config.strongModel ?? this.config.model : this.config.model,
          temperature: 0,
          top_p: 0.7,
          max_tokens: 900,
          stream: false,
          messages: [
            { role: "system", content: uiTarsMicroActionPrompt() },
            {
              role: "user",
              content: [
                { type: "text", text: JSON.stringify({
                  task_id: task.taskId,
                  step_id: task.stepId,
                  instruction: task.instruction,
                  target: task.target,
                  expected_result: task.expectedResult,
                  risk_level: task.riskLevel,
                  allowed_actions: task.allowedActions,
                  allowed_scroll_directions: task.allowedScrollDirections,
                  surface_fingerprint: surfaceFingerprintFor(screenshot),
                  screenshot: { width: screenshot.width, height: screenshot.height, scaleFactor: screenshot.scaleFactor }
                }) },
                { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }
              ]
            }
          ]
        })
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 500);
        throw new Error(`dedicated GUI grounding failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const body = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> };
      const prediction = openAIMessageText(body.choices?.[0]?.message?.content);
      if (!prediction) throw new Error("dedicated GUI grounding returned no prediction");
      if (this.config.protocol === "adpilot-json") {
        return normalizeJsonAction(VisualAction.parse(parseModelJson(prediction)), screenshot, this.config.coordinateFormat ?? "pixels");
      }
      const parsed = actionParser({
        prediction,
        factor: [1000, 1000],
        screenContext: { width: screenshot.width, height: screenshot.height },
        scaleFactor: screenshot.scaleFactor,
        modelVer: modelVersion
      }).parsed;
      if (parsed.length !== 1 || !parsed[0]) throw new Error("dedicated GUI grounding must return exactly one action");
      return mapGroundedAction(parsed[0], screenshot, task);
    } catch (error) {
      if (controller.signal.aborted) throw new VisualTimeoutError(`dedicated GUI grounding timed out after ${this.config.timeoutMs ?? 20_000}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeJsonAction(action: VisualAction, screenshot: Screenshot, format: "pixels" | "normalized" | "ui-tars-1000"): VisualAction {
  if (format === "pixels") return action;
  const factorX = format === "normalized" ? screenshot.width : screenshot.width / 1000;
  const factorY = format === "normalized" ? screenshot.height : screenshot.height / 1000;
  const scaled: Record<string, unknown> = { ...action };
  if ("x" in action && action.x !== undefined) scaled.x = action.x * factorX;
  if ("y" in action && action.y !== undefined) scaled.y = action.y * factorY;
  if (action.action === "drag") {
    scaled.end_x = action.end_x * factorX;
    scaled.end_y = action.end_y * factorY;
  }
  return VisualAction.parse(scaled);
}

/** Backward-compatible name for the dedicated provider. */
export class UiTarsGroundingModel extends OpenAICompatibleUiTarsProvider {}

export interface GuiGroundingRouteEvent {
  provider: string;
  kind: VisualGroundingProvider["kind"];
  tier: ModelTier;
  outcome: "selected" | "failed";
  error?: string;
}

/** Dedicated UI-TARS is always attempted first; PiVision is the bounded fallback. */
export class GuiGroundingProviderRouter implements GroundingModel {
  constructor(
    private readonly dedicated: VisualGroundingProvider | undefined,
    private readonly piVisionFallback: VisualGroundingProvider | undefined,
    private readonly onRoute: (event: GuiGroundingRouteEvent) => void | Promise<void> = () => undefined
  ) {}

  async ground(task: VisualMicroTask, screenshot: Screenshot, tier: ModelTier): Promise<VisualAction> {
    const providers = [this.dedicated, this.piVisionFallback].filter((provider): provider is VisualGroundingProvider => Boolean(provider));
    if (!providers.length) throw new Error("no GUI grounding provider is configured");
    const failures: string[] = [];
    for (const provider of providers) {
      try {
        const action = await provider.ground(task, screenshot, tier);
        await this.onRoute({ provider: provider.id, kind: provider.kind, tier, outcome: "selected" });
        return action;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${provider.id}: ${message}`);
        await this.onRoute({ provider: provider.id, kind: provider.kind, tier, outcome: "failed", error: message });
      }
    }
    throw new Error(`all GUI grounding providers failed (${failures.join("; ")})`);
  }
}

function uiTarsMicroActionPrompt(): string {
  return [
    "You are a short-horizon GUI grounding runtime. Return exactly one immediate visible action and never plan the overall task.",
    "Output exactly: Thought: <brief visible evidence>\\nAction: <one function call>.",
    "Allowed actions:",
    "click(start_box='[x1,y1,x2,y2]')",
    "left_double(start_box='[x1,y1,x2,y2]')",
    "right_single(start_box='[x1,y1,x2,y2]')",
    "mouse_move(start_box='[x1,y1,x2,y2]')",
    "drag(start_box='[x1,y1,x2,y2]', end_box='[x1,y1,x2,y2]')",
    "type(content='')",
    "hotkey(key='')",
    "scroll(start_box='[x1,y1,x2,y2]', direction='up or down')",
    "wait()",
    "finished()",
    "call_user()",
    "Coordinates use the model's UI-TARS coordinate space. Never emit multiple actions or guess an invisible target."
  ].join("\n");
}

function openAIMessageText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("\n").trim();
  return "";
}

/** Uses the same Pi code/reasoning models as chat for screenshot grounding and verification. */
export class PiVisionModel implements VisualGroundingProvider, VisualVerifier {
  readonly id = "pi-vision";
  readonly kind = "pi-vision" as const;
  constructor(
    private readonly models: Models,
    private readonly primary: Model<Api>,
    private readonly strong: Model<Api> = primary
  ) {
    if (!primary.input.includes("image")) throw new Error(`model does not accept screenshots: ${primary.provider}/${primary.id}`);
    if (!strong.input.includes("image")) throw new Error(`strong model does not accept screenshots: ${strong.provider}/${strong.id}`);
  }

  async ground(task: VisualMicroTask, screenshot: Screenshot, tier: ModelTier): Promise<VisualAction> {
    const model = tier === "strong" ? this.strong : this.primary;
    return this.completeStructured(VisualAction, model, this.strong, [
        "You are the visual grounding layer inside AdPilot. Inspect the screenshot and return exactly one immediate GUI micro-action as JSON.",
        "Never plan the overall task. Coordinates must be absolute screenshot pixels. Never infer hidden elements or credentials.",
        "Allowed actions: click, double_click, right_click, move, drag, type, hotkey, scroll, wait, screenshot, done, fail.",
        "Return keys required by the action plus target, reason, confidence, expected_result, risk_level. Do not wrap JSON in markdown."
      ].join("\n"), [{
        role: "user",
        content: [
          { type: "text", text: JSON.stringify({
            task_id: task.taskId,
            step_id: task.stepId,
            surface_fingerprint: surfaceFingerprintFor(screenshot),
            instruction: task.instruction,
            target: task.target,
            expectedResult: task.expectedResult,
            declaredRisk: task.riskLevel,
            allowedActions: task.allowedActions,
            allowedScrollDirections: task.allowedScrollDirections,
            screenshot: { width: screenshot.width, height: screenshot.height }
          }) },
          { type: "image", data: screenshot.base64, mimeType: "image/png" }
        ],
        timestamp: Date.now()
      }], "GROUNDING_FAILED", "GUI action");
  }

  async verify(expectedResult: string, before: Screenshot, after: Screenshot): Promise<{ matched: boolean; confidence: number; reason: string }> {
    return this.completeStructured(
      z.object({ matched: z.boolean(), confidence: z.number().min(0).max(1), reason: z.string().min(1) }),
      this.strong,
      this.strong,
      "Compare the before and after screenshots. Return JSON only with matched:boolean, confidence:number from 0 to 1, and reason:string. Judge only whether the stated expected result is visibly satisfied.", [{
        role: "user",
        content: [
          { type: "text", text: `Expected visible result: ${expectedResult}\nBEFORE:` },
          { type: "image", data: before.base64, mimeType: "image/png" },
          { type: "text", text: "AFTER:" },
          { type: "image", data: after.base64, mimeType: "image/png" }
        ],
        timestamp: Date.now()
      }], "VERIFICATION_FAILED", "visual verification");
  }

  private async completeStructured<S extends z.ZodTypeAny>(
    schema: S,
    primary: Model<Api>,
    strong: Model<Api>,
    systemPrompt: string,
    messages: Array<any>,
    blockerCode: "GROUNDING_FAILED" | "VERIFICATION_FAILED",
    label: string
  ): Promise<z.output<S>> {
    let response = await this.models.completeSimple(primary, { systemPrompt, messages }, { temperature: 0, maxTokens: 900, maxRetries: 1, timeoutMs: 20_000 });
    let invalid = assistantText(response);
    let issue = "invalid JSON";
    for (let pass = 1; pass <= 3; pass += 1) {
      try { return schema.parse(parseModelJson(invalid)); }
      catch (error) {
        issue = error instanceof Error ? error.message : String(error);
        if (pass === 3) break;
        const repairModel = pass === 1 ? primary : strong;
        response = await this.models.completeSimple(repairModel, {
          systemPrompt: `Repair one invalid ${label} JSON object. Return only a complete JSON object matching the requested schema; do not add markdown or commentary.`,
          messages: [{ role: "user", content: [{ type: "text", text: `Validation error:\n${issue}\n\nInvalid output:\n${invalid}` }], timestamp: Date.now() }]
        }, { temperature: 0, maxTokens: 900, maxRetries: 1, timeoutMs: 20_000 });
        invalid = assistantText(response);
      }
    }
    throw new VisualRuntimeBlocker(blockerCode, `${label} returned invalid structured output after three passes: ${issue}`);
  }
}

function assistantText(message: AssistantMessage): string {
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? "vision model failed");
  return message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
}

function parseModelJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("vision model did not return a JSON object");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function mapGroundedAction(parsed: { action_type: string; action_inputs: Record<string, unknown>; thought: string; reflection: string | null }, screenshot: Screenshot, task: VisualMicroTask): VisualAction {
  const typeMap: Record<string, VisualAction["action"]> = {
    left_click: "click", left_single: "click", click: "click",
    left_double: "double_click", double_click: "double_click",
    right_single: "right_click", right_click: "right_click",
    mouse_move: "move", hover: "move", drag: "drag", left_click_drag: "drag",
    type: "type", hotkey: "hotkey", scroll: "scroll", wait: "wait",
    finished: "done", call_user: "fail", error_env: "fail"
  };
  const action = typeMap[parsed.action_type];
  if (!action) throw new Error(`unsupported grounding action: ${parsed.action_type}`);
  const base = {
    action,
    target: task.target,
    reason: parsed.thought || parsed.reflection || "grounded visual action",
    confidence: 0.8,
    expected_result: task.expectedResult,
    risk_level: action === "done" || action === "fail" || action === "wait" ? "observe" as const : task.riskLevel
  };
  if (["click", "double_click", "right_click", "move", "drag"].includes(action)) {
    const point = parseBoxToScreenCoords({ boxStr: String(parsed.action_inputs.start_box ?? ""), screenWidth: screenshot.width, screenHeight: screenshot.height });
    if (point.x === null || point.y === null) throw new Error("grounding action has no coordinates");
    if (action === "drag") {
      const end = parseBoxToScreenCoords({ boxStr: String(parsed.action_inputs.end_box ?? ""), screenWidth: screenshot.width, screenHeight: screenshot.height });
      if (end.x === null || end.y === null) throw new Error("drag action has no destination");
      return VisualAction.parse({ ...base, x: point.x, y: point.y, end_x: end.x, end_y: end.y });
    }
    return VisualAction.parse({ ...base, x: point.x, y: point.y });
  }
  if (action === "type") return VisualAction.parse({ ...base, text: String(parsed.action_inputs.content ?? "") });
  if (action === "hotkey") return VisualAction.parse({ ...base, keys: String(parsed.action_inputs.key ?? parsed.action_inputs.hotkey ?? "") });
  if (action === "scroll") return VisualAction.parse({ ...base, direction: String(parsed.action_inputs.direction ?? "down").toLowerCase() });
  if (action === "wait") return VisualAction.parse({ ...base, milliseconds: 1000 });
  return VisualAction.parse(base);
}

export class ImageChangeVerifier implements VisualVerifier {
  async verify(expectedResult: string, before: Screenshot, after: Screenshot): Promise<{ matched: boolean; confidence: number; reason: string }> {
    const changed = before.sha256 !== after.sha256;
    return { matched: changed, confidence: changed ? 0.51 : 1, reason: changed ? `screen changed after: ${expectedResult}` : "screen did not change" };
  }
}

export class OpenAICompatibleVisualVerifier implements VisualVerifier {
  constructor(private readonly config: { apiKey?: string; baseURL: string; model: string; strongModel?: string; timeoutMs?: number; fetch?: typeof fetch }) {}

  async verify(expectedResult: string, before: Screenshot, after: Screenshot): Promise<{ matched: boolean; confidence: number; reason: string }> {
    const schema = z.object({ matched: z.boolean(), confidence: z.number().min(0).max(1), reason: z.string().min(1) });
    let invalid = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 20_000);
      try {
        const request = this.config.fetch ?? globalThis.fetch;
        const response = await request(`${this.config.baseURL.replace(/\/$/, "")}/chat/completions`, {
          method: "POST", signal: controller.signal,
          headers: { "content-type": "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
          body: JSON.stringify({
            model: attempt === 3 ? this.config.strongModel ?? this.config.model : this.config.model,
            temperature: 0, response_format: { type: "json_object" },
            messages: [{ role: "user", content: [
              { type: "text", text: `${attempt > 1 ? `Repair the invalid previous output (${invalid.slice(0, 400)}). ` : ""}Did the AFTER screenshot satisfy this expected result: ${expectedResult}? Return JSON only: {\"matched\":boolean,\"confidence\":number,\"reason\":string}.` },
              { type: "text", text: "BEFORE" }, { type: "image_url", image_url: { url: `data:image/png;base64,${before.base64}` } },
              { type: "text", text: "AFTER" }, { type: "image_url", image_url: { url: `data:image/png;base64,${after.base64}` } }
            ] }]
          })
        });
        if (!response.ok) throw new Error(`visual verification failed: HTTP ${response.status}`);
        const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        invalid = body.choices?.[0]?.message?.content ?? "";
        try { return schema.parse(parseModelJson(invalid)); }
        catch (error) { if (attempt === 3) throw new VisualRuntimeBlocker("VERIFICATION_FAILED", `visual verifier returned invalid structured output after recovery: ${error instanceof Error ? error.message : String(error)}`); }
      } finally { clearTimeout(timeout); }
    }
    throw new VisualRuntimeBlocker("VERIFICATION_FAILED", "visual verifier recovery exhausted");
  }
}

export function assertScreenshotOutput(value: ScreenshotOutput): ScreenshotOutput {
  if (!value.base64 || !Number.isFinite(value.scaleFactor) || value.scaleFactor <= 0) throw new Error("invalid native screenshot");
  return value;
}
