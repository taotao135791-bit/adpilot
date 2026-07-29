import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import PptxGenJSModule from "pptxgenjs";
import type { ArtifactRenderer, RenderedOutput } from "./record.js";

// pptxgenjs ships UMD typings whose default export collapses to the module
// namespace under NodeNext. The runtime shape also varies by loader: plain
// Node ESM yields the class itself, while tsx/esbuild wraps the CJS build as
// a { __esModule, default } facade. Unwrap one level so both work.
type PptxGenJS = InstanceType<(typeof import("pptxgenjs"))["default"]>;
const PptxGenJS = ((PptxGenJSModule as { default?: unknown }).default ?? PptxGenJSModule) as new () => PptxGenJS;

export const SlidesTheme = z.object({
  /** Hex RGB without `#`, e.g. "2563EB". */
  accentColor: z
    .string()
    .regex(/^[0-9a-f]{6}$/i)
    .optional(),
  fontFamily: z.string().min(1).optional()
});
export type SlidesTheme = z.infer<typeof SlidesTheme>;

export const KpiItem = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  delta: z.string().optional()
});
export type KpiItem = z.infer<typeof KpiItem>;

export const TableBlock = z.object({
  head: z.array(z.string().min(1)).min(1),
  rows: z.array(z.array(z.string())).min(1)
});

export const ChartBlock = z.object({
  kind: z.enum(["bar", "line", "pie"]),
  categories: z.array(z.string().min(1)).min(1),
  series: z
    .array(
      z.object({
        name: z.string().min(1),
        values: z.array(z.number()).min(1)
      })
    )
    .min(1)
});
export type ChartBlock = z.infer<typeof ChartBlock>;

const baseSlideFields = {
  heading: z.string().min(1),
  notes: z.string().optional(),
  kpi: z.array(KpiItem).min(1).optional()
};

export const SlideSpec = z.discriminatedUnion("layout", [
  z.object({
    layout: z.literal("title"),
    ...baseSlideFields,
    subheading: z.string().optional()
  }),
  z.object({
    layout: z.literal("section"),
    ...baseSlideFields,
    subheading: z.string().optional()
  }),
  z.object({
    layout: z.literal("bullets"),
    ...baseSlideFields,
    bullets: z.array(z.string().min(1)).min(1)
  }),
  z.object({
    layout: z.literal("two-column"),
    ...baseSlideFields,
    columns: z.object({
      left: z.array(z.string().min(1)).min(1),
      right: z.array(z.string().min(1)).min(1)
    })
  }),
  z.object({
    layout: z.literal("table"),
    ...baseSlideFields,
    table: TableBlock
  }),
  z.object({
    layout: z.literal("chart"),
    ...baseSlideFields,
    chart: ChartBlock
  }),
  z.object({
    layout: z.literal("closing"),
    ...baseSlideFields,
    subheading: z.string().optional()
  })
]);
export type SlideSpec = z.infer<typeof SlideSpec>;

export const SlidesSpec = z.object({
  title: z.string().min(1),
  theme: SlidesTheme.optional(),
  slides: z.array(SlideSpec).min(1)
});
export type SlidesSpec = z.infer<typeof SlidesSpec>;

/** Fields of a slide that may be changed by an update patch. */
export const SlidePatch = z
  .object({
    heading: z.string().min(1),
    subheading: z.string(),
    bullets: z.array(z.string().min(1)).min(1),
    columns: z.object({
      left: z.array(z.string().min(1)).min(1),
      right: z.array(z.string().min(1)).min(1)
    }),
    table: TableBlock,
    chart: ChartBlock,
    notes: z.string(),
    kpi: z.array(KpiItem).min(1)
  })
  .partial();
export type SlidePatch = z.infer<typeof SlidePatch>;

const PAGE_W = 13.33;
const PAGE_H = 7.5;
const DEFAULT_ACCENT = "2563EB";
const DEFAULT_FONT = "Arial";
const INK = "111827";
const MUTED = "6B7280";

interface DeckTheme {
  accent: string;
  font: string;
}

export class SlidesRenderer implements ArtifactRenderer<SlidesSpec> {
  readonly exportFormats = ["pptx", "svg"];

  async render(specInput: SlidesSpec, outputDir: string): Promise<RenderedOutput> {
    return this.renderSlides(specInput, outputDir);
  }

