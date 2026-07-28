import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";
import type { ArtifactRenderer, RenderedOutput } from "./record.js";

export const DocumentBlock = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("heading"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: z.string().min(1)
  }),
  z.object({ kind: z.literal("paragraph"), text: z.string().min(1) }),
  z.object({ kind: z.literal("bullets"), items: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("numbered"), items: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("quote"), text: z.string().min(1) }),
  z.object({
    kind: z.literal("table"),
    head: z.array(z.string().min(1)).min(1),
    rows: z.array(z.array(z.string())).min(1)
  })
]);
export type DocumentBlock = z.infer<typeof DocumentBlock>;

export const DocumentSpec = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  author: z.string().optional(),
  /** Prepend a cover page with title/subtitle/author/date. */
  cover: z.boolean().optional(),
  /** Running header text; defaults to the document title. */
  header: z.string().optional(),
  blocks: z.array(DocumentBlock).min(1)
});
export type DocumentSpec = z.infer<typeof DocumentSpec>;

const ACCENT = "2563EB";
const INK = "111827";
const MUTED = "6B7280";
const FONT = "Arial";

export class DocumentRenderer implements ArtifactRenderer<DocumentSpec> {
  readonly exportFormats = ["docx", "txt"];

  async render(specInput: DocumentSpec, outputDir: string): Promise<RenderedOutput> {
    return this.renderDocument(specInput, outputDir);
  }

  previewFile(files: string[]): string | undefined {
    return files.find((file) => file === "preview.txt");
  }

  /**
   * Render a real .docx (heading hierarchy, lists, tables, running header,
   * footer with generation timestamp and page numbers, optional cover page)
   * plus a plain-text preview. Returns file names relative to `outputDir`.
   */
  async renderDocument(specInput: DocumentSpec, outputDir: string): Promise<RenderedOutput> {
    const spec = DocumentSpec.parse(specInput);
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const generatedAt = new Date();

    const document = new Document({
      creator: spec.author ?? "AdPilot",
      title: spec.title,
      description: spec.subtitle ?? spec.title,
      styles: {
        default: {
          document: { run: { font: FONT, size: 22, color: INK } },
          heading1: { run: { font: FONT, size: 36, bold: true, color: ACCENT } },
          heading2: { run: { font: FONT, size: 28, bold: true, color: INK } },
          heading3: { run: { font: FONT, size: 24, bold: true, color: INK } }
        }
      },
      numbering: {
        config: [
          {
            reference: "adpilot-numbering",
            levels: [
              {
                level: 0,
                format: LevelFormat.DECIMAL,
                text: "%1.",
                alignment: AlignmentType.START,
                style: { paragraph: { indent: { left: 720, hanging: 360 } } }
              }
            ]
          }
        ]
      },
      sections: [
        {
          headers: {
            default: new Header({
              children: [
                new Paragraph({
                  alignment: AlignmentType.RIGHT,
                  children: [
                    new TextRun({
                      text: spec.header ?? spec.title,
                      size: 16,
                      color: MUTED,
                      font: FONT
                    })
                  ]
                })
              ]
            })
          },
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      text: `Generated ${generatedAt.toISOString()} · Page `,
                      size: 16,
                      color: MUTED,
                      font: FONT
                    }),
                    new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED, font: FONT }),
                    new TextRun({ text: " of ", size: 16, color: MUTED, font: FONT }),
                    new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: MUTED, font: FONT })
                  ]
                })
              ]
            })
          },
          children: [
            ...(spec.cover ? coverParagraphs(spec, generatedAt) : []),
            ...spec.blocks.flatMap((block) => blockToParagraphs(block))
          ]
        }
      ]
    });

    const buffer = await Packer.toBuffer(document);
    await writeFile(join(outputDir, "document.docx"), buffer, { mode: 0o600 });
    await writeFile(join(outputDir, "preview.txt"), toPlainText(spec, generatedAt), {
      encoding: "utf8",
      mode: 0o600
    });
    return { files: ["document.docx", "preview.txt"] };
  }
}

function coverParagraphs(spec: DocumentSpec, generatedAt: Date): Paragraph[] {
  const paragraphs: Paragraph[] = [
    new Paragraph({ spacing: { before: 3600 } }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: spec.title, font: FONT, size: 56, bold: true, color: ACCENT })]
    })
  ];
  if (spec.subtitle) {
    paragraphs.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 240 },
        children: [new TextRun({ text: spec.subtitle, font: FONT, size: 28, color: MUTED })]
      })
    );
  }
  paragraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 720 },
      children: [
        new TextRun({
          text: [spec.author, generatedAt.toISOString().slice(0, 10)]
            .filter((part) => part !== undefined && part.length > 0)
            .join(" · "),
          font: FONT,
          size: 20,
          color: MUTED
        })
      ]
    }),
    new Paragraph({ children: [new PageBreak()] })
  );
  return paragraphs;
}

