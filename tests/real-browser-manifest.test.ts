import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp } from "jimp";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessRealBrowserManifest,
  readRealBrowserManifest,
  RealBrowserValidationManifest,
  sha256Text,
  verifyRealBrowserEvidence
} from "../scripts/real-browser-manifest.js";

const temporaryRoots: string[] = [];
const startedAt = "2026-07-27T10:00:00.000Z";
const completedAt = "2026-07-27T10:00:05.000Z";
const confirmationMinimumConfidence = 0.8;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("real-browser validation manifest", () => {
  it("accepts a coherent schema-v2 run and verifies every evidence file hash", async () => {
    const fixture = await createFixture();
    const manifest = RealBrowserValidationManifest.parse(fixture.manifest);
    await writeFile(fixture.path, JSON.stringify(manifest));

    expect(assessRealBrowserManifest(manifest)).toEqual([]);
    expect(await verifyRealBrowserEvidence(fixture.path, manifest)).toEqual([]);
    expect(await readRealBrowserManifest(fixture.path)).toEqual(manifest);
  });

  it("rejects empty-record and partial-record fake success", async () => {
    const fixture = await createFixture();
    const empty = RealBrowserValidationManifest.parse({ ...fixture.manifest, records: [] });

    expect(assessRealBrowserManifest(empty)).toContain(
      "expected 2 records for prepare, received 0"
    );
    expect(RealBrowserValidationManifest.safeParse({
      ...fixture.manifest,
      records: [{ stepPassed: true }, { stepPassed: true }]
    }).success).toBe(false);
  });

  it("rejects unknown risk, out-of-order steps, and unbound prepare text", async () => {
    const fixture = await createFixture();
    const unknownRisk = structuredClone(fixture.manifest) as any;
    unknownRisk.records[0].result.action.riskLevel = "unknown";
    expect(RealBrowserValidationManifest.safeParse(unknownRisk).success).toBe(false);

    const parsed = RealBrowserValidationManifest.parse(fixture.manifest);
    parsed.records[0]!.task.stepId = "prepare-02";
    const firstResult = parsed.records[0]!.result;
    if (firstResult.status !== "done") throw new Error("fixture result must be done");
    firstResult.action.inputSha256 = "f".repeat(64);
    expect(assessRealBrowserManifest(parsed)).toEqual(expect.arrayContaining([
      "record 1 has unexpected stepId",
      "prepare text was not bound to the exact approved payload"
    ]));
  });

  it("rejects missing, tampered, symlink-like, and escaping evidence paths", async () => {
    const fixture = await createFixture();
    const manifest = RealBrowserValidationManifest.parse(fixture.manifest);
    await writeFile(
      join(fixture.root, manifest.records[0]!.evidence.before!.file),
      await readFile(join(fixture.root, manifest.records[0]!.evidence.after!.file))
    );
    expect(await verifyRealBrowserEvidence(fixture.path, manifest)).toContain(
      `evidence hash mismatch: ${manifest.records[0]!.evidence.before!.file}`
    );

    const escaping = structuredClone(fixture.manifest) as any;
    escaping.records[0].evidence.before.file = "../private.png";
    expect(RealBrowserValidationManifest.safeParse(escaping).success).toBe(false);

    const symlinkManifest = RealBrowserValidationManifest.parse(fixture.manifest);
    const original = symlinkManifest.records[0]!.evidence.after!.file;
    await symlink(join(fixture.root, original), join(fixture.root, "linked.png"));
    symlinkManifest.records[0]!.evidence.after!.file = "linked.png";
    expect(await verifyRealBrowserEvidence(fixture.path, symlinkManifest)).toContain(
      "evidence file is unavailable: linked.png"
    );
  });

  it("does not accept matched=true below the declared confidence threshold", async () => {
    const fixture = await createFixture();
    const manifest = RealBrowserValidationManifest.parse(fixture.manifest);
    manifest.records[0]!.result = {
      ...manifest.records[0]!.result,
      status: "done",
      confirmationPassed: true,
      confirmation: {
        matched: true,
        confidence: 0.2,
        minimumConfidence: confirmationMinimumConfidence,
        reason: "uncertain"
      }
    } as Extract<typeof manifest.records[number]["result"], { status: "done" }>;

    expect(assessRealBrowserManifest(manifest)).toContain(
      "record 1 lacks the required visual confirmation"
    );
  });

  it("rejects non-canonical permissions, missing execution, reused evidence, and cross-client events", async () => {
    const fixture = await createFixture();
    const manifest = RealBrowserValidationManifest.parse(fixture.manifest);
    manifest.records[1]!.task.allowedActions = ["hotkey"];
    const firstResult = manifest.records[0]!.result;
    if (firstResult.status !== "done") throw new Error("fixture result must be done");
    firstResult.executed = false;
    firstResult.verified = false;
    manifest.records[0]!.events = manifest.records[0]!.events.filter((event) => event.type !== "executed");
    manifest.records[1]!.evidence.before!.file = manifest.records[0]!.evidence.before!.file;
    const secondResult = manifest.records[1]!.result;
    if (secondResult.status !== "done") throw new Error("fixture result must be done");
    secondResult.evidence.beforeFile = manifest.records[0]!.evidence.before!.file;
    manifest.records[1]!.events[0]!.clientId = "other-client";

    expect(assessRealBrowserManifest(manifest)).toEqual(expect.arrayContaining([
      "record 2 task policy is not canonical",
      "record 1 lacks one verified native execution",
      "record 2 reuses evidence filename",
      "record 2 contains an unscoped event"
    ]));
  });

  it("requires explicit confirmation provenance and capture-linked evidence", async () => {
    const fixture = await createFixture();
    const manifest = RealBrowserValidationManifest.parse(fixture.manifest);
    manifest.records[1]!.events = manifest.records[1]!.events.filter((event) =>
      !(event.type === "verified" && event.attempt === 0)
    );
    const afterHash = manifest.records[0]!.evidence.after!.sha256;
    manifest.records[0]!.events = manifest.records[0]!.events.filter((event) =>
      !(event.type === "screenshot" && event.screenshot.sha256 === afterHash)
    );

    expect(assessRealBrowserManifest(manifest)).toEqual(expect.arrayContaining([
      "record 2 lacks confirmation event provenance",
      "record 1 after evidence is not linked to a capture event"
    ]));
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-real-browser-"));
  temporaryRoots.push(root);
  const path = join(root, "manifest.json");
  const exactTextHash = sha256Text("120");
  const records = [];
  for (let index = 1; index <= 2; index += 1) {
    const beforeFile = `${String(index * 2 - 1).padStart(3, "0")}-prepare-${String(index).padStart(2, "0")}-before.png`;
    const afterFile = `${String(index * 2).padStart(3, "0")}-prepare-${String(index).padStart(2, "0")}-after.png`;
    const beforeBytes = await new Jimp({
      width: 2,
      height: 2,
      color: index === 1 ? 0xff0000ff : 0x00ff00ff
    }).getBuffer("image/png");
    const afterBytes = await new Jimp({
      width: 2,
      height: 2,
      color: index === 1 ? 0x0000ffff : 0xffffffff
    }).getBuffer("image/png");
    await writeFile(join(root, beforeFile), beforeBytes);
    await writeFile(join(root, afterFile), afterBytes);
    const beforeSha256 = digest(beforeBytes);
    const afterSha256 = digest(afterBytes);
    const action = index === 1
      ? {
          action: "type",
          target: "daily budget input",
          reason: "focused",
          confidence: 0.98,
          expectedResult: "the unsaved draft budget visibly shows 120",
          riskLevel: "interact",
          inputSha256: exactTextHash
        }
      : {
          action: "done",
          target: "unsubmitted budget draft",
          reason: "visible",
          confidence: 0.96,
          expectedResult: "the draft budget 120 is visible and no success confirmation is present",
          riskLevel: "observe"
        };
    const taskId = index === 1
      ? "11111111-1111-4111-8111-111111111111"
      : "22222222-2222-4222-8222-222222222222";
    const task = {
      taskId,
      stepId: `prepare-${String(index).padStart(2, "0")}`,
      platform: "google_ads",
      instruction: index === 1 ? "type exact draft" : "confirm draft",
      target: action.target,
      expectedResult: action.expectedResult,
      riskLevel: index === 1 ? "interact" : "observe",
      permission: index === 1 ? "INTERACT" : "OBSERVE",
      allowedActions: index === 1 ? ["type", "fail"] : ["done", "fail", "screenshot"],
      ...(index === 1 ? { allowedTextSha256: exactTextHash } : {}),
      retryPolicy: "none"
    };
    const frame = (file: string, sha256: string) => ({
      file,
      width: 2,
      height: 2,
      scaleFactor: 2,
      capturedAt: startedAt,
      sha256,
      surfaceFingerprint: "b".repeat(64)
    });
    const beforeFrame = frame(beforeFile, beforeSha256);
    const afterFrame = frame(afterFile, afterSha256);
    const eventScreenshot = ({ file: _file, ...value }: ReturnType<typeof frame>) => value;
    records.push({
      index,
      task,
      stepPassed: true,
      result: {
        status: "done",
        attempts: 1,
        action,
        executed: index === 1,
        verified: index === 1,
        confirmationPassed: true,
        confirmation: {
          matched: true,
          confidence: 0.95,
          minimumConfidence: confirmationMinimumConfidence,
          reason: "visible"
        },
        evidence: { beforeFile, afterFile, beforeSha256, afterSha256 }
      },
      evidence: {
        before: beforeFrame,
        after: afterFrame
      },
      latencyMs: 100 * index,
      events: [
        {
          type: "screenshot",
          clientId: "client-1",
          taskId,
          phase: "before",
          screenshot: eventScreenshot(beforeFrame)
        },
        { type: "grounded", clientId: "client-1", taskId, attempt: 1, tier: "gui", action },
        ...(index === 1 ? [{ type: "executed", clientId: "client-1", taskId, attempt: 1, action }] : []),
        ...(index === 1
          ? [{ type: "verified", clientId: "client-1", taskId, attempt: 1, matched: true, confidence: 0.95, reason: "visible" }]
          : []),
        {
          type: "screenshot",
          clientId: "client-1",
          taskId,
          phase: "before",
          screenshot: eventScreenshot(afterFrame)
        },
        { type: "verified", clientId: "client-1", taskId, attempt: 0, matched: true, confidence: 0.95, reason: "visible" }
      ]
    });
  }
  const manifest = {
    schemaVersion: 2,
    runId: "2026-07-27T10-00-00-000Z-prepare",
    mode: "prepare",
    passed: true,
    safety: {
      domAutomation: false,
      submitAllowed: false,
      mutationsAllowed: false,
      confirmationMinimumConfidence,
      exactPrepareTextBound: true,
      coordinateActionsRegionBound: true,
      prepareActionAllowlist: [["type", "fail"], ["done", "fail", "screenshot"]],
      prepareRetryPolicy: "none"
    },
    clientId: "client-1",
    accountRef: "google-ads-account-1",
    browserProfile: "Work",
    browserSession: {
      sessionId: "browser-session-1",
      clientId: "client-1",
      browserProfile: "Work",
      nativeProfileFingerprint: "profile-hash",
      processId: 41,
      windowId: "window-1",
      platform: "google_ads",
      browserApplicationId: "com.google.Chrome",
      browserApp: "Google Chrome",
      sessionStatus: "connected",
      startedAt,
      updatedAt: completedAt
    },
    initialSurface: {
      fingerprint: "b".repeat(64),
      surface: {
        platform: "darwin",
        app: "Google Chrome",
        bundleId: "com.google.Chrome",
        pid: 41,
        windowId: "window-1",
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        screenId: "main",
        screenBounds: { x: 0, y: 0, width: 1512, height: 982 },
        scaleFactor: 2,
        browserProfile: "profile-hash"
      }
    },
    accountFingerprint: {
      status: "not-created",
      reason: "read-only preparation never creates a mutation fingerprint"
    },
    screenshotPrivacyAudits: [],
    models: { gui: "test/gui", guiStrong: "test/verifier" },
    tokenUsage: null,
    tokenUsageNote: "test provider does not expose usage",
    startedAt,
    completedAt,
    failures: [],
    records
  };
  return { root, path, manifest };
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