  previewFile(files: string[]): string | undefined {
    return files.find((file) => file.endsWith(".svg"));
  }

  /**
   * Render a real .pptx deck plus one hand-drawn SVG thumbnail per slide
   * (the thumbnails power previews; the .pptx is the deliverable).
   * Returns file names relative to `outputDir`.
   */
  async renderSlides(specInput: SlidesSpec, outputDir: string): Promise<RenderedOutput> {
    const spec = SlidesSpec.parse(specInput);
    const theme = resolveTheme(spec);
    await mkdir(outputDir, { recursive: true, mode: 0o700 });

    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = "AdPilot";
    pptx.title = spec.title;
    pptx.company = "AdPilot";

    const total = spec.slides.length;
    spec.slides.forEach((slide, index) => {
      const target = pptx.addSlide();
      target.background = { color: "FFFFFF" };
      renderSlide(target, slide, theme, spec.title, index, total);
      if (slide.notes) target.addNotes(slide.notes);
    });

    const buffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
    await writeFile(join(outputDir, "slides.pptx"), buffer, { mode: 0o600 });

    const files = ["slides.pptx"];
    for (let index = 0; index < spec.slides.length; index += 1) {
      const name = `thumb-${String(index + 1).padStart(2, "0")}.svg`;
      const slide = spec.slides[index] as SlideSpec;
      await writeFile(
        join(outputDir, name),
        renderThumbnail(slide, theme, index, total),
        { encoding: "utf8", mode: 0o600 }
      );
      files.push(name);
    }
    return { files };
  }
}

/**
 * Slides are spec-level artifacts: pptxgenjs cannot patch an existing .pptx,
 * so an update produces a new spec which is then re-rendered wholesale (the
 * service stores spec.json as the artifact source and bumps the version).
 */
export function applySlidePatch(
  specInput: SlidesSpec,
  slideIndex: number,
  patchInput: SlidePatch
): SlidesSpec {
  const spec = SlidesSpec.parse(specInput);
  const patch = SlidePatch.parse(patchInput);
  if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= spec.slides.length) {
    throw new Error(`slide index ${slideIndex} is out of range`);
  }
  const slides = spec.slides.map((slide, index) => {
    if (index !== slideIndex) return slide;
    const merged = { ...slide, ...patch };
    return SlideSpec.parse(merged);
  });
  return SlidesSpec.parse({ ...spec, slides });
}

function resolveTheme(spec: SlidesSpec): DeckTheme {
  return {
    accent: (spec.theme?.accentColor ?? DEFAULT_ACCENT).toUpperCase(),
    font: spec.theme?.fontFamily ?? DEFAULT_FONT
  };
}

type PptxSlide = ReturnType<PptxGenJS["addSlide"]>;
type ChartName = Parameters<PptxSlide["addChart"]>[0];
type ShapeName = Parameters<PptxSlide["addShape"]>[0];

