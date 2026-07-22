import { createHash } from "node:crypto";
import { Jimp } from "jimp";
import { describe, expect, it } from "vitest";
import type { Screenshot } from "./index.js";
import {
  DualVisualIdentityVerifier,
  type ExpectedVisualIdentity,
  type VisualIdentityObservation,
  type VisualIdentityReviewer
} from "./account-fingerprint.js";

const expected: ExpectedVisualIdentity = {
  clientId: "client-a",
  taskId: "task-1",
  platform: "google_ads",
  browserProfile: "google-primary",
  nativeProfileFingerprint: "Default@managed-profile",
  applicationId: "com.google.Chrome",
  windowId: "window-7",
  pageType: "campaign_budget_editor",
  accountName: "Example Ads",
  accountId: "123-456-7890",
  campaignName: "Brand Search",
  campaignId: "campaign-42",
  currency: "USD",
  currentValue: 100,
  operation: "set_daily_budget",
  proposedValue: 110,
  target: "Save budget button"
};

const observation: VisualIdentityObservation = {
  platform: "google_ads",
  pageType: "campaign_budget_editor",
  accountName: "Example Ads",
  accountId: "123-456-7890",
  campaignName: "Brand Search",
  campaignId: "campaign-42",
  currency: "USD",
  currentValue: 100,
  operation: "set_daily_budget",
  proposedValue: 110,
  target: "Save budget button",
  accountNameComplete: true,
  accountIdVisible: true,
  campaignNameComplete: true,
  campaignIdVisible: true,
  currentValueVisible: true,
  proposedValueVisible: true,
  targetVisible: true,
  unobscured: true,
  confidence: 0.94,
  regions: {
    account: { x: 2, y: 2, width: 30, height: 12 },
    campaign: { x: 2, y: 18, width: 38, height: 12 },
    currentValue: { x: 44, y: 18, width: 20, height: 12 },
    target: { x: 66, y: 44, width: 30, height: 18 }
  },
  reason: "all required identity and mutation facts are fully visible"
};

async function screenshot(overrides: Partial<NonNullable<Screenshot["surface"]>> = {}): Promise<Screenshot> {
  const png = await new Jimp({ width: 100, height: 80, color: 0xfffefeff }).getBuffer("image/png");
  return {
    base64: png.toString("base64"),
    width: 100,
    height: 80,
    scaleFactor: 1,
    capturedAt: "2026-07-22T00:00:00.000Z",
    sha256: createHash("sha256").update(png).digest("hex"),
    surface: {
      platform: "darwin",
      app: "Google Chrome",
      bundleId: "com.google.Chrome",
      browserProfile: "Default@managed-profile",
      pid: 42,
      title: "Campaigns - Google Ads",
      windowId: "window-7",
      bounds: { x: 0, y: 0, width: 100, height: 80 },
      screenId: "screen-1",
      screenBounds: { x: 0, y: 0, width: 100, height: 80 },
      scaleFactor: 1,
      ...overrides
    },
    surfaceFingerprint: "a".repeat(64)
  };
}

function reviewer(id: string, value: VisualIdentityObservation): VisualIdentityReviewer {
  return { id, review: async () => structuredClone(value) };
}

function gate(left = observation, right = observation): DualVisualIdentityVerifier {
  return new DualVisualIdentityVerifier(reviewer("gui-verifier", left), reviewer("deep-vision-reviewer", right));
}

describe("visual account fingerprint", () => {
  it("accepts two independent high-confidence observations for the exact account", async () => {
    const result = await gate().confirm(expected, await screenshot());
    expect(result.fingerprint).toMatchObject({
      accountName: "Example Ads",
      accountId: "123-456-7890",
      campaignName: "Brand Search",
      browserProfile: "google-primary",
      nativeProfileFingerprint: "Default@managed-profile",
      screenshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      criticalRegionHashes: {
        account: expect.stringMatching(/^[a-f0-9]{64}$/),
        campaign: expect.stringMatching(/^[a-f0-9]{64}$/),
        currentValue: expect.stringMatching(/^[a-f0-9]{64}$/),
        target: expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      confidence: 0.94
    });
    expect(result.fingerprintHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.targetRegion).toEqual({ x: 66, y: 44, width: 30, height: 18 });
    expect(result.reviewers.map((item) => item.id)).toEqual(["gui-verifier", "deep-vision-reviewer"]);
    const later = await gate().confirm(expected, { ...(await screenshot()), capturedAt: "2026-07-22T00:01:00.000Z", sha256: "b".repeat(64) });
    expect(later.fingerprintHash).toBe(result.fingerprintHash);
  });

  it("rejects a different account", async () => {
    const wrong = { ...observation, accountName: "Other Ads", accountId: "999-999-9999" };
    await expect(gate(wrong, wrong).confirm(expected, await screenshot())).rejects.toMatchObject({ code: "VISUAL_IDENTITY_CONFLICT" });
  });

  it("rejects a truncated Campaign name", async () => {
    const truncated = { ...observation, campaignName: "Brand Sea…", campaignNameComplete: false };
    await expect(gate(truncated, truncated).confirm(expected, await screenshot())).rejects.toMatchObject({ code: "UNRELIABLE_VISUAL_IDENTITY" });
  });

  it("rejects a changed current value", async () => {
    const changed = { ...observation, currentValue: 120 };
    await expect(gate(changed, changed).confirm(expected, await screenshot())).rejects.toMatchObject({ code: "CURRENT_VALUE_CHANGED" });
  });

  it("rejects a changed native window", async () => {
    await expect(gate().confirm(expected, await screenshot({ windowId: "window-8" }))).rejects.toMatchObject({ code: "SURFACE_CHANGED" });
  });

  it("rejects a changed native browser Profile", async () => {
    await expect(gate().confirm(expected, await screenshot({ browserProfile: "Default@other-profile" }))).rejects.toMatchObject({ code: "PROFILE_CHANGED" });
  });

  it("rejects either reviewer below 0.85", async () => {
    await expect(gate({ ...observation, confidence: 0.84 }).confirm(expected, await screenshot())).rejects.toMatchObject({ code: "UNRELIABLE_VISUAL_IDENTITY" });
  });

  it("rejects conflicting reviewer judgments", async () => {
    const conflict = { ...observation, campaignName: "Competitor Search", campaignId: "campaign-99" };
    await expect(gate(observation, conflict).confirm(expected, await screenshot())).rejects.toMatchObject({ code: "VISUAL_IDENTITY_CONFLICT" });
  });

  it("rejects obscured identity and target regions", async () => {
    await expect(gate({ ...observation, unobscured: false }, { ...observation, unobscured: false }).confirm(expected, await screenshot()))
      .rejects.toMatchObject({ code: "OBSCURED_VISUAL_IDENTITY" });
  });
});
