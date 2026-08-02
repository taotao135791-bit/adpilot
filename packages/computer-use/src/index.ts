import { createHash, randomUUID } from "node:crypto";
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
import {
  BrowserPageIdentityChangedError,
  BrowserPageIdentityUnavailableError
} from "./browser-page-identity.js";
import {
  ComputerActionRecord,
  VerificationResult,
  type ComputerAction as ComputerActionValue,
  type ComputerActionRecord as ComputerActionRecordValue
} from "./protocol.js";
import type { ComputerActionRecordStore } from "./runtime.js";
import type { MutationReplayStore } from "./replay.js";

export * from "./surface.js";
export * from "./browser-page-identity.js";
export * from "./browser-session.js";
export * from "./privacy.js";
export * from "./account-fingerprint.js";
export * from "./protocol.js";
export * from "./control-state.js";
export * from "./replay.js";
export * from "./runtime.js";
export * from "./action-record-store.js";
export * from "./native-helper-operator.js";

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
  /** Fresh canonical address-bar URL. Never populated from a launch/start URL. */
  url?: string;
  /** Fresh HTTP(S) origin derived from the address-bar URL. */
  origin?: string;
  /** Informational title from the exact native/Accessibility window. */
  pageTitle?: string;
  /** User-facing Profile binding used to locate the managed session. */
  browserProfile?: string;
  /** Non-reversible proof read from the native browser process command line. */
  nativeProfileFingerprint?: string;
  allowedApps: string[];
  allowedDomains: string[];
}