function renderSlide(
  slide: PptxSlide,
  spec: SlideSpec,
  theme: DeckTheme,
  deckTitle: string,
  index: number,
  total: number
): void {
  const text = { fontFace: theme.font } as const;
  switch (spec.layout) {
    case "title": {
      slide.addShape("rect" as ShapeName, { x: 0, y: 0, w: PAGE_W, h: 0.18, fill: { color: theme.accent } });
      slide.addText(spec.heading, {
        x: 1, y: 2.4, w: PAGE_W - 2, h: 1.4, align: "center",
        fontSize: 40, bold: true, color: INK, ...text
      });
      if (spec.subheading) {
        slide.addText(spec.subheading, {
          x: 1, y: 3.9, w: PAGE_W - 2, h: 0.8, align: "center",
          fontSize: 18, color: MUTED, ...text
        });
      }
      break;
    }
    case "section": {
      slide.addShape("rect" as ShapeName, { x: 0.8, y: 2.55, w: 0.14, h: 1.7, fill: { color: theme.accent } });
      slide.addText(spec.heading, {
        x: 1.2, y: 2.5, w: PAGE_W - 2.4, h: 1.1,
        fontSize: 32, bold: true, color: INK, ...text
      });
      if (spec.subheading) {
        slide.addText(spec.subheading, {
          x: 1.2, y: 3.6, w: PAGE_W - 2.4, h: 0.7,
          fontSize: 16, color: MUTED, ...text
        });
      }
      break;
    }
    case "closing": {
      slide.addShape("rect" as ShapeName, { x: 0, y: PAGE_H - 0.18, w: PAGE_W, h: 0.18, fill: { color: theme.accent } });
      slide.addText(spec.heading, {
        x: 1, y: 2.7, w: PAGE_W - 2, h: 1.2, align: "center",
        fontSize: 36, bold: true, color: INK, ...text
      });
      if (spec.subheading) {
        slide.addText(spec.subheading, {
          x: 1, y: 4.0, w: PAGE_W - 2, h: 0.8, align: "center",
          fontSize: 16, color: MUTED, ...text
        });
      }
      break;
    }
    case "bullets": {
      addHeading(slide, spec.heading, theme);
      slide.addText(
        spec.bullets.map((line) => ({
          text: line,
          options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 10 }
        })),
        { x: 0.9, y: 1.6, w: PAGE_W - 1.8, h: contentHeight(spec), fontSize: 16, color: INK, ...text }
      );
      break;
    }
    case "two-column": {
      addHeading(slide, spec.heading, theme);
      const columnWidth = (PAGE_W - 2.2) / 2;
      const columnOptions = {
        y: 1.6, w: columnWidth, h: contentHeight(spec), fontSize: 14, color: INK, ...text
      };
      slide.addText(toBulletRuns(spec.columns.left), { x: 0.9, ...columnOptions });
      slide.addText(toBulletRuns(spec.columns.right), { x: 1.3 + columnWidth, ...columnOptions });
      break;
    }
    case "table": {
      addHeading(slide, spec.heading, theme);
      const header = spec.table.head.map((cell) => ({
        text: cell,
        options: { bold: true, color: "FFFFFF", fill: { color: theme.accent } } as const
      }));
      const body = spec.table.rows.map((row) =>
        row.map((cell) => ({ text: cell, options: { color: INK } as const }))
      );
      slide.addTable([header, ...body], {
        x: 0.9, y: 1.6, w: PAGE_W - 1.8,
        fontSize: 12, fontFace: theme.font,
        border: { pt: 0.5, color: "D1D5DB" },
        margin: 0.08, valign: "middle", autoPage: false
      });
      break;
    }
    case "chart": {
      addHeading(slide, spec.heading, theme);
      const data = spec.chart.series.map((series) => ({
        name: series.name,
        labels: spec.chart.categories,
        values: series.values
      }));
      const palette = [theme.accent, "9CA3AF", "D1D5DB", "4B5563"];
      const options = {
        x: 0.9, y: 1.6, w: PAGE_W - 1.8, h: contentHeight(spec),
        chartColors: palette,
        showLegend: spec.chart.series.length > 1 || spec.chart.kind === "pie",
        legendPos: "b" as const,
        legendFontFace: theme.font,
        legendFontSize: 10,
        catAxisLabelFontFace: theme.font,
        catAxisLabelFontSize: 10,
        valAxisLabelFontFace: theme.font,
        valAxisLabelFontSize: 10
      };
      if (spec.chart.kind === "bar") {
        slide.addChart("bar" as ChartName, data, { ...options, barDir: "col", barGapWidthPct: 60 });
      } else if (spec.chart.kind === "line") {
        slide.addChart("line" as ChartName, data, { ...options, lineSize: 2 });
      } else {
        slide.addChart("pie" as ChartName, data, { ...options, showPercent: true });
      }
      break;
    }
  }

  if (spec.kpi && spec.kpi.length > 0) renderKpiBand(slide, spec.kpi, theme);
  addFooter(slide, theme, deckTitle, index, total);
}

function addHeading(slide: PptxSlide, heading: string, theme: DeckTheme): void {
  slide.addText(heading, {
    x: 0.9, y: 0.45, w: PAGE_W - 1.8, h: 0.7,
    fontSize: 24, bold: true, color: INK, fontFace: theme.font
  });
  slide.addShape("rect" as ShapeName, { x: 0.9, y: 1.22, w: 1.2, h: 0.05, fill: { color: theme.accent } });
}

