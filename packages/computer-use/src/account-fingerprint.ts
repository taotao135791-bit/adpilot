import { createHash } from "node:crypto";
import { Jimp } from "jimp";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { z } from "zod";
import { Platform, stableJson } from "@adpilot/shared";
import type { Screenshot } from "./index.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const IdentityValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const VisualIdentityRegion = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
}).strict();
export type VisualIdentityRegion = z.infer<typeof VisualIdentityRegion>;

/**
 * A model observation, before it is trusted. Nullable text is intentional:
 * reviewers must report unreadable values instead of completing them from the
 * task prompt.
 */
export const VisualIdentityObservation = z.object({
  platform: Platform.nullable(),
  pageType: z.string().min(1).nullable(),
  accountName: z.string().min(1).nullable(),
  accountId: z.string().min(1).nullable(),
  campaignName: z.string().min(1).nullable(),
  campaignId: z.string().min(1).nullable(),
  currency: z.string().min(1).nullable(),
  currentValue: IdentityValue,
  operation: z.string().min(1).nullable(),
  proposedValue: IdentityValue,
  target: z.string().min(1).nullable(),
  accountNameComplete: z.boolean(),
  accountIdVisible: z.boolean(),
  campaignNameComplete: z.boolean(),
  campaignIdVisible: z.boolean(),
  currentValueVisible: z.boolean(),
  proposedValueVisible: z.boolean(),
  targetVisible: z.boolean(),
  unobscured: z.boolean(),
  confidence: z.number().min(0).max(1),
  regions: z.object({
    account: VisualIdentityRegion,
    campaign: VisualIdentityRegion,
    currentValue: VisualIdentityRegion,
    target: VisualIdentityRegion
  }).strict(),
  reason: z.string().min(1)
}).strict();
export type VisualIdentityObservation = z.infer<typeof VisualIdentityObservation>;

export const ExpectedVisualIdentity = z.object({
  clientId: z.string().min(1),
  taskId: z.string().min(1),
  platform: Platform,
  browserProfile: z.string().min(1),
  applicationId: z.string().min(1),
  windowId: z.string().min(1),
  pageType: z.string().min(1),
  accountName: z.string().min(1),
  accountId: z.string().min(1),
  campaignName: z.string().min(1),
  campaignId: z.string().min(1),
  currency: z.string().min(1).nullable(),
  currentValue: IdentityValue,
  operation: z.string().min(1),
  proposedValue: IdentityValue,
  target: z.string().min(1)
}).strict();
export type ExpectedVisualIdentity = z.infer<typeof ExpectedVisualIdentity>;

export const VisualAccountFingerprint = z.object({
  platform: Platform,
  browserProfile: z.string().min(1),
  applicationId: z.string().min(1),
  windowId: z.string().min(1),
  windowTitle: z.string().min(1),
  pageType: z.string().min(1),
  accountName: z.string().min(1),
  accountId: z.string().min(1),
  campaignName: z.string().min(1),
  campaignId: z.string().min(1),
  currency: z.string().min(1).nullable(),
  currentValue: IdentityValue,
  screenshotHash: Sha256,
  criticalRegionHashes: z.object({
    account: Sha256,
    campaign: Sha256,
    currentValue: Sha256,
    target: Sha256
  }).strict(),
  capturedAt: z.string().datetime(),
  confidence: z.number().min(0.85).max(1)
}).strict();
export type VisualAccountFingerprint = z.infer<typeof VisualAccountFingerprint>;

export interface VisualIdentityReviewer {
  /** Role-qualified identity. Independent reviewers must not share this id. */
  readonly id: string;
  review(expected: ExpectedVisualIdentity, screenshot: Screenshot): Promise<VisualIdentityObservation>;
}

export const VisualIdentityErrorCode = z.enum([
  "SURFACE_CHANGED",
  "PROFILE_CHANGED",
  "UNRELIABLE_VISUAL_IDENTITY",
  "VISUAL_IDENTITY_CONFLICT",
  "OBSCURED_VISUAL_IDENTITY",
  "CURRENT_VALUE_CHANGED"
]);
export type VisualIdentityErrorCode = z.infer<typeof VisualIdentityErrorCode>;

