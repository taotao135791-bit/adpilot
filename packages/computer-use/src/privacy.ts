import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Jimp } from "jimp";
import { z } from "zod";
import type {
  Screenshot,
  VisualAction,
  VisualGroundingProvider,
  VisualMicroTask,
  VisualVerifier
} from "./index.js";
import {
  VisualIdentityObservation,
  type ExpectedVisualIdentity,
  type VisualIdentityRegions,
  type VisualIdentityReviewer
} from "./account-fingerprint.js";
import type { ModelTier } from "@adpilot/shared";

export const ScreenshotRegion = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
});
export type ScreenshotRegion = z.infer<typeof ScreenshotRegion>;

export const PrivacyMaskCategory = z.enum([
  "user_avatar",
  "email",
  "browser_tabs",
  "notification",
  "unrelated_account",
  "top_personal_info",
  "system_menu_bar",
  "other_campaign",
  "unrelated_financial_data",
  "custom"
]);
export type PrivacyMaskCategory = z.infer<typeof PrivacyMaskCategory>;

export const ScreenshotMask = z.object({
  category: PrivacyMaskCategory,
  region: ScreenshotRegion,
  reason: z.string().min(1)
});
export type ScreenshotMask = z.infer<typeof ScreenshotMask>;

export const ScreenshotPrivacyMode = z.enum(["minimized", "local-only"]);
export type ScreenshotPrivacyMode = z.infer<typeof ScreenshotPrivacyMode>;

export const ModelPrivacyDescriptor = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  location: z.enum(["local", "remote"]),
  retentionPolicy: z.string().min(1)
});
export type ModelPrivacyDescriptor = z.infer<typeof ModelPrivacyDescriptor>;

export const LocalScreenshotArtifact = z.object({
  screenshotId: z.string().uuid(),
  clientId: z.string().min(1),
  taskId: z.string().min(1),
  sha256: z.string().length(64),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  capturedAt: z.string().datetime(),
  localPath: z.string().min(1),
  retentionPolicy: z.string().min(1)
});
export type LocalScreenshotArtifact = z.infer<typeof LocalScreenshotArtifact>;

export const ScreenshotModelCallAudit = z.object({
  auditId: z.string().uuid(),
  clientId: z.string().min(1),
  taskId: z.string().min(1),
  purpose: z.enum(["grounding", "verification", "table_read", "account_identity", "other"]),
  callRole: z.enum(["table_reader", "table_verifier", "identity_locator", "identity_verifier"]).optional(),
  modelProvider: z.string().min(1),
  modelId: z.string().min(1),
  screenshotId: z.string().uuid(),
  screenshotSha256: z.string().length(64),
  sentRoi: ScreenshotRegion,
  masks: z.array(ScreenshotMask),
  requiredVisibleRegions: z.array(ScreenshotRegion).optional(),
  transmittedWidth: z.number().int().positive().optional(),
  transmittedHeight: z.number().int().positive().optional(),
  leftLocal: z.boolean(),
  fullScreenshotLocalOnly: z.literal(true),
  privacyMode: ScreenshotPrivacyMode,
  dataRetentionPolicy: z.string().min(1),
  outcome: z.enum(["prepared", "blocked"]),
  createdAt: z.string().datetime()
});
export type ScreenshotModelCallAudit = z.infer<typeof ScreenshotModelCallAudit>;

export interface ScreenshotArtifactStore {
  saveFull(input: {
    screenshotId: string;
    clientId: string;
    taskId: string;
    screenshot: Screenshot;
    retentionPolicy: string;
  }): Promise<LocalScreenshotArtifact>;
}

export interface ScreenshotModelCallAuditStore {
  append(record: ScreenshotModelCallAudit): Promise<void>;
  list(clientId?: string): Promise<ScreenshotModelCallAudit[]>;
}

/** Stores complete captures only inside the supplied local Workspace directory. */
export class FileScreenshotArtifactStore implements ScreenshotArtifactStore {
  constructor(private readonly workspaceDirectory: string) {}