function blockToParagraphs(block: DocumentBlock): (Paragraph | Table)[] {
  switch (block.kind) {
    case "heading": {
      const heading =
        block.level === 1
          ? HeadingLevel.HEADING_1
          : block.level === 2
            ? HeadingLevel.HEADING_2
            : HeadingLevel.HEADING_3;
      return [
        new Paragraph({
          heading,
          spacing: { before: 240, after: 120 },
          children: [new TextRun(block.text)]
        })
      ];
    }
    case "paragraph":
      return [
        new Paragraph({
          spacing: { after: 160 },
          children: [new TextRun(block.text)]
        })
      ];
    case "bullets":
      return block.items.map(
        (item) =>
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 80 },
            children: [new TextRun(item)]
          })
      );
    case "numbered":
      return block.items.map(
        (item) =>
          new Paragraph({
            numbering: { reference: "adpilot-numbering", level: 0 },
            spacing: { after: 80 },
            children: [new TextRun(item)]
          })
        );
    case "quote":
      return [
        new Paragraph({
          indent: { left: 720 },
          spacing: { after: 160 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 8 }
          },
          children: [new TextRun({ text: block.text, italics: true, color: MUTED })]
        })
      ];
    case "table": {
      const width = Math.floor(100 / block.head.length);
      const headerRow = new TableRow({
        tableHeader: true,
        children: block.head.map(
          (cell) =>
            new TableCell({
              width: { size: width, type: WidthType.PERCENTAGE },
              shading: { type: ShadingType.SOLID, color: ACCENT, fill: ACCENT },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: cell, bold: true, color: "FFFFFF" })]
                })
              ]
            })
        )
      });
      const bodyRows = block.rows.map(
        (row) =>
          new TableRow({
            children: row.map(
              (cell) =>
                new TableCell({
                  width: { size: width, type: WidthType.PERCENTAGE },
                  children: [new Paragraph({ children: [new TextRun(cell)] })]
                })
            )
          })
      );
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [headerRow, ...bodyRows]
        }),
        new Paragraph({ spacing: { after: 160 } })
      ];
    }
  }
}

function toPlainText(spec: DocumentSpec, generatedAt: Date): string {
  const lines: string[] = [`# ${spec.title}`];
  if (spec.subtitle) lines.push(spec.subtitle);
  lines.push(`Generated ${generatedAt.toISOString()}`, "");
  for (const block of spec.blocks) {
    switch (block.kind) {
      case "heading":
        lines.push(`${"#".repeat(block.level)} ${block.text}`, "");
        break;
      case "paragraph":
        lines.push(block.text, "");
        break;
      case "bullets":
        lines.push(...block.items.map((item) => `- ${item}`), "");
        break;
      case "numbered":
        lines.push(...block.items.map((item, index) => `${index + 1}. ${item}`), "");
        break;
      case "quote":
        lines.push(`> ${block.text}`, "");
        break;
      case "table":
        lines.push(
          `| ${block.head.join(" | ")} |`,
          `| ${block.head.map(() => "---").join(" | ")} |`,
          ...block.rows.map((row) => `| ${row.join(" | ")} |`),
          ""
        );
        break;
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Minimal Markdown → DocumentSpec converter, sufficient for advertising
 * reports: ATX headings (#/##/###), `-`/`*` bullet lists, `1.` numbered
 * lists, pipe tables, `>` quotes, and paragraphs. Not full CommonMark.
 * The first H1 becomes the document title.
 */
export function markdownToDocumentSpec(markdown: string): DocumentSpec {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let title: string | undefined;
  const blocks: DocumentBlock[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let numbered: string[] = [];
  let table: { head: string[]; rows: string[][] } | undefined;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushBullets = (): void => {
    if (bullets.length > 0) {
      blocks.push({ kind: "bullets", items: bullets });
      bullets = [];
    }
  };
  const flushNumbered = (): void => {
    if (numbered.length > 0) {
      blocks.push({ kind: "numbered", items: numbered });
      numbered = [];
    }
  };
  const flushTable = (): void => {
    if (table) {
      blocks.push({ kind: "table", head: table.head, rows: table.rows });
      table = undefined;
    }
  };
  const flush = (): void => {
    flushParagraph();
    flushBullets();
    flushNumbered();
    flushTable();
  };
  // Switching into one block kind finalizes the other in-progress kinds, but
  // consecutive lines of the same kind keep accumulating.
  const flushExcept = (keep: "bullets" | "numbered" | "table"): void => {
    flushParagraph();
    if (keep !== "bullets") flushBullets();
    if (keep !== "numbered") flushNumbered();
    if (keep !== "table") flushTable();
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    const bulletMatch = /^[-*]\s+(.*)$/.exec(trimmed);
    const numberedMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
    const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
    const isTableRow = trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;

    if (headingMatch) {
      flush();
      const level = headingMatch[1]?.length ?? 1;
      const text = (headingMatch[2] ?? "").trim();
      if (text.length === 0) continue;
      if (level === 1 && title === undefined) {
        title = text;
        continue;
      }
      blocks.push({
        kind: "heading",
        level: (Math.min(level, 3) as 1 | 2 | 3),
        text
      });
      continue;
    }
    if (isTableRow) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue; // separator row
      if (table === undefined) {
        flushExcept("table");
        table = { head: cells, rows: [] };
      } else {
        table.rows.push(cells);
      }
      continue;
    }
    if (bulletMatch) {
      flushExcept("bullets");
      bullets.push((bulletMatch[1] ?? "").trim());
      continue;
    }
    if (numberedMatch) {
      flushExcept("numbered");
      numbered.push((numberedMatch[1] ?? "").trim());
      continue;
    }
    if (quoteMatch) {
      flush();
      const text = (quoteMatch[1] ?? "").trim();
      if (text.length > 0) blocks.push({ kind: "quote", text });
      continue;
    }
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();

  return DocumentSpec.parse({
    title: title ?? "Untitled report",
    blocks: blocks.length > 0 ? blocks : [{ kind: "paragraph", text: "(empty document)" }]
  });
}