export class VisualIdentityError extends Error {
  constructor(readonly code: VisualIdentityErrorCode, message: string) {
    super(message);
    this.name = "VisualIdentityError";
  }
}

export interface ConfirmedVisualIdentity {
  fingerprint: VisualAccountFingerprint;
  fingerprintHash: string;
  reviewers: [
    { id: string; confidence: number; reason: string },
    { id: string; confidence: number; reason: string }
  ];
}

/**
 * Stable identity binding used inside an execution plan. Volatile screenshot
 * evidence remains in VisualAccountFingerprint and the audit log, while this
 * hash changes only when an execution-critical identity fact changes.
 */
export function visualAccountFingerprintHash(input: VisualAccountFingerprint): string {
  const fingerprint = VisualAccountFingerprint.parse(input);
  return createHash("sha256").update(stableJson({
    platform: fingerprint.platform,
    browserProfile: fingerprint.browserProfile,
    applicationId: fingerprint.applicationId,
    windowId: fingerprint.windowId,
    pageType: fingerprint.pageType,
    accountName: fingerprint.accountName,
    accountId: fingerprint.accountId,
    campaignName: fingerprint.campaignName,
    campaignId: fingerprint.campaignId,
    currency: fingerprint.currency,
    currentValue: fingerprint.currentValue
  })).digest("hex");
}

/**
 * Mutation identity gate. It trusts native process/window metadata for the
 * surface and requires two separately invoked vision reviewers to agree on
 * every execution-critical fact visible in the pixels.
 */
export class DualVisualIdentityVerifier {
  constructor(
    private readonly guiVerifier: VisualIdentityReviewer,
    private readonly deepVisionReviewer: VisualIdentityReviewer,
    private readonly minimumConfidence = 0.85
  ) {
    if (guiVerifier.id === deepVisionReviewer.id) throw new Error("visual identity reviewers require distinct role ids");
    if (minimumConfidence < 0.85 || minimumConfidence > 1) throw new Error("visual identity confidence threshold must be between 0.85 and 1");
  }

  async confirm(expectedInput: ExpectedVisualIdentity, screenshot: Screenshot): Promise<ConfirmedVisualIdentity> {
    const expected = ExpectedVisualIdentity.parse(expectedInput);
    const surface = screenshot.surface;
    if (!surface) throw new VisualIdentityError("SURFACE_CHANGED", "visual account identity requires a native window-bound screenshot");
    const applicationId = surface.bundleId ?? surface.app;
    if (applicationId !== expected.applicationId || surface.windowId !== expected.windowId) {
      throw new VisualIdentityError("SURFACE_CHANGED", "native application or window no longer matches the approved visual plan");
    }
    if (!surface.browserProfile || surface.browserProfile !== expected.browserProfile) {
      throw new VisualIdentityError("PROFILE_CHANGED", "native browser Profile no longer matches the approved visual plan");
    }
    if (!surface.title.trim()) throw new VisualIdentityError("SURFACE_CHANGED", "native browser window title is unavailable");

    const [gui, deep] = await Promise.all([
      this.guiVerifier.review(expected, screenshot).then((value) => VisualIdentityObservation.parse(value)),
      this.deepVisionReviewer.review(expected, screenshot).then((value) => VisualIdentityObservation.parse(value))
    ]);
    for (const [reviewer, observation] of [[this.guiVerifier, gui], [this.deepVisionReviewer, deep]] as const) {
      if (observation.confidence < this.minimumConfidence) {
        throw new VisualIdentityError("UNRELIABLE_VISUAL_IDENTITY", `${reviewer.id} confidence ${observation.confidence.toFixed(2)} is below ${this.minimumConfidence.toFixed(2)}`);
      }
      ensureCompleteIdentity(reviewer.id, observation);
      ensureMatchesExpected(reviewer.id, observation, expected);
      validateObservationRegions(observation, screenshot);
    }
    ensureReviewerAgreement(gui, deep);
    ensureRegionAgreement(gui, deep);

    const criticalRegionHashes = {
      account: await hashAgreedRegion(screenshot, gui.regions.account, deep.regions.account),
      campaign: await hashAgreedRegion(screenshot, gui.regions.campaign, deep.regions.campaign),
      currentValue: await hashAgreedRegion(screenshot, gui.regions.currentValue, deep.regions.currentValue),
      target: await hashAgreedRegion(screenshot, gui.regions.target, deep.regions.target)
    };
    const fingerprint = VisualAccountFingerprint.parse({
      platform: expected.platform,
      browserProfile: expected.browserProfile,
      applicationId: expected.applicationId,
      windowId: expected.windowId,
      windowTitle: surface.title,
      pageType: expected.pageType,
      accountName: expected.accountName,
      accountId: expected.accountId,
      campaignName: expected.campaignName,
      campaignId: expected.campaignId,
      currency: expected.currency,
      currentValue: expected.currentValue,
      screenshotHash: screenshot.sha256,
      criticalRegionHashes,
      capturedAt: screenshot.capturedAt,
      confidence: Math.min(gui.confidence, deep.confidence)
    });
    return {
      fingerprint,
      fingerprintHash: visualAccountFingerprintHash(fingerprint),
      reviewers: [
        { id: this.guiVerifier.id, confidence: gui.confidence, reason: gui.reason },
        { id: this.deepVisionReviewer.id, confidence: deep.confidence, reason: deep.reason }
      ]
    };
  }
}

