import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import type { ArtifactRenderer, RenderedOutput } from "./record.js";

/** A cell may carry a literal value or a real spreadsheet formula. */
export const SheetCellValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.object({
    /** Formula without the leading `=`, e.g. "SUM(B2:B10)". */
    formula: z.string().min(1),
    /** Cached result shown before recalculation. */
    result: z.union([z.number(), z.string()]).optional()
  })
]);
export type SheetCellValue = z.infer<typeof SheetCellValue>;

export const SheetColumn = z.object({
  header: z.string().min(1),
  key: z.string().min(1),
  width: z.number().positive().optional(),
  /** Excel number format, e.g. "#,##0.00" or "0.0%". */
  format: z.string().min(1).optional()
});
export type SheetColumn = z.infer<typeof SheetColumn>;

export const SheetSpec = z.object({
  name: z.string().min(1).max(31),
  columns: z.array(SheetColumn).min(1),
  rows: z.array(z.record(z.string(), SheetCellValue)),
  /** Freeze the header row (default true). */
  freezeHeader: z.boolean().optional()
});
export type SheetSpec = z.infer<typeof SheetSpec>;

export const WorkbookSpec = z.object({
  title: z.string().min(1).optional(),
  sheets: z.array(SheetSpec).min(1)
});
export type WorkbookSpec = z.infer<typeof WorkbookSpec>;

const JSON_PREVIEW_ROWS = 50;

export class SpreadsheetRenderer implements ArtifactRenderer<WorkbookSpec> {
  readonly exportFormats = ["xlsx", "csv", "json"];

  async render(specInput: WorkbookSpec, outputDir: string): Promise<RenderedOutput> {
    return this.renderWorkbook(specInput, outputDir);
  }

  previewFile(files: string[]): string | undefined {
    return files.find((file) => file === "preview.json");
  }

  /**
   * Render a real .xlsx workbook (multi-sheet, bold styled header, column
   * widths, number formats, real formulas, frozen header row, auto-filter)
   * plus one CSV per sheet and a JSON preview of the first 50 rows of each
   * sheet. Returns file names relative to `outputDir`.
   */
  async renderWorkbook(specInput: WorkbookSpec, outputDir: string): Promise<RenderedOutput> {
    const spec = WorkbookSpec.parse(specInput);
    await mkdir(outputDir, { recursive: true, mode: 0o700 });

    const workbook = XLSX.utils.book_new();
    const files: string[] = [];
    const preview: Record<string, Record<string, string | number | boolean | null>[]> = {};

    for (const sheet of spec.sheets) {
      const worksheet = buildWorksheet(sheet);
      XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);

      const csvName = `sheet-${sanitizeFileName(sheet.name)}.csv`;
      await writeFile(join(outputDir, csvName), XLSX.utils.sheet_to_csv(worksheet), {
        encoding: "utf8",
        mode: 0o600
      });
      files.push(csvName);
      preview[sheet.name] = previewRows(sheet);
    }

    const raw = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const styled = await applyWorkbookChrome(raw, spec);
    await writeFile(join(outputDir, "workbook.xlsx"), styled, { mode: 0o600 });
    files.push("workbook.xlsx");

