import { useCallback, useEffect, useState } from "react";
import {
  artifactStatusLabel,
  artifactStatusTone,
  artifactTypeLabel,
  workspaceCopy,
  type AppLocale
} from "../labels.js";
import {
  artifactDownloadFile,
  artifactOutputUrl,
  artifactThumbFiles,
  currentVersionFiles,
  interpolate,
  kernelArtifactUrl,
  type ArtifactVersionFiles,
  type KernelArtifact
} from "../workspace.js";
import { Badge, Button } from "../ui.js";
import { IconChevronDown, IconDownload, IconFile } from "../icons.js";

/**
 * Artifact preview panel: renders the real outputs of the selected artifact
 * — a slides carousel over the per-slide SVG thumbnails, the plain-text
 * document preview, or the spreadsheet preview.json as a table — plus a
 * download link for the original deliverable file (pptx/docx/xlsx…). Version
 * files come from the artifact detail payload, so the carousel count is
 * always exact.
 */
export function PreviewPanel({ locale, workspaceId, artifacts, selectedId, onSelect }: {
  locale: AppLocale;
  workspaceId: string;
  artifacts: KernelArtifact[];
  selectedId: string | null;
  onSelect: (artifactId: string) => void;
}) {
  const copy = workspaceCopy(locale);
  const artifact = artifacts.find((item) => item.id === selectedId) ?? null;
  const [files, setFiles] = useState<string[]>([]);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [tablePreview, setTablePreview] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const [error, setError] = useState("");

  const loadDetail = useCallback(async (target: KernelArtifact) => {
    setError("");
    setTextPreview(null);
    setTablePreview(null);
    setSlideIndex(0);
    try {
      const response = await fetch(kernelArtifactUrl(target.id, workspaceId));
      if (!response.ok) throw new Error(String(response.status));
      const detail = await response.json() as KernelArtifact & { versions?: ArtifactVersionFiles[] };
      const versionFiles = currentVersionFiles(target, detail.versions ?? []);
      setFiles(versionFiles);
      const versionPrefix = `v${target.version}/`;
      if (target.type === "document" && versionFiles.includes("preview.txt")) {
        const preview = await fetch(artifactOutputUrl(target.id, `${versionPrefix}preview.txt`, workspaceId));
        if (preview.ok) setTextPreview(await preview.text());
      } else if (target.type === "spreadsheet" && versionFiles.includes("preview.json")) {
        const preview = await fetch(artifactOutputUrl(target.id, `${versionPrefix}preview.json`, workspaceId));
        if (preview.ok) setTablePreview(normalizeSpreadsheetPreview(await preview.json()));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.previewLoadFailed);
    }
  }, [copy, workspaceId]);

  useEffect(() => { if (artifact) void loadDetail(artifact); }, [artifact, loadDetail]);

  if (artifacts.length === 0) {
    return (
      <div className="panel preview-panel">
        <div className="empty-block">
          <strong>{copy.previewEmpty}</strong>
          <p>{copy.previewEmptyBody}</p>
        </div>
      </div>
    );
  }

  if (!artifact) {
    return (
      <div className="panel preview-panel">
        <div className="empty-block">
          <IconFile size={22} />
          <p>{copy.previewSelect}</p>
        </div>
      </div>
    );
  }

  const thumbs = artifactThumbFiles(files);
  const download = artifactDownloadFile(files);
  const versionPrefix = `v${artifact.version}/`;

  return (
    <div className="panel preview-panel">
      <div className="preview-head">
        <div className="preview-title">
          <strong>{artifact.title}</strong>
          <div className="project-card-meta">
            <Badge tone="neutral" variant="outline">{artifactTypeLabel(artifact.type, locale)}</Badge>
            <Badge tone={artifactStatusTone(artifact.status)} variant="soft">{artifactStatusLabel(artifact.status, locale)}</Badge>
            <Badge tone="neutral" variant="outline">{interpolate(copy.artifactVersion, { version: String(artifact.version) })}</Badge>
          </div>
        </div>
        {download && (
          <a className="preview-download" href={artifactOutputUrl(artifact.id, `${versionPrefix}${download}`, workspaceId)} download={download}>
            <IconDownload size={13} />
            {copy.previewDownload}
          </a>
        )}
      </div>

      {error && (
        <div className="panel-banner" data-tone="danger" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="subtle" onClick={() => void loadDetail(artifact)}>{copy.retry}</Button>
        </div>
      )}

      <div className="panel-scroll">
        {artifact.type === "slides" && thumbs.length > 0 && (
          <div className="preview-carousel">
            <img
              className="preview-thumb"
              src={artifactOutputUrl(artifact.id, `${versionPrefix}${thumbs[Math.min(slideIndex, thumbs.length - 1)]}`, workspaceId)}
              alt={`${artifact.title} ${interpolate(copy.previewOf, { index: String(slideIndex + 1), total: String(thumbs.length) })}`}
            />
            <div className="preview-nav">
              <Button size="sm" variant="outline" disabled={slideIndex <= 0} onClick={() => setSlideIndex((index) => Math.max(0, index - 1))}>
                <IconChevronDown size={12} className="rotate-90" />
              </Button>
              <span>{interpolate(copy.previewOf, { index: String(slideIndex + 1), total: String(thumbs.length) })}</span>
              <Button size="sm" variant="outline" disabled={slideIndex >= thumbs.length - 1} onClick={() => setSlideIndex((index) => Math.min(thumbs.length - 1, index + 1))}>
                <IconChevronDown size={12} className="rotate-neg-90" />
              </Button>
            </div>
          </div>
        )}

        {artifact.type === "document" && (
          textPreview !== null
            ? <pre className="preview-text">{textPreview}</pre>
            : !error && <p className="workbench-quiet">{copy.loading}…</p>
        )}

        {artifact.type === "spreadsheet" && tablePreview && (
          <table className="preview-table">
            <thead>
              <tr>{tablePreview.columns.map((column, index) => <th key={index}>{column}</th>)}</tr>
            </thead>
            <tbody>
              {tablePreview.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell === null || cell === undefined ? "" : String(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        )}

        {artifact.type !== "slides" && artifact.type !== "document" && artifact.type !== "spreadsheet" && (
          <div className="empty-block">
            <p>{copy.previewSelect}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Normalizes the spreadsheet renderer's preview.json into columns + rows.
 * The renderer writes a workbook-shaped object (sheet names to row arrays of
 * objects); the first sheet becomes the table, its union of keys the columns.
 */
function normalizeSpreadsheetPreview(payload: unknown): { columns: string[]; rows: unknown[][] } {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const sheets = Object.values(payload as Record<string, unknown>);
    const firstSheet = sheets.find((sheet) => Array.isArray(sheet));
    if (Array.isArray(firstSheet)) {
      const records = firstSheet.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
      if (records.length > 0) {
        const columns = [...new Set(records.flatMap((row) => Object.keys(row)))];
        return { columns, rows: records.map((row) => columns.map((column) => row[column])) };
      }
    }
  }
  return { columns: [], rows: [] };
}
