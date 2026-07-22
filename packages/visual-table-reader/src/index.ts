import { createHash } from "node:crypto";
import { Jimp } from "jimp";
import { z } from "zod";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import {
  EvidenceBoundingBox,
  SharedFact,
  SharedFactLedger,
  type SharedFact as SharedFactValue,
  type SharedFactDraft,
  type SharedFactVerification
} from "@adpilot/shared";

export const VisualTableScreenshot = z.object({
  screenshotId: z.string().min(1),
  base64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  capturedAt: z.string().datetime()
});
export type VisualTableScreenshot = z.infer<typeof VisualTableScreenshot>;

export const VisualTableColumn = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  valueType: z.enum(["auto", "currency", "percentage", "number", "text", "status"]).default("auto"),
  unit: z.string().default(""),
  critical: z.boolean().default(true)
});
export type VisualTableColumn = z.infer<typeof VisualTableColumn>;

export const VisualTableReadRequest = z.object({
  clientId: z.string().min(1),
  taskId: z.string().uuid(),
  platform: z.string().min(1),
  screenshot: VisualTableScreenshot,
  tableRoi: EvidenceBoundingBox,
  targetColumns: z.array(VisualTableColumn).min(1),
  targetRows: z.array(z.string().min(1)).default([]),
  scrollDirection: z.enum(["none", "down", "right"]).default("none"),
  historicalOverlapRows: z.array(z.union([
    z.string().min(1),
    z.object({ rowKey: z.string().min(1), fingerprint: z.string().min(1).optional() })
  ])).default([]),
  pageScale: z.number().positive(),
  dpr: z.number().positive(),
  factTtlMs: z.number().int().positive().default(15 * 60_000),
  maxPages: z.number().int().min(1).max(100).default(30)
});
export type VisualTableReadRequest = z.infer<typeof VisualTableReadRequest>;

const ModelHeader = z.object({
  columnKey: z.string().min(1),
  rawText: z.string(),
  boundingBox: EvidenceBoundingBox,
  confidence: z.number().min(0).max(1),
  fixed: z.boolean().default(false)
});

const ModelCell = z.object({
  columnKey: z.string().min(1),
  rawText: z.string(),
  boundingBox: EvidenceBoundingBox,
  confidence: z.number().min(0).max(1)
});

const ModelRow = z.object({
  rowKey: z.string().min(1),
  rawLabel: z.string().min(1),
  boundingBox: EvidenceBoundingBox,
  truncated: z.boolean().default(false),
  kind: z.enum(["data", "total"]).default("data"),
  cells: z.array(ModelCell)
});

export const VisualTablePageObservation = z.object({
  state: z.enum(["ready", "loading", "error"]),
  headers: z.array(ModelHeader),
  rows: z.array(ModelRow),
  hasMore: z.boolean(),
  pageNumber: z.number().int().positive().optional(),
  anomaly: z.string().min(1).optional()
});
export type VisualTablePageObservation = z.infer<typeof VisualTablePageObservation>;

export const VisualTableCell = z.object({
  rowKey: z.string().min(1),
  columnKey: z.string().min(1),
  rawText: z.string(),
  normalizedValue: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  unit: z.string(),
  qualifier: z.enum(["exact", "less_than", "greater_than", "empty"]).default("exact"),
  confidence: z.number().min(0).max(1),
  boundingBox: EvidenceBoundingBox,
  screenshotId: z.string().min(1),
  evidenceScreenshotIds: z.array(z.string().min(1)).min(1),
  verified: z.boolean()
});
export type VisualTableCell = z.infer<typeof VisualTableCell>;

const CellReview = z.object({
  rowKey: z.string().min(1),
  columnKey: z.string().min(1),
  matched: z.boolean(),
  confidence: z.number().min(0).max(1),
  normalizedValue: z.union([z.number(), z.string(), z.boolean(), z.null()]).optional(),
  reason: z.string().min(1)
});

export const VisualTableVerification = z.object({
  reviews: z.array(CellReview),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1)
});
export type VisualTableVerification = z.infer<typeof VisualTableVerification>;

export interface VisualTableModelRequest {
  screenshotId: string;
  /** Cropped table ROI only; the full window image is never exposed here. */
  roiImageBase64: string;
  roiWidth: number;
  roiHeight: number;
  coordinateSpace: "roi_pixels";
  targetColumns: VisualTableColumn[];
  targetRows: string[];
  historicalOverlapRows: VisualTableReadRequest["historicalOverlapRows"];
  scrollDirection: VisualTableReadRequest["scrollDirection"];
  pageScale: number;
  dpr: number;
}