    await writeFile(join(outputDir, "preview.json"), `${JSON.stringify(preview, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    files.push("preview.json");

    return { files };
  }
}

function buildWorksheet(sheet: SheetSpec): XLSX.WorkSheet {
  const worksheet: XLSX.WorkSheet = {};
  const range: XLSX.Range = {
    s: { r: 0, c: 0 },
    e: { r: sheet.rows.length, c: sheet.columns.length - 1 }
  };

  sheet.columns.forEach((column, columnIndex) => {
    worksheet[XLSX.utils.encode_cell({ r: 0, c: columnIndex })] = {
      t: "s",
      v: column.header
    };
  });

  sheet.rows.forEach((row, rowIndex) => {
    sheet.columns.forEach((column, columnIndex) => {
      const value = row[column.key];
      if (value === undefined || value === null) return;
      const address = XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex });
      const cell = toXlsxCell(value, column.format);
      if (cell) worksheet[address] = cell;
    });
  });

  worksheet["!ref"] = XLSX.utils.encode_range(range);
  worksheet["!cols"] = sheet.columns.map((column) => ({
    wch: column.width ?? Math.max(10, column.header.length + 2)
  }));
  worksheet["!autofilter"] = { ref: XLSX.utils.encode_range(range) };
  return worksheet;
}

function toXlsxCell(value: SheetCellValue, format?: string): XLSX.CellObject | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object") {
    const cell: XLSX.CellObject = {
      t: typeof value.result === "string" ? "s" : "n",
      f: value.formula.replace(/^=/, "")
    };
    if (value.result !== undefined) cell.v = value.result;
    if (format) cell.z = format;
    return cell;
  }
  if (typeof value === "number") {
    const cell: XLSX.CellObject = { t: "n", v: value };
    if (format) cell.z = format;
    return cell;
  }
  if (typeof value === "boolean") return { t: "b", v: value };
  return { t: "s", v: value };
}

function previewRows(sheet: SheetSpec): Record<string, string | number | boolean | null>[] {
  return sheet.rows.slice(0, JSON_PREVIEW_ROWS).map((row) => {
    const output: Record<string, string | number | boolean | null> = {};
    for (const column of sheet.columns) {
      const value = row[column.key];
      if (value === undefined || value === null) {
        output[column.header] = null;
      } else if (typeof value === "object") {
        output[column.header] = `=${value.formula.replace(/^=/, "")}`;
      } else {
        output[column.header] = value;
      }
    }
    return output;
  });
}

function sanitizeFileName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "sheet";
}

/**
 * SheetJS community edition does not write cell styles or frozen panes, so
 * the generated package is patched in place: a bold header font/xf is added
 * to styles.xml and applied to row 1 cells, and a frozen top-row pane is
 * injected into each sheet view. Both are standard ECMA-376 markup.
 */
async function applyWorkbookChrome(buffer: Buffer, spec: WorkbookSpec): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const stylesEntry = zip.file("xl/styles.xml");
  if (!stylesEntry) throw new Error("generated workbook is missing styles.xml");
  let styles = await stylesEntry.async("string");

  const boldFontIndex = countOf(styles, "fonts");
  styles = appendToCollection(
    styles,
    "fonts",
    '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>'
  );
  const headerXfIndex = countOf(styles, "cellXfs");
  styles = appendToCollection(
    styles,
    "cellXfs",
    `<xf numFmtId="0" fontId="${boldFontIndex}" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
  );
  zip.file("xl/styles.xml", styles);

  for (let index = 0; index < spec.sheets.length; index += 1) {
    const sheet = spec.sheets[index] as SheetSpec;
    const path = `xl/worksheets/sheet${index + 1}.xml`;
    const entry = zip.file(path);
    if (!entry) continue;
    let xml = await entry.async("string");
    xml = styleHeaderRow(xml, headerXfIndex);
    if (sheet.freezeHeader !== false) xml = freezeTopRow(xml);
    zip.file(path, xml);
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function countOf(xml: string, tag: string): number {
  const match = new RegExp(`<${tag} count="(\\d+)"`).exec(xml);
  return match ? Number.parseInt(match[1] as string, 10) : 0;
}

function appendToCollection(xml: string, tag: string, item: string): string {
  const open = new RegExp(`<${tag} count="(\\d+)"`);
  const match = open.exec(xml);
  if (!match) throw new Error(`generated workbook is missing <${tag}>`);
  const bumped = xml.replace(open, `<${tag} count="${Number.parseInt(match[1] as string, 10) + 1}"`);
  return bumped.replace(`</${tag}>`, `${item}</${tag}>`);
}

function styleHeaderRow(xml: string, styleIndex: number): string {
  return xml.replace(/<c r="([A-Z]+1)"([^>]*?)(\/?)>/g, (whole, ref: string, attrs: string, close: string) => {
    const restyled = /s="\d+"/.test(attrs)
      ? attrs.replace(/s="\d+"/, `s="${styleIndex}"`)
      : `${attrs} s="${styleIndex}"`;
    return `<c r="${ref}"${restyled}${close}>`;
  });
}

function freezeTopRow(xml: string): string {
  const pane =
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';
  if (/<sheetView[^>]*\/>/.test(xml)) {
    return xml.replace(/<sheetView([^>]*?)\/>/, `<sheetView$1>${pane}</sheetView>`);
  }
  if (/<sheetView[^>]*>/.test(xml)) {
    return xml.replace(/<sheetView([^>]*?)>/, `<sheetView$1>${pane}`);
  }
  return xml.replace(
    "</sheetViews>",
    `<sheetView workbookViewId="0">${pane}</sheetView></sheetViews>`
  );
}