  async saveFull(input: {
    screenshotId: string;
    clientId: string;
    taskId: string;
    screenshot: Screenshot;
    retentionPolicy: string;
  }): Promise<LocalScreenshotArtifact> {
    const screenshotId = z.string().uuid().parse(input.screenshotId);
    const clientKey = createHash("sha256").update(input.clientId).digest("hex").slice(0, 24);
    const directory = join(this.workspaceDirectory, "screenshots", clientKey);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const localPath = join(directory, `${screenshotId}.png`);
    const buffer = screenshotBuffer(input.screenshot.base64);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    await writeFile(localPath, buffer, { mode: 0o600 });
    await chmod(localPath, 0o600);
    const artifact = LocalScreenshotArtifact.parse({
      screenshotId,
      clientId: input.clientId,
      taskId: input.taskId,
      sha256,
      width: input.screenshot.width,
      height: input.screenshot.height,
      capturedAt: input.screenshot.capturedAt,
      localPath,
      retentionPolicy: input.retentionPolicy
    });
    const metadataPath = join(directory, `${screenshotId}.json`);
    await writeFile(metadataPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(metadataPath, 0o600);
    return artifact;
  }
}

/** Append-only model image disclosure ledger. It never contains image bytes. */
export class FileScreenshotModelCallAuditStore implements ScreenshotModelCallAuditStore {
  private readonly file: string;

  constructor(private readonly workspaceDirectory: string) {
    this.file = join(workspaceDirectory, "audit", "screenshot-model-calls.jsonl");
  }

