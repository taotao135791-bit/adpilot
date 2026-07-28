import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactService,
  DocumentRenderer,
  FileArtifactStore,
  markdownToDocumentSpec,
  SpreadsheetRenderer,
  SlidesRenderer,
  type SlidesSpec,
  type WorkbookSpec
} from "./index.js";

let root: string;
let store: FileArtifactStore;
let service: ArtifactService;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "adpilot-artifacts-"));
  store = new FileArtifactStore(root);
  service = new ArtifactService(store);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const slidesSpec: SlidesSpec = {
  title: "Q3 投放复盘",
  theme: { accentColor: "FF6B2C", fontFamily: "Arial" },
  slides: [
    { layout: "title", heading: "Q3 投放复盘", subheading: "Google Ads · UAC" },
    { layout: "section", heading: "核心结论", subheading: "三条主线" },
    {
      layout: "bullets",
      heading: "本期要点",
      bullets: ["CPI 环比下降 12%", "韩国市场 ROAS 达标", "素材疲劳度上升"],
      notes: "强调韩国市场的出价实验",
      kpi: [
        { label: "CPI", value: "$1.84", delta: "-12% WoW" },
        { label: "ROAS D7", value: "38%", delta: "+4pt" }
      ]
    },
    {
      layout: "two-column",
      heading: "做了什么 / 下一步",
      columns: {
        left: ["重启 AC2.5 出价实验", "下线低效素材 14 条"],
        right: ["扩量韩国 tROAS", "补齐短视频素材"]
      }
    },
    {
      layout: "table",
      heading: "分渠道数据",
      table: {
        head: ["渠道", "花费", "安装", "CPI"],
        rows: [
          ["Google UAC", "$12,400", "6,739", "$1.84"],
          ["Meta", "$8,200", "3,905", "$2.10"]
        ]
      }
    },
    {
      layout: "chart",
      heading: "周安装趋势",
      chart: {
        kind: "bar",
        categories: ["W1", "W2", "W3", "W4"],
        series: [{ name: "安装", values: [1420, 1680, 1510, 2129] }]
      }
    },
    { layout: "closing", heading: "谢谢", subheading: "数据口径: MMP D7" }
  ]
};

describe("SlidesRenderer", () => {
  it("renders a real .pptx plus one SVG thumbnail per slide", async () => {
    const out = join(root, "slides-out");
    const { files } = await new SlidesRenderer().render(slidesSpec, out);
    expect(files).toContain("slides.pptx");
    expect(files.filter((file) => file.endsWith(".svg"))).toHaveLength(slidesSpec.slides.length);

    const pptx = await readFile(join(out, "slides.pptx"));
    expect(pptx.subarray(0, 2).toString()).toBe("PK");
    const zip = await JSZip.loadAsync(pptx);
    const slideFiles = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name)
    );
    expect(slideFiles).toHaveLength(slidesSpec.slides.length);

    // Theme accent color is applied to every slide master/shape output.
    const slideOne = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideOne).toContain("FF6B2C");
    // Page number footer.
    expect(slideOne).toContain("1 / 7");
    // Speaker notes round-trip.
    const notesFiles = Object.keys(zip.files).filter((name) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)
    );
    expect(notesFiles.length).toBeGreaterThan(0);
    const notesXml = await zip.file("ppt/notesSlides/notesSlide3.xml")?.async("string");
    expect(notesXml).toContain("出价实验");

    const thumb = await readFile(join(out, "thumb-01.svg"), "utf8");
    expect(thumb).toContain("<svg");
    expect(thumb).toContain("Q3 投放复盘");
  });
});

const workbookSpec: WorkbookSpec = {
  title: "日报数据",
  sheets: [
    {
      name: "Campaigns",
      columns: [
        { header: "Campaign", key: "campaign", width: 28 },
        { header: "Cost", key: "cost", width: 12, format: "#,##0.00" },
        { header: "Installs", key: "installs", width: 10 },
        { header: "CPI", key: "cpi", width: 10, format: "0.00" }
      ],
      rows: [
        { campaign: "UAC-KR-tROAS", cost: 5200.5, installs: 2826 },
        { campaign: "UAC-JP-Install", cost: 3400, installs: 1619 },
        {
          campaign: "合计",
          cost: { formula: "SUM(B2:B3)", result: 8600.5 },
          installs: { formula: "SUM(C2:C3)", result: 4445 },
          cpi: { formula: "B4/C4", result: 1.93 }
        }
      ]
    },
    {
      name: " creatives 素材",
      columns: [{ header: "Name", key: "name" }],
      rows: [{ name: "video_hook_a.mp4" }],
      freezeHeader: false
    }
  ]
};