/** Uses the configured image-capable Pi model for one isolated identity review. */
export class PiVisualIdentityReviewer implements VisualIdentityReviewer {
  constructor(
    private readonly models: Models,
    private readonly model: Model<Api>,
    readonly id: string
  ) {
    if (!model.input.includes("image")) throw new Error(`identity reviewer does not accept screenshots: ${model.provider}/${model.id}`);
    if (!id) throw new Error("identity reviewer id is required");
  }

  async review(expected: ExpectedVisualIdentity, screenshot: Screenshot): Promise<VisualIdentityObservation> {
    const messages = [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: identityRequest(expected, screenshot) },
        { type: "image" as const, data: screenshot.base64, mimeType: "image/png" }
      ],
      timestamp: Date.now()
    }];
    let response = await this.models.completeSimple(this.model, { systemPrompt: identitySystemPrompt(), messages }, {
      temperature: 0, maxTokens: 1400, maxRetries: 1, timeoutMs: 20_000
    });
    let invalid = assistantText(response);
    for (let pass = 1; pass <= 2; pass += 1) {
      try { return VisualIdentityObservation.parse(parseJsonObject(invalid)); }
      catch (error) {
        if (pass === 2) throw new VisualIdentityError("UNRELIABLE_VISUAL_IDENTITY", `${this.id} returned invalid identity JSON: ${errorMessage(error)}`);
        response = await this.models.completeSimple(this.model, {
          systemPrompt: identitySystemPrompt(),
          messages: [{
            role: "user",
            content: [{ type: "text", text: `Repair this invalid observation without inventing unreadable facts. Return JSON only.\n${invalid}` }],
            timestamp: Date.now()
          }]
        }, { temperature: 0, maxTokens: 1400, maxRetries: 1, timeoutMs: 20_000 });
        invalid = assistantText(response);
      }
    }
    throw new VisualIdentityError("UNRELIABLE_VISUAL_IDENTITY", `${this.id} did not return an identity observation`);
  }
}

/** OpenAI-compatible identity reviewer used by the built-in GUI verifier route. */
export class OpenAICompatibleVisualIdentityReviewer implements VisualIdentityReviewer {
  private readonly request: typeof fetch;

