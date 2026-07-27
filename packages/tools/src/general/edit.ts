/**
 * Vendored from pi (https://github.com/earendil-works/pi),
 * packages/coding-agent/src/core/tools/edit.ts @ 0.80.10.
 * MIT License — see licenses/pi-MIT.txt.
 *
 * AdPilot adaptations:
 * - Paths resolve through the AdPilot write-path guard (strictly the
 *   workspace root; the `.adpilot` subtree and every protected path are
 *   rejected before a single byte is read or written) instead of upstream's
 *   cwd-relative resolveToCwd.
 * - pi-tui renderCall/renderResult and the streaming diff preview were
 *   removed (no TUI here); the edit semantics are kept: each oldText must
 *   occur exactly once in the original file (matched against the original,
 *   not incrementally), CRLF files round-trip in CRLF, a UTF-8 BOM is
 *   preserved. The upstream edit-diff helpers are inlined at their essential
 *   complexity instead of vendoring the whole diff renderer.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ReadPathGuard } from "./path-guard.js";
import { withFileMutationQueue } from "./write.js";

const editParameters = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative to the workspace root)" }),
  edits: Type.Array(Type.Object({
    oldText: Type.String({ description: "Exact text for one targeted replacement; must be unique in the file and must not overlap with other edits" }),
    newText: Type.String({ description: "Replacement text for this targeted edit" })
  }), { description: "One or more targeted replacements, matched against the original file (not incrementally). Merge nearby changes into one edit." })
});

const editInput = z.object({
  path: z.string().min(1),
  edits: z.array(z.object({ oldText: z.string(), newText: z.string() })).min(1)
});

export interface EditToolDetails {
  path: string;
  replacements: number;
  firstChangedLine: number;
}

function detectLineEnding(text: string): "\r\n" | "\n" {
  const index = text.indexOf("\n");
  return index > 0 && text[index - 1] === "\r" ? "\r\n" : "\n";
}

/** Applies the edits against the ORIGINAL content; every oldText must be unique and edits must not overlap. */
export function applyEdits(content: string, edits: readonly { oldText: string; newText: string }[]): string {
  let result = content;
  for (const [index, edit] of edits.entries()) {
    if (edit.oldText.length === 0) throw new Error(`edits[${index}].oldText must not be empty`);
    const occurrences = result.split(edit.oldText).length - 1;
    if (occurrences === 0) {
      throw new Error(`edits[${index}].oldText was not found in the file (matching is exact, against the original content)`);
    }
    if (occurrences > 1) {
      throw new Error(`edits[${index}].oldText occurs ${occurrences} times; it must be unique in the file`);
    }
  }
  for (const [index, edit] of edits.entries()) {
    for (const [otherIndex, other] of edits.entries()) {
      if (otherIndex !== index && other.oldText.includes(edit.oldText)) {
        throw new Error(`edits[${index}].oldText overlaps with edits[${otherIndex}].oldText; merge them into one edit`);
      }
    }
    result = result.replace(edit.oldText, edit.newText);
  }
  return result;
}

export function createEditTool(guard: ReadPathGuard): AgentTool {
  return {
    name: "edit",
    label: "Edit a file",
    description: `Apply targeted text replacements to a file inside the workspace root (${guard.describeRoots()}). Each oldText must match the current file content exactly and uniquely. Paths outside the workspace, inside the private .adpilot directory, or on protected paths (credentials, approval secrets, audit chain, browser profiles) are refused.`,
    parameters: editParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, raw, signal) => {
      const { path, edits } = editInput.parse(raw);
      if (signal?.aborted) throw new Error("Operation aborted");
      const absolutePath = await guard.resolve(path);
      return withFileMutationQueue(absolutePath, async () => {
        if (signal?.aborted) throw new Error("Operation aborted");
        const buffer = await readFile(absolutePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") throw new Error(`Path not found: ${absolutePath}`);
          throw error;
        });
        const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
        const rawText = buffer.toString("utf-8");
        const withoutBom = hasBom ? rawText.slice(1) : rawText;
        const lineEnding = detectLineEnding(withoutBom);
        const normalized = lineEnding === "\r\n" ? withoutBom.replaceAll("\r\n", "\n") : withoutBom;
        const edited = applyEdits(normalized, edits);
        if (edited === normalized) throw new Error("edits produced no change");
        const restored = lineEnding === "\r\n" ? edited.replaceAll("\n", "\r\n") : edited;
        if (signal?.aborted) throw new Error("Operation aborted");
        await writeFile(absolutePath, hasBom ? "\uFEFF" + restored : restored, "utf-8");
        const firstChangedLine = edited.slice(0, firstDifferenceIndex(normalized, edited)).split("\n").length;
        const details: EditToolDetails = { path: absolutePath, replacements: edits.length, firstChangedLine };
        return {
          content: [{ type: "text" as const, text: `Applied ${edits.length} edit(s) to ${path} (first change at line ${firstChangedLine})` }],
          details
        };
      });
    }
  };
}

function firstDifferenceIndex(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return limit;
}
