import { Jimp } from "jimp";
import { beforeAll, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { InMemorySharedFactRepository, SharedFactLedger } from "@adpilot/shared";
import {
  normalizeVisualValue,
  PiVisualTableModel,
  PiVisualTableVerifier,
  screenshotSha256,
  VisualTableReader,
  type VisualTablePageObservation,
  type VisualTableReadRequest,
  type VisualTableScreenshot,
  type VisualTableSurface,
  type VisualTableVerifier,
  type VisualTableVisionModel
} from "./index.js";

let pngBase64 = "";

beforeAll(async () => {
  pngBase64 = (await new Jimp({ width: 240, height: 140, color: 0xffffffff }).getBuffer("image/png")).toString("base64");
});

describe("VisualTableReader", () => {
  it("reads and independently verifies a single-page table with screenshot evidence", async () => {
    const repository = new InMemorySharedFactRepository();
    const ledger = new SharedFactLedger(repository, { now: () => new Date("2026-07-22T00:00:05.000Z") });
    const reader = makeReader([page([
      row("campaign-a", "Campaign A", [cell("name", "Campaign A", 0.99), cell("budget", "$1,234.50", 0.98)])
    ])], { factSink: ledger });
    const result = await reader.read(baseRequest());
    expect(result.status).toBe("done");
    expect(result.cells).toMatchObject([
      { rowKey: "campaign-a", columnKey: "name", normalizedValue: "Campaign A", verified: true, screenshotId: "screen-1" },
      { rowKey: "campaign-a", columnKey: "budget", normalizedValue: 1234.5, unit: "USD", verified: true, screenshotId: "screen-1" }
    ]);
    expect(result.facts).toHaveLength(2);
    expect(result.facts.every((fact) => fact.status === "verified" && fact.sourceScreenshotId === "screen-1" && fact.sourceBoundingBox)).toBe(true);
    expect(await ledger.usable("client-a", { taskId: baseRequest().taskId })).toHaveLength(2);
  });

  it("scrolls vertically, aligns overlap rows, and removes duplicates", async () => {
    const pages = [
      page([
        row("campaign-a", "Campaign A", [cell("name", "Campaign A"), cell("budget", "$100")]),
        row("campaign-b", "Campaign B", [cell("name", "Campaign B"), cell("budget", "$200")])
      ], true),
      page([
        row("campaign-b", "Campaign B", [cell("name", "Campaign B"), cell("budget", "$200")]),
        row("campaign-c", "Campaign C", [cell("name", "Campaign C"), cell("budget", "$300")])
      ])
    ];
    const reader = makeReader(pages, { surface: makeSurface([screenshot("screen-2")]) });
    const result = await reader.read(baseRequest({ scrollDirection: "down", historicalOverlapRows: ["campaign-b"] }));
    expect(result.status).toBe("done");
    expect(new Set(result.cells.map((item) => item.rowKey))).toEqual(new Set(["campaign-a", "campaign-b", "campaign-c"]));
    expect(result.checks.duplicateRowsRemoved).toBeGreaterThan(0);
    expect(result.screenshots).toEqual(["screen-1", "screen-2"]);
  });

  it("merges fixed identity and metric columns across horizontal scrolling", async () => {
    const first = page([
      row("campaign-a", "Campaign A", [cell("name", "Campaign A")])
    ], true, [header("name", "Campaign", true)]);
    const second = page([
      row("campaign-a", "Campaign A", [cell("budget", "$120")])
    ], false, [header("budget", "Budget")]);
    const result = await makeReader([first, second], { surface: makeSurface([screenshot("screen-2")]) })
      .read(baseRequest({ scrollDirection: "right" }));
    expect(result.status).toBe("done");
    expect(result.cells.map((item) => item.columnKey).sort()).toEqual(["budget", "name"]);
  });

  it("normalizes currencies and locale-specific thousands and decimals", () => {
    expect(normalizeVisualValue("¥1,234.50", column("budget", "currency"))).toEqual({ value: 1234.5, unit: "CNY", qualifier: "exact" });
    expect(normalizeVisualValue("€1.234,50", column("budget", "currency"))).toEqual({ value: 1234.5, unit: "EUR", qualifier: "exact" });
    expect(normalizeVisualValue("$2.5K", column("budget", "currency"))).toEqual({ value: 2500, unit: "USD", qualifier: "exact" });
  });

  it("normalizes percentages and preserves less-than qualifiers", () => {
    expect(normalizeVisualValue("12.5%", column("rate", "percentage"))).toEqual({ value: 12.5, unit: "percent", qualifier: "exact" });
    expect(normalizeVisualValue("< 0.01%", column("rate", "percentage"))).toEqual({ value: 0.01, unit: "percent", qualifier: "less_than" });
  });

  it("keeps empty cells null instead of guessing", async () => {
    const result = await makeReader([page([row("campaign-a", "Campaign A", [cell("name", "Campaign A"), cell("budget", "—")])])])
      .read(baseRequest());
    expect(result.status).toBe("done");
    expect(result.cells.find((item) => item.columnKey === "budget")).toMatchObject({ rawText: "—", normalizedValue: null, qualifier: "empty" });
  });

  it("blocks truncated campaign identities", async () => {
    const result = await makeReader([page([row("Campaign A…", "Campaign A…", [cell("name", "Campaign A…"), cell("budget", "$100")], { truncated: true })])])
      .read(baseRequest());
    expect(result).toMatchObject({ status: "blocked", blocker: { code: "TRUNCATED_ROW_IDENTITY" } });
  });

  it("returns TABLE_LOADING when the visual surface never stabilizes", async () => {
    const result = await makeReader([{ state: "loading", headers: [], rows: [], hasMore: false }])
      .read(baseRequest());
    expect(result).toMatchObject({ status: "blocked", blocker: { code: "TABLE_LOADING" } });
  });

  it("returns UNRELIABLE_VISUAL_VALUE and does not verify low-confidence numbers", async () => {
    const repository = new InMemorySharedFactRepository();
    const ledger = new SharedFactLedger(repository, { now: () => new Date("2026-07-22T00:00:05.000Z") });
    const result = await makeReader([page([row("campaign-a", "Campaign A", [cell("name", "Campaign A"), cell("budget", "$100", 0.7)])])], { factSink: ledger })
      .read(baseRequest());
    expect(result).toMatchObject({ status: "blocked", blocker: { code: "UNRELIABLE_VISUAL_VALUE" } });
    expect((await ledger.list("client-a", { taskId: baseRequest().taskId })).every((fact) => fact.status === "observed")).toBe(true);
    expect(await ledger.usable("client-a", { taskId: baseRequest().taskId })).toEqual([]);
  });

  it("keeps a visually disputed value out of production facts", async () => {
    const repository = new InMemorySharedFactRepository();
    const ledger = new SharedFactLedger(repository, { now: () => new Date("2026-07-22T00:00:05.000Z") });
    const verifier: VisualTableVerifier = {
      identity: "independent-disagreeing-verifier",
      verify: async (request) => ({
        reviews: request.cells.map((item) => ({
          rowKey: item.rowKey, columnKey: item.columnKey, matched: item.columnKey !== "budget",
          confidence: 0.99, normalizedValue: item.columnKey === "budget" ? 999 : item.normalizedValue, reason: "budget did not match"
        })),
        confidence: 0.99,
        reason: "one value disagreed"
      })
    };
    const result = await makeReader([page([row("campaign-a", "Campaign A", [cell("name", "Campaign A"), cell("budget", "$100")])])], {
      factSink: ledger,
      verifier
    }).read(baseRequest());
    expect(result).toMatchObject({ status: "blocked", blocker: { code: "UNRELIABLE_VISUAL_VALUE" } });
    expect(result.facts.find((fact) => fact.predicate === "budget")).toMatchObject({ status: "rejected" });
    expect(await ledger.usable("client-a", { taskId: baseRequest().taskId })).toHaveLength(1);
  });

  it("checks a matching total row", async () => {
    const result = await makeReader([page([
      row("campaign-a", "Campaign A", [cell("name", "Campaign A"), cell("budget", "$100")]),
      row("campaign-b", "Campaign B", [cell("name", "Campaign B"), cell("budget", "$200")]),
      row("total", "Total", [cell("name", "Total"), cell("budget", "$300")], { kind: "total" })
    ])]).read(baseRequest());
    expect(result.status).toBe("done");
    expect(result.checks).toMatchObject({ totalsChecked: 1, totalsConsistent: true });
  });

  it("blocks when an advertised total disagrees with visible values", async () => {
    const result = await makeReader([page([
      row("campaign-a", "Campaign A", [cell("name", "Campaign A"), cell("budget", "$100")]),
      row("campaign-b", "Campaign B", [cell("name", "Campaign B"), cell("budget", "$200")]),
      row("total", "Total", [cell("name", "Total"), cell("budget", "$999")], { kind: "total" })
    ])]).read(baseRequest());
    expect(result).toMatchObject({ status: "blocked", blocker: { code: "TOTAL_MISMATCH" }, checks: { totalsConsistent: false } });
  });

  it("blocks conflicting values for the same overlapping row", async () => {
    const pages = [
      page([row("campaign-a", "Campaign A", [cell("name", "Campaign A"), cell("budget", "$100")])], true),
      page([row("campaign-a", "Campaign A", [cell("name", "Campaign A"), cell("budget", "$120")])])
    ];
    const result = await makeReader(pages, { surface: makeSurface([screenshot("screen-2")]) }).read(baseRequest({ scrollDirection: "down" }));
    expect(result).toMatchObject({ status: "blocked", blocker: { code: "CONFLICTING_OVERLAP_VALUE" } });
  });

  it("allows the same vision model through an independent verifier call", async () => {
    const model = makeModel([page([
      row("campaign-a", "Campaign A", [cell("name", "Campaign A"), cell("budget", "$100")])
    ])], "same-model");
    const verifier = makeVerifier("same-model");
    const result = await new VisualTableReader({ model, verifier }).read(baseRequest());
    expect(result).toMatchObject({ status: "done", verification: { confidence: 0.98 } });
    expect(result.facts.every((fact) => fact.status === "verified")).toBe(true);
  });

  it("runs the production Pi multimodal reader and verifier adapters", async () => {
    const faux = fauxProvider({ provider: "visual-table-pi", models: [{ id: "reader", input: ["text", "image"] }, { id: "verifier", input: ["text", "image"] }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(JSON.stringify(page([row("campaign-a", "Campaign A", [cell("name", "Campaign A"), cell("budget", "$100")])]))),
      fauxAssistantMessage(JSON.stringify({
        reviews: [
          { rowKey: "campaign-a", columnKey: "name", matched: true, confidence: 0.99, normalizedValue: "Campaign A", reason: "matched" },
          { rowKey: "campaign-a", columnKey: "budget", matched: true, confidence: 0.99, normalizedValue: 100, reason: "matched" }
        ],
        confidence: 0.99,
        reason: "all matched"
      }))
    ]);
    const reader = new VisualTableReader({
      model: new PiVisualTableModel(models, faux.getModel("reader")!),
      verifier: new PiVisualTableVerifier(models, faux.getModel("verifier")!)
    });
    const result = await reader.read(baseRequest());
    expect(result.status).toBe("done");
    expect(result.facts.every((fact) => fact.status === "verified")).toBe(true);
    expect(faux.state.callCount).toBe(2);
  });
});

function makeReader(
  pages: VisualTablePageObservation[],
  options: { surface?: VisualTableSurface; factSink?: SharedFactLedger; verifier?: VisualTableVerifier } = {}
): VisualTableReader {
  return new VisualTableReader({
    model: makeModel(pages),
    verifier: options.verifier ?? makeVerifier(),
    ...(options.surface ? { surface: options.surface } : {}),
    ...(options.factSink ? { factSink: options.factSink } : {})
  });
}

function makeModel(pages: VisualTablePageObservation[], identity = "table-reader-model"): VisualTableVisionModel {
  let index = 0;
  return { identity, readPage: async () => pages[Math.min(index++, pages.length - 1)] };
}

function makeVerifier(identity = "independent-table-verifier"): VisualTableVerifier {
  return {
    identity,
    verify: async (request) => ({
      reviews: request.cells.map((item) => ({
        rowKey: item.rowKey,
        columnKey: item.columnKey,
        matched: true,
        confidence: 0.98,
        normalizedValue: item.normalizedValue,
        reason: "independent screenshot review matched"
      })),
      confidence: 0.98,
      reason: "all cells matched"
    })
  };
}

function makeSurface(captures: VisualTableScreenshot[]): VisualTableSurface {
  let index = 0;
  return {
    scroll: async () => "advanced",
    capture: async () => captures[Math.min(index++, captures.length - 1)]!
  };
}

function baseRequest(overrides: Partial<VisualTableReadRequest> = {}): VisualTableReadRequest {
  return {
    clientId: "client-a",
    taskId: "11111111-1111-4111-8111-111111111111",
    platform: "google_ads",
    screenshot: screenshot("screen-1"),
    tableRoi: [0, 0, 200, 100],
    targetColumns: [column("name", "text", "Campaign"), column("budget", "currency", "Budget")],
    targetRows: [],
    scrollDirection: "none",
    historicalOverlapRows: [],
    pageScale: 1,
    dpr: 2,
    factTtlMs: 15 * 60_000,
    maxPages: 30,
    ...overrides
  };
}

function screenshot(screenshotId: string): VisualTableScreenshot {
  return {
    screenshotId,
    base64: pngBase64,
    width: 240,
    height: 140,
    sha256: screenshotSha256(pngBase64),
    capturedAt: "2026-07-22T00:00:00.000Z"
  };
}

function column(key: string, valueType: "auto" | "currency" | "percentage" | "number" | "text" | "status", label = key) {
  return { key, label, valueType, unit: "", critical: true } as const;
}

function header(columnKey: string, rawText: string, fixed = false) {
  return { columnKey, rawText, boundingBox: [5, 2, 80, 12] as [number, number, number, number], confidence: 0.99, fixed };
}

function cell(columnKey: string, rawText: string, confidence = 0.98) {
  return { columnKey, rawText, boundingBox: [5, 20, 80, 12] as [number, number, number, number], confidence };
}

function row(
  rowKey: string,
  rawLabel: string,
  cells: ReturnType<typeof cell>[],
  options: { truncated?: boolean; kind?: "data" | "total" } = {}
) {
  return {
    rowKey,
    rawLabel,
    boundingBox: [2, 18, 190, 16] as [number, number, number, number],
    truncated: options.truncated ?? false,
    kind: options.kind ?? "data",
    cells
  };
}

function page(
  rows: ReturnType<typeof row>[],
  hasMore = false,
  headers = [header("name", "Campaign", true), header("budget", "Budget")]
): VisualTablePageObservation {
  return { state: "ready", headers, rows, hasMore };
}