export interface VisualTableVisionModel {
  readonly identity: string;
  readPage(request: VisualTableModelRequest): Promise<unknown>;
}

export interface VisualTableVerifierRequest {
  screenshots: Array<{ screenshotId: string; roiImageBase64: string; width: number; height: number }>;
  cells: VisualTableCell[];
  targetColumns: VisualTableColumn[];
}

export interface VisualTableVerifier {
  readonly identity: string;
  verify(request: VisualTableVerifierRequest): Promise<unknown>;
}

/** Production Pi multimodal adapter for table header/row/cell extraction. */
export class PiVisualTableModel implements VisualTableVisionModel {
  readonly identity: string;

  constructor(
    private readonly models: Models,
    private readonly model: Model<Api>,
    private readonly repairModel: Model<Api> = model
  ) {
    if (!model.input.includes("image")) throw new Error(`table model does not accept images: ${model.provider}/${model.id}`);
    if (!repairModel.input.includes("image")) throw new Error(`table repair model does not accept images: ${repairModel.provider}/${repairModel.id}`);
    this.identity = `${model.provider}/${model.id}`;
  }

  async readPage(request: VisualTableModelRequest): Promise<VisualTablePageObservation> {
    return this.complete(VisualTablePageObservation, [
      "Read only the visible advertising table inside this cropped screenshot.",
      "Return one JSON object with state, headers, rows, hasMore, optional pageNumber and anomaly.",
      "Header fields: columnKey, rawText, boundingBox [x,y,width,height], confidence, fixed.",
      "Row fields: rowKey, rawLabel, boundingBox, truncated, kind data|total, cells.",
      "Cell fields: columnKey, rawText, boundingBox, confidence.",
      "All coordinates are ROI pixels. Preserve symbols, separators, dashes and less-than signs exactly in rawText.",
      "Never complete a truncated name. Set truncated=true. Report loading instead of inventing rows.",
      "Return JSON only."
    ].join("\n"), [{
      role: "user",
      content: [
        { type: "text", text: JSON.stringify({
          screenshotId: request.screenshotId,
          dimensions: { width: request.roiWidth, height: request.roiHeight },
          targetColumns: request.targetColumns,
          targetRows: request.targetRows,
          historicalOverlapRows: request.historicalOverlapRows,
          scrollDirection: request.scrollDirection,
          pageScale: request.pageScale,
          dpr: request.dpr
        }) },
        { type: "image", data: request.roiImageBase64, mimeType: "image/png" }
      ],
      timestamp: Date.now()
    }]);
  }

  private async complete<S extends z.ZodTypeAny>(schema: S, systemPrompt: string, messages: Array<any>): Promise<z.output<S>> {
    let response = await this.models.completeSimple(this.model, { systemPrompt, messages }, tableModelOptions());
    let text = tableAssistantText(response);
    let issue = "invalid JSON";
    for (let pass = 1; pass <= 3; pass += 1) {
      try { return schema.parse(parseTableJson(text)); }
      catch (error) {
        issue = error instanceof Error ? error.message : String(error);
        if (pass === 3) break;
        response = await this.models.completeSimple(pass === 1 ? this.model : this.repairModel, {
          systemPrompt: "Repair one visual table JSON response. Return only a complete JSON object matching the requested schema.",
          messages: [{ role: "user", content: [{ type: "text", text: `Validation error:\n${issue}\n\nInvalid output:\n${text}` }], timestamp: Date.now() }]
        }, tableModelOptions());
        text = tableAssistantText(response);
      }
    }
    throw new Error(`visual table model returned invalid structured output after three passes: ${issue}`);
  }
}

/** Independent Pi multimodal reviewer. Use a different model from the reader. */
export class PiVisualTableVerifier implements VisualTableVerifier {
  readonly identity: string;

  constructor(private readonly models: Models, private readonly model: Model<Api>) {
    if (!model.input.includes("image")) throw new Error(`table verifier does not accept images: ${model.provider}/${model.id}`);
    this.identity = `${model.provider}/${model.id}`;
  }

