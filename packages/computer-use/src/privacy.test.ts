import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp } from "jimp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileScreenshotArtifactStore,
  FileScreenshotModelCallAuditStore,
  PrivacyAwareGroundingProvider,
  PrivacyAwareVisualVerifier,
  PrivacyModeRemoteProviderError,
  ScreenshotMinimizationError,
  ScreenshotPrivacyPipeline,
  defaultBrowserContentRoi,
  restoreFullScreenshotCoordinates,
  type Screenshot,
  type ScreenshotMask,
  type VisualGroundingProvider
} from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function screenshot(width = 100, height = 80): Promise<Screenshot> {
  const image = new Jimp({ width, height, color: 0x336699ff });
  const buffer = await image.getBuffer("image/png");
  return {
    base64: buffer.toString("base64"), width, height, scaleFactor: 1,
    capturedAt: "2026-07-22T08:00:00.000Z", sha256: createHash("sha256").update(buffer).digest("hex")
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-privacy-"));
  roots.push(root);
  const artifacts = new FileScreenshotArtifactStore(root);
  const audits = new FileScreenshotModelCallAuditStore(root);
  const pipeline = new ScreenshotPrivacyPipeline(artifacts, audits, () => new Date("2026-07-22T08:30:00.000Z"));
  return { root, artifacts, audits, pipeline };
}

const remoteModel = { provider: "remote-vendor", modelId: "gui-vision", location: "remote" as const, retentionPolicy: "provider-zero-retention" };
const localModel = { provider: "local-runtime", modelId: "ui-tars-local", location: "local" as const, retentionPolicy: "memory-only" };

describe("screenshot privacy pipeline", () => {
  it("crops the exact ROI and keeps the full capture only in the local Workspace", async () => {
    const { pipeline, root } = await fixture();
    const original = await screenshot();
    const prepared = await pipeline.prepareForModel({
      clientId: "client-a", taskId: "task-a", purpose: "grounding", screenshot: original,
      roi: { x: 20, y: 10, width: 40, height: 30 }, includeDefaultMasks: false, model: remoteModel
    });
    expect(prepared.screenshot).toMatchObject({ width: 40, height: 30 });
    expect(prepared.screenshot.base64).not.toBe(original.base64);
    expect(prepared.fullArtifact.localPath).toContain(join(root, "screenshots"));
    expect(await readFile(prepared.fullArtifact.localPath)).toEqual(Buffer.from(original.base64, "base64"));
    expect((await stat(prepared.fullArtifact.localPath)).mode & 0o777).toBe(0o600);
    expect(prepared.audit).toMatchObject({ leftLocal: true, fullScreenshotLocalOnly: true, sentRoi: { x: 20, y: 10, width: 40, height: 30 } });
  });

  it("blacks out sensitive regions inside the transmitted ROI", async () => {
    const { pipeline } = await fixture();
    const original = await screenshot();
    const sensitive: ScreenshotMask = {
      category: "email", region: { x: 30, y: 20, width: 10, height: 8 }, reason: "customer email"
    };
    const prepared = await pipeline.prepareForModel({
      clientId: "client-a", taskId: "task-a", purpose: "grounding", screenshot: original,
      roi: { x: 20, y: 10, width: 50, height: 40 }, sensitiveRegions: [sensitive],
      includeDefaultMasks: false, model: remoteModel
    });
    const transmitted = await Jimp.fromBuffer(Buffer.from(prepared.screenshot.base64, "base64"));
    expect(transmitted.getPixelColor(11, 11)).toBe(0x111111ff);
    expect(transmitted.getPixelColor(1, 1)).toBe(0x336699ff);
    expect(prepared.audit.masks).toEqual([sensitive]);
  });

  it("applies default browser, personal-information, and notification masks", async () => {
    const { pipeline } = await fixture();
    const original = await screenshot(200, 100);
    const prepared = await pipeline.prepareForModel({
      clientId: "client-a", taskId: "task-a", purpose: "other", screenshot: original,
      roi: { x: 100, y: 1, width: 90, height: 45 }, model: localModel
    });
    expect(new Set(prepared.masks.map((mask) => mask.category))).toEqual(new Set(["browser_tabs", "system_menu_bar", "top_personal_info", "notification"]));
    const transmitted = await Jimp.fromBuffer(Buffer.from(prepared.screenshot.base64, "base64"));
    expect(transmitted.getPixelColor(89, 1)).toBe(0x111111ff);
  });

  it("blocks remote providers in local-only mode before returning image bytes", async () => {
    const { pipeline, audits } = await fixture();
    const original = await screenshot();
    await expect(pipeline.prepareForModel({
      clientId: "client-a", taskId: "task-private", purpose: "verification", screenshot: original,
      roi: { x: 10, y: 10, width: 60, height: 50 }, model: remoteModel, privacyMode: "local-only"
    })).rejects.toBeInstanceOf(PrivacyModeRemoteProviderError);
    expect(await audits.list("client-a")).toEqual([expect.objectContaining({ outcome: "blocked", leftLocal: false, privacyMode: "local-only" })]);
  });

  it("allows a local model in local-only mode", async () => {
    const { pipeline } = await fixture();
    const prepared = await pipeline.prepareForModel({
      clientId: "client-a", taskId: "task-private", purpose: "grounding", screenshot: await screenshot(),
      roi: { x: 0, y: 0, width: 100, height: 80 }, model: localModel, privacyMode: "local-only"
    });
    expect(prepared.audit).toMatchObject({ outcome: "prepared", leftLocal: false, privacyMode: "local-only" });
  });

  it("rejects accidental full-window upload to a remote provider", async () => {
    const { pipeline, audits } = await fixture();
    await expect(pipeline.prepareForModel({
      clientId: "client-a", taskId: "task-a", purpose: "grounding", screenshot: await screenshot(),
      roi: { x: 0, y: 0, width: 100, height: 80 }, model: remoteModel
    })).rejects.toBeInstanceOf(ScreenshotMinimizationError);
    expect(await audits.list()).toEqual([expect.objectContaining({ outcome: "blocked", fullScreenshotLocalOnly: true })]);
  });

  it("records provider, model, screenshot, ROI, masks, locality, and retention without image bytes", async () => {
    const { pipeline, audits, root } = await fixture();
    await pipeline.prepareForModel({
      clientId: "client-a", taskId: "task-a", purpose: "table_read", screenshot: await screenshot(),
      roi: { x: 10, y: 20, width: 70, height: 40 }, includeDefaultMasks: false,
      sensitiveRegions: [{ category: "other_campaign", region: { x: 12, y: 22, width: 5, height: 5 }, reason: "not requested" }],
      model: remoteModel, localFullRetentionPolicy: "local-24h"
    });
    const records = await audits.list();
    expect(records[0]).toMatchObject({
      modelProvider: "remote-vendor", modelId: "gui-vision", purpose: "table_read",
      sentRoi: { x: 10, y: 20, width: 70, height: 40 }, leftLocal: true,
      dataRetentionPolicy: "provider-zero-retention", outcome: "prepared"
    });
    const rawAudit = await readFile(join(root, "audit", "screenshot-model-calls.jsonl"), "utf8");
    expect(rawAudit).not.toContain("base64");
    expect(rawAudit).not.toContain(records[0]!.screenshotId + ".png");
  });

  it("restores sanitized ROI coordinates before native execution", async () => {
    expect(restoreFullScreenshotCoordinates({
      action: "drag", x: 5, y: 7, end_x: 20, end_y: 22,
      target: "budget", reason: "visible", confidence: 1, expected_result: "open", risk_level: "interact"
    }, { x: 100, y: 200, width: 300, height: 250 })).toMatchObject({ x: 105, y: 207, end_x: 120, end_y: 222 });

    const { pipeline } = await fixture();
    const underlying: VisualGroundingProvider = {
      id: "remote-gui", kind: "dedicated",
      ground: vi.fn(async (_task, shot) => {
        expect(shot).toMatchObject({ width: 40, height: 30 });
        return { action: "click" as const, x: 6, y: 8, target: "date", reason: "visible", confidence: 1, expected_result: "open", risk_level: "interact" as const };
      })
    };
    const privateGrounding = new PrivacyAwareGroundingProvider(
      underlying, pipeline, () => "client-a", () => ({ x: 20, y: 10, width: 40, height: 30 }), () => remoteModel
    );
    const task = {
      taskId: "task-a", instruction: "open date", target: "date", expectedResult: "open", riskLevel: "interact" as const,
      permission: "INTERACT" as const, surface: { app: "Browser", allowedApps: ["Browser"], allowedDomains: [] }
    };
    await expect(privateGrounding.ground(task, await screenshot(), "gui")).resolves.toMatchObject({ x: 26, y: 18 });
  });

  it("gives a verifier only minimized before/after images and audits both", async () => {
    const { pipeline, audits } = await fixture();
    const verify = vi.fn(async (_expected: string, before: Screenshot, after: Screenshot) => {
      expect(before).toMatchObject({ width: 60, height: 30 });
      expect(after).toMatchObject({ width: 60, height: 30 });
      return { matched: true, confidence: 0.95, reason: "changed" };
    });
    const verifier = new PrivacyAwareVisualVerifier(
      { verify }, pipeline, () => ({ clientId: "client-a", taskId: "task-verify" }),
      () => ({ before: { x: 10, y: 20, width: 60, height: 30 }, after: { x: 10, y: 20, width: 60, height: 30 } }),
      remoteModel
    );
    await expect(verifier.verify("budget dialog open", await screenshot(), await screenshot())).resolves.toMatchObject({ matched: true });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await audits.list()).toHaveLength(2);
  });

  it("derives a conservative content ROI instead of the full browser window", () => {
    expect(defaultBrowserContentRoi(1200, 800)).toEqual({ x: 0, y: 96, width: 1200, height: 704 });
  });
});
