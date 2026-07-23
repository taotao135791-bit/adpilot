/**
 * Vendored from pi (https://github.com/earendil-works/pi),
 * packages/coding-agent/src/core/tools/read.ts @ 0.80.10.
 * MIT License — see licenses/pi-MIT.txt.
 *
 * AdPilot adaptations:
 * - Paths resolve through the AdPilot read-path guard (workspace confinement)
 *   instead of upstream's cwd-relative resolveToCwd/resolveReadPathAsync; the
 *   macOS screenshot filename variants (NFD, curly quotes, AM/PM) were dropped
 *   because tool paths come from ls/find output, not user drag-and-drop.
 * - The image pipeline was trimmed: upstream detects supported image MIME
 *   types and attaches processed image content via coding-agent-only modules
 *   (utils/image-process.ts, utils/mime.ts, photon WASM). This build keeps
 *   text files only; known image extensions and binary content return an
 *   explicit note instead of image attachments. Screenshot analysis in
 *   AdPilot goes through the managed visual table pipeline.
 * - pi-tui renderCall/renderResult, syntax highlighting, promptSnippet and
 *   the pi-docs compact-read classification were removed (no TUI here).
 * - The first-line-exceeds-limit hint no longer points at a bash/sed fallback
 *   (AdPilot has no bash tool); it points at grep instead.
 * - Files larger than READ_MAX_FILE_BYTES are refused before loading.
 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ReadPathGuard } from "./path-guard.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, type TruncationResult } from "./truncate.js";

/** Extensions upstream would serve as image attachments; this build reports them as unsupported. */
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

/** Files larger than this are refused up front instead of being read fully into memory. */
export const READ_MAX_FILE_BYTES = 64 * 1024 * 1024;

const readParameters = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative to the workspace root, or absolute inside a readable root)" }),
  offset: Type.Optional(Type.Number({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum number of lines to read" }))
});

const readInput = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional()
});

export interface ReadToolDetails {
  truncation?: TruncationResult;
}

export function createReadTool(guard: ReadPathGuard): AgentTool {
  return {
    name: "read",
    label: "Read a file",
    description: `Read the contents of a text file inside the readable roots (${guard.describeRoots()}). Paths are relative to the workspace root unless absolute. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. Images and binary files are not supported by this build.`,
    parameters: readParameters,
    executionMode: "parallel",
    execute: async (_toolCallId, raw, signal) => {
      const { path, offset, limit } = readInput.parse(raw);
      if (signal?.aborted) throw new Error("Operation aborted");
      const absolutePath = await guard.resolve(path);
      const fileStat = await stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error(`Path not found: ${absolutePath}`);
        throw error;
      });
      if (fileStat.isDirectory()) throw new Error(`Not a file: ${absolutePath}. Use the ls tool to list directories.`);
      if (fileStat.size > READ_MAX_FILE_BYTES) {
        throw new Error(`File is ${formatSize(fileStat.size)}, too large to read whole. Use the grep tool to extract the relevant lines.`);
      }
      if (IMAGE_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
        return {
          content: [{ type: "text", text: `[Image files are not supported by this build of the read tool: ${absolutePath}. AdPilot analyzes screenshots through the managed visual table pipeline, not file attachments.]` }],
          details: undefined
        };
      }
      const buffer = await readFile(absolutePath);
      if (buffer.subarray(0, 8192).includes(0)) {
        throw new Error(`File appears to be binary and cannot be displayed as text: ${absolutePath}`);
      }
      const textContent = buffer.toString("utf-8");
      const allLines = textContent.split("\n");
      const totalFileLines = allLines.length;
      // Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
      }
      let selectedContent: string;
      let userLimitedLines: number | undefined;
      // If limit is specified by the user, honor it first. Otherwise truncateHead decides.
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }
      // Apply truncation, respecting both line and byte limits.
      const truncation = truncateHead(selectedContent);
      let outputText: string;
      let details: ReadToolDetails | undefined;
      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine]!, "utf-8"));
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use the grep tool with a pattern to extract matching portions of long lines]`;
        details = { truncation };
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        if (truncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
        } else {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        }
        details = { truncation };
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText = truncation.content;
      }
      return { content: [{ type: "text", text: outputText }], details };
    }
  };
}
