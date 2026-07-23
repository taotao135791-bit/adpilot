/**
 * General read-only tool set, vendored from pi's read-only factory
 * (packages/coding-agent/src/core/tools/index.ts createReadOnlyToolDefinitions
 * @ 0.80.10, MIT — see licenses/pi-MIT.txt) and adapted to AdPilot:
 * every tool is bound to one read-path guard so the model can only observe
 * the client workspace and directories the operator explicitly allowed.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createReadPathGuard, type ReadAccessPolicy, type ReadPathGuard } from "./path-guard.js";

export { PATH_ESCAPE_MESSAGE, createReadPathGuard, workspaceReadPolicy } from "./path-guard.js";
export type { ReadAccessPolicy, ReadPathGuard } from "./path-guard.js";
export { globToRegExp } from "./walk.js";
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, GREP_MAX_LINE_LENGTH } from "./truncate.js";

export interface GeneralReadToolsOptions {
  policy: ReadAccessPolicy;
}

/** Names of the vendored read-only tools, in factory order (asserted by the gate tests). */
export const GENERAL_READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

/**
 * Builds the read/grep/find/ls tool set for one confinement policy. The guard
 * is created once so every tool shares the same compiled roots.
 */
export function createGeneralReadTools(options: GeneralReadToolsOptions): AgentTool[] {
  const guard: ReadPathGuard = createReadPathGuard(options.policy);
  return [createReadTool(guard), createGrepTool(guard), createFindTool(guard), createLsTool(guard)];
}
