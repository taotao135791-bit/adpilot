import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const ReplayCase = z.object({
  id: z.string().min(1), scene: z.string().min(1), screenshot: z.string().min(1),
  language: z.enum(["zh-CN", "en"]), theme: z.enum(["light", "dark"]),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), logicalWidth: z.number().int().positive(), logicalHeight: z.number().int().positive(), scaleFactor: z.number().positive() }),
  action: z.enum(["click", "type", "wait", "fail"]),
  allowed: z.object({ xMin: z.number().nonnegative(), yMin: z.number().nonnegative(), xMax: z.number().positive(), yMax: z.number().positive() }),
  riskLevel: z.enum(["observe", "interact", "mutate", "destructive"]),
  shouldExecute: z.boolean(), failureConditions: z.array(z.string().min(1)).min(3), expectedBlocker: z.string().nullable()
});

const manifest = z.object({ version: z.literal(1), cases: z.array(ReplayCase).min(50) }).parse(JSON.parse(await readFile(resolve("evals/computer-use-replay/cases.json"), "utf8")));

describe("60-case sanitized visual replay corpus", () => {
  it("covers required scenes, languages, themes, resolutions, and scaling", () => {
    const scenes = new Set(manifest.cases.map((item) => item.scene));
    for (const scene of ["campaign-list", "date-picker", "budget-edit", "bid-edit", "conversion-goals", "asset-list", "account-switch", "confirm-dialog", "loading", "error-dialog", "browser-switched", "unauthorized-app"]) expect(scenes.has(scene)).toBe(true);
    expect(new Set(manifest.cases.map((item) => item.language))).toEqual(new Set(["zh-CN", "en"]));
    expect(new Set(manifest.cases.map((item) => item.theme))).toEqual(new Set(["light", "dark"]));
    expect(new Set(manifest.cases.map((item) => item.viewport.scaleFactor)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(manifest.cases.map((item) => `${item.viewport.width}x${item.viewport.height}`)).size).toBeGreaterThanOrEqual(5);
  });

  it.each(manifest.cases)("validates fixture $id", async (fixture) => {
    const image = await readFile(resolve(fixture.screenshot));
    expect(image.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(image.readUInt32BE(16)).toBe(fixture.viewport.width);
    expect(image.readUInt32BE(20)).toBe(fixture.viewport.height);
    expect(fixture.allowed.xMin).toBeLessThan(fixture.allowed.xMax);
    expect(fixture.allowed.yMin).toBeLessThan(fixture.allowed.yMax);
    expect(fixture.allowed.xMax).toBeLessThanOrEqual(fixture.viewport.width);
    expect(fixture.allowed.yMax).toBeLessThanOrEqual(fixture.viewport.height);
    if (!fixture.shouldExecute) expect(fixture.action).toBe("fail");
    if (fixture.riskLevel === "mutate") expect(["budget-edit", "bid-edit", "confirm-dialog"]).toContain(fixture.scene);
  });
});
