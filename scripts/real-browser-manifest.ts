import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Jimp } from "jimp";
import { z } from "zod";

const RiskLevel = z.enum(["observe", "interact", "mutate", "destructive"]);
const Permission = z.enum(["OBSERVE", "INTERACT"]);
const ActionKind = z.enum([
  "click",
  "double_click",
  "right_click",
  "move",
  "drag",
  "type",
  "hotkey",
  "scroll",
  "wait",
  "screenshot",
  "done",
  "fail"
]);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const IsoDate = z.string().datetime();
const maxImageDimension = 32_768;
const maxImagePixels = 100_000_000;

export const PublicValidationAction = z.object({
  action: ActionKind,
  target: z.string().min(1),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  expectedResult: z.string().min(1),
  riskLevel: RiskLevel,
  inputSha256: Sha256.optional()
}).strict();

const PublicScreenshot = z.object({
  width: z.number().int().positive().max(maxImageDimension),
  height: z.number().int().positive().max(maxImageDimension),
  scaleFactor: z.number().positive().max(8),
  capturedAt: IsoDate,
  sha256: Sha256,
  surfaceFingerprint: Sha256.optional()
}).strict().refine((value) => value.width * value.height <= maxImagePixels, {
  message: "screenshot pixel count exceeds limit"
});

const RuntimeEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("screenshot"),
    clientId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    phase: z.enum(["before", "after"]),
    screenshot: PublicScreenshot
  }).strict(),
  z.object({
    type: z.literal("grounded"),
    clientId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    attempt: z.number().int().nonnegative(),
    tier: z.enum(["gui", "strong"]),
    action: PublicValidationAction
  }).strict(),
  z.object({
    type: z.literal("executed"),
    clientId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    attempt: z.number().int().nonnegative(),
    action: PublicValidationAction
  }).strict(),
  z.object({
    type: z.literal("verified"),
    clientId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    attempt: z.number().int().nonnegative(),
    matched: z.boolean(),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1)
  }).strict(),
  z.object({
    type: z.literal("blocked"),
    clientId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    attempt: z.number().int().nonnegative(),
    reason: z.string().min(1),
    code: z.string().min(1).optional()
  }).strict()
]);
type RuntimeEventValue = z.infer<typeof RuntimeEvent>;

const EvidenceFrame = z.object({
  file: z.string().regex(/^[A-Za-z0-9._-]+\.png$/),
  width: z.number().int().positive().max(maxImageDimension),
  height: z.number().int().positive().max(maxImageDimension),
  scaleFactor: z.number().positive().max(8),
  capturedAt: IsoDate,
  sha256: Sha256,
  surfaceFingerprint: Sha256.optional()
}).strict().refine((value) => value.width * value.height <= maxImagePixels, {
  message: "evidence pixel count exceeds limit"
});

const ValidationTask = z.object({
  taskId: z.string().uuid(),
  stepId: z.string().regex(/^(readonly|prepare)-\d{2}$/),
  platform: z.literal("google_ads"),
  instruction: z.string().min(1),
  target: z.string().min(1),
  expectedResult: z.string().min(1),
  riskLevel: z.enum(["observe", "interact"]),
  permission: Permission,
  allowedActions: z.array(ActionKind).min(1),
  allowedTextSha256: Sha256.optional(),
  allowedRegion: z.object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
    coordinateSpace: z.literal("screenshot_pixels")
  }).strict().optional(),
  retryPolicy: z.literal("none")
}).strict();

const Confirmation = z.object({
  matched: z.boolean(),
  confidence: z.number().min(0).max(1),
  minimumConfidence: z.number().min(0).max(1),
  reason: z.string().min(1)
}).strict();

const DoneResult = z.object({
  status: z.literal("done"),
  attempts: z.number().int().positive(),
  action: PublicValidationAction,
  executed: z.boolean(),
  verified: z.boolean(),
  confirmationPassed: z.boolean(),
  confirmation: Confirmation,
  evidence: z.object({
    beforeFile: z.string().min(1),
    afterFile: z.string().min(1),
    beforeSha256: Sha256,
    afterSha256: Sha256
  }).strict()
}).strict();

