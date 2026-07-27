/**
 * General tool set, vendored from pi's tool factories
 * (packages/coding-agent/src/core/tools/index.ts @ 0.80.10, MIT — see
 * licenses/pi-MIT.txt) and adapted to AdPilot:
 *
 * - read/grep/find/ls are bound to one read-path guard so the model can only
 *   observe the client workspace and directories the operator explicitly
 *   allowed.
 * - write/edit are bound to a strictly workspace-confined write guard
 *   (workspace 外写一律拒绝, `.adpilot` 写拒绝, protected paths 拒绝) and are
 *   approval-gated at the runtime tool gate.
 * - bash runs the deterministic command classifier and executes exclusively
 *   through macOS sandbox-exec (fail-closed when unavailable). It is only
 *   offered to the main agent, never to specialists.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool, type BashToolOptions } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createReadPathGuard, workspaceWritePolicy, type ReadAccessPolicy, type ReadPathGuard } from "./path-guard.js";

export { PATH_ESCAPE_MESSAGE, createReadPathGuard, workspaceReadPolicy, workspaceWritePolicy } from "./path-guard.js";
export type { ReadAccessPolicy, ReadPathGuard } from "./path-guard.js";
export { PROTECTED_PATH_MESSAGE, createProtectedPathMatcher } from "./protected-paths.js";
export type { ProtectedPathMatcher } from "./protected-paths.js";
export { BASH_DENY_MESSAGE, createBashTool } from "./bash.js";
export type { BashToolAuditEntry, BashToolOptions } from "./bash.js";
export { buildSeatbeltProfile, resolveSandboxExec, sandboxedEnv, SANDBOX_EXEC_PATH, SANDBOX_UNAVAILABLE_MESSAGE } from "./sandbox.js";
export type { SandboxAvailability, SeatbeltProfileOptions } from "./sandbox.js";
export { globToRegExp } from "./walk.js";
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, GREP_MAX_LINE_LENGTH } from "./truncate.js";

export interface GeneralReadToolsOptions {
  policy: ReadAccessPolicy;
}

/** Names of the vendored read-only tools, in factory order (asserted by the gate tests). */
export const GENERAL_READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

/** Names of the main-agent-only write-side tools, in factory order. */
export const GENERAL_AGENT_TOOL_NAMES = ["read", "grep", "find", "ls", "write", "edit", "bash"] as const;

/**
 * Builds the read/grep/find/ls tool set for one confinement policy. The guard
 * is created once so every tool shares the same compiled roots.
 */
export function createGeneralReadTools(options: GeneralReadToolsOptions): AgentTool[] {
  const guard: ReadPathGuard = createReadPathGuard(options.policy);
  return [createReadTool(guard), createGrepTool(guard), createFindTool(guard), createLsTool(guard)];
}

export interface GeneralAgentToolsOptions {
  /** Workspace root: the only writable area and the bash cwd. */
  workspaceRoot: string;
  /** Extra readable roots for the read-only subset (skill/prompt directories). */
  readPolicy: ReadAccessPolicy;
  /** Bash execution options (audit hook, sandbox path, spawn injection). */
  bash: Omit<BashToolOptions, "workspaceRoot">;
}

/**
 * Builds the main-agent tool set: the confined read-only tools plus the
 * write-side trio write/edit (workspace-confined, approval-gated) and bash
 * (classified, sandboxed, fail-closed). Specialists never receive this set.
 */
export function createGeneralAgentTools(options: GeneralAgentToolsOptions): AgentTool[] {
  const readGuard = createReadPathGuard(options.readPolicy);
  const writeGuard = createReadPathGuard(workspaceWritePolicy(options.workspaceRoot));
  return [
    createReadTool(readGuard),
    createGrepTool(readGuard),
    createFindTool(readGuard),
    createLsTool(readGuard),
    createWriteTool(writeGuard),
    createEditTool(writeGuard),
    createBashTool({ workspaceRoot: options.workspaceRoot, ...options.bash })
  ];
}