describe("SpreadsheetRenderer", () => {
  it("renders a real workbook with formulas, formats and a frozen header", async () => {
    const out = join(root, "sheets-out");
    const { files } = await new SpreadsheetRenderer().render(workbookSpec, out);
    expect(files).toContain("workbook.xlsx");
    expect(files).toContain("sheet-campaigns.csv");
    expect(files).toContain("sheet-creatives.csv");
    expect(files).toContain("preview.json");

    const buffer = await readFile(join(out, "workbook.xlsx"));
    const workbook = XLSX.read(buffer, { cellNF: true, cellStyles: true });
    expect(workbook.SheetNames).toEqual(["Campaigns", " creatives 素材"]);
    const sheet = workbook.Sheets["Campaigns"];
    expect(sheet).toBeDefined();
    // Formulas survive a round-trip through the real file.
    expect(sheet?.["B4"]?.f).toBe("SUM(B2:B3)");
    expect(sheet?.["D4"]?.f).toBe("B4/C4");
    expect(sheet?.["B4"]?.v).toBe(8600.5);
    // Number format written via the cell z property.
    expect(sheet?.["B2"]?.z).toBe("#,##0.00");
    // Column widths.
    expect(sheet?.["!cols"]?.[0]?.wch).toBe(28);

    // Frozen header + bold header style are patched into the package.
    const zip = await JSZip.loadAsync(buffer);
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
    expect(sheetXml).toContain('state="frozen"');
    expect(sheetXml).toContain('topLeftCell="A2"');
    expect(sheetXml).toMatch(/<c r="A1"[^>]*s="\d+"/);
    const stylesXml = await zip.file("xl/styles.xml")?.async("string");
    expect(stylesXml).toContain("<b/>");
    // Second sheet opts out of the freeze.
    const sheetTwoXml = await zip.file("xl/worksheets/sheet2.xml")?.async("string");
    expect(sheetTwoXml).not.toContain('state="frozen"');

    const csv = await readFile(join(out, "sheet-campaigns.csv"), "utf8");
    expect(csv.split("\n")[0]).toContain("Campaign,Cost,Installs,CPI");

    const preview = JSON.parse(await readFile(join(out, "preview.json"), "utf8")) as Record<
      string,
      Record<string, unknown>[]
    >;
    expect(preview["Campaigns"]).toHaveLength(3);
    expect(preview["Campaigns"]?.[2]?.["Cost"]).toBe("=SUM(B2:B3)");
  });

  it("caps the JSON preview at 50 rows", async () => {
    const out = join(root, "sheets-big");
    const rows = Array.from({ length: 60 }, (_, index) => ({ name: `row-${index}` }));
    await new SpreadsheetRenderer().render(
      { sheets: [{ name: "Big", columns: [{ header: "Name", key: "name" }], rows }] },
      out
    );
    const preview = JSON.parse(await readFile(join(out, "preview.json"), "utf8")) as Record<
      string,
      unknown[]
    >;
    expect(preview["Big"]).toHaveLength(50);
  });
});

describe("DocumentRenderer", () => {
  it("renders a real .docx with headings, a table and header/footer", async () => {
    const out = join(root, "docs-out");
    const spec = markdownToDocumentSpec(
      [
        "# 客户周报",
        "",
        "本周整体消耗稳定，韩国市场继续扩量。",
        "",
        "## 关键动作",
        "",
        "- 重启 AC2.5 出价实验",
        "- 下线低效素材 14 条",
        "",
        "1. 第一步：对齐口径",
        "2. 第二步：确认预算",
        "",
        "> 客户要求下周提供分渠道拆解。",
        "",
        "| 渠道 | 花费 | CPI |",
        "| --- | --- | --- |",
        "| Google UAC | $12,400 | $1.84 |",
        "| Meta | $8,200 | $2.10 |"
      ].join("\n")
    );
    expect(spec.title).toBe("客户周报");
    expect(spec.blocks.some((block) => block.kind === "table")).toBe(true);
    expect(spec.blocks.some((block) => block.kind === "quote")).toBe(true);
    expect(spec.blocks.some((block) => block.kind === "numbered")).toBe(true);

    const { files } = await new DocumentRenderer().render(
      { ...spec, cover: true, subtitle: "2026-W30", author: "AdPilot" },
      out
    );
    expect(files).toEqual(["document.docx", "preview.txt"]);

    const docx = await readFile(join(out, "document.docx"));
    expect(docx.subarray(0, 2).toString()).toBe("PK");
    const zip = await JSZip.loadAsync(docx);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    expect(documentXml).toContain("关键动作");
    expect(documentXml).toContain("重启 AC2.5 出价实验");
    // Real table markup with the channel row.
    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).toContain("Google UAC");
    const footerNames = Object.keys(zip.files).filter((name) => /^word\/footer\d+\.xml$/.test(name));
    expect(footerNames.length).toBeGreaterThan(0);
    const footerXml = await zip.file(footerNames[0] as string)?.async("string");
    expect(footerXml).toContain("Generated");
    expect(footerXml).toContain("PAGE");
    const headerNames = Object.keys(zip.files).filter((name) => /^word\/header\d+\.xml$/.test(name));
    const headerXml = await zip.file(headerNames[0] as string)?.async("string");
    expect(headerXml).toContain("客户周报");

    const preview = await readFile(join(out, "preview.txt"), "utf8");
    expect(preview).toContain("# 客户周报");
    expect(preview).toContain("| Google UAC | $12,400 | $1.84 |");
  });
});