  async append(record: ScreenshotModelCallAudit): Promise<void> {
    const parsed = ScreenshotModelCallAudit.parse(record);
    await mkdir(join(this.workspaceDirectory, "audit"), { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(this.file, 0o600);
  }

  async list(clientId?: string): Promise<ScreenshotModelCallAudit[]> {
    let content: string;
    try { content = await readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return content.split("\n").filter(Boolean).map((line) => ScreenshotModelCallAudit.parse(JSON.parse(line)))
      .filter((record) => !clientId || record.clientId === clientId);
  }
}

export interface PrepareScreenshotForModelInput {
  clientId: string;
  taskId: string;
  purpose: ScreenshotModelCallAudit["purpose"];
  callRole?: ScreenshotModelCallAudit["callRole"];
  screenshot: Screenshot;
  roi: ScreenshotRegion;
  sensitiveRegions?: ScreenshotMask[];
  /** Exact semantic evidence regions that must remain visible after masking. */
  requiredVisibleRegions?: ScreenshotRegion[];
  includeDefaultMasks?: boolean;
  model: ModelPrivacyDescriptor;
  privacyMode?: ScreenshotPrivacyMode;
  localFullRetentionPolicy?: string;
}

export interface PreparedModelScreenshot {
  /** Sanitized ROI only. This is the sole image object safe to pass to a model. */
  screenshot: Screenshot;
  screenshotId: string;
  originalRoi: ScreenshotRegion;
  masks: ScreenshotMask[];
  fullArtifact: LocalScreenshotArtifact;
  audit: ScreenshotModelCallAudit;
}

export class PrivacyModeRemoteProviderError extends Error {
  readonly code = "PRIVACY_MODE_REMOTE_PROVIDER_BLOCKED" as const;
  constructor(readonly audit: ScreenshotModelCallAudit) {
    super(`privacy mode blocked remote screenshot provider ${audit.modelProvider}/${audit.modelId}`);
    this.name = "PrivacyModeRemoteProviderError";
  }
}

export class ScreenshotMinimizationError extends Error {
  readonly code = "SCREENSHOT_MINIMIZATION_REQUIRED" as const;
}

/**
 * Saves the complete capture locally, crops the requested ROI, masks sensitive
 * pixels, and returns only the minimized image plus a disclosure audit record.
 */
export class ScreenshotPrivacyPipeline {
  constructor(
    private readonly artifacts: ScreenshotArtifactStore,
    private readonly audits: ScreenshotModelCallAuditStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async prepareForModel(input: PrepareScreenshotForModelInput): Promise<PreparedModelScreenshot> {
    if (!input.clientId || !input.taskId) throw new Error("clientId and taskId are required for screenshot privacy auditing");
    const model = ModelPrivacyDescriptor.parse(input.model);
    const privacyMode = ScreenshotPrivacyMode.parse(input.privacyMode ?? "minimized");
    const roi = validateRegionWithin(ScreenshotRegion.parse(input.roi), input.screenshot.width, input.screenshot.height, "ROI");
    const screenshotId = randomUUID();
    const retention = input.localFullRetentionPolicy ?? "local-session";
    const fullArtifact = await this.artifacts.saveFull({
      screenshotId,
      clientId: input.clientId,
      taskId: input.taskId,
      screenshot: input.screenshot,
      retentionPolicy: retention
    });
    const candidateMasks = [
      ...(input.includeDefaultMasks === false ? [] : defaultSensitiveMasks(input.screenshot.width, input.screenshot.height)),
      ...(input.sensitiveRegions ?? [])
    ].map((mask) => ScreenshotMask.parse(mask));
    const appliedMasks = candidateMasks.flatMap((mask) => {
      const clipped = intersection(mask.region, roi);
      return clipped ? [{ ...mask, region: clipped }] : [];
    });
    const requiredVisibleRegions = (input.requiredVisibleRegions ?? [])
      .map((region) => validateRegionWithin(ScreenshotRegion.parse(region), input.screenshot.width, input.screenshot.height, "required visible region"));
    const baseAudit = {
      auditId: randomUUID(),
      clientId: input.clientId,
      taskId: input.taskId,
      purpose: input.purpose,
      ...(input.callRole ? { callRole: input.callRole } : {}),
      modelProvider: model.provider,
      modelId: model.modelId,
      screenshotId,
      screenshotSha256: fullArtifact.sha256,
      sentRoi: roi,
      masks: appliedMasks,
      requiredVisibleRegions,
      leftLocal: model.location === "remote",
      fullScreenshotLocalOnly: true as const,
      privacyMode,
      dataRetentionPolicy: model.retentionPolicy,
      createdAt: this.now().toISOString()
    };
    if (privacyMode === "local-only" && model.location === "remote") {
      const audit = ScreenshotModelCallAudit.parse({ ...baseAudit, leftLocal: false, outcome: "blocked" });
      await this.audits.append(audit);
      throw new PrivacyModeRemoteProviderError(audit);
    }
    if (model.location === "remote" && isFullWindow(roi, input.screenshot.width, input.screenshot.height)) {
      const audit = ScreenshotModelCallAudit.parse({ ...baseAudit, leftLocal: false, outcome: "blocked" });
      await this.audits.append(audit);
      throw new ScreenshotMinimizationError("remote providers may not receive an uncropped full-window screenshot");
    }
    if (model.location === "remote" && requiresSemanticMinimization(input.purpose)) {
      const identityDiscovery = input.purpose === "account_identity" && input.callRole === "identity_locator";
      const missingIdentityRegions = input.purpose === "account_identity" && !identityDiscovery && requiredVisibleRegions.length !== 4;
      const hasUnprotectedPixels = !requiredVisibleRegions.some((region) => contains(region, roi));
      const missingSemanticMasks = hasUnprotectedPixels
        && (input.purpose === "grounding" || input.purpose === "verification" || input.purpose === "table_read")
        && !(["other_campaign", "unrelated_financial_data"] as const)
          .every((category) => appliedMasks.some((mask) => mask.category === category));
      const invalidVisibleRegion = requiredVisibleRegions.some((region) => !contains(roi, region));
      const obscuredVisibleRegion = requiredVisibleRegions.some((region) => appliedMasks.some((mask) => intersection(region, mask.region) !== undefined));
      if ((!requiredVisibleRegions.length && !identityDiscovery) || missingIdentityRegions || missingSemanticMasks || invalidVisibleRegion || obscuredVisibleRegion) {
        const audit = ScreenshotModelCallAudit.parse({ ...baseAudit, leftLocal: false, outcome: "blocked" });
        await this.audits.append(audit);
        const requirement = input.purpose === "account_identity"
          ? "remote identity review requires four explicit local evidence regions that remain unmasked"
          : input.purpose === "table_read"
            ? "remote table reading requires explicit visible target regions plus other-campaign and unrelated-financial-data masks"
            : "remote visual processing requires an explicit unmasked target plus other-campaign and unrelated-financial-data masks for surrounding pixels";
        throw new ScreenshotMinimizationError(requirement);
      }
    }
    const image = await Jimp.fromBuffer(screenshotBuffer(input.screenshot.base64));
    if (image.width !== input.screenshot.width || image.height !== input.screenshot.height) {
      throw new Error(`screenshot metadata does not match PNG dimensions (${input.screenshot.width}x${input.screenshot.height} vs ${image.width}x${image.height})`);
    }
    image.crop({ x: roi.x, y: roi.y, w: roi.width, h: roi.height });
    for (const mask of appliedMasks) {
      const clipped = intersection(mask.region, roi);
      if (!clipped) continue;
      const redaction = new Jimp({ width: clipped.width, height: clipped.height, color: 0x111111ff });
      image.composite(redaction, clipped.x - roi.x, clipped.y - roi.y);
    }
    const buffer = await image.getBuffer("image/png");
    const sanitized = sanitizedScreenshot(input.screenshot, buffer, roi);
    const audit = ScreenshotModelCallAudit.parse({
      ...baseAudit,
      transmittedWidth: sanitized.width,
      transmittedHeight: sanitized.height,
      outcome: "prepared"
    });
    await this.audits.append(audit);
    return { screenshot: sanitized, screenshotId, originalRoi: roi, masks: appliedMasks, fullArtifact, audit };
  }
}

export type GroundingRoiSelector = (task: VisualMicroTask, screenshot: Screenshot, tier: ModelTier) => ScreenshotRegion | Promise<ScreenshotRegion>;
export type GroundingMaskSelector = (task: VisualMicroTask, screenshot: Screenshot, tier: ModelTier) => ScreenshotMask[] | Promise<ScreenshotMask[]>;

/** Forces grounding providers to see only a sanitized ROI and restores full-image coordinates. */
export class PrivacyAwareGroundingProvider implements VisualGroundingProvider {
  readonly id: string;
  readonly kind: VisualGroundingProvider["kind"];

  constructor(
    private readonly underlying: VisualGroundingProvider,
    private readonly privacy: ScreenshotPrivacyPipeline,
    private readonly clientId: (task: VisualMicroTask) => string,
    private readonly roi: GroundingRoiSelector,
    private readonly model: (tier: ModelTier) => ModelPrivacyDescriptor,
    private readonly privacyMode: () => ScreenshotPrivacyMode = () => "minimized",
    private readonly masks: GroundingMaskSelector = () => []
  ) {
    this.id = underlying.id;
    this.kind = underlying.kind;
  }

  async ground(task: VisualMicroTask, screenshot: Screenshot, tier: ModelTier): Promise<VisualAction> {
    const prepared = await this.privacy.prepareForModel({
      clientId: this.clientId(task),
      taskId: task.taskId ?? privacyTaskId(task),
      purpose: "grounding",
      screenshot,
      roi: await this.roi(task, screenshot, tier),
      sensitiveRegions: await this.masks(task, screenshot, tier),
      requiredVisibleRegions: taskAllowedScreenshotRegion(task, screenshot),
      includeDefaultMasks: false,
      model: this.model(tier),
      privacyMode: this.privacyMode()
    });
    const action = await this.underlying.ground(task, prepared.screenshot, tier);
    return restoreFullScreenshotCoordinates(action, prepared.originalRoi);
  }
}

export type VerificationRoiSelector = (
  expectedResult: string,
  before: Screenshot,
  after: Screenshot,
  task?: VisualMicroTask
) => { before: ScreenshotRegion; after: ScreenshotRegion } | Promise<{ before: ScreenshotRegion; after: ScreenshotRegion }>;

/** Forces verification providers to compare sanitized ROIs rather than complete captures. */
export class PrivacyAwareVisualVerifier implements VisualVerifier {
  constructor(
    private readonly underlying: VisualVerifier,
    private readonly privacy: ScreenshotPrivacyPipeline,
    private readonly context: (expectedResult: string, task?: VisualMicroTask) => { clientId: string; taskId: string },
    private readonly roi: VerificationRoiSelector,
    private readonly model: ModelPrivacyDescriptor,
    private readonly privacyMode: () => ScreenshotPrivacyMode = () => "minimized",
    private readonly masks: (expectedResult: string, screenshot: Screenshot, phase: "before" | "after", task?: VisualMicroTask) => ScreenshotMask[] | Promise<ScreenshotMask[]> = () => []
  ) {}

  async verify(expectedResult: string, before: Screenshot, after: Screenshot, task?: VisualMicroTask): Promise<{ matched: boolean; confidence: number; reason: string }> {
    const context = this.context(expectedResult, task);
    const regions = await this.roi(expectedResult, before, after, task);
    const [privateBefore, privateAfter] = await Promise.all([
      this.privacy.prepareForModel({
        ...context,
        purpose: "verification",
        screenshot: before,
        roi: regions.before,
        sensitiveRegions: await this.masks(expectedResult, before, "before", task),
        requiredVisibleRegions: taskAllowedScreenshotRegion(task, before),
        includeDefaultMasks: false,
        model: this.model,
        privacyMode: this.privacyMode()
      }),
      this.privacy.prepareForModel({
        ...context,
        purpose: "verification",
        screenshot: after,
        roi: regions.after,
        sensitiveRegions: await this.masks(expectedResult, after, "after", task),
        requiredVisibleRegions: taskAllowedScreenshotRegion(task, after),
        includeDefaultMasks: false,
        model: this.model,
        privacyMode: this.privacyMode()
      })
    ]);
    return this.underlying.verify(expectedResult, privateBefore.screenshot, privateAfter.screenshot, task);
  }
}

/** Forces account-identity reviewers to receive only a masked browser ROI. */
export class PrivacyAwareVisualIdentityReviewer implements VisualIdentityReviewer {
  readonly id: string;

  constructor(
    private readonly underlying: VisualIdentityReviewer,
    private readonly privacy: ScreenshotPrivacyPipeline,
    private readonly roi: (expected: ExpectedVisualIdentity, screenshot: Screenshot) => ScreenshotRegion | Promise<ScreenshotRegion>,
    private readonly model: ModelPrivacyDescriptor,
    private readonly privacyMode: () => ScreenshotPrivacyMode = () => "minimized",
    private readonly masks: (expected: ExpectedVisualIdentity, screenshot: Screenshot) => ScreenshotMask[] | Promise<ScreenshotMask[]> = () => [],
    private readonly includeDefaultMasks = true,
    private readonly role: "locator" | "verifier" = "verifier"
  ) {
    this.id = underlying.id;
  }

  async review(expected: ExpectedVisualIdentity, screenshot: Screenshot) {
    const locating = !expected.evidenceRegions && this.role === "locator";
    const prepared = await this.privacy.prepareForModel({
      clientId: expected.clientId,
      taskId: expected.taskId,
      purpose: "account_identity",
      callRole: locating ? "identity_locator" : "identity_verifier",
      screenshot,
      roi: await this.roi(expected, screenshot),
      sensitiveRegions: await this.masks(expected, screenshot),
      requiredVisibleRegions: expected.evidenceRegions ? Object.values(expected.evidenceRegions) : [],
      includeDefaultMasks: locating || this.includeDefaultMasks,
      model: this.model,
      privacyMode: this.privacyMode()
    });
    const relativeExpected = expected.evidenceRegions
      ? {
          ...expected,
          evidenceRegions: offsetIdentityRegions(expected.evidenceRegions, -prepared.originalRoi.x, -prepared.originalRoi.y)
        }
      : expected;
    const observation = VisualIdentityObservation.parse(await this.underlying.review(relativeExpected, prepared.screenshot));
    return VisualIdentityObservation.parse({
      ...observation,
      regions: Object.fromEntries(Object.entries(observation.regions).map(([key, region]) => [key, {
        ...region,
        x: region.x + prepared.originalRoi.x,
        y: region.y + prepared.originalRoi.y
      }]))
    });
  }
}

/** Conservative browser-content ROI when a task has not supplied a tighter region. */
export function defaultBrowserContentRoi(width: number, height: number): ScreenshotRegion {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) throw new Error("valid screenshot dimensions are required");
  const top = Math.min(height - 1, Math.max(1, Math.round(height * 0.12)));
  return { x: 0, y: top, width, height: height - top };
}

export function defaultSensitiveMasks(width: number, height: number): ScreenshotMask[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("valid screenshot dimensions are required");
  const topBar = Math.max(1, Math.round(height * 0.1));
  const personalWidth = Math.max(1, Math.round(width * 0.28));
  const personalHeight = Math.max(1, Math.round(height * 0.16));
  const notificationHeight = Math.max(1, Math.round(height * 0.18));
  const notificationY = Math.min(height - 1, personalHeight);
  return [
    { category: "browser_tabs", region: { x: 0, y: 0, width, height: topBar }, reason: "hide unrelated browser tabs and browser chrome" },
    { category: "system_menu_bar", region: { x: 0, y: 0, width, height: Math.max(1, Math.round(height * 0.025)) }, reason: "hide system menu and status details" },
    { category: "top_personal_info", region: { x: width - personalWidth, y: 0, width: personalWidth, height: personalHeight }, reason: "hide avatar, email, and top personal information" },
    { category: "notification", region: { x: width - personalWidth, y: notificationY, width: personalWidth, height: Math.min(notificationHeight, height - notificationY) }, reason: "hide unrelated notifications" }
  ].map((mask) => ScreenshotMask.parse(mask));
}

/**
 * Builds the single tight ROI supported by current vision APIs, then locally
 * blacks out every pixel not belonging to one of the four required identity
 * evidence boxes. No model is used to discover these regions.
 */
export function minimumIdentityDisclosure(
  regions: VisualIdentityRegions | undefined,
  width: number,
  height: number
): { roi: ScreenshotRegion; masks: ScreenshotMask[]; requiredVisibleRegions: ScreenshotRegion[] } {
  if (!regions) {
    return { roi: { x: 0, y: 0, width, height }, masks: [], requiredVisibleRegions: [] };
  }
  const protectedRegions = Object.values(regions)
    .map((region) => validateRegionWithin(ScreenshotRegion.parse(region), width, height, "identity evidence region"));
  const roi = boundingRegion(protectedRegions);
  return {
    roi,
    masks: masksOutsideProtectedRegions(roi, protectedRegions),
    requiredVisibleRegions: protectedRegions
  };
}

/** Auditable redaction of everything in an ROI except explicit target pixels. */
export function masksOutsideProtectedRegions(roi: ScreenshotRegion, protectedRegions: ScreenshotRegion[]): ScreenshotMask[] {
  const clippedProtected = protectedRegions.map((region) => intersection(region, roi)).filter((region): region is ScreenshotRegion => Boolean(region));
  if (!clippedProtected.length) return [];
  const xs = [...new Set([roi.x, roi.x + roi.width, ...clippedProtected.flatMap((region) => [region.x, region.x + region.width])])].sort((a, b) => a - b);
  const ys = [...new Set([roi.y, roi.y + roi.height, ...clippedProtected.flatMap((region) => [region.y, region.y + region.height])])].sort((a, b) => a - b);
  const cells: ScreenshotRegion[] = [];
  for (let yi = 0; yi < ys.length - 1; yi += 1) {
    for (let xi = 0; xi < xs.length - 1; xi += 1) {
      const cell = { x: xs[xi]!, y: ys[yi]!, width: xs[xi + 1]! - xs[xi]!, height: ys[yi + 1]! - ys[yi]! };
      if (cell.width < 1 || cell.height < 1) continue;
      if (clippedProtected.some((region) => contains(region, cell))) continue;
      cells.push(cell);
    }
  }
  return cells.map((region, index) => ScreenshotMask.parse({
    category: index % 2 === 0 ? "other_campaign" : "unrelated_financial_data",
    region,
    reason: "redact non-essential pixels outside explicit target evidence regions"
  }));
}

export function restoreFullScreenshotCoordinates(action: VisualAction, roi: ScreenshotRegion): VisualAction {
  if (!("x" in action) || action.x === undefined || !("y" in action) || action.y === undefined) return action;
  if (action.action === "drag") {
    return { ...action, x: action.x + roi.x, y: action.y + roi.y, end_x: action.end_x + roi.x, end_y: action.end_y + roi.y };
  }
  return { ...action, x: action.x + roi.x, y: action.y + roi.y };
}

function sanitizedScreenshot(original: Screenshot, buffer: Buffer, roi: ScreenshotRegion): Screenshot {
  return {
    base64: buffer.toString("base64"),
    width: roi.width,
    height: roi.height,
    scaleFactor: original.scaleFactor,
    capturedAt: original.capturedAt,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    ...(original.surface ? { surface: original.surface } : {}),
    ...(original.surfaceFingerprint ? { surfaceFingerprint: original.surfaceFingerprint } : {})
  };
}

function validateRegionWithin(region: ScreenshotRegion, width: number, height: number, label: string): ScreenshotRegion {
  if (region.x + region.width > width || region.y + region.height > height) {
    throw new Error(`${label} is outside screenshot bounds`);
  }
  return region;
}

function intersection(left: ScreenshotRegion, right: ScreenshotRegion): ScreenshotRegion | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const endX = Math.min(left.x + left.width, right.x + right.width);
  const endY = Math.min(left.y + left.height, right.y + right.height);
  if (endX <= x || endY <= y) return undefined;
  return { x, y, width: endX - x, height: endY - y };
}

function contains(outer: ScreenshotRegion, inner: ScreenshotRegion): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function boundingRegion(regions: ScreenshotRegion[]): ScreenshotRegion {
  if (!regions.length) throw new ScreenshotMinimizationError("at least one explicit evidence region is required");
  const x = Math.min(...regions.map((region) => region.x));
  const y = Math.min(...regions.map((region) => region.y));
  const right = Math.max(...regions.map((region) => region.x + region.width));
  const bottom = Math.max(...regions.map((region) => region.y + region.height));
  return { x, y, width: right - x, height: bottom - y };
}

function offsetIdentityRegions(regions: VisualIdentityRegions, x: number, y: number): VisualIdentityRegions {
  return Object.fromEntries(Object.entries(regions).map(([key, region]) => [key, {
    ...region,
    x: region.x + x,
    y: region.y + y
  }])) as VisualIdentityRegions;
}

function taskAllowedScreenshotRegion(task: VisualMicroTask | undefined, screenshot: Screenshot): ScreenshotRegion[] {
  if (!task?.allowedRegion) return [];
  const scale = task.allowedRegion.coordinateSpace === "screen_points" ? screenshot.scaleFactor : 1;
  return [validateRegionWithin(ScreenshotRegion.parse({
    x: Math.round(task.allowedRegion.x * scale),
    y: Math.round(task.allowedRegion.y * scale),
    width: Math.round(task.allowedRegion.width * scale),
    height: Math.round(task.allowedRegion.height * scale)
  }), screenshot.width, screenshot.height, "task allowed region")];
}

function requiresSemanticMinimization(purpose: ScreenshotModelCallAudit["purpose"]): boolean {
  return purpose === "grounding" || purpose === "verification" || purpose === "table_read" || purpose === "account_identity";
}

function isFullWindow(region: ScreenshotRegion, width: number, height: number): boolean {
  return region.x === 0 && region.y === 0 && region.width === width && region.height === height;
}

function screenshotBuffer(base64: string): Buffer {
  const cleaned = base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
  const buffer = Buffer.from(cleaned, "base64");
  if (!buffer.length) throw new Error("screenshot contains no image bytes");
  return buffer;
}

function privacyTaskId(task: VisualMicroTask): string {
  return `visual_${createHash("sha256").update(`${task.instruction}\u0000${task.target}\u0000${task.expectedResult}`).digest("hex").slice(0, 24)}`;
}