const FailedResult = z.object({
  status: z.literal("failed"),
  attempts: z.number().int().nonnegative(),
  blocker: z.string().min(1),
  blockerCode: z.string().min(1).optional(),
  lastAction: PublicValidationAction.optional(),
  evidence: z.object({ beforeFile: z.string().min(1) }).strict()
}).strict();

const ErrorResult = z.object({
  status: z.literal("error"),
  message: z.string().min(1)
}).strict();

export const RealBrowserValidationRecord = z.object({
  index: z.number().int().positive(),
  task: ValidationTask,
  stepPassed: z.boolean(),
  result: z.union([DoneResult, FailedResult, ErrorResult]),
  evidence: z.object({
    before: EvidenceFrame.optional(),
    after: EvidenceFrame.optional()
  }).strict(),
  latencyMs: z.number().finite().nonnegative(),
  events: z.array(RuntimeEvent)
}).strict();
export type RealBrowserValidationRecord = z.infer<typeof RealBrowserValidationRecord>;

const BrowserSession = z.object({
  sessionId: z.string().min(1),
  clientId: z.string().min(1),
  browserProfile: z.string().min(1),
  nativeProfileFingerprint: z.string().min(1),
  processId: z.number().int().positive(),
  windowId: z.string().min(1),
  platform: z.literal("google_ads"),
  browserApplicationId: z.string().min(1),
  browserApp: z.string().min(1),
  sessionStatus: z.literal("connected"),
  startedAt: IsoDate,
  updatedAt: IsoDate
}).strict();

const Rect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive()
}).strict();

const SurfaceIdentity = z.object({
  fingerprint: Sha256,
  surface: z.object({
    platform: z.string().min(1),
    app: z.string().min(1),
    bundleId: z.string().min(1).optional(),
    pid: z.number().int().positive(),
    windowId: z.string().min(1),
    bounds: Rect,
    screenId: z.string().min(1),
    screenBounds: Rect,
    scaleFactor: z.number().positive(),
    browserProfile: z.string().min(1).optional()
  }).strict()
}).strict();

const Failure = z.object({
  index: z.number().int().positive(),
  stepId: z.string().min(1),
  reason: z.string().min(1)
}).strict();

export const RealBrowserValidationManifest = z.object({
  schemaVersion: z.literal(2),
  runId: z.string().min(1),
  mode: z.enum(["readonly", "prepare"]),
  passed: z.boolean(),
  safety: z.object({
    domAutomation: z.literal(false),
    submitAllowed: z.literal(false),
    mutationsAllowed: z.literal(false),
    confirmationMinimumConfidence: z.number().min(0.5).max(1),
    exactPrepareTextBound: z.boolean(),
    coordinateActionsRegionBound: z.boolean(),
    prepareActionAllowlist: z.array(z.array(ActionKind).min(1)).nullable(),
    prepareRetryPolicy: z.literal("none").nullable()
  }).strict(),
  clientId: z.string().min(1),
  accountRef: z.string().min(1),
  browserProfile: z.string().min(1),
  browserSession: BrowserSession,
  initialSurface: SurfaceIdentity,
  accountFingerprint: z.object({
    status: z.literal("not-created"),
    reason: z.string().min(1)
  }).strict(),
  screenshotPrivacyAudits: z.array(z.unknown()),
  models: z.record(z.unknown()),
  tokenUsage: z.number().nonnegative().nullable(),
  tokenUsageNote: z.string().min(1),
  startedAt: IsoDate,
  completedAt: IsoDate,
  failures: z.array(Failure),
  records: z.array(RealBrowserValidationRecord)
}).strict();
export type RealBrowserValidationManifest = z.infer<typeof RealBrowserValidationManifest>;

