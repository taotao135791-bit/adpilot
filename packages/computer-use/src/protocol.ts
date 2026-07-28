import { createHash } from "node:crypto";
import { z } from "zod";
import { RiskLevel } from "@adpilot/shared";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const IsoDate = z.string().datetime();

export const ComputerRect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive()
}).strict();
export type ComputerRect = z.infer<typeof ComputerRect>;

export const ComputerControlState = z.enum([
  "agent_observing",
  "agent_proposing",
  "awaiting_approval",
  "agent_executing",
  "verifying",
  "paused",
  "user_control",
  "recovering",
  "stopped",
  "failed"
]);
export type ComputerControlState = z.infer<typeof ComputerControlState>;

export const ComputerControlOwner = z.enum(["agent", "user", "none"]);
export type ComputerControlOwner = z.infer<typeof ComputerControlOwner>;

export const ComputerSessionBinding = z.object({
  adPilotSessionId: z.string().min(1),
  browserSessionId: z.string().min(1),
  clientId: z.string().min(1),
  browserProfileId: z.string().min(1),
  platform: z.string().min(1),
  applicationId: z.string().min(1).optional(),
  appPid: z.number().int().positive().optional(),
  windowId: z.string().min(1).optional(),
  tabId: z.string().min(1).optional(),
  urlOrigin: z.string().url().optional(),
  accountId: z.string().min(1).optional(),
  pageType: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional()
}).strict();
export type ComputerSessionBinding = z.infer<typeof ComputerSessionBinding>;

export const StartComputerSession = z.object({
  runId: z.string().min(1),
  binding: ComputerSessionBinding
}).strict();
export type StartComputerSession = z.infer<typeof StartComputerSession>;

export const ComputerSession = z.object({
  id: z.string().uuid(),
  runId: z.string().min(1),
  binding: ComputerSessionBinding,
  state: ComputerControlState,
  controlOwner: ComputerControlOwner,
  revision: z.number().int().nonnegative(),
  requiresFreshObservation: z.boolean(),
  startedAt: IsoDate,
  updatedAt: IsoDate,
  lastObservationId: z.string().uuid().optional(),
  surfaceFingerprint: Sha256.optional(),
  failureReason: z.string().min(1).optional()
}).strict();
export type ComputerSession = z.infer<typeof ComputerSession>;

export const ScreenFrame = z.object({
  id: z.string().uuid(),
  format: z.enum(["png", "jpeg", "webp"]),
  base64: z.string().min(1).optional(),
  artifactUri: z.string().min(1).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sha256: Sha256,
  capturedAt: IsoDate,
  displayId: z.string().min(1),
  displayBounds: ComputerRect,
  scaleFactor: z.number().finite().positive()
}).strict().superRefine((frame, context) => {
  if (!frame.base64 && !frame.artifactUri) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a frame requires either base64 pixels or an artifact URI"
    });
  }
});
export type ScreenFrame = z.infer<typeof ScreenFrame>;

export const BrowserObservation = z.object({
  url: z.string().url().optional(),
  title: z.string().optional(),
  profileId: z.string().min(1),
  tabId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  pageType: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional()
}).strict();
export type BrowserObservation = z.infer<typeof BrowserObservation>;

export const OcrBlock = z.object({
  text: z.string(),
  bounds: ComputerRect,
  confidence: z.number().min(0).max(1)
}).strict();
export type OcrBlock = z.infer<typeof OcrBlock>;

export const AccessibilitySnapshot = z.object({
  capturedAt: IsoDate,
  focusedRole: z.string().optional(),
  focusedLabel: z.string().optional(),
  tree: z.unknown()
}).strict();
export type AccessibilitySnapshot = z.infer<typeof AccessibilitySnapshot>;

export const Observation = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  frame: ScreenFrame,
  activeApp: z.object({
    pid: z.number().int().positive(),
    bundleId: z.string().min(1),
    name: z.string().min(1)
  }).strict(),
  activeWindow: z.object({
    id: z.string().min(1),
    title: z.string().optional(),
    bounds: ComputerRect
  }).strict(),
  browser: BrowserObservation.optional(),
  accessibility: AccessibilitySnapshot.optional(),
  ocr: z.array(OcrBlock).optional(),
  surfaceFingerprint: Sha256
}).strict();
export type Observation = z.infer<typeof Observation>;

