/**
 * Vendored from pi (https://github.com/earendil-works/pi),
 * packages/coding-agent/src/core/tools/find.ts @ 0.80.10.
 * MIT License — see licenses/pi-MIT.txt.
 *
 * AdPilot adaptations:
 * - Paths resolve through the AdPilot read-path guard (workspace confinement)
 *   instead of upstream's cwd-relative resolveToCwd.
 * - The external fd child process (auto-downloaded upstream via
 *   utils/tools-manager.ts) was replaced with an in-process filesystem walk;
 *   see walk.ts for the supported glob subset and the fixed ignore set
 *   (.git, node_modules) that replaces fd's .gitignore handling. Matching
 *   directories are listed with a trailing '/' like fd.
 * - pi-tui renderCall/renderResult, promptSnippet and the pluggable
 *   FindOperations indirection (upstream's remote-SSH hook) were removed.
 */
import { stat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ReadPathGuard } from "./path-guard.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from "./truncate.js";
import { globMatches, globToRegExp, walkEntries } from "./walk.js";

const DEFAULT_LIMIT = 1000;

const findParameters = Type.Object({
  pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
  path: Type.Optional(Type.String({ description: "Directory to search in (relative to the workspace root, or absolute inside a readable root; default: workspace root)" })),
  limit: Type.Optional(Type.Number({ minimum: 1, description: `Maximum number of results (default: ${DEFAULT_LIMIT})` }))
});

const findInput = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  limit: z.number().int().min(1).optional()
});

export interface FindToolDetails {
  truncation?: TruncationResult;
  resultLimitReached?: number;
}

export function createFindTool(guard: ReadPathGuard): AgentTool {
  return {
    name: "find",
    label: "Find files",
    description: `Search for files by glob pattern inside the readable roots (${guard.describeRoots()}). Returns matching file paths relative to the search directory. Skips .git and node_modules. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: findParameters,
    executionMode: "parallel",
    execute: async (_toolCallId, raw, signal) => {
      const { pattern, path: searchDir, limit } = findInput.parse(raw);
      if (signal?.aborted) throw new Error("Operation aborted");
      const searchPath = await guard.resolve(searchDir ?? ".");
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      const rootStat = await stat(searchPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error(`Path not found: ${searchPath}`);
        throw error;
      });
      if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${searchPath}`);

      const compiled = globToRegExp(pattern);
      const results: string[] = [];
      let resultLimitReached = false;
      for await (const entry of walkEntries(searchPath, guard, { signal })) {
        if (results.length >= effectiveLimit) {
          resultLimitReached = true;
          break;
        }
        if (!globMatches(compiled, entry.relativePath)) continue;
        results.push(entry.isDirectory ? `${entry.relativePath}/` : entry.relativePath);
      }

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
      }

      const rawOutput = results.join("\n");
      // Apply byte truncation. There is no separate line limit because the result count is already capped.
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let resultOutput = truncation.content;
      const details: FindToolDetails = {};
      const notices: string[] = [];
      if (resultLimitReached) {
        notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
        details.resultLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (notices.length > 0) {
        resultOutput += `\n\n[${notices.join(". ")}]`;
      }
      return { content: [{ type: "text", text: resultOutput }], details: Object.keys(details).length > 0 ? details : undefined };
    }
  };
}