export function assessRealBrowserManifest(manifest: RealBrowserValidationManifest): string[] {
  const reasons: string[] = [];
  const expectedSteps = manifest.mode === "readonly" ? 11 : 2;
  const canonicalSteps = canonicalValidationSteps(manifest.mode);
  if (!manifest.passed) reasons.push("manifest did not claim a passed run");
  if (manifest.records.length !== expectedSteps) {
    reasons.push(`expected ${expectedSteps} records for ${manifest.mode}, received ${manifest.records.length}`);
  }
  if (manifest.failures.length > 0) reasons.push("manifest contains recorded failures");
  if (manifest.clientId !== manifest.browserSession.clientId) {
    reasons.push("browser session client does not match manifest client");
  }
  if (manifest.browserProfile !== manifest.browserSession.browserProfile) {
    reasons.push("browser session profile does not match manifest profile");
  }
  if (manifest.browserSession.processId !== manifest.initialSurface.surface.pid) {
    reasons.push("initial surface process does not match browser session");
  }
  if (manifest.browserSession.windowId !== manifest.initialSurface.surface.windowId) {
    reasons.push("initial surface window does not match browser session");
  }
  const initialApplicationId = manifest.initialSurface.surface.bundleId
    ?? manifest.initialSurface.surface.app;
  if (manifest.browserSession.browserApplicationId !== initialApplicationId) {
    reasons.push("initial surface application does not match browser session");
  }
  if (manifest.initialSurface.surface.browserProfile !== manifest.browserSession.nativeProfileFingerprint) {
    reasons.push("initial surface native profile does not match browser session");
  }
  if (!/chrome|safari|edge|arc|brave|firefox/i.test(
    `${manifest.initialSurface.surface.app} ${manifest.initialSurface.surface.bundleId ?? ""}`
  )) {
    reasons.push("initial surface is not a supported browser application");
  }
  const expectedPrepareAllowlist = manifest.mode === "prepare"
    ? canonicalSteps.map((step) => step.allowedActions)
    : null;
  if (stableValue(manifest.safety.prepareActionAllowlist) !== stableValue(expectedPrepareAllowlist)
    || manifest.safety.prepareRetryPolicy !== (manifest.mode === "prepare" ? "none" : null)
    || manifest.safety.exactPrepareTextBound !== (manifest.mode === "prepare")
    || !manifest.safety.coordinateActionsRegionBound) {
    reasons.push("manifest safety policy does not match its canonical mode");
  }
  const taskIds = new Set<string>();
  const evidenceFiles = new Set<string>();
  for (let offset = 0; offset < manifest.records.length; offset += 1) {
    const record = manifest.records[offset]!;
    const canonical = canonicalSteps[offset];
    const expectedIndex = offset + 1;
    const expectedStepId = `${manifest.mode}-${String(expectedIndex).padStart(2, "0")}`;
    if (record.index !== expectedIndex) reasons.push(`record ${expectedIndex} has non-sequential index`);
    if (record.task.stepId !== expectedStepId) reasons.push(`record ${expectedIndex} has unexpected stepId`);
    if (taskIds.has(record.task.taskId)) reasons.push(`record ${expectedIndex} reuses taskId`);
    taskIds.add(record.task.taskId);
    if (canonical && (
      record.task.riskLevel !== canonical.riskLevel
      || record.task.permission !== canonical.permission
      || stableValue(record.task.allowedActions) !== stableValue(canonical.allowedActions)
      || Boolean(record.task.allowedRegion) !== canonical.regionRequired
    )) {
      reasons.push(`record ${expectedIndex} task policy is not canonical`);
    }
    if (!record.stepPassed) reasons.push(`record ${expectedIndex} did not pass`);
    if (record.result.status !== "done") {
      reasons.push(`record ${expectedIndex} result is ${record.result.status}`);
      continue;
    }
    if (!record.result.confirmationPassed
      || !record.result.confirmation.matched
      || record.result.confirmation.confidence < record.result.confirmation.minimumConfidence
      || record.result.confirmation.minimumConfidence !== manifest.safety.confirmationMinimumConfidence) {
      reasons.push(`record ${expectedIndex} lacks the required visual confirmation`);
    }
    if (record.result.attempts !== 1) reasons.push(`record ${expectedIndex} was not single-attempt`);
    if (!record.task.allowedActions.includes(record.result.action.action)) {
      reasons.push(`record ${expectedIndex} result action is outside its allowlist`);
    }
    if (record.result.action.target !== record.task.target
      || record.result.action.expectedResult !== record.task.expectedResult) {
      reasons.push(`record ${expectedIndex} result action is not bound to its task`);
    }
    if (["click", "double_click", "right_click", "drag", "scroll"].includes(record.result.action.action)
      && (!manifest.safety.coordinateActionsRegionBound || !record.task.allowedRegion)) {
      reasons.push(`record ${expectedIndex} coordinate action is not region-bound`);
    }
    if (riskRank(record.result.action.riskLevel) > riskRank(record.task.riskLevel)) {
      reasons.push(`record ${expectedIndex} result action exceeds task risk`);
    }
    if (manifest.mode === "readonly"
      && (record.result.action.action === "type" || record.result.action.action === "hotkey")) {
      reasons.push(`record ${expectedIndex} used forbidden readonly input`);
    }
    if (!record.evidence.before || !record.evidence.after) {
      reasons.push(`record ${expectedIndex} is missing before/after evidence`);
    } else if (
      record.result.evidence.beforeFile !== record.evidence.before.file
      || record.result.evidence.beforeSha256 !== record.evidence.before.sha256
      || record.result.evidence.afterFile !== record.evidence.after.file
      || record.result.evidence.afterSha256 !== record.evidence.after.sha256
    ) {
      reasons.push(`record ${expectedIndex} result evidence does not match its files`);
    } else if (!record.evidence.before.surfaceFingerprint || !record.evidence.after.surfaceFingerprint) {
      reasons.push(`record ${expectedIndex} evidence lacks native surface identity`);
    } else {
      const expectedBefore = `${String(expectedIndex * 2 - 1).padStart(3, "0")}-${expectedStepId}-before.png`;
      const expectedAfter = `${String(expectedIndex * 2).padStart(3, "0")}-${expectedStepId}-after.png`;
      if (record.evidence.before.file !== expectedBefore || record.evidence.after.file !== expectedAfter) {
        reasons.push(`record ${expectedIndex} evidence filename is not canonical`);
      }
      for (const frame of [record.evidence.before, record.evidence.after]) {
        if (evidenceFiles.has(frame.file)) reasons.push(`record ${expectedIndex} reuses evidence filename`);
        evidenceFiles.add(frame.file);
      }
      if (record.task.allowedRegion && (
        record.task.allowedRegion.x + record.task.allowedRegion.width > record.evidence.before.width
        || record.task.allowedRegion.y + record.task.allowedRegion.height > record.evidence.before.height
      )) {
        reasons.push(`record ${expectedIndex} allowed region exceeds screenshot evidence`);
      }
    }
    const groundedEvents = record.events.filter((event) => event.type === "grounded");
    const executedEvents = record.events.filter((event) => event.type === "executed");
    const blockedEvents = record.events.filter((event) => event.type === "blocked");
    const grounded = groundedEvents.length === 1;
    const visiblyVerified = record.events.some((event) =>
      event.type === "verified"
      && event.matched
      && event.confidence >= manifest.safety.confirmationMinimumConfidence
    );
    if (!grounded) reasons.push(`record ${expectedIndex} has no grounding event`);
    if (!visiblyVerified) reasons.push(`record ${expectedIndex} has no passing verification event`);
    if (blockedEvents.length > 0) reasons.push(`record ${expectedIndex} contains a blocked event`);
    const verifiedEvents = record.events.filter(
      (event): event is Extract<RuntimeEventValue, { type: "verified" }> =>
        event.type === "verified"
    );
    const externalConfirmations = verifiedEvents.filter((event) => event.attempt === 0);
    if (externalConfirmations.length !== 1
      || externalConfirmations[0]!.matched !== record.result.confirmation.matched
      || externalConfirmations[0]!.confidence !== record.result.confirmation.confidence
      || externalConfirmations[0]!.reason !== record.result.confirmation.reason) {
      reasons.push(`record ${expectedIndex} lacks confirmation event provenance`);
    }
    const internalVerifications = verifiedEvents.filter((event) => event.attempt === 1);
    if (record.result.verified
      ? internalVerifications.length !== 1 || internalVerifications[0]!.matched !== true
      : internalVerifications.length !== 0) {
      reasons.push(`record ${expectedIndex} runtime verification provenance is inconsistent`);
    }
    const screenshotHashes = new Set(record.events.flatMap((event) =>
      event.type === "screenshot" ? [event.screenshot.sha256] : []
    ));
    if (record.evidence.before && !screenshotHashes.has(record.evidence.before.sha256)) {
      reasons.push(`record ${expectedIndex} before evidence is not linked to a capture event`);
    }
    if (record.evidence.after && !screenshotHashes.has(record.evidence.after.sha256)) {
      reasons.push(`record ${expectedIndex} after evidence is not linked to a capture event`);
    }
    const resultActionExecuted = record.result.action.action !== "done";
    if (resultActionExecuted) {
      if (!record.result.executed || !record.result.verified || executedEvents.length !== 1) {
        reasons.push(`record ${expectedIndex} lacks one verified native execution`);
      }
    } else if (record.result.executed || record.result.verified || executedEvents.length !== 0) {
      reasons.push(`record ${expectedIndex} reports execution for terminal done`);
    }
    for (const event of [...groundedEvents, ...executedEvents]) {
      if (!samePublicAction(event.action, record.result.action)) {
        reasons.push(`record ${expectedIndex} event action does not match its result`);
      }
    }
    for (const event of record.events) {
      if (event.taskId !== record.task.taskId || event.clientId !== manifest.clientId) {
        reasons.push(`record ${expectedIndex} contains an unscoped event`);
      }
      if (event.type !== "executed") continue;
      if (riskRank(event.action.riskLevel) > riskRank(record.task.riskLevel)) {
        reasons.push(`record ${expectedIndex} executed above task risk`);
      }
      if (event.action.riskLevel === "mutate" || event.action.riskLevel === "destructive") {
        reasons.push(`record ${expectedIndex} contains a mutation-risk execution`);
      }
    }
  }
  const first = manifest.records[0];
  if (manifest.mode === "prepare" && first?.result.status === "done") {
    if (!manifest.safety.exactPrepareTextBound
      || first.result.action.action !== "type"
      || !first.result.executed
      || !first.result.verified
      || !first.task.allowedTextSha256
      || first.result.action.inputSha256 !== first.task.allowedTextSha256) {
      reasons.push("prepare text was not bound to the exact approved payload");
    }
  }
  return reasons;
}