function addFooter(
  slide: PptxSlide,
  theme: DeckTheme,
  deckTitle: string,
  index: number,
  total: number
): void {
  slide.addText(deckTitle, {
    x: 0.9, y: PAGE_H - 0.42, w: 6, h: 0.3,
    fontSize: 9, color: MUTED, fontFace: theme.font
  });
  slide.addText(`${index + 1} / ${total}`, {
    x: PAGE_W - 2.4, y: PAGE_H - 0.42, w: 1.5, h: 0.3, align: "right",
    fontSize: 9, color: MUTED, fontFace: theme.font
  });
}

function renderKpiBand(slide: PptxSlide, kpis: KpiItem[], theme: DeckTheme): void {
  const count = Math.min(kpis.length, 4);
  const gap = 0.25;
  const width = (PAGE_W - 1.8 - gap * (count - 1)) / count;
  const y = PAGE_H - 1.9;
  for (let i = 0; i < count; i += 1) {
    const kpi = kpis[i] as KpiItem;
    const x = 0.9 + i * (width + gap);
    slide.addShape("roundRect" as ShapeName, {
      x, y, w: width, h: 1.25, rectRadius: 0.08,
      fill: { color: "F3F4F6" }, line: { color: "E5E7EB", width: 0.75 }
    });
    slide.addText(kpi.label, {
      x: x + 0.15, y: y + 0.08, w: width - 0.3, h: 0.3,
      fontSize: 10, color: MUTED, fontFace: theme.font
    });
    slide.addText(kpi.value, {
      x: x + 0.15, y: y + 0.36, w: width - 0.3, h: 0.5,
      fontSize: 20, bold: true, color: theme.accent, fontFace: theme.font
    });
    if (kpi.delta) {
      slide.addText(kpi.delta, {
        x: x + 0.15, y: y + 0.88, w: width - 0.3, h: 0.28,
        fontSize: 9, color: MUTED, fontFace: theme.font
      });
    }
  }
}

function contentHeight(spec: SlideSpec): number {
  return spec.kpi && spec.kpi.length > 0 ? 3.4 : 5.2;
}

function toBulletRuns(lines: string[]): { text: string; options: object }[] {
  return lines.map((line) => ({
    text: line,
    options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 8 }
  }));
}

/* ------------------------------------------------------------------ */
/* SVG thumbnails (hand-drawn previews; no pptx rasterization)         */
/* ------------------------------------------------------------------ */

function renderThumbnail(slide: SlideSpec, theme: DeckTheme, index: number, total: number): string {
  const w = 320;
  const h = 180;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="#ffffff"/>`
  );
  const accent = `#${theme.accent}`;
  const ink = "#111827";
  const muted = "#9CA3AF";

  switch (slide.layout) {
    case "title": {
      parts.push(`<rect x="0" y="0" width="${w}" height="6" fill="${accent}"/>`);
      parts.push(svgText(slide.heading, w / 2, 84, 17, ink, "bold", "middle"));
      if (slide.subheading) parts.push(svgText(slide.subheading, w / 2, 106, 10, muted, "normal", "middle"));
      break;
    }
    case "section": {
      parts.push(`<rect x="22" y="66" width="5" height="46" fill="${accent}"/>`);
      parts.push(svgText(slide.heading, 34, 86, 16, ink, "bold", "start"));
      if (slide.subheading) parts.push(svgText(slide.subheading, 34, 104, 9, muted, "normal", "start"));
      break;
    }
    case "closing": {
      parts.push(`<rect x="0" y="${h - 6}" width="${w}" height="6" fill="${accent}"/>`);
      parts.push(svgText(slide.heading, w / 2, 88, 16, ink, "bold", "middle"));
      if (slide.subheading) parts.push(svgText(slide.subheading, w / 2, 108, 9, muted, "normal", "middle"));
      break;
    }
    case "bullets":
    case "two-column": {
      parts.push(thumbHeading(slide.heading, accent));
      const columns =
        slide.layout === "two-column" ? [slide.columns.left, slide.columns.right] : [slide.bullets];
      const colW = columns.length === 2 ? 128 : 264;
      columns.forEach((lines, columnIndex) => {
        const x = 22 + columnIndex * (colW + 16);
        lines.slice(0, 6).forEach((line, lineIndex) => {
          const y = 58 + lineIndex * 18;
          parts.push(`<circle cx="${x + 3}" cy="${y - 3}" r="2" fill="${accent}"/>`);
          parts.push(svgText(line, x + 10, y, 8, ink, "normal", "start", colW - 10));
        });
      });
      break;
    }
    case "table": {
      parts.push(thumbHeading(slide.heading, accent));
      const cols = slide.table.head.length;
      const colW = 264 / cols;
      slide.table.head.forEach((cell, cellIndex) => {
        parts.push(
          `<rect x="${22 + cellIndex * colW}" y="52" width="${colW}" height="16" fill="${accent}"/>`
        );
        parts.push(svgText(cell, 26 + cellIndex * colW, 63, 7, "#ffffff", "bold", "start", colW - 6));
      });
      slide.table.rows.slice(0, 4).forEach((row, rowIndex) => {
        row.slice(0, cols).forEach((cell, cellIndex) => {
          const y = 68 + rowIndex * 15;
          parts.push(
            `<rect x="${22 + cellIndex * colW}" y="${y}" width="${colW}" height="15" fill="${rowIndex % 2 ? "#F9FAFB" : "#ffffff"}" stroke="#E5E7EB" stroke-width="0.5"/>`
          );
          parts.push(svgText(cell, 26 + cellIndex * colW, y + 11, 7, ink, "normal", "start", colW - 6));
        });
      });
      break;
    }
    case "chart": {
      parts.push(thumbHeading(slide.heading, accent));
      parts.push(thumbChart(slide.chart, accent));
      break;
    }
  }

  parts.push(svgText(`${index + 1} / ${total}`, w - 12, h - 8, 7, muted, "normal", "end"));
  parts.push("</svg>");
  return parts.join("");
}