export interface VisualMicroTask {
  clientId?: string;
  /** Durable AdPilot product Session. This is intentionally not the task id. */
  adPilotSessionId?: string;
  /** Exact managed browser Session used by this Computer Use task. */
  browserSessionId?: string;
  taskId?: string;
  stepId?: string;
  planId?: string;
  /** Exact persisted approval consumed for a mutation task. */
  approvalId?: string;
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
  /** When typing is permitted, the only exact text payload the native operator may receive. */
  allowedText?: string;
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
  capture(task?: VisualMicroTask): Promise<Screenshot>;
  execute(action: VisualAction, screenshot: Screenshot, task?: VisualMicroTask, signal?: AbortSignal): Promise<void>;
  identifySurface?(task?: VisualMicroTask): Promise<{ surface: NativeSurface; fingerprint: string }>;
  /** Cancel only input that has not yet been posted to the operating system. */
  cancelPendingInput?(session?: VisualComputerSessionBinding): void | Promise<void>;
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
  "BROWSER_PAGE_IDENTITY_UNAVAILABLE",
  "BROWSER_PAGE_IDENTITY_CHANGED",
  "DUPLICATE_COORDINATE",
  "MUTATION_RETRY_FORBIDDEN",
  "TIMEOUT",
  "POLICY_BLOCKED",
  "GROUNDING_FAILED",
  "VERIFICATION_FAILED",
  "CANCELLED",
  "PAUSED",
  "USER_TAKEOVER",
  "DUPLICATE_MUTATION"
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

export interface VisualPersistenceVerification {
  verified: true;
  refreshedFrameSha256: string;
  exactValue: string | number | boolean | null;
  identityMatch: true;
  accountId: string;
  campaignId: string;
  verifiedAt: string;
  evidenceIds: string[];
}

export type VisualStepResult =
  | {
      status: "done";
      attempts: number;
      action: VisualAction;
      before: Screenshot;
      after: Screenshot;
      /** True only after NativeOperator.execute returned successfully. */
      executed: boolean;
      /** True only after the independent post-action verifier matched. */
      verified: boolean;
      actionRecordId?: string;
      persistenceVerification?: VisualPersistenceVerification;
    }
  | {
      status: "failed";
      attempts: number;
      blocker: string;
      blockerCode?: VisualBlockerCode;
      lastAction?: VisualAction;
      actionRecordId?: string;
    };

export class VisualPolicy {
  check(action: VisualAction, screenshot: Screenshot, task: VisualMicroTask): void {
    this.checkSurface(task.surface);
    if (task.allowedActions && !task.allowedActions.includes(action.action)) {
      throw new Error(`action ${action.action} is outside this micro-task allowlist`);
    }
    if (action.action === "type" && task.allowedText !== undefined && action.text !== task.allowedText) {
      throw new Error("typed text differs from this micro-task's exact allowlist");
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
    if (permissionRank[permission] < permissionRank.MUTATE && action.action === "type" && /[\r\n\t]/.test(action.text)) {
      throw new Error("non-mutation typing cannot contain Enter, Return, or Tab characters");
    }
    if (permissionRank[permission] < permissionRank.MUTATE && action.action === "hotkey" && /(?:enter|return)/i.test(action.keys)) {
      throw new Error("Enter and Return require an approved mutation plan");
    }
    if (permissionRank[permission] < permissionRank.MUTATE && !["done", "fail", "screenshot", "wait", "move", "type", "hotkey", "scroll"].includes(action.action)
      && mutationControlTarget(action.target)) {
      throw new Error("mutation controls require an approved mutation plan");
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

export type VisualRuntimeStatus = "running" | "paused" | "cancelled";
export type VisualControlStatus = VisualRuntimeStatus | "user_control";

export interface VisualComputerSessionBinding {
  adPilotSessionId: string;
  browserSessionId: string;
}

export interface VisualComputerControlSnapshot extends VisualComputerSessionBinding {
  computerSessionId: string;
  revision: number;
  controlState: VisualControlStatus;
  executionStatus: VisualRuntimeStatus;
}

export interface FinalizeVisualActionRecordInput {
  binding: VisualComputerSessionBinding;
  persistenceVerification: VisualPersistenceVerification;
  expectedUiEvidence: string[];
  exactValueEvidence: string[];
  independentVerifier: string;
  reason: string;
}

export class VisualControlRevisionError extends Error {
  readonly code = "COMPUTER_CONTROL_REVISION_CONFLICT" as const;

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
    readonly computerSessionId: string
  ) {
    super(`Computer Session revision changed (${expectedRevision} -> ${actualRevision})`);
    this.name = "VisualControlRevisionError";
  }
}

export class VisualComputerSessionNotFoundError extends Error {
  readonly code = "COMPUTER_SESSION_NOT_FOUND" as const;

  constructor(readonly computerSessionId: string) {
    super(`Computer Session is not active: ${computerSessionId}`);
    this.name = "VisualComputerSessionNotFoundError";
  }
}

type VisualSessionState = {
  binding: VisualComputerSessionBinding;
  computerSessionId: string;
  control: VisualControlStatus;
  controlRevision: number;
  requiresFreshCapture: boolean;
  activeControllers: Set<AbortController>;
  attemptedMutationPlans: Set<string>;
  recordSessionId: string;
};

const LEGACY_VISUAL_SESSION_BINDING: VisualComputerSessionBinding = {
  adPilotSessionId: "legacy-product-session",
  browserSessionId: "legacy-browser-session"
};

export function visualComputerSessionId(binding: VisualComputerSessionBinding): string {
  const parsed = parseVisualComputerSessionBinding(binding);
  return `computer_${createHash("sha256")
    .update(`${parsed.adPilotSessionId}\u0000${parsed.browserSessionId}`)
    .digest("hex")
    .slice(0, 40)}`;
}

export class VisualComputerRuntime {
  private readonly sessions = new Map<string, VisualSessionState>();

  constructor(
    private readonly operator: NativeOperator,
    private readonly grounding: GroundingModel,
    private readonly verifier: VisualVerifier,
    private readonly policy = new VisualPolicy(),
    private readonly onEvent: (event: VisualRuntimeEvent) => void | Promise<void> = () => undefined,
    private readonly stepTimeoutMs = 20_000,
    private readonly maxAttempts = 3,
    private readonly actionRecords?: ComputerActionRecordStore,
    private readonly mutationReplay?: MutationReplayStore
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("visual max attempts must be between 1 and 3");
  }

  /**
   * Backward-compatible UI status. User control is intentionally rendered as
   * paused to old clients, while controlStatus() exposes the real owner.
   */
  executionStatus(): VisualRuntimeStatus {
    return this.executionStatusFor();
  }

  executionStatusFor(selector?: VisualComputerSessionBinding | string): VisualRuntimeStatus {
    const control = this.sessionForSelector(selector).control;
    if (control === "cancelled") return "cancelled";
    return control === "running" ? "running" : "paused";
  }

  controlStatus(selector?: VisualComputerSessionBinding | string): VisualControlStatus {
    return this.sessionForSelector(selector).control;
  }

  controlSnapshot(selector?: VisualComputerSessionBinding | string): VisualComputerControlSnapshot {
    return this.snapshot(this.sessionForSelector(selector));
  }

  listControlSnapshots(): VisualComputerControlSnapshot[] {
    return [...this.sessions.values()].map((state) => this.snapshot(state));
  }

  async getActionRecord(actionId: string): Promise<ComputerActionRecordValue | undefined> {
    return this.actionRecords?.get(actionId);
  }

  async listActionRecords(selector: VisualComputerSessionBinding | string): Promise<ComputerActionRecordValue[]> {
    if (!this.actionRecords) return [];
    return this.actionRecords.list(this.sessionForSelector(selector).recordSessionId);
  }

  async finalizeActionRecord(
    actionId: string,
    input: FinalizeVisualActionRecordInput
  ): Promise<ComputerActionRecordValue> {
    if (!this.actionRecords) throw new Error("persistent Computer Action records are unavailable");
    const record = await this.actionRecords.get(actionId);
    if (!record) throw new Error(`Computer Action record does not exist: ${actionId}`);
    const binding = parseVisualComputerSessionBinding(input.binding);
    if (
      record.binding?.adPilotSessionId !== binding.adPilotSessionId
      || record.binding.browserSessionId !== binding.browserSessionId
    ) {
      throw new Error("Computer Action record belongs to another Product+Browser session");
    }
    const persistence = input.persistenceVerification;
    const verificationResult = VerificationResult.parse({
      actionId: record.id,
      sessionId: record.sessionId,
      status: "passed",
      levels: [
        {
          level: 1,
          status: "passed",
          evidence: ["native-action-record", record.id],
          reason: "the atomic native action returned and was recorded"
        },
        {
          level: 2,
          status: "passed",
          evidence: input.expectedUiEvidence,
          reason: "the immediate expected UI state matched"
        },
        {
          level: 3,
          status: "passed",
          evidence: input.exactValueEvidence,
          reason: "two independent reviewers read the exact approved target value"
        },
        {
          level: 4,
          status: "passed",
          evidence: [
            `frame:${persistence.refreshedFrameSha256}`,
            ...persistence.evidenceIds
          ],
          reason: "the exact value survived a safe refresh/re-entry and fresh capture"
        },
        {
          level: 5,
          status: "passed",
          evidence: [
            `account:${persistence.accountId}`,
            `campaign:${persistence.campaignId}`,
            ...persistence.evidenceIds
          ],
          reason: "the Product, browser, account, Campaign, app, and window identity remained exact"
        }
      ],
      exactValueMatch: true,
      persistedAfterRefresh: true,
      identityMatch: true,
      independentVerifier: input.independentVerifier,
      verifiedAt: persistence.verifiedAt,
      reason: input.reason
    });
    const finalized = ComputerActionRecord.parse({ ...record, verificationResult });
    await this.actionRecords.save(finalized);
    return finalized;
  }

  ensureControlSession(binding: VisualComputerSessionBinding): VisualComputerControlSnapshot {
    return this.snapshot(this.sessionForBinding(binding));
  }

  pause(selector?: VisualComputerSessionBinding | string, expectedRevision?: number): void {
    const state = this.sessionForSelector(selector);
    this.assertExpectedRevision(state, expectedRevision);
    if (state.control === "cancelled" || state.control === "paused") return;
    this.setControl(state, "paused", "paused by user");
  }

  resume(selector?: VisualComputerSessionBinding | string, expectedRevision?: number): void {
    const state = this.sessionForSelector(selector);
    this.assertExpectedRevision(state, expectedRevision);
    if (state.control !== "paused") return;
    this.setControl(state, "running", "agent resumed");
  }

  takeover(selector?: VisualComputerSessionBinding | string, expectedRevision?: number): void {
    const state = this.sessionForSelector(selector);
    this.assertExpectedRevision(state, expectedRevision);
    if (state.control === "cancelled" || state.control === "user_control") return;
    this.setControl(state, "user_control", "user took control");
  }

  returnControl(selector?: VisualComputerSessionBinding | string, expectedRevision?: number): void {
    const state = this.sessionForSelector(selector);
    this.assertExpectedRevision(state, expectedRevision);
    if (state.control !== "user_control") return;
    this.setControl(state, "running", "user returned control");
  }

  notifyUserInput(selector?: VisualComputerSessionBinding | string): void {
    this.takeover(selector);
  }

  cancel(selector?: VisualComputerSessionBinding | string, expectedRevision?: number): void {
    const state = this.sessionForSelector(selector);
    this.assertExpectedRevision(state, expectedRevision);
    if (state.control === "cancelled") return;
    this.setControl(state, "cancelled", "user cancelled");
  }

  stop(selector?: VisualComputerSessionBinding | string, expectedRevision?: number): void {
    this.cancel(selector, expectedRevision);
  }

  /** Resolve the live execution surface through the same native operator used for actions. */
  async identifySurface(task?: VisualMicroTask): Promise<{ surface?: NativeSurface; fingerprint: string }> {
    const state = this.sessionForTask(task);
    this.assertAgentControl(state);
    if (task && this.operator.bindTask) await this.operator.bindTask(task);
    if (this.operator.identifySurface) return this.operator.identifySurface(task);
    const screenshot = await withTimeout(this.operator.capture(task), this.stepTimeoutMs, "surface identity");
    return {
      ...(screenshot.surface ? { surface: screenshot.surface } : {}),
      fingerprint: surfaceFingerprintFor(screenshot)
    };
  }

  /** Read-only verifier preflight used before consuming a mutation approval. */
  async verifyVisible(expectedResult: string, task?: VisualMicroTask): Promise<{ matched: boolean; confidence: number; reason: string; screenshot: Screenshot }> {
    const state = this.sessionForTask(task);
    this.assertAgentControl(state);
    if (task && this.operator.bindTask) await this.operator.bindTask(task);
    const screenshot = await withTimeout(this.operator.capture(task), this.stepTimeoutMs, "verification preflight screenshot");
    await this.onEvent(scopeVisualRuntimeEvent({ type: "screenshot", phase: "before", screenshot }, task));
    this.assertAgentControl(state);
    const result = await withTimeout(this.verifier.verify(expectedResult, screenshot, screenshot, task), this.stepTimeoutMs, "verification preflight");
    this.assertAgentControl(state);
    await this.onEvent(scopeVisualRuntimeEvent({ type: "verified", attempt: 0, ...result }, task));
    return { ...result, screenshot };
  }

  /** Capture one current native window after applying the task/session binding. */
  async captureForTask(task: VisualMicroTask): Promise<Screenshot> {
    const state = this.sessionForTask(task);
    this.assertAgentControl(state);
    if (this.operator.bindTask) await this.operator.bindTask(task);
    const screenshot = await withTimeout(this.operator.capture(task), this.stepTimeoutMs, "task-bound screenshot capture");
    this.assertAgentControl(state);
    await this.onEvent(scopeVisualRuntimeEvent({ type: "screenshot", phase: "before", screenshot }, task));
    return screenshot;
  }

  /**
   * Deterministic, non-mutating browser refresh used only to prove that an
   * approved value survives re-entry. It stays on the exact Product+Browser
   * session and exact native window, then returns a forced fresh capture.
   */
  async refreshForPersistence(task: VisualMicroTask, settleMs = 1_200): Promise<Screenshot> {
    if (!Number.isInteger(settleMs) || settleMs < 100 || settleMs > 10_000) {
      throw new Error("persistence refresh settle time must be 100-10000ms");
    }
    const state = this.sessionForTask(task);
    this.assertAgentControl(state);
    const revision = state.controlRevision;
    const controller = new AbortController();
    state.activeControllers.add(controller);
    let persistedRecord: ComputerActionRecordValue | undefined;
    let nativeExecutionStarted = false;
    try {
      const taskId = task.taskId ?? stableId("task", task.instruction, task.target);
      const stepId = stableId("refresh-step", task.stepId ?? taskId, String(Date.now()));
      const planId = task.planId ?? stableId("refresh-plan", taskId);
      const refreshTask: VisualMicroTask & { taskId: string; stepId: string; planId: string } = {
        ...task,
        taskId,
        stepId,
        planId,
        instruction: "Refresh the exact managed browser page once, then wait for it to settle",
        target: "managed browser page refresh",
        expectedResult: "the exact bound page reloads without changing account or Campaign identity",
        riskLevel: "interact",
        permission: "INTERACT",
        allowedActions: ["hotkey"],
        retryPolicy: "none"
      };
      if (this.operator.bindTask) await this.operator.bindTask(refreshTask);
      const before = await withTimeout(
        this.operator.capture(refreshTask),
        this.stepTimeoutMs,
        "persistence refresh before-frame",
        controller.signal
      );
      this.assertRunControl(state, revision, controller.signal);
      const expectedFingerprint = surfaceFingerprintFor(before);
      const action = bindActionContext({
        action: "hotkey",
        keys: "CMD+R",
        target: refreshTask.target,
        reason: "deterministic safe browser refresh",
        confidence: 1,
        expected_result: refreshTask.expectedResult,
        risk_level: "interact"
      }, refreshTask, before, expectedFingerprint);
      this.policy.check(action, before, refreshTask);
      await this.assertSurfaceUnchanged(expectedFingerprint, refreshTask, controller.signal);
      this.assertRunControl(state, revision, controller.signal);
      if (this.actionRecords) {
        persistedRecord = legacyActionRecord(
          randomUUID(),
          state,
          refreshTask,
          before,
          expectedFingerprint,
          { kind: "keypress", keys: ["CMD", "R"] }
        );
        await this.actionRecords.save(persistedRecord);
      }
      nativeExecutionStarted = true;
      await withTimeout(
        this.operator.execute(action, before, refreshTask, controller.signal),
        this.stepTimeoutMs,
        "persistence browser refresh",
        controller.signal
      );
      this.assertRunControl(state, revision, controller.signal);
      if (persistedRecord) {
        persistedRecord = ComputerActionRecord.parse({
          ...persistedRecord,
          completedAt: new Date().toISOString(),
          executionResult: { status: "posted", purpose: "persistence_refresh" },
          userTookOver: false
        });
        await this.actionRecords!.save(persistedRecord);
      }
      await abortableDelay(settleMs, controller.signal);
      this.assertRunControl(state, revision, controller.signal);
      const after = await withTimeout(
        this.operator.capture(refreshTask),
        this.stepTimeoutMs,
        "persistence refresh fresh capture",
        controller.signal
      );
      this.assertRunControl(state, revision, controller.signal);
      const afterFingerprint = surfaceFingerprintFor(after);
      if (
        afterFingerprint !== expectedFingerprint
        && !(before.surface && after.surface && sameNativeWindow(before.surface, after.surface))
      ) {
        throw new SurfaceChangedBlocker(expectedFingerprint, afterFingerprint);
      }
      if (persistedRecord) {
        persistedRecord = ComputerActionRecord.parse({
          ...persistedRecord,
          afterFrameId: randomUUID(),
          executionResult: {
            status: "posted",
            purpose: "persistence_refresh",
            afterFrameSha256: after.sha256,
            afterSurfaceFingerprint: afterFingerprint
          }
        });
        await this.actionRecords!.save(persistedRecord);
      }
      return after;
    } catch (error) {
      if (persistedRecord) {
        const failed = ComputerActionRecord.parse({
          ...persistedRecord,
          completedAt: persistedRecord.completedAt ?? new Date().toISOString(),
          executionResult: {
            status: nativeExecutionStarted ? "unknown" : "blocked",
            purpose: "persistence_refresh",
            reason: error instanceof Error ? error.message : String(error)
          },
          userTookOver: state.control === "user_control"
        });
        await this.actionRecords!.save(failed).catch(() => undefined);
      }
      throw error;
    } finally {
      state.activeControllers.delete(controller);
    }
  }

  async runMicroTask(
    task: VisualMicroTask,
    initialScreenshot?: Screenshot,
    constraintInput?: VisualExecutionConstraints,
    externalSignal?: AbortSignal
  ): Promise<VisualStepResult> {
    const state = this.sessionForTask(task);
    const unavailable = this.controlFailure(state, 0);
    if (unavailable) return unavailable;
    const revision = state.controlRevision;
    const controller = new AbortController();
    const stopFromParent = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) stopFromParent();
    else externalSignal?.addEventListener("abort", stopFromParent, { once: true });
    state.activeControllers.add(controller);
    try {
      return await this.runControlledMicroTask(state, task, initialScreenshot, constraintInput, revision, controller.signal);
    } finally {
      externalSignal?.removeEventListener("abort", stopFromParent);
      state.activeControllers.delete(controller);
    }
  }

  private async runControlledMicroTask(
    state: VisualSessionState,
    task: VisualMicroTask,
    initialScreenshot: Screenshot | undefined,
    constraintInput: VisualExecutionConstraints | undefined,
    revision: number,
    signal: AbortSignal
  ): Promise<VisualStepResult> {
    const constraints = constraintInput ? VisualExecutionConstraints.parse(constraintInput) : undefined;
    let lastAction: VisualAction | undefined;
    const executedCoordinates = new Set<string>();
    let mutationAttempted = false;
    const taskId = task.taskId ?? stableId("task", task.instruction, task.target);
    const stepId = task.stepId ?? stableId("step", taskId, task.expectedResult);
    const planId = task.planId ?? stableId("plan", taskId, task.instruction, task.target, task.expectedResult);
    const boundTask = { ...task, taskId, stepId, planId };
    const attemptLimit = task.retryPolicy === "none" ? 1 : this.maxAttempts;
    if (this.operator.bindTask) await this.operator.bindTask(boundTask);
    this.assertRunControl(state, revision, signal);
    const allowInitialScreenshot = !state.requiresFreshCapture;
    state.requiresFreshCapture = false;
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      const unavailable = this.controlFailure(state, attempt - 1, lastAction);
      if (unavailable) return unavailable;
      if (mutationAttempted) {
        return failedResult(attempt - 1, "mutating actions are never retried after native execution was attempted", "MUTATION_RETRY_FORBIDDEN", lastAction);
      }
      const tier: ModelTier = task.retryPolicy === "none" ? "gui" : attempt >= attemptLimit ? "strong" : "gui";
      let persistedRecord: ComputerActionRecordValue | undefined;
      let nativeExecutionStarted = false;
      try {
        const before = attempt === 1 && initialScreenshot && allowInitialScreenshot
          ? Screenshot.parse(initialScreenshot)
          : await withTimeout(this.operator.capture(boundTask), this.stepTimeoutMs, "screenshot capture", signal);
        this.assertRunControl(state, revision, signal);
        await this.onEvent(scopeVisualRuntimeEvent({ type: "screenshot", phase: "before", screenshot: before }, boundTask));
        this.assertRunControl(state, revision, signal);
        const expectedFingerprint = surfaceFingerprintFor(before);
        const grounded = await withTimeout(
          this.grounding.ground(boundTask, before, tier),
          this.stepTimeoutMs,
          "visual grounding",
          signal
        );
        this.assertRunControl(state, revision, signal);
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
        this.assertRunControl(state, revision, signal);
        if (action.action === "fail") return { status: "failed", attempts: attempt, blocker: action.reason, lastAction: action };
        if (action.action === "done") {
          if (boundTask.riskLevel === "mutate" || boundTask.riskLevel === "destructive") {
            return failedResult(
              attempt,
              "a mutation cannot complete without a native action and independent post-action verification",
              "POLICY_BLOCKED",
              action
            );
          }
          return { status: "done", attempts: attempt, action, before, after: before, executed: false, verified: false };
        }

        const coordinateKey = actionCoordinateKey(action);
        if (coordinateKey && executedCoordinates.has(coordinateKey)) {
          throw new VisualRuntimeBlocker("DUPLICATE_COORDINATE", `refusing to repeat coordinates for ${action.action}: ${coordinateKey}`);
        }
        await this.assertSurfaceUnchanged(expectedFingerprint, boundTask, signal);
        this.assertRunControl(state, revision, signal);
        const mutation = action.risk_level === "mutate" || action.risk_level === "destructive";
        const computerAction = computerActionFromVisual(action, before);
        const actionRecordId = computerAction ? randomUUID() : undefined;
        if (mutation) {
          const immediate = await withTimeout(
            this.operator.capture(boundTask),
            this.stepTimeoutMs,
            "mutation state recheck",
            signal
          );
          this.assertRunControl(state, revision, signal);
          if (immediate.sha256 !== before.sha256 || surfaceFingerprintFor(immediate) !== expectedFingerprint) {
            throw new VisualRuntimeBlocker("SURFACE_CHANGED", "pixels or surface identity changed after grounding; a new approval plan is required");
          }
          if (state.attemptedMutationPlans.has(planId)) {
            throw new VisualRuntimeBlocker("DUPLICATE_MUTATION", "this mutation plan already attempted native input and cannot be replayed");
          }
        }
        if (coordinateKey) executedCoordinates.add(coordinateKey);
        this.assertRunControl(state, revision, signal);
        if (mutation) {
          // Claim before invoking the operator. A thrown error or timeout cannot
          // prove that native input was not posted.
          state.attemptedMutationPlans.add(planId);
          mutationAttempted = true;
          if (this.mutationReplay) {
            if (!boundTask.approvalId) {
              throw new VisualRuntimeBlocker(
                "POLICY_BLOCKED",
                "production mutation replay protection requires an exact approval id"
              );
            }
            const claimed = await this.mutationReplay.claim({
              mutationKey: createHash("sha256")
                .update(`${state.computerSessionId}\u0000${boundTask.approvalId}\u0000${planId}`)
                .digest("hex"),
              sessionId: state.recordSessionId,
              actionId: actionRecordId ?? randomUUID(),
              approvalId: boundTask.approvalId,
              claimedAt: new Date().toISOString()
            });
            if (!claimed) {
              throw new VisualRuntimeBlocker(
                "DUPLICATE_MUTATION",
                "this approved mutation was already attempted and cannot be replayed after restart"
              );
            }
          }
        }
        if (computerAction && actionRecordId && this.actionRecords) {
          persistedRecord = legacyActionRecord(
            actionRecordId,
            state,
            boundTask,
            before,
            expectedFingerprint,
            computerAction
          );
          await this.actionRecords.save(persistedRecord);
        }
        nativeExecutionStarted = true;
        await withTimeout(
          this.operator.execute(action, before, boundTask, signal),
          this.stepTimeoutMs,
          "native action",
          signal
        );
        this.assertRunControl(state, revision, signal);
        if (persistedRecord) {
          persistedRecord = ComputerActionRecord.parse({
            ...persistedRecord,
            completedAt: new Date().toISOString(),
            executionResult: { status: "posted" },
            userTookOver: false
          });
          await this.actionRecords!.save(persistedRecord);
        }
        await this.onEvent(scopeVisualRuntimeEvent({ type: "executed", attempt, action }, boundTask));
        this.assertRunControl(state, revision, signal);
        const after = await withTimeout(
          this.operator.capture(boundTask),
          this.stepTimeoutMs,
          "verification screenshot",
          signal
        );
        this.assertRunControl(state, revision, signal);
        await this.onEvent(scopeVisualRuntimeEvent({ type: "screenshot", phase: "after", screenshot: after }, boundTask));
        this.assertRunControl(state, revision, signal);
        const afterFingerprint = surfaceFingerprintFor(after);
        const afterFrameId = persistedRecord ? randomUUID() : undefined;
        if (afterFingerprint !== expectedFingerprint && !(before.surface && after.surface && sameNativeWindow(before.surface, after.surface))) {
          throw new SurfaceChangedBlocker(expectedFingerprint, afterFingerprint);
        }
        const verified = await withTimeout(
          this.verifier.verify(action.expected_result, before, after, boundTask),
          this.stepTimeoutMs,
          "visual verification",
          signal
        );
        this.assertRunControl(state, revision, signal);
        if (persistedRecord && afterFrameId) {
          persistedRecord = ComputerActionRecord.parse({
            ...persistedRecord,
            afterFrameId,
            executionResult: {
              status: "posted",
              afterFrameSha256: after.sha256,
              afterSurfaceFingerprint: afterFingerprint
            },
            verificationResult: legacyVerificationResult(
              persistedRecord.id,
              persistedRecord.sessionId,
              verified,
              expectedFingerprint === afterFingerprint
                || Boolean(before.surface && after.surface && sameNativeWindow(before.surface, after.surface))
            )
          });
          await this.actionRecords!.save(persistedRecord);
        }
        await this.onEvent(scopeVisualRuntimeEvent({ type: "verified", attempt, ...verified }, boundTask));
        if (verified.matched) {
          return {
            status: "done",
            attempts: attempt,
            action,
            before,
            after,
            executed: true,
            verified: true,
            ...(persistedRecord ? { actionRecordId: persistedRecord.id } : {})
          };
        }
        if (mutationAttempted) {
          return failedResult(attempt, `mutation was executed but could not be visually verified: ${verified.reason}`, "MUTATION_RETRY_FORBIDDEN", action);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (persistedRecord && !persistedRecord.verificationResult) {
          persistedRecord = ComputerActionRecord.parse({
            ...persistedRecord,
            completedAt: persistedRecord.completedAt ?? new Date().toISOString(),
            executionResult: {
              status: nativeExecutionStarted ? "unknown" : "blocked",
              reason
            },
            userTookOver: state.control === "user_control"
          });
          await this.actionRecords!.save(persistedRecord).catch(() => undefined);
        }
        const code = blockerCode(error);
        await this.onEvent(scopeVisualRuntimeEvent({ type: "blocked", attempt, reason, ...(code ? { code } : {}) }, boundTask));
        if (error instanceof VisualControlInterruptedError) {
          if (mutationAttempted) {
            return failedResult(attempt, `${reason}; mutation outcome is unknown and will not be retried`, "MUTATION_RETRY_FORBIDDEN", lastAction);
          }
          return this.controlFailure(state, attempt, lastAction)
            ?? failedResult(attempt, reason, "PAUSED", lastAction);
        }
        if (error instanceof SurfaceCaptureChangedError || error instanceof NativeSurfaceUnavailableError) {
          return failedResult(attempt, reason, "SURFACE_CHANGED", lastAction);
        }
        if (error instanceof BrowserSessionLostError) {
          return failedResult(attempt, reason, "BROWSER_SESSION_LOST", lastAction);
        }
        if (error instanceof VisualRuntimeBlocker) {
          return failedResult(attempt, reason, error.code, lastAction);
        }
        if (mutationAttempted) {
          return failedResult(attempt, `${reason}; mutation outcome is unknown and will not be retried`, "MUTATION_RETRY_FORBIDDEN", lastAction);
        }
        if (error instanceof VisualTimeoutError) {
          return failedResult(attempt, `${reason}; stopped to avoid a duplicate or blind action`, "TIMEOUT", lastAction);
        }
      }
    }
    return failedResult(attemptLimit, `visual action failed ${attemptLimit} time${attemptLimit === 1 ? "" : "s"}; blind operation stopped`, "VERIFICATION_FAILED", lastAction);
  }

  private async assertSurfaceUnchanged(
    expectedFingerprint: string,
    task: VisualMicroTask,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.operator.identifySurface) return;
    const current = await withTimeout(
      this.operator.identifySurface(task),
      this.stepTimeoutMs,
      "surface identity",
      signal
    );
    if (current.fingerprint !== expectedFingerprint) throw new SurfaceChangedBlocker(expectedFingerprint, current.fingerprint);
  }

  private assertAgentControl(state: VisualSessionState): void {
    if (state.control !== "running") throw new VisualControlInterruptedError();
  }

  private assertRunControl(state: VisualSessionState, revision: number, signal: AbortSignal): void {
    if (signal.aborted || state.control !== "running" || revision !== state.controlRevision) {
      throw new VisualControlInterruptedError();
    }
  }

  private controlFailure(state: VisualSessionState, attempts: number, lastAction?: VisualAction): VisualStepResult | undefined {
    if (state.control === "cancelled") return failedResult(attempts, "user cancelled", "CANCELLED", lastAction);
    if (state.control === "user_control") return failedResult(attempts, "user took control", "USER_TAKEOVER", lastAction);
    if (state.control === "paused") return failedResult(attempts, "paused by user", "PAUSED", lastAction);
    return undefined;
  }

  private setControl(state: VisualSessionState, next: VisualControlStatus, reason: string): void {
    state.control = next;
    state.controlRevision += 1;
    state.requiresFreshCapture = true;
    for (const controller of state.activeControllers) controller.abort(reason);
    state.activeControllers.clear();
    try {
      const pending = this.operator.cancelPendingInput?.(state.binding);
      if (pending && typeof (pending as Promise<void>).catch === "function") {
        void (pending as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Control authority changes before best-effort native queue cleanup.
    }
  }

  private sessionForTask(task?: VisualMicroTask): VisualSessionState {
    return task ? this.sessionForBinding(visualComputerBindingFromTask(task)) : this.sessionForBinding(LEGACY_VISUAL_SESSION_BINDING);
  }

  private sessionForBinding(binding: VisualComputerSessionBinding): VisualSessionState {
    const parsed = parseVisualComputerSessionBinding(binding);
    const computerSessionId = visualComputerSessionId(parsed);
    const existing = this.sessions.get(computerSessionId);
    if (existing) return existing;
    const state: VisualSessionState = {
      binding: parsed,
      computerSessionId,
      control: "running",
      controlRevision: 0,
      requiresFreshCapture: false,
      activeControllers: new Set(),
      attemptedMutationPlans: new Set(),
      recordSessionId: randomUUID()
    };
    this.sessions.set(computerSessionId, state);
    return state;
  }

  private sessionForSelector(selector?: VisualComputerSessionBinding | string): VisualSessionState {
    if (!selector) return this.sessionForBinding(LEGACY_VISUAL_SESSION_BINDING);
    if (typeof selector !== "string") return this.sessionForBinding(selector);
    const state = this.sessions.get(selector);
    if (!state) throw new VisualComputerSessionNotFoundError(selector);
    return state;
  }

  private assertExpectedRevision(state: VisualSessionState, expectedRevision?: number): void {
    if (expectedRevision !== undefined && expectedRevision !== state.controlRevision) {
      throw new VisualControlRevisionError(expectedRevision, state.controlRevision, state.computerSessionId);
    }
  }

  private snapshot(state: VisualSessionState): VisualComputerControlSnapshot {
    return {
      ...state.binding,
      computerSessionId: state.computerSessionId,
      revision: state.controlRevision,
      controlState: state.control,
      executionStatus: state.control === "cancelled" ? "cancelled" : state.control === "running" ? "running" : "paused"
    };
  }
}

class VisualTimeoutError extends Error {}

class VisualControlInterruptedError extends Error {
  constructor() {
    super("Computer Use control changed while an operation was in flight");
    this.name = "VisualControlInterruptedError";
  }
}

function scopeVisualRuntimeEvent(event: VisualRuntimeEventPayload, task?: VisualMicroTask): VisualRuntimeEvent {
  return {
    ...event,
    ...(task?.clientId ? { clientId: task.clientId } : {}),
    ...(task?.taskId ? { taskId: task.taskId } : {})
  };
}

function mutationControlTarget(target: string): boolean {
  return /\b(?:save|apply|publish|submit|confirm|delete|remove|pause|enable|disable|launch)\b|保存|应用|发布|提交|确认|删除|移除|暂停|启用|停用|上线/i.test(target);
}

function failedResult(attempts: number, blocker: string, blockerCode: VisualBlockerCode, lastAction?: VisualAction): VisualStepResult {
  return { status: "failed", attempts, blocker, blockerCode, ...(lastAction ? { lastAction } : {}) };
}

function blockerCode(error: unknown): VisualBlockerCode | undefined {
  if (error instanceof VisualRuntimeBlocker) return error.code;
  if (error instanceof SurfaceCaptureChangedError) return "SURFACE_CHANGED";
  if (error instanceof BrowserSessionLostError) return "BROWSER_SESSION_LOST";
  if (error instanceof BrowserPageIdentityUnavailableError) return "BROWSER_PAGE_IDENTITY_UNAVAILABLE";
  if (error instanceof BrowserPageIdentityChangedError) return "BROWSER_PAGE_IDENTITY_CHANGED";
  if (error instanceof VisualTimeoutError) return "TIMEOUT";
  return undefined;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}

export function visualComputerBindingFromTask(task: VisualMicroTask): VisualComputerSessionBinding {
  return parseVisualComputerSessionBinding({
    adPilotSessionId: task.adPilotSessionId ?? task.clientId ?? LEGACY_VISUAL_SESSION_BINDING.adPilotSessionId,
    browserSessionId: task.browserSessionId
      ?? task.surface.nativeProfileFingerprint
      ?? task.surface.browserProfile
      ?? LEGACY_VISUAL_SESSION_BINDING.browserSessionId
  });
}

function parseVisualComputerSessionBinding(binding: VisualComputerSessionBinding): VisualComputerSessionBinding {
  const adPilotSessionId = binding.adPilotSessionId.trim();
  const browserSessionId = binding.browserSessionId.trim();
  if (!adPilotSessionId || adPilotSessionId.length > 256) {
    throw new Error("adPilotSessionId must contain 1-256 characters");
  }
  if (!browserSessionId || browserSessionId.length > 256) {
    throw new Error("browserSessionId must contain 1-256 characters");
  }
  return { adPilotSessionId, browserSessionId };
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

function computerActionFromVisual(action: VisualAction, screenshot: Screenshot): ComputerActionValue | undefined {
  switch (action.action) {
    case "move":
    case "click":
    case "double_click":
    case "right_click":
      return { kind: action.action, x: action.x, y: action.y, coordinateSpace: "frame_pixels" };
    case "drag":
      return {
        kind: "drag",
        x: action.x,
        y: action.y,
        endX: action.end_x,
        endY: action.end_y,
        coordinateSpace: "frame_pixels"
      };
    case "type":
      return { kind: "type", text: action.text };
    case "hotkey":
      return {
        kind: "keypress",
        keys: action.keys.split("+").map((key) => key.trim()).filter(Boolean)
      };
    case "scroll": {
      const delta = scrollActionDelta(action.direction);
      return {
        kind: "scroll",
        x: action.x ?? Math.floor(screenshot.width / 2),
        y: action.y ?? Math.floor(screenshot.height / 2),
        coordinateSpace: "frame_pixels",
        ...delta
      };
    }
    case "wait":
      return { kind: "wait", milliseconds: action.milliseconds };
    case "done":
    case "fail":
    case "screenshot":
      return undefined;
  }
}

function scrollActionDelta(direction: "up" | "down" | "left" | "right"): { deltaX: number; deltaY: number } {
  if (direction === "up") return { deltaX: 0, deltaY: 600 };
  if (direction === "down") return { deltaX: 0, deltaY: -600 };
  if (direction === "left") return { deltaX: 600, deltaY: 0 };
  return { deltaX: -600, deltaY: 0 };
}

function legacyActionRecord(
  actionId: string,
  state: VisualSessionState,
  task: VisualMicroTask & { taskId: string; stepId: string; planId: string },
  before: Screenshot,
  surfaceFingerprint: string,
  action: ComputerActionValue
): ComputerActionRecordValue {
  if (!before.surface) {
    throw new VisualRuntimeBlocker(
      "SURFACE_CHANGED",
      "persistent native action records require an exact app/window/display surface"
    );
  }
  return ComputerActionRecord.parse({
    id: actionId,
    sessionId: state.recordSessionId,
    runId: task.taskId,
    binding: {
      ...state.binding,
      ...(task.clientId ? { clientId: task.clientId } : {}),
      ...(task.surface.browserProfile ? { browserProfileId: task.surface.browserProfile } : {})
    },
    controlRevision: state.controlRevision,
    taskId: task.taskId,
    stepId: task.stepId,
    planId: task.planId,
    surfaceFingerprint,
    beforeFrameSha256: before.sha256,
    appPid: before.surface.pid,
    appBundleId: before.surface.bundleId ?? before.surface.app,
    windowId: before.surface.windowId,
    ...(before.surface.title ? { windowTitle: before.surface.title } : {}),
    displayId: before.surface.screenId,
    scaleFactor: before.scaleFactor,
    beforeFrameId: randomUUID(),
    action,
    proposedBy: "visual-grounding-runtime",
    policyDecision: "visual-policy:allow",
    ...(task.approvalId ? { approvalId: task.approvalId } : {}),
    startedAt: new Date().toISOString(),
    userTookOver: false
  });
}

function legacyVerificationResult(
  actionId: string,
  sessionId: string,
  verified: { matched: boolean; confidence: number; reason: string },
  identityMatch: boolean
) {
  const unknown = (level: 3 | 4 | 5, reason: string) => ({
    level,
    status: "unknown" as const,
    evidence: [],
    reason
  });
  return VerificationResult.parse({
    actionId,
    sessionId,
    status: verified.matched && identityMatch ? "unknown" : "failed",
    levels: [
      { level: 1, status: "passed", evidence: ["native operator returned"], reason: "atomic native call returned without error" },
      {
        level: 2,
        status: verified.matched ? "passed" : "failed",
        evidence: [`visual-confidence:${verified.confidence}`],
        reason: verified.reason
      },
      unknown(3, "legacy visual verifier does not prove the exact target field and structured value"),
      unknown(4, "legacy visual verifier does not refresh/re-enter and prove persistence"),
      identityMatch
        ? {
            level: 5,
            status: "unknown",
            evidence: ["surface-fingerprint"],
            reason: "bound app/window identity remained unchanged, but the advertising account and Campaign identity are not yet reverified"
          }
        : { level: 5, status: "failed", evidence: ["surface-fingerprint"], reason: "bound app/window identity changed" }
    ],
    identityMatch,
    independentVerifier: "legacy-visual-verifier",
    verifiedAt: new Date().toISOString(),
    reason: verified.matched
      ? "visual result matched; exact-value and persistence levels remain unknown"
      : verified.reason
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) throw new VisualControlInterruptedError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new VisualTimeoutError(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
      ...(signal
        ? [new Promise<never>((_resolve, reject) => {
            abortListener = () => reject(new VisualControlInterruptedError());
            signal.addEventListener("abort", abortListener, { once: true });
          })]
        : [])
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return;
  }
  if (signal.aborted) throw new VisualControlInterruptedError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new VisualControlInterruptedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
      const base64 = captured.base64.replace(/^data:image\/\w+;base64,/, "");
      const screenshot = Screenshot.parse({
        base64,
        width: captured.width,
        height: captured.height,
        scaleFactor: captured.scaleFactor,
        capturedAt: new Date().toISOString(),
        sha256: createHash("sha256").update(base64, "base64").digest("hex"),
        surface: captured.surface,
        surfaceFingerprint: captured.surfaceFingerprint
      });
      this.lastCapture = screenshot;
      return screenshot;
    }
    const raw = await this.operator.screenshot();
    const base64 = raw.base64.replace(/^data:image\/\w+;base64,/, "");
    const image = await Jimp.fromBuffer(Buffer.from(base64, "base64"));
    const screenshot = Screenshot.parse({
      base64,
      width: image.width,
      height: image.height,
      scaleFactor: raw.scaleFactor,
      capturedAt: new Date().toISOString(),
      sha256: createHash("sha256").update(base64, "base64").digest("hex")
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

  async execute(action: VisualAction, screenshot: Screenshot, _task?: VisualMicroTask, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new VisualControlInterruptedError();
    if (action.action === "screenshot") return;
    if (action.action === "wait") {
      await abortableDelay(action.milliseconds, signal);
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
    if (signal?.aborted) throw new VisualControlInterruptedError();
    await this.operator.execute({
      prediction: `${actionType}()`,
      parsedPrediction: { action_type: actionType, action_inputs: actionInputs, reflection: null, thought: action.reason },
      screenWidth: screenshot.width,
      screenHeight: screenshot.height,
      scaleFactor: screenshot.scaleFactor,
      factors: [1000, 1000]
    });
    if (signal?.aborted) throw new VisualControlInterruptedError();
    await abortableDelay(350, signal);
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
                  allowed_text: task.allowedText,
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
            allowedText: task.allowedText,
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