export async function verifyRealBrowserEvidence(
  manifestPath: string,
  manifest: RealBrowserValidationManifest
): Promise<string[]> {
  const reasons: string[] = [];
  const source = await realpath(resolve(manifestPath)).catch(() => resolve(manifestPath));
  const root = dirname(source);
  for (const record of manifest.records) {
    for (const frame of [record.evidence.before, record.evidence.after]) {
      if (!frame) continue;
      if (basename(frame.file) !== frame.file) {
        reasons.push(`evidence path is not a local filename: ${frame.file}`);
        continue;
      }
      const candidate = resolve(root, frame.file);
      if (dirname(candidate) !== root) {
        reasons.push(`evidence path escapes manifest directory: ${frame.file}`);
        continue;
      }
      try {
        const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) {
            reasons.push(`evidence is not a regular file: ${frame.file}`);
            continue;
          }
          if (stat.size < 1 || stat.size > 100 * 1024 * 1024) {
            reasons.push(`evidence file size is outside limits: ${frame.file}`);
            continue;
          }
          const bytes = await handle.readFile();
          if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
            reasons.push(`evidence is not a PNG file: ${frame.file}`);
            continue;
          }
          if (bytes.length < 24
            || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
            reasons.push(`evidence PNG has no valid IHDR: ${frame.file}`);
            continue;
          }
          const declaredWidth = bytes.readUInt32BE(16);
          const declaredHeight = bytes.readUInt32BE(20);
          if (declaredWidth < 1
            || declaredHeight < 1
            || declaredWidth > maxImageDimension
            || declaredHeight > maxImageDimension
            || declaredWidth * declaredHeight > maxImagePixels) {
            reasons.push(`evidence PNG dimensions exceed limits: ${frame.file}`);
            continue;
          }
          if (declaredWidth !== frame.width || declaredHeight !== frame.height) {
            reasons.push(`evidence dimensions do not match manifest: ${frame.file}`);
            continue;
          }
          const image = await Jimp.fromBuffer(bytes).catch(() => undefined);
          if (!image) {
            reasons.push(`evidence PNG cannot be decoded: ${frame.file}`);
            continue;
          }
          if (image.width !== frame.width || image.height !== frame.height) {
            reasons.push(`evidence dimensions do not match manifest: ${frame.file}`);
            continue;
          }
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (digest !== frame.sha256) reasons.push(`evidence hash mismatch: ${frame.file}`);
        } finally {
          await handle.close();
        }
      } catch {
        reasons.push(`evidence file is unavailable: ${frame.file}`);
      }
    }
  }
  return reasons;
}

