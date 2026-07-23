/**
 * Vendored from pi (https://github.com/earendil-works/pi),
 * packages/coding-agent/src/core/tools/ls.ts @ 0.80.10.
 * MIT License — see licenses/pi-MIT.txt.
 *
 * AdPilot adaptations:
 * - Paths resolve through the AdPilot read-path guard (workspace confinement)
 *   instead of upstream's cwd-relative resolveToCwd.
 * - pi-tui renderCall/renderResult, promptSnippet and the pluggable
 *   LsOperations indirection (upstream's remote-SSH hook) were removed; the
 *   tool always reads the local filesystem.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ReadPathGuard } from "./path-guard.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from "./truncate.js";

const DEFAULT_LIMIT = 500;

const lsParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (relative to the workspace root, or absolute inside a readable root; default: workspace root)" })),
  limit: Type.Optional(Type.Number({ minimum: 1, description: `Maximum number of entries to return (default: ${DEFAULT_LIMIT})` }))
});

const lsInput = z.object({
  path: z.string().min(1).optional(),
  limit: z.number().int().min(1).optional()
});

export interface LsToolDetails {
  truncation?: TruncationResult;
  entryLimitReached?: number;
}

export function createLsTool(guard: ReadPathGuard): AgentTool {
  return {
    name: "ls",
    label: "List a directory",
    description: `List directory contents inside the readable roots (${guard.describeRoots()}). Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: lsParameters,
    executionMode: "parallel",
    execute: async (_toolCallId, raw, signal) => {
      const { path, limit } = lsInput.parse(raw);
      if (signal?.aborted) throw new Error("Operation aborted");
      const dirPath = await guard.resolve(path ?? ".");
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      const dirStat = await stat(dirPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error(`Path not found: ${dirPath}`);
        throw error;
      });
      if (!dirStat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

      const entries = await readdir(dirPath).catch((error: NodeJS.ErrnoException) => {
        throw new Error(`Cannot read directory: ${error.message}`);
      });

      // Sort alphabetically, case-insensitive.
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      // Format entries with directory indicators.
      const results: string[] = [];
      let entryLimitReached = false;
      for (const entry of entries) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (results.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        let suffix = "";
        try {
          const entryStat = await stat(join(dirPath, entry));
          if (entryStat.isDirectory()) suffix = "/";
        } catch {
          // Skip entries we cannot stat.
          continue;
        }
        results.push(entry + suffix);
      }

      if (results.length === 0) {
        return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
      }

      const rawOutput = results.join("\n");
      // Apply byte truncation. There is no separate line limit because entry count is already capped.
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: LsToolDetails = {};
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
        details.entryLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
      }
      return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
    }
  };
}
