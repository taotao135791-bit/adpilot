/**
 * Vendored from pi (https://github.com/earendil-works/pi),
 * packages/coding-agent/src/core/tools/grep.ts @ 0.80.10.
 * MIT License — see licenses/pi-MIT.txt.
 *
 * AdPilot adaptations:
 * - Paths resolve through the AdPilot read-path guard (workspace confinement)
 *   instead of upstream's cwd-relative resolveToCwd.
 * - The external ripgrep child process (auto-downloaded upstream via
 *   utils/tools-manager.ts) was replaced with an in-process filesystem walk;
 *   see walk.ts for the fixed ignore set (.git, node_modules) that replaces
 *   rg's .gitignore handling. Binary files (NUL byte in the first 8KB) and
 *   files larger than GREP_MAX_FILE_BYTES are skipped. Note: matching runs
 *   the model-supplied regex with the JS engine, so pathological patterns are
 *   not RE2-immune the way rg is — keep patterns simple.
 * - pi-tui renderCall/renderResult, promptSnippet and the pluggable
 *   GrepOperations indirection (upstream's remote-SSH hook) were removed.
 */
import { readFile, stat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ReadPathGuard } from "./path-guard.js";
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine, type TruncationResult } from "./truncate.js";
import { globMatches, globToRegExp, walkEntries } from "./walk.js";

const DEFAULT_LIMIT = 100;

/** Files larger than this are skipped during a search (bounded read cost). */
export const GREP_MAX_FILE_BYTES = 20 * 1024 * 1024;

const grepParameters = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (relative to the workspace root, or absolute inside a readable root; default: workspace root)" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
  context: Type.Optional(Type.Number({ minimum: 0, description: "Number of lines to show before and after each match (default: 0)" })),
  limit: Type.Optional(Type.Number({ minimum: 1, description: `Maximum number of matches to return (default: ${DEFAULT_LIMIT})` }))
});

const grepInput = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  ignoreCase: z.boolean().optional(),
  literal: z.boolean().optional(),
  context: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional()
});

export interface GrepToolDetails {
  truncation?: TruncationResult;
  matchLimitReached?: number;
  linesTruncated?: boolean;
}

interface GrepMatch {
  relativePath: string;
  lineNumber: number;
  lines: string[];
}

export function createGrepTool(guard: ReadPathGuard): AgentTool {
  return {
    name: "grep",
    label: "Search file contents",
    description: `Search file contents for a pattern inside the readable roots (${guard.describeRoots()}). Returns matching lines with file paths and line numbers. Skips .git, node_modules, and binary files. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    parameters: grepParameters,
    executionMode: "parallel",
    execute: async (_toolCallId, raw, signal) => {
      const { pattern, path: searchDir, glob, ignoreCase, literal, context, limit } = grepInput.parse(raw);
      if (signal?.aborted) throw new Error("Operation aborted");
      const searchPath = await guard.resolve(searchDir ?? ".");
      const contextValue = context && context > 0 ? context : 0;
      const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
      const globFilter = glob ? globToRegExp(glob) : undefined;

      let regex: RegExp;
      try {
        regex = new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? "i" : "");
      } catch (error) {
        throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
      }

      const rootStat = await stat(searchPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error(`Path not found: ${searchPath}`);
        throw error;
      });

      // Collect matching files: the root itself when it is a file, otherwise
      // every regular file in the walk (symlinked files only after the
      // guard's realpath check resolves them inside the policy).
      const candidateFiles: Array<{ path: string; relativePath: string }> = [];
      if (rootStat.isFile()) {
        candidateFiles.push({ path: searchPath, relativePath: searchPath.split("/").pop() ?? searchPath });
      } else if (rootStat.isDirectory()) {
        for await (const entry of walkEntries(searchPath, guard, { signal })) {
          if (entry.isDirectory) continue;
          if (globFilter && !globMatches(globFilter, entry.relativePath)) continue;
          if (entry.symbolicLink) {
            const resolved = await guard.resolve(entry.path).catch(() => undefined);
            if (!resolved) continue;
            const targetStat = await stat(resolved).catch(() => undefined);
            if (!targetStat?.isFile()) continue;
            candidateFiles.push({ path: resolved, relativePath: entry.relativePath });
            continue;
          }
          if (!entry.isFile) continue;
          candidateFiles.push({ path: entry.path, relativePath: entry.relativePath });
        }
      } else {
        throw new Error(`Not a file or directory: ${searchPath}`);
      }

      const matches: GrepMatch[] = [];
      let matchLimitReached = false;
      for (const file of candidateFiles) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (matches.length >= effectiveLimit) {
          matchLimitReached = true;
          break;
        }
        const fileStat = await stat(file.path).catch(() => undefined);
        if (!fileStat || fileStat.size > GREP_MAX_FILE_BYTES) continue;
        const buffer = await readFile(file.path).catch(() => undefined);
        if (!buffer || buffer.subarray(0, 8192).includes(0)) continue;
        const lines = buffer.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          if (!regex.test(lines[index]!)) continue;
          matches.push({ relativePath: file.relativePath, lineNumber: index + 1, lines });
          if (matches.length >= effectiveLimit) {
            matchLimitReached = true;
            break;
          }
        }
      }

      if (matches.length === 0) {
        return { content: [{ type: "text", text: "No matches found" }], details: undefined };
      }

      let linesTruncated = false;
      const outputLines: string[] = [];
      for (const match of matches) {
        const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
        const end = contextValue > 0 ? Math.min(match.lines.length, match.lineNumber + contextValue) : match.lineNumber;
        for (let current = start; current <= end; current += 1) {
          const lineText = (match.lines[current - 1] ?? "").replace(/\r/g, "");
          const isMatchLine = current === match.lineNumber;
          // Truncate long lines so grep output stays compact.
          const { text: truncatedText, wasTruncated } = truncateLine(lineText);
          if (wasTruncated) linesTruncated = true;
          if (isMatchLine) outputLines.push(`${match.relativePath}:${current}: ${truncatedText}`);
          else outputLines.push(`${match.relativePath}-${current}- ${truncatedText}`);
        }
      }

      const rawOutput = outputLines.join("\n");
      // Apply byte truncation. There is no line limit here because the match limit already capped rows.
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: GrepToolDetails = {};
      const notices: string[] = [];
      if (matchLimitReached) {
        notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
        details.matchLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
    }
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