export const ComputerActionKind = z.enum([
  "move",
  "click",
  "double_click",
  "right_click",
  "type",
  "keypress",
  "scroll",
  "drag",
  "focus_window",
  "activate_app",
  "wait"
]);
export type ComputerActionKind = z.infer<typeof ComputerActionKind>;

const framePoint = {
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  coordinateSpace: z.literal("frame_pixels")
} as const;

export const ComputerAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), ...framePoint }).strict(),
  z.object({ kind: z.literal("click"), ...framePoint }).strict(),
  z.object({ kind: z.literal("double_click"), ...framePoint }).strict(),
  z.object({ kind: z.literal("right_click"), ...framePoint }).strict(),
  z.object({ kind: z.literal("type"), text: z.string().min(1).max(16_384) }).strict(),
  z.object({
    kind: z.literal("keypress"),
    keys: z.array(z.string().min(1)).min(1).max(8)
  }).strict(),
  z.object({
    kind: z.literal("scroll"),
    ...framePoint,
    deltaX: z.number().int().min(-10_000).max(10_000),
    deltaY: z.number().int().min(-10_000).max(10_000)
  }).strict(),
  z.object({
    kind: z.literal("drag"),
    ...framePoint,
    endX: z.number().finite().nonnegative(),
    endY: z.number().finite().nonnegative()
  }).strict(),
  z.object({ kind: z.literal("focus_window"), windowId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("activate_app"), bundleId: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal("wait"),
    milliseconds: z.number().int().min(50).max(10_000)
  }).strict()
]).superRefine((action, context) => {
  if (action.kind === "scroll" && action.deltaX === 0 && action.deltaY === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a scroll action requires a non-zero delta"
    });
  }
});
export type ComputerAction = z.infer<typeof ComputerAction>;

export const ObserveRequest = z.object({
  sessionId: z.string().uuid()
}).strict();
export type ObserveRequest = z.infer<typeof ObserveRequest>;

export const GroundingRequest = z.object({
  sessionId: z.string().uuid(),
  observationId: z.string().uuid(),
  instruction: z.string().min(1),
  target: z.string().min(1),
  expectedResult: z.string().min(1),
  riskLevel: RiskLevel,
  allowedActions: z.array(ComputerActionKind).min(1),
  allowedRegion: ComputerRect.optional()
}).strict();
export type GroundingRequest = z.infer<typeof GroundingRequest>;

export const ProposedComputerAction = z.object({
  action: ComputerAction,
  proposedBy: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1)
}).strict();
export type ProposedComputerAction = z.infer<typeof ProposedComputerAction>;

export const ActionProposal = z.object({
  id: z.string().uuid(),
  actionId: z.string().uuid(),
  sessionId: z.string().uuid(),
  observationId: z.string().uuid(),
  surfaceFingerprint: Sha256,
  action: ComputerAction,
  proposedBy: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  target: z.string().min(1),
  expectedResult: z.string().min(1),
  riskLevel: RiskLevel,
  createdAt: IsoDate,
  expiresAt: IsoDate
}).strict().superRefine((proposal, context) => {
  if (Date.parse(proposal.expiresAt) <= Date.parse(proposal.createdAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "an action proposal must expire after it is created"
    });
  }
});
export type ActionProposal = z.infer<typeof ActionProposal>;

export const ComputerPolicyDecision = z.object({
  id: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
  reason: z.string().min(1),
  evaluatedAt: IsoDate,
  requiresApproval: z.boolean()
}).strict();
export type ComputerPolicyDecision = z.infer<typeof ComputerPolicyDecision>;

export const ExecuteActionRequest = z.object({
  sessionId: z.string().uuid(),
  proposalId: z.string().uuid(),
  actionId: z.string().uuid(),
  policyDecision: ComputerPolicyDecision,
  approvalId: z.string().uuid().optional(),
  mutationKey: Sha256.optional()
}).strict();
export type ExecuteActionRequest = z.infer<typeof ExecuteActionRequest>;

export const ActionExecution = z.object({
  actionId: z.string().uuid(),
  sessionId: z.string().uuid(),
  status: z.enum(["executed", "blocked", "unknown"]),
  startedAt: IsoDate,
  completedAt: IsoDate.optional(),
  beforeFrameId: z.string().uuid(),
  afterFrameId: z.string().uuid().optional(),
  executionResult: z.unknown().optional(),
  blockerCode: z.string().min(1).optional(),
  blockerReason: z.string().min(1).optional(),
  userTookOver: z.boolean()
}).strict();
export type ActionExecution = z.infer<typeof ActionExecution>;