describe("FileArtifactStore + ArtifactService", () => {
  it("creates artifacts, keeps old versions and marks lifecycle status", async () => {
    const record = await service.createFromRenderer(
      "proj-ads",
      "slides",
      "Q3 投放复盘",
      slidesSpec,
      new SlidesRenderer(),
      { sessionId: "session-1" }
    );
    expect(record.status).toBe("ready");
    expect(record.version).toBe(1);
    expect(record.previewUrl).toBe("v1/thumb-01.svg");
    expect(record.exportFormats).toEqual(["pptx", "svg"]);
    expect(record.sourceFiles).toEqual(["spec.json"]);

    // record.json is private.
    const recordStat = await stat(join(root, ".adpilot", "artifacts", record.id, "record.json"));
    expect(recordStat.mode & 0o777).toBe(0o600);

    // Re-render same title+project → version 2, v1 files kept.
    const second = await service.createFromRenderer(
      "proj-ads",
      "slides",
      "Q3 投放复盘",
      slidesSpec,
      new SlidesRenderer()
    );
    expect(second.id).toBe(record.id);
    expect(second.version).toBe(2);
    expect(second.revision).toBeGreaterThan(record.revision);
    const versions = await service.listVersions(record.id);
    expect(versions.map((entry) => entry.version)).toEqual([1, 2]);
    expect(versions[0]?.files).toContain("slides.pptx");
    const oldPptx = await store.readOutput(record.id, "v1/slides.pptx");
    const newPptx = await store.readOutput(record.id, "v2/slides.pptx");
    expect(oldPptx?.subarray(0, 2).toString()).toBe("PK");
    expect(newPptx?.subarray(0, 2).toString()).toBe("PK");

    // Spec-level slide update re-renders as version 3.
    const updated = await service.updateSlide(record.id, 2, { heading: "本期要点（已更新）" });
    expect(updated.version).toBe(3);
    const specBuffer = await store.readOutput(record.id, "spec.json");
    expect(specBuffer?.toString("utf8")).toContain("本期要点（已更新）");

    // list() filters by project.
    const projectArtifacts = await service.list("proj-ads");
    expect(projectArtifacts.map((entry) => entry.id)).toEqual([record.id]);
    expect(await service.list("other-project")).toEqual([]);
  });

  it("records failed renders with the error on the record", async () => {
    const failing = {
      exportFormats: ["bin"],
      render: async (): Promise<{ files: string[] }> => {
        throw new Error("render exploded");
      }
    };
    await expect(
      service.createFromRenderer("proj-ads", "report", "坏掉的产物", {}, failing)
    ).rejects.toThrow("render exploded");
    const failed = (await service.list("proj-ads")).find(
      (entry) => entry.title === "坏掉的产物"
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("render exploded");
  });

  it("rejects output filenames that escape the artifact directory", async () => {
    const record = await service.createFromRenderer(
      "proj-ads",
      "document",
      "逃逸测试",
      { title: "t", blocks: [{ kind: "paragraph", text: "x" }] },
      new DocumentRenderer()
    );
    await expect(store.writeOutput(record.id, "../escape.txt", Buffer.from("x"))).rejects.toThrow(
      /escaped|relative/
    );
    await expect(store.writeOutput(record.id, "/abs/path.txt", Buffer.from("x"))).rejects.toThrow(
      /escaped|relative/
    );
    await expect(store.writeOutput(record.id, "v1/../../escape.txt", Buffer.from("x"))).rejects.toThrow(
      /escaped/
    );
    await expect(store.readOutput(record.id, "../../outside.json")).rejects.toThrow(/escaped/);

    await service.delete(record.id);
    expect(await store.get(record.id)).toBeUndefined();
    const versions = await store.listVersions(record.id);
    expect(versions).toEqual([]);
  });
});