export async function readRealBrowserManifest(path: string): Promise<RealBrowserValidationManifest> {
  const source = resolve(path);
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("real-browser manifest is not a regular file");
    if (stat.size < 2 || stat.size > 10 * 1024 * 1024) {
      throw new Error("real-browser manifest size is outside limits");
    }
    return RealBrowserValidationManifest.parse(JSON.parse(await handle.readFile({ encoding: "utf8" })));
  } finally {
    await handle.close();
  }
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function riskRank(value: z.infer<typeof RiskLevel>): number {
  return { observe: 0, interact: 1, mutate: 2, destructive: 3 }[value];
}

function canonicalValidationSteps(mode: "readonly" | "prepare") {
  const observe = ["screenshot", "done", "fail", "wait", "move"] as const;
  const navigation = ["click", ...observe] as const;
  const readScroll = ["scroll", ...observe] as const;
  if (mode === "prepare") {
    return [
      { riskLevel: "interact" as const, permission: "INTERACT" as const, allowedActions: ["type", "fail"] as const, regionRequired: false },
      { riskLevel: "observe" as const, permission: "OBSERVE" as const, allowedActions: ["done", "fail", "screenshot"] as const, regionRequired: false }
    ];
  }
  return [
    { riskLevel: "observe" as const, permission: "OBSERVE" as const, allowedActions: observe, regionRequired: false },
    { riskLevel: "observe" as const, permission: "OBSERVE" as const, allowedActions: observe, regionRequired: false },
    { riskLevel: "interact" as const, permission: "INTERACT" as const, allowedActions: navigation, regionRequired: true },
    { riskLevel: "interact" as const, permission: "INTERACT" as const, allowedActions: navigation, regionRequired: true },
    { riskLevel: "interact" as const, permission: "INTERACT" as const, allowedActions: navigation, regionRequired: true },
    { riskLevel: "interact" as const, permission: "INTERACT" as const, allowedActions: readScroll, regionRequired: true },
    { riskLevel: "interact" as const, permission: "INTERACT" as const, allowedActions: readScroll, regionRequired: true },
    { riskLevel: "interact" as const, permission: "INTERACT" as const, allowedActions: readScroll, regionRequired: true },
    { riskLevel: "interact" as const, permission: "INTERACT" as const, allowedActions: readScroll, regionRequired: true },
    { riskLevel: "interact" as const, permission: "INTERACT" as const, allowedActions: navigation, regionRequired: true },
    { riskLevel: "observe" as const, permission: "OBSERVE" as const, allowedActions: observe, regionRequired: false }
  ];
}

function stableValue(value: unknown): string {
  return JSON.stringify(value);
}

function samePublicAction(
  left: z.infer<typeof PublicValidationAction>,
  right: z.infer<typeof PublicValidationAction>
): boolean {
  return left.action === right.action
    && left.target === right.target
    && left.expectedResult === right.expectedResult
    && left.riskLevel === right.riskLevel;
}