  async verify(request: VisualTableVerifierRequest): Promise<VisualTableVerification> {
    const imageContent: Array<Record<string, unknown>> = [];
    for (const screenshot of request.screenshots) {
      imageContent.push({ type: "text", text: `Screenshot ${screenshot.screenshotId}, ${screenshot.width}x${screenshot.height}:` });
      imageContent.push({ type: "image", data: screenshot.roiImageBase64, mimeType: "image/png" });
    }
    const systemPrompt = [
      "Independently verify extracted advertising table cells against the cropped screenshots.",
      "Return JSON only: {reviews:[{rowKey,columnKey,matched,confidence,normalizedValue?,reason}],confidence,reason}.",
      "Check the exact row, column, raw value, currency/percent signs, decimal separators and bounding-box region.",
      "Do not trust the reader. A truncated identity, ambiguity, missing cell or unreadable value must not match."
    ].join("\n");
    let response = await this.models.completeSimple(this.model, {
      systemPrompt,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: JSON.stringify({ targetColumns: request.targetColumns, extractedCells: request.cells }) },
          ...imageContent
        ],
        timestamp: Date.now()
      } as any]
    }, tableModelOptions());
    let text = tableAssistantText(response);
    let issue = "invalid JSON";
    for (let pass = 1; pass <= 3; pass += 1) {
      try { return VisualTableVerification.parse(parseTableJson(text)); }
      catch (error) {
        issue = error instanceof Error ? error.message : String(error);
        if (pass === 3) break;
        response = await this.models.completeSimple(this.model, {
          systemPrompt: "Repair one visual table verification JSON object. Return JSON only.",
          messages: [{ role: "user", content: [{ type: "text", text: `Validation error:\n${issue}\n\nInvalid output:\n${text}` }], timestamp: Date.now() }]
        }, tableModelOptions());
        text = tableAssistantText(response);
      }
    }
    throw new Error(`visual table verifier returned invalid structured output after three passes: ${issue}`);
  }
}

export interface VisualTableSurface {
  capture(): Promise<VisualTableScreenshot>;
  scroll(direction: "down" | "right", tableRoi: z.infer<typeof EvidenceBoundingBox>): Promise<"advanced" | "end">;
}

export interface VisualTableEvidenceStore {
  saveFullScreenshotLocally(screenshot: VisualTableScreenshot): Promise<void>;
}

export interface VisualTableFactSink {
  observe(draft: SharedFactDraft): Promise<SharedFactValue>;
  verify(clientId: string, factId: string, verification: SharedFactVerification): Promise<SharedFactValue>;
  reject(clientId: string, factId: string, reason: string): Promise<SharedFactValue>;
}

export const VisualTableBlockerCode = z.enum([
  "UNRELIABLE_VISUAL_VALUE",
  "TABLE_LOADING",
  "TABLE_MODEL_ERROR",
  "MISSING_TABLE_HEADER",
  "TRUNCATED_ROW_IDENTITY",
  "CONFLICTING_OVERLAP_VALUE",
  "INCOMPLETE_TABLE",
  "TOTAL_MISMATCH",
  "VERIFICATION_FAILED",
  "VERIFIER_NOT_INDEPENDENT"
]);
export type VisualTableBlockerCode = z.infer<typeof VisualTableBlockerCode>;

export interface VisualTableBlocker {
  code: VisualTableBlockerCode;
  message: string;
  cells: Array<{ rowKey: string; columnKey: string }>;
}

export interface VisualTableChecks {
  pagesRead: number;
  duplicateRowsRemoved: number;
  totalsChecked: number;
  totalsConsistent: boolean;
  anomalies: string[];
}

export type VisualTableReadResult = {
  status: "done";
  cells: VisualTableCell[];
  facts: SharedFactValue[];
  screenshots: string[];
  checks: VisualTableChecks;
  verification: VisualTableVerification | null;
} | {
  status: "blocked";
  blocker: VisualTableBlocker;
  cells: VisualTableCell[];
  facts: SharedFactValue[];
  screenshots: string[];
  checks: VisualTableChecks;
  verification: VisualTableVerification | null;
};

export interface VisualTableReaderOptions {
  model: VisualTableVisionModel;
  verifier: VisualTableVerifier;
  surface?: VisualTableSurface;
  evidenceStore?: VisualTableEvidenceStore;
  factSink?: VisualTableFactSink;
  confidenceThreshold?: number;
  loadingRetries?: number;
}

