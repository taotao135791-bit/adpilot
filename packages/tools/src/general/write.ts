/**
 * Vendored from pi (https://github.com/earendil-works/pi),
 * packages/coding-agent/src/core/tools/write.ts @ 0.80.10.
 * MIT License — see licenses/pi-MIT.txt.
 *
 * AdPilot adaptations:
 * - Paths resolve through the AdPilot write-path guard (strictly the
 *   workspace root; the `.adpilot` subtree and every protected path are
 *   rejected before a single byte is written) instead of upstream's
 *   cwd-relative resolveToCwd.
 * - pi-tui renderCall/renderResult, syntax highlighting and promptSnippet
 *   were removed (no TUI here). The file-mutation queue is kept as an
 *   in-process lock per path.
 * - The tool gate classifies write as an approval-gated write: the model call
 *   must reference the executed approval of the same client and task.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ReadPathGuard } from "./path-guard.js";
import { formatSize } from "./truncate.js";

/** Serializes mutations per absolute path so concurrent writes cannot interleave. */
const mutationQueues = new Map<string, Promise<unknown>>();

export function withFileMutationQueue<T>(absolutePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(absolutePath) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  mutationQueues.set(absolutePath, result.catch(() => undefined));
  return result;
}

const writeParameters = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative to the workspace root)" }),
  content: Type.String({ description: "Content to write to the file" })
});

const writeInput = z.object({
  path: z.string().min(1),
  content: z.string()
});

export function createWriteTool(guard: ReadPathGuard): AgentTool {
  return {
    name: "write",
    label: "Write a file",
    description: `Write content to a file inside the workspace root (${guard.describeRoots()}), creating parent directories as needed and overwriting existing files. Writes outside the workspace, into the private .adpilot directory, or onto protected paths (credentials, approval secrets, audit chain, browser profiles) are refused. Use write only for new files or complete rewrites; use edit for targeted changes.`,
    parameters: writeParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, raw, signal) => {
      const { path, content } = writeInput.parse(raw);
      if (signal?.aborted) throw new Error("Operation aborted");
      const absolutePath = await guard.resolve(path);
      const directory = dirname(absolutePath);
      return withFileMutationQueue(absolutePath, async () => {
        // Do not reject from an abort event listener here: that would release the
        // mutation queue while an in-flight filesystem operation may still finish.
        if (signal?.aborted) throw new Error("Operation aborted");
        await mkdir(directory, { recursive: true });
        if (signal?.aborted) throw new Error("Operation aborted");
        await writeFile(absolutePath, content, "utf-8");
        return {
          content: [{ type: "text" as const, text: `Successfully wrote ${formatSize(Buffer.byteLength(content, "utf-8"))} to ${path}` }],
          details: { path: absolutePath, bytes: Buffer.byteLength(content, "utf-8") }
        };
      });
    }
  };
}