  constructor(
    readonly id: string,
    private readonly config: { baseURL: string; model: string; apiKey?: string; timeoutMs?: number; fetch?: typeof fetch }
  ) {
    if (!id || !config.baseURL || !config.model) throw new Error("identity reviewer id, endpoint, and model are required");
    this.request = config.fetch ?? globalThis.fetch;
  }

  async review(expected: ExpectedVisualIdentity, screenshot: Screenshot): Promise<VisualIdentityObservation> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 20_000);
    try {
      const response = await this.request(`${this.config.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: identitySystemPrompt() },
            { role: "user", content: [
              { type: "text", text: identityRequest(expected, screenshot) },
              { type: "image_url", image_url: { url: `data:image/png;base64,${screenshot.base64}` } }
            ] }
          ]
        })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return VisualIdentityObservation.parse(parseJsonObject(body.choices?.[0]?.message?.content ?? ""));
    } catch (error) {
      throw new VisualIdentityError("UNRELIABLE_VISUAL_IDENTITY", `${this.id} identity review failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function ensureCompleteIdentity(reviewer: string, observation: VisualIdentityObservation): void {
  if (!observation.unobscured) throw new VisualIdentityError("OBSCURED_VISUAL_IDENTITY", `${reviewer} reports that critical identity is obscured`);
  const checks = [
    [observation.accountName !== null && observation.accountNameComplete, "account name"],
    [observation.accountId !== null && observation.accountIdVisible, "account id"],
    [observation.campaignName !== null && observation.campaignNameComplete, "campaign name"],
    [observation.campaignId !== null && observation.campaignIdVisible, "campaign id"],
    [observation.currentValueVisible, "current value"],
    [observation.proposedValueVisible, "proposed value"],
    [observation.target !== null && observation.targetVisible, "target control"],
    [observation.platform !== null, "platform"],
    [observation.pageType !== null, "page type"],
    [observation.operation !== null, "operation"]
  ] as const;
  const missing = checks.filter(([visible]) => !visible).map(([, label]) => label);
  if (missing.length) throw new VisualIdentityError("UNRELIABLE_VISUAL_IDENTITY", `${reviewer} could not fully read: ${missing.join(", ")}`);
}

function ensureMatchesExpected(reviewer: string, observation: VisualIdentityObservation, expected: ExpectedVisualIdentity): void {
  const textFields = ["platform", "pageType", "accountName", "accountId", "campaignName", "campaignId", "currency", "operation", "target"] as const;
  for (const field of textFields) {
    if (canonicalText(observation[field]) !== canonicalText(expected[field])) {
      throw new VisualIdentityError("VISUAL_IDENTITY_CONFLICT", `${reviewer} observed a different ${field}`);
    }
  }
  if (stableJson(observation.currentValue) !== stableJson(expected.currentValue)) {
    throw new VisualIdentityError("CURRENT_VALUE_CHANGED", `${reviewer} observed a different current value`);
  }
  if (stableJson(observation.proposedValue) !== stableJson(expected.proposedValue)) {
    throw new VisualIdentityError("VISUAL_IDENTITY_CONFLICT", `${reviewer} observed a different proposed value`);
  }
}

function ensureReviewerAgreement(left: VisualIdentityObservation, right: VisualIdentityObservation): void {
  const fields = ["platform", "pageType", "accountName", "accountId", "campaignName", "campaignId", "currency", "operation", "target"] as const;
  for (const field of fields) {
    if (canonicalText(left[field]) !== canonicalText(right[field])) {
      throw new VisualIdentityError("VISUAL_IDENTITY_CONFLICT", `visual reviewers disagree on ${field}`);
    }
  }
  if (stableJson(left.currentValue) !== stableJson(right.currentValue)) {
    throw new VisualIdentityError("VISUAL_IDENTITY_CONFLICT", "visual reviewers disagree on currentValue");
  }
  if (stableJson(left.proposedValue) !== stableJson(right.proposedValue)) {
    throw new VisualIdentityError("VISUAL_IDENTITY_CONFLICT", "visual reviewers disagree on proposedValue");
  }
}

function ensureRegionAgreement(left: VisualIdentityObservation, right: VisualIdentityObservation): void {
  for (const key of ["account", "campaign", "currentValue", "target"] as const) {
    if (intersectionOverUnion(left.regions[key], right.regions[key]) < 0.5) {
      throw new VisualIdentityError("VISUAL_IDENTITY_CONFLICT", `visual reviewers disagree on ${key} evidence region`);
    }
  }
}

function validateObservationRegions(observation: VisualIdentityObservation, screenshot: Screenshot): void {
  for (const [name, region] of Object.entries(observation.regions)) {
    if (region.x + region.width > screenshot.width || region.y + region.height > screenshot.height) {
      throw new VisualIdentityError("UNRELIABLE_VISUAL_IDENTITY", `${name} evidence region is outside the current screenshot`);
    }
  }
}

async function hashAgreedRegion(screenshot: Screenshot, left: VisualIdentityRegion, right: VisualIdentityRegion): Promise<string> {
  const intersection = intersect(left, right);
  if (!intersection) throw new VisualIdentityError("VISUAL_IDENTITY_CONFLICT", "reviewer evidence regions do not overlap");
  const buffer = Buffer.from(screenshot.base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, ""), "base64");
  const image = await Jimp.fromBuffer(buffer);
  if (image.width !== screenshot.width || image.height !== screenshot.height) {
    throw new VisualIdentityError("UNRELIABLE_VISUAL_IDENTITY", "screenshot dimensions do not match its pixel payload");
  }
  image.crop({ x: intersection.x, y: intersection.y, w: intersection.width, h: intersection.height });
  const pixels = await image.getBuffer("image/png");
  return createHash("sha256").update(pixels).digest("hex");
}

function intersect(left: VisualIdentityRegion, right: VisualIdentityRegion): VisualIdentityRegion | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const endX = Math.min(left.x + left.width, right.x + right.width);
  const endY = Math.min(left.y + left.height, right.y + right.height);
  if (endX <= x || endY <= y) return undefined;
  return { x, y, width: endX - x, height: endY - y };
}