interface PreparedRoi {
  screenshotId: string;
  base64: string;
  width: number;
  height: number;
}

/** Pure screenshot + visual-model table reader. */
export class VisualTableReader {
  private readonly factSink: VisualTableFactSink;
  private readonly threshold: number;
  private readonly loadingRetries: number;

  constructor(private readonly options: VisualTableReaderOptions) {
    this.factSink = options.factSink ?? new SharedFactLedger();
    this.threshold = z.number().min(0.85).max(1).parse(options.confidenceThreshold ?? 0.85);
    this.loadingRetries = z.number().int().min(0).max(5).parse(options.loadingRetries ?? 2);
  }

  async read(input: z.input<typeof VisualTableReadRequest>): Promise<VisualTableReadResult> {
    const request = VisualTableReadRequest.parse(input);
    const checks: VisualTableChecks = { pagesRead: 0, duplicateRowsRemoved: 0, totalsChecked: 0, totalsConsistent: true, anomalies: [] };
    const screenshots = new Map<string, PreparedRoi>();
    const cellMap = new Map<string, VisualTableCell>();
    const rowKinds = new Map<string, "data" | "total">();
    let blocker: VisualTableBlocker | undefined;
    let verificationResult: VisualTableVerification | null = null;
    let current = request.screenshot;
    let loadingAttempts = 0;

    if (this.options.model.identity === this.options.verifier.identity) {
      return blocked("VERIFIER_NOT_INDEPENDENT", "table values require an independent visual verifier", [], [], [], checks);
    }

    for (let page = 0; page < request.maxPages; page += 1) {
      await this.options.evidenceStore?.saveFullScreenshotLocally(current);
      const roi = await cropRoi(current, request.tableRoi);
      screenshots.set(current.screenshotId, roi);
      let rawObservation: unknown;
      try {
        rawObservation = await this.options.model.readPage({
          screenshotId: current.screenshotId,
          roiImageBase64: roi.base64,
          roiWidth: roi.width,
          roiHeight: roi.height,
          coordinateSpace: "roi_pixels",
          targetColumns: request.targetColumns,
          targetRows: request.targetRows,
          historicalOverlapRows: request.historicalOverlapRows,
          scrollDirection: request.scrollDirection,
          pageScale: request.pageScale,
          dpr: request.dpr
        });
      } catch (error) {
        blocker = makeBlocker("TABLE_MODEL_ERROR", error instanceof Error ? error.message : String(error));
        break;
      }
      const parsed = VisualTablePageObservation.safeParse(rawObservation);
      if (!parsed.success) {
        blocker = makeBlocker("TABLE_MODEL_ERROR", `invalid table model output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        break;
      }
      const observation = parsed.data;
      const invalidBox = [
        ...observation.headers.map((item) => item.boundingBox),
        ...observation.rows.flatMap((item) => [item.boundingBox, ...item.cells.map((cell) => cell.boundingBox)])
      ].find((box) => !boxWithin(box, roi.width, roi.height));
      if (invalidBox) {
        blocker = makeBlocker("TABLE_MODEL_ERROR", `table model returned an out-of-ROI bounding box: ${invalidBox.join(",")}`);
        break;
      }
      if (observation.state === "loading") {
        if (!this.options.surface || loadingAttempts >= this.loadingRetries) {
          blocker = makeBlocker("TABLE_LOADING", "table remained in a loading state");
          break;
        }
        loadingAttempts += 1;
        current = await this.options.surface.capture();
        page -= 1;
        continue;
      }
      loadingAttempts = 0;
      if (observation.state === "error") {
        blocker = makeBlocker("TABLE_MODEL_ERROR", observation.anomaly ?? "the visual model identified an error state");
        break;
      }
      checks.pagesRead += 1;
      if (observation.anomaly) checks.anomalies.push(observation.anomaly);

      const visibleHeaders = new Map(observation.headers.map((header) => [header.columnKey, header]));
      const rowHeader = request.targetColumns.find((column) => column.valueType === "text") ?? request.targetColumns[0]!;
      for (const column of request.targetColumns) {
        const header = visibleHeaders.get(column.key);
        if (!header && request.scrollDirection !== "right") {
          blocker = makeBlocker("MISSING_TABLE_HEADER", `target column header is not visible: ${column.key}`);
          break;
        }
        if (header && header.confidence < this.threshold) {
          blocker = makeBlocker("UNRELIABLE_VISUAL_VALUE", `column header confidence is too low: ${column.key}`);
          break;
        }
      }
      if (blocker) break;

      for (const row of observation.rows) {
        if (request.targetRows.length && !request.targetRows.includes(row.rowKey)) continue;
        if (row.truncated || /(?:…|\.\.\.)\s*$/.test(row.rawLabel) || /(?:…|\.\.\.)\s*$/.test(row.rowKey)) {
          blocker = makeBlocker("TRUNCATED_ROW_IDENTITY", `row identity is truncated: ${row.rawLabel}`, [{ rowKey: row.rowKey, columnKey: rowHeader.key }]);
          break;
        }
        rowKinds.set(row.rowKey, row.kind);
        for (const rawCell of row.cells) {
          const column = request.targetColumns.find((candidate) => candidate.key === rawCell.columnKey);
          if (!column) continue;
          const header = visibleHeaders.get(column.key);
          if (!header) {
            blocker = makeBlocker("MISSING_TABLE_HEADER", `cell ${row.rowKey}/${column.key} has no visible header`, [{ rowKey: row.rowKey, columnKey: column.key }]);
            break;
          }
          if (!rangesOverlap(rawCell.boundingBox[0], rawCell.boundingBox[2], header.boundingBox[0], header.boundingBox[2])) {
            blocker = makeBlocker("TABLE_MODEL_ERROR", `cell ${row.rowKey}/${column.key} is not aligned with its header`, [{ rowKey: row.rowKey, columnKey: column.key }]);
            break;
          }
          const normalized = normalizeVisualValue(rawCell.rawText, column);
          const cell = VisualTableCell.parse({
            rowKey: row.rowKey,
            columnKey: column.key,
            rawText: rawCell.rawText,
            normalizedValue: normalized.value,
            unit: normalized.unit,
            qualifier: normalized.qualifier,
            confidence: Math.min(rawCell.confidence, visibleHeaders.get(column.key)?.confidence ?? rawCell.confidence),
            boundingBox: offsetBox(rawCell.boundingBox, request.tableRoi),
            screenshotId: current.screenshotId,
            evidenceScreenshotIds: [current.screenshotId],
            verified: false
          });
          const key = cellKey(cell.rowKey, cell.columnKey);
          const previous = cellMap.get(key);
          if (previous) {
            checks.duplicateRowsRemoved += 1;
            if (!valuesEquivalent(previous.normalizedValue, cell.normalizedValue) || previous.qualifier !== cell.qualifier) {
              blocker = makeBlocker("CONFLICTING_OVERLAP_VALUE", `overlapping screenshots disagree for ${key}`, [{ rowKey: cell.rowKey, columnKey: cell.columnKey }]);
              break;
            }
            const preferred = cell.confidence > previous.confidence ? cell : previous;
            cellMap.set(key, VisualTableCell.parse({
              ...preferred,
              evidenceScreenshotIds: [...new Set([...previous.evidenceScreenshotIds, ...cell.evidenceScreenshotIds])]
            }));
          } else {
            cellMap.set(key, cell);
          }
        }
        if (blocker) break;
      }
      if (blocker) break;
      if (!observation.hasMore) break;
      if (request.scrollDirection === "none" || !this.options.surface) {
        blocker = makeBlocker("INCOMPLETE_TABLE", "the table has more rows or columns but no visual scroll surface is available");
        break;
      }
      const advanced = await this.options.surface.scroll(request.scrollDirection, request.tableRoi);
      if (advanced === "end") {
        blocker = makeBlocker("INCOMPLETE_TABLE", "visual scrolling ended before the model reached the table boundary");
        break;
      }
      current = await this.options.surface.capture();
      if (page === request.maxPages - 1) blocker = makeBlocker("INCOMPLETE_TABLE", "visual table page limit reached");
    }

    const cells = [...cellMap.values()];
    if (!blocker) {
      blocker = validateRequiredCells(cells, request.targetColumns, request.targetRows, this.threshold);
    }
    if (!blocker) {
      const totalResult = validateTotals(cells, rowKinds);
      checks.totalsChecked = totalResult.checked;
      checks.totalsConsistent = totalResult.consistent;
      checks.anomalies.push(...totalResult.anomalies);
      if (!totalResult.consistent) blocker = makeBlocker("TOTAL_MISMATCH", totalResult.anomalies.join("; "));
    }

    const facts: SharedFactValue[] = [];
    const factByCell = new Map<string, SharedFactValue>();
    for (const cell of cells.filter((candidate) => rowKinds.get(candidate.rowKey) !== "total")) {
      const fact = await this.factSink.observe({
        clientId: request.clientId,
        taskId: request.taskId,
        subject: cell.rowKey,
        predicate: cell.columnKey,
        value: cell.normalizedValue,
        unit: cell.unit,
        sourceType: "visual_table",
        sourceScreenshotId: cell.screenshotId,
        sourceBoundingBox: cell.boundingBox,
        evidenceIds: cell.evidenceScreenshotIds.map((id) => `screenshot:${id}`),
        confidence: cell.confidence,
        createdBy: `visual_table_reader:${this.options.model.identity}`,
        expiresAt: new Date(Date.parse(request.screenshot.capturedAt) + request.factTtlMs).toISOString()
      });
      facts.push(fact);
      factByCell.set(cellKey(cell.rowKey, cell.columnKey), fact);
    }

    if (!blocker && cells.length > 0) {
      let verificationRaw: unknown;
      try {
        verificationRaw = await this.options.verifier.verify({
          screenshots: [...screenshots.values()].map((item) => ({ screenshotId: item.screenshotId, roiImageBase64: item.base64, width: item.width, height: item.height })),
          cells,
          targetColumns: request.targetColumns
        });
      } catch (error) {
        blocker = makeBlocker("VERIFICATION_FAILED", error instanceof Error ? error.message : String(error));
        verificationRaw = undefined;
      }
      if (blocker) {
        return { status: "blocked", blocker, cells, facts, screenshots: [...screenshots.keys()], checks, verification: null };
      }
      const verification = VisualTableVerification.safeParse(verificationRaw);
      if (!verification.success) {
        blocker = makeBlocker("VERIFICATION_FAILED", `invalid verifier output: ${verification.error.issues.map((issue) => issue.message).join("; ")}`);
      } else {
        verificationResult = verification.data;
        const reviews = new Map(verification.data.reviews.map((review) => [cellKey(review.rowKey, review.columnKey), review]));
        for (let index = 0; index < cells.length; index += 1) {
          const cell = cells[index]!;
          const review = reviews.get(cellKey(cell.rowKey, cell.columnKey));
          const matches = verification.data.confidence >= this.threshold
            && Boolean(review?.matched)
            && (review?.confidence ?? 0) >= this.threshold
            && (review?.normalizedValue === undefined || valuesEquivalent(review.normalizedValue, cell.normalizedValue));
          cells[index] = VisualTableCell.parse({ ...cell, verified: matches });
          if (rowKinds.get(cell.rowKey) === "total") continue;
          const fact = factByCell.get(cellKey(cell.rowKey, cell.columnKey));
          if (!fact) continue;
          if (matches) {
            const verified = await this.factSink.verify(request.clientId, fact.factId, {
              verifier: `visual_table_verifier:${this.options.verifier.identity}`,
              confidence: Math.min(verification.data.confidence, review!.confidence)
            });
            const factIndex = facts.findIndex((candidate) => candidate.factId === fact.factId);
            if (factIndex >= 0) facts[factIndex] = verified;
          } else {
            const rejected = await this.factSink.reject(request.clientId, fact.factId, review?.reason ?? "independent visual verification failed");
            const factIndex = facts.findIndex((candidate) => candidate.factId === fact.factId);
            if (factIndex >= 0) facts[factIndex] = rejected;
          }
        }
        const failed = cells.filter((cell) => request.targetColumns.find((column) => column.key === cell.columnKey)?.critical && !cell.verified);
        if (failed.length) {
          blocker = makeBlocker("UNRELIABLE_VISUAL_VALUE", "one or more critical table values failed independent verification", failed.map(({ rowKey, columnKey }) => ({ rowKey, columnKey })));
        }
      }
    }

    const screenshotIds = [...screenshots.keys()];
    return blocker
      ? { status: "blocked", blocker, cells, facts, screenshots: screenshotIds, checks, verification: verificationResult }
      : { status: "done", cells, facts: facts.map((fact) => SharedFact.parse(fact)), screenshots: screenshotIds, checks, verification: verificationResult };
  }
}

export function normalizeVisualValue(rawText: string, column: VisualTableColumn): {
  value: number | string | boolean | null;
  unit: string;
  qualifier: "exact" | "less_than" | "greater_than" | "empty";
} {
  const raw = rawText.replace(/\u00a0/g, " ").trim();
  if (!raw || /^(?:-|--|–|—|n\/?a|null)$/i.test(raw)) return { value: null, unit: column.unit, qualifier: "empty" };
  if (column.valueType === "text") return { value: raw, unit: column.unit, qualifier: "exact" };
  if (column.valueType === "status") {
    const normalized = raw.replace(/^[\s\u25cf\u25cb\u2713\u2714\u2715\u26a0]+/, "").trim().toLowerCase();
    return { value: normalized || raw.toLowerCase(), unit: column.unit || "status", qualifier: "exact" };
  }
  const qualifier = /^\s*</.test(raw) ? "less_than" : /^\s*>/.test(raw) ? "greater_than" : "exact";
  const currency = detectCurrency(raw);
  const percentage = raw.includes("%") || column.valueType === "percentage";
  const suffix = raw.match(/([kmb])\s*%?$/i)?.[1]?.toLowerCase();
  const numericText = raw
    .replace(/^(?:USD|CNY|EUR|GBP|JPY|KRW|INR)\s*/i, "")
    .replace(/^(?:US|CA|AU|NZ|HK|SG)?\s*[$¥￥€£₩₹]/i, "")
    .replace(/\s*(?:USD|CNY|EUR|GBP|JPY|KRW|INR)$/i, "")
    .replace(/[<>%\s]/g, "")
    .replace(/[kmb]$/i, "");
  const normalizedNumeric = normalizeNumberString(numericText);
  const numeric = Number(normalizedNumeric) * (suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1);
  const expectsNumber = column.valueType !== "auto" || currency !== undefined || percentage || /^[<>]?\s*[\d.,]+\s*[kmb]?\s*%?$/i.test(raw);
  if (expectsNumber && Number.isFinite(numeric)) {
    return { value: numeric, unit: percentage ? "percent" : column.unit || currency || "", qualifier };
  }
  return { value: raw, unit: column.unit, qualifier: "exact" };
}

async function cropRoi(screenshot: VisualTableScreenshot, roi: z.infer<typeof EvidenceBoundingBox>): Promise<PreparedRoi> {
  const [x, y, width, height] = roi.map((value) => Math.round(value)) as [number, number, number, number];
  if (x + width > screenshot.width || y + height > screenshot.height) throw new Error("table ROI exceeds screenshot bounds");
  const source = Buffer.from(screenshot.base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const image = await Jimp.fromBuffer(source);
  const buffer = await image.clone().crop({ x, y, w: width, h: height }).getBuffer("image/png");
  return { screenshotId: screenshot.screenshotId, base64: buffer.toString("base64"), width, height };
}

function offsetBox(box: z.infer<typeof EvidenceBoundingBox>, roi: z.infer<typeof EvidenceBoundingBox>): z.infer<typeof EvidenceBoundingBox> {
  return EvidenceBoundingBox.parse([box[0] + roi[0], box[1] + roi[1], box[2], box[3]]);
}

function boxWithin(box: z.infer<typeof EvidenceBoundingBox>, width: number, height: number): boolean {
  return box[0] + box[2] <= width && box[1] + box[3] <= height;
}

function rangesOverlap(leftStart: number, leftWidth: number, rightStart: number, rightWidth: number): boolean {
  return Math.max(leftStart, rightStart) < Math.min(leftStart + leftWidth, rightStart + rightWidth);
}

function validateRequiredCells(
  cells: readonly VisualTableCell[],
  columns: readonly VisualTableColumn[],
  targetRows: readonly string[],
  threshold: number
): VisualTableBlocker | undefined {
  const lowConfidence = cells.filter((cell) => columns.find((column) => column.key === cell.columnKey)?.critical && cell.confidence < threshold);
  if (lowConfidence.length) {
    return makeBlocker("UNRELIABLE_VISUAL_VALUE", "one or more critical values are below the confidence threshold", lowConfidence.map(({ rowKey, columnKey }) => ({ rowKey, columnKey })));
  }
  const whollyMissingColumns = columns
    .filter((column) => column.critical && !cells.some((cell) => cell.columnKey === column.key))
    .map((column) => ({ rowKey: targetRows[0] ?? "*", columnKey: column.key }));
  if (whollyMissingColumns.length) return makeBlocker("UNRELIABLE_VISUAL_VALUE", "one or more requested columns were not visually read", whollyMissingColumns);
  if (targetRows.length) {
    const missing: Array<{ rowKey: string; columnKey: string }> = [];
    for (const rowKey of targetRows) for (const column of columns) {
      if (column.critical && !cells.some((cell) => cell.rowKey === rowKey && cell.columnKey === column.key)) missing.push({ rowKey, columnKey: column.key });
    }
    if (missing.length) return makeBlocker("UNRELIABLE_VISUAL_VALUE", "one or more requested cells were not visually read", missing);
  }
  return undefined;
}

function validateTotals(cells: readonly VisualTableCell[], rowKinds: ReadonlyMap<string, "data" | "total">): {
  checked: number;
  consistent: boolean;
  anomalies: string[];
} {
  const totalCells = cells.filter((cell) => rowKinds.get(cell.rowKey) === "total" && typeof cell.normalizedValue === "number");
  const anomalies: string[] = [];
  for (const total of totalCells) {
    const values = cells.filter((cell) => rowKinds.get(cell.rowKey) === "data" && cell.columnKey === total.columnKey && typeof cell.normalizedValue === "number");
    if (!values.length) continue;
    const sum = values.reduce((result, cell) => result + (cell.normalizedValue as number), 0);
    const tolerance = Math.max(0.01, Math.abs(total.normalizedValue as number) * 0.001);
    if (Math.abs(sum - (total.normalizedValue as number)) > tolerance) anomalies.push(`${total.columnKey} total ${total.normalizedValue} does not match visible sum ${sum}`);
  }
  return { checked: totalCells.length, consistent: anomalies.length === 0, anomalies };
}

function detectCurrency(raw: string): string | undefined {
  if (/\bUSD\b|(?:US)?\s*\$/i.test(raw)) return "USD";
  if (/\bCNY\b|[¥￥]/i.test(raw)) return "CNY";
  if (/\bEUR\b|€/i.test(raw)) return "EUR";
  if (/\bGBP\b|£/i.test(raw)) return "GBP";
  if (/\bJPY\b/i.test(raw)) return "JPY";
  if (/\bKRW\b|₩/i.test(raw)) return "KRW";
  if (/\bINR\b|₹/i.test(raw)) return "INR";
  return undefined;
}

function normalizeNumberString(value: string): string {
  if (/^-?\d{1,3}(?:\.\d{3})+,\d+$/.test(value)) return value.replace(/\./g, "").replace(",", ".");
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value)) return value.replace(/,/g, "");
  if (/^-?\d+,\d+$/.test(value) && !/^-?\d{1,3},\d{3}$/.test(value)) return value.replace(",", ".");
  return value.replace(/,/g, "");
}

function valuesEquivalent(left: VisualTableCell["normalizedValue"], right: VisualTableCell["normalizedValue"]): boolean {
  if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) <= Math.max(0.0001, Math.abs(left) * 0.0001);
  return left === right;
}

function cellKey(rowKey: string, columnKey: string): string {
  return `${rowKey}\u0000${columnKey}`;
}

function makeBlocker(code: VisualTableBlockerCode, message: string, cells: VisualTableBlocker["cells"] = []): VisualTableBlocker {
  return { code: VisualTableBlockerCode.parse(code), message, cells };
}

function blocked(
  code: VisualTableBlockerCode,
  message: string,
  cells: VisualTableCell[],
  facts: SharedFactValue[],
  screenshots: string[],
  checks: VisualTableChecks
): VisualTableReadResult {
  return { status: "blocked", blocker: makeBlocker(code, message), cells, facts, screenshots, checks, verification: null };
}

export function screenshotSha256(base64: string): string {
  return createHash("sha256").update(base64.replace(/^data:image\/\w+;base64,/, ""), "base64").digest("hex");
}

function tableModelOptions() {
  return { temperature: 0, maxTokens: 4_000, maxRetries: 1, timeoutMs: 30_000 } as const;
}

function tableAssistantText(message: AssistantMessage): string {
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? "visual table model failed");
  return message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
}

function parseTableJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(cleaned); }
  catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("visual table model did not return a JSON object");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}