export const VerificationLevel = z.object({
  level: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5)
  ]),
  status: z.enum(["passed", "failed", "unknown"]),
  evidence: z.array(z.string().min(1)),
  reason: z.string().min(1)
}).strict();
export type VerificationLevel = z.infer<typeof VerificationLevel>;

export const VerificationRequest = z.object({
  sessionId: z.string().uuid(),
  actionId: z.string().uuid(),
  expectedResult: z.string().min(1),
  expectedValue: z.unknown().optional(),
  mutation: z.boolean(),
  requirePersistence: z.boolean()
}).strict();
export type VerificationRequest = z.infer<typeof VerificationRequest>;

export const VerificationResult = z.object({
  actionId: z.string().uuid(),
  sessionId: z.string().uuid(),
  status: z.enum(["passed", "failed", "unknown"]),
  levels: z.array(VerificationLevel).min(1),
  exactValueMatch: z.boolean().optional(),
  persistedAfterRefresh: z.boolean().optional(),
  identityMatch: z.boolean(),
  independentVerifier: z.string().min(1),
  verifiedAt: IsoDate,
  reason: z.string().min(1)
}).strict().superRefine((result, context) => {
  const levels = new Map(result.levels.map((level) => [level.level, level.status]));
  if (levels.size !== result.levels.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "verification levels must not contain duplicates"
    });
  }
  if (result.status === "passed" && [...levels.values()].some((status) => status !== "passed")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "passed verification cannot contain failed or unknown levels"
    });
  }
});
export type VerificationResult = z.infer<typeof VerificationResult>;

export const ComputerActionRecord = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  runId: z.string().min(1),
  binding: z.object({
    adPilotSessionId: z.string().min(1),
    browserSessionId: z.string().min(1),
    clientId: z.string().min(1).optional(),
    browserProfileId: z.string().min(1).optional()
  }).strict().optional(),
  controlRevision: z.number().int().nonnegative().optional(),
  taskId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  planId: z.string().min(1).optional(),
  surfaceFingerprint: Sha256.optional(),
  beforeFrameSha256: Sha256.optional(),
  appPid: z.number().int().positive(),
  appBundleId: z.string().min(1),
  windowId: z.string().min(1),
  windowTitle: z.string().optional(),
  displayId: z.string().min(1),
  scaleFactor: z.number().finite().positive(),
  beforeFrameId: z.string().uuid(),
  action: ComputerAction,
  proposedBy: z.string().min(1),
  policyDecision: z.string().min(1),
  approvalId: z.string().uuid().optional(),
  startedAt: IsoDate,
  completedAt: IsoDate.optional(),
  afterFrameId: z.string().uuid().optional(),
  executionResult: z.unknown().optional(),
  verificationResult: VerificationResult.optional(),
  userTookOver: z.boolean()
}).strict();
export type ComputerActionRecord = z.infer<typeof ComputerActionRecord>;

export function controlOwnerForState(state: ComputerControlState): ComputerControlOwner {
  if (state === "user_control") return "user";
  if (state === "stopped" || state === "failed" || state === "paused") return "none";
  return "agent";
}

/**
 * Identity proof for execution. Pixels are deliberately excluded: a frame hash
 * proves freshness, while this fingerprint proves the app/window/browser/page
 * surface on which those pixels were captured.
 */
export function fingerprintObservationSurface(observationInput: Observation): string {
  const observation = Observation.parse(observationInput);
  return createHash("sha256").update(stableJson({
    app: observation.activeApp,
    window: observation.activeWindow,
    displayId: observation.frame.displayId,
    displayBounds: observation.frame.displayBounds,
    scaleFactor: observation.frame.scaleFactor,
    browser: observation.browser ?? null
  })).digest("hex");
}

export function assertObservationSelfConsistent(observationInput: Observation): Observation {
  const observation = Observation.parse(observationInput);
  const fingerprint = fingerprintObservationSurface(observation);
  if (fingerprint !== observation.surfaceFingerprint) {
    throw new ComputerProtocolError(
      "SURFACE_FINGERPRINT_INVALID",
      "observation surface fingerprint does not match its identity metadata"
    );
  }
  return observation;
}

export function isMutationRisk(risk: z.infer<typeof RiskLevel>): boolean {
  return risk === "mutate" || risk === "destructive";
}

export class ComputerProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ComputerProtocolError";
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