function intersectionOverUnion(left: VisualIdentityRegion, right: VisualIdentityRegion): number {
  const overlap = intersect(left, right);
  if (!overlap) return 0;
  const overlapArea = overlap.width * overlap.height;
  return overlapArea / (left.width * left.height + right.width * right.height - overlapArea);
}

function canonicalText(value: string | null): string {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function identitySystemPrompt(): string {
  return [
    "You are one independent visual safety reviewer for an advertising GUI mutation.",
    "Read only pixels in the supplied screenshot. The expected fields are comparison targets, never a source of facts.",
    "Never infer truncated, hidden, obscured, off-screen, or remembered text. Use null/false and lower confidence when any fact is not fully visible.",
    "Return one JSON object matching every requested key. Numeric values must be normalized JSON numbers without currency symbols.",
    "All regions are absolute screenshot-pixel rectangles {x,y,width,height}."
  ].join("\n");
}

function identityRequest(expected: ExpectedVisualIdentity, screenshot: Screenshot): string {
  return JSON.stringify({
    instruction: "Independently identify all visible facts and the exact control that would be changed.",
    expectedForComparisonOnly: expected,
    screenshot: { width: screenshot.width, height: screenshot.height },
    outputKeys: [
      "platform", "pageType", "accountName", "accountId", "campaignName", "campaignId", "currency", "currentValue",
      "operation", "proposedValue", "target", "accountNameComplete", "accountIdVisible", "campaignNameComplete",
      "campaignIdVisible", "currentValueVisible", "proposedValueVisible", "targetVisible", "unobscured", "confidence",
      "regions.account", "regions.campaign", "regions.currentValue", "regions.target", "reason"
    ]
  });
}

function assistantText(message: AssistantMessage): string {
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? "identity vision model failed");
  return message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
}

function parseJsonObject(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(cleaned); }
  catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("model did not return a JSON object");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
