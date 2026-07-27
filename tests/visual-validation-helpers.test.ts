import { describe, expect, it } from "vitest";
import type {
  NativeSurface,
  Screenshot,
  VisualAction,
  VisualStepResult
} from "@adpilot/computer-use";
import {
  parseValidationArguments,
  publicBrowserSession,
  publicSurfaceIdentity,
  publicVisualAction,
  publicVisualResult,
  screenshotEvidence,
  summarizeRealBrowserRecords
} from "../scripts/visual-validation-helpers.js";

const surface: NativeSurface = {
  platform: "darwin",
  app: "Google Chrome",
  bundleId: "com.google.Chrome",
  pid: 41,
  windowId: "window-1",
  title: "Private customer – Google Ads",
  bounds: { x: 0, y: 0, width: 1200, height: 800 },
  screenId: "main",
  screenBounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
  browserProfile: "profile-hash"
};

const screenshot: Screenshot = {
  base64: Buffer.from("private pixels").toString("base64"),
  width: 1200,
  height: 800,
  scaleFactor: 2,
  capturedAt: "2026-07-27T10:00:00.000Z",
  sha256: "a".repeat(64),
  surfaceFingerprint: "b".repeat(64),
  surface
};

const typedAction: VisualAction = {
  action: "type",
  text: "SECRET-DRAFT-123",
  target: "daily budget input",
  reason: "replace only the draft",
  confidence: 0.99,
  expected_result: "draft is visible",
  risk_level: "interact"
};

describe("Google Ads validation evidence redaction", () => {
  it("removes typed text, keys, coordinates, and screenshot pixels from public results", () => {
    const result: VisualStepResult = {
      status: "done",
      attempts: 1,
      action: typedAction,
      before: screenshot,
      after: { ...screenshot, sha256: "c".repeat(64) },
      executed: true,
      verified: true
    };
    const output = publicVisualResult(
      result,
      { file: "001-before.png", sha256: "a".repeat(64) },
      { file: "002-after.png", sha256: "d".repeat(64) },
      {
        matched: true,
        confidence: 0.97,
        minimumConfidence: 0.8,
        reason: "draft remains unsubmitted"
      }
    );
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain("base64");
    expect(serialized).not.toContain("SECRET-DRAFT-123");
    expect(serialized).not.toContain('"text"');
    expect(serialized).not.toContain('"keys"');
    expect(serialized).not.toContain('"x"');
    expect(serialized).not.toContain('"y"');
    expect(output).toMatchObject({
      status: "done",
      confirmationPassed: true,
      evidence: {
        beforeFile: "001-before.png",
        afterFile: "002-after.png",
        afterSha256: "d".repeat(64)
      }
    });
  });

  it("redacts native window titles and browser profile directories", () => {
    const browser = publicBrowserSession({
      sessionId: "session-1",
      clientId: "client-1",
      browserProfile: "Work",
      nativeProfileFingerprint: "profile-hash",
      processId: 41,
      windowId: "window-1",
      platform: "google_ads",
      browserApplicationId: "com.google.Chrome",
      browserApp: "Google Chrome",
      sessionStatus: "connected",
      startedAt: "2026-07-27T10:00:00.000Z",
      updatedAt: "2026-07-27T10:01:00.000Z",
      profileDirectory: "/Users/example/private-profile"
    } as Parameters<typeof publicBrowserSession>[0] & { profileDirectory: string });
    const identity = publicSurfaceIdentity({ fingerprint: "b".repeat(64), surface });
    const serialized = JSON.stringify({ browser, identity });

    expect(serialized).not.toContain("profileDirectory");
    expect(serialized).not.toContain("/Users/example/private-profile");
    expect(serialized).not.toContain("Private customer");
    expect(serialized).not.toContain('"title"');
  });

  it("keeps only screenshot metadata and a local evidence filename", () => {
    const serialized = JSON.stringify(screenshotEvidence(screenshot, {
      file: "001-before.png",
      sha256: screenshot.sha256
    }));

    expect(serialized).toContain("001-before.png");
    expect(serialized).toContain(screenshot.sha256);
    expect(serialized).not.toContain(screenshot.base64);
    expect(serialized).not.toContain("Private customer");
  });

  it("sanitizes failed last actions too", () => {
    const output = publicVisualResult(
      {
        status: "failed",
        attempts: 1,
        blocker: "verification failed",
        blockerCode: "VERIFICATION_FAILED",
        lastAction: typedAction
      },
      { file: "001-before.png", sha256: "a".repeat(64) }
    );

    expect(JSON.stringify(output)).not.toContain("SECRET-DRAFT-123");
    expect(publicVisualAction(undefined)).toEqual({});
  });

  it("counts only independently passed records and reads camel-case public risk levels", () => {
    const summary = summarizeRealBrowserRecords([
      {
        stepPassed: true,
        result: { status: "done", attempts: 1 },
        latencyMs: 120,
        task: { riskLevel: "observe" },
        events: [
          { type: "grounded", tier: "gui" },
          { type: "executed", action: { riskLevel: "interact" } },
          { type: "verified", matched: true }
        ]
      },
      {
        stepPassed: false,
        result: { status: "done", attempts: 2 },
        latencyMs: 180,
        task: { riskLevel: "interact" },
        events: [
          { type: "grounded", tier: "strong" },
          { type: "executed" },
          { type: "verified", matched: false }
        ]
      }
    ]);

    expect(summary.completed).toBe(1);
    expect(summary.grounded).toBe(2);
    expect(summary.unsafe).toBe(2);
    expect(summary.escalated).toBe(1);
    expect(summary.retries).toEqual([0, 1]);
    expect(summary.latencies).toEqual([120, 180]);
  });

  it("rejects unknown, duplicate, missing, and valueless CLI flags", () => {
    const valid = parseValidationArguments("prepare", [
      "--",
      "--client", "client-1",
      "--browser-profile", "Work",
      "--campaign", "Brand",
      "--draft-budget", "120"
    ]);
    expect(valid.get("--draft-budget")).toBe("120");
    expect(() => parseValidationArguments("readonly", [
      "--client", "client-1",
      "--browser-profile", "Work",
      "--campaign", "Brand",
      "--draft-budget", "120"
    ])).toThrow("unknown validation argument");
    expect(() => parseValidationArguments("readonly", [
      "--client", "client-1",
      "--client", "client-2",
      "--browser-profile", "Work",
      "--campaign", "Brand"
    ])).toThrow("only once");
    expect(() => parseValidationArguments("readonly", [
      "--client", "--browser-profile", "Work", "--campaign", "Brand"
    ])).toThrow("requires one value");
    expect(() => parseValidationArguments("readonly", [
      "--client", "client-1", "--browser-profile", "Work"
    ])).toThrow("--campaign is required");
  });
});