function thumbHeading(heading: string, accent: string): string {
  return (
    svgText(heading, 22, 34, 13, "#111827", "bold", "start", 276) +
    `<rect x="22" y="42" width="34" height="3" fill="${accent}"/>`
  );
}

function thumbChart(chart: ChartBlock, accent: string): string {
  const parts: string[] = [];
  const baseX = 30;
  const baseY = 150;
  const chartW = 250;
  const chartH = 88;
  const first = chart.series[0] as ChartBlock["series"][number];
  if (chart.kind === "pie") {
    const values = first.values.map((value) => Math.max(0, value));
    const total = values.reduce((sum, value) => sum + value, 0) || 1;
    const colors = [accent, "#9CA3AF", "#D1D5DB", "#4B5563"];
    let angle = -Math.PI / 2;
    const cx = 160;
    const cy = 102;
    const r = 42;
    values.slice(0, 6).forEach((value, i) => {
      const sweep = (value / total) * Math.PI * 2;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(angle + sweep);
      const y2 = cy + r * Math.sin(angle + sweep);
      const large = sweep > Math.PI ? 1 : 0;
      parts.push(
        `<path d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${colors[i % colors.length]}"/>`
      );
      angle += sweep;
    });
    return parts.join("");
  }
  const max = Math.max(1e-9, ...first.values.map((value) => Math.abs(value)));
  const step = chartW / Math.max(1, first.values.length);
  if (chart.kind === "bar") {
    first.values.slice(0, 12).forEach((value, i) => {
      const barH = (Math.max(0, value) / max) * chartH;
      parts.push(
        `<rect x="${baseX + i * step + 3}" y="${baseY - barH}" width="${Math.max(4, step - 8)}" height="${barH.toFixed(1)}" fill="${accent}"/>`
      );
    });
  } else {
    const points = first.values
      .slice(0, 24)
      .map((value, i) => `${(baseX + i * step + step / 2).toFixed(1)},${(baseY - (Math.max(0, value) / max) * chartH).toFixed(1)}`)
      .join(" ");
    parts.push(`<polyline points="${points}" fill="none" stroke="${accent}" stroke-width="2"/>`);
  }
  parts.push(`<line x1="${baseX}" y1="${baseY}" x2="${baseX + chartW}" y2="${baseY}" stroke="#E5E7EB"/>`);
  return parts.join("");
}

function svgText(
  value: string,
  x: number,
  y: number,
  size: number,
  color: string,
  weight: "normal" | "bold",
  anchor: "start" | "middle" | "end",
  maxChars?: number
): string {
  const clipped =
    maxChars !== undefined && value.length > Math.floor(maxChars / (size * 0.62))
      ? `${value.slice(0, Math.max(1, Math.floor(maxChars / (size * 0.62))) - 1)}…`
      : value;
  return `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escapeXml(clipped)}</text>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
