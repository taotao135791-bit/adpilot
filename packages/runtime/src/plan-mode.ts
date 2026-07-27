/**
 * Plan mode (AdPilot-native, modeled on the upstream plan-mode extension
 * example but deterministic): a conversation-level read-only switch.
 *
 * While enabled for a client+conversation, the runtime shrinks the main
 * agent's tool set to the read-only surface (read/grep/find/ls,
 * read_workspace, read_visual_table, the deterministic analysis tools, and
 * read-classified skills/dispatches), appends the plan-mode system-prompt
 * instructions (a numbered plan is required, no side effects), and the tool
 * gate hard-denies any call whose classification is not read — so even a tool
 * that slipped into the set cannot write. State persists to the workspace as
 * conversation metadata and every toggle is chained into the audit log.
 *
 * Executing the plan means switching plan mode off (server endpoint), after
 * which every write flows through the normal approval chain.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuditLog } from "@adpilot/audit";
import { PLAN_MODE_READ_TOOL_NAMES, READ_ONLY_SKILL_NAMES } from "@adpilot/shared";
import type { WorkspaceStore } from "@adpilot/workspace";

export const PlanModeState = z.object({
  enabled: z.boolean(),
  updatedAt: z.string().datetime(),
  actor: z.string().min(1)
});
export type PlanModeState = z.infer<typeof PlanModeState>;

const DEFAULT_STATE: PlanModeState = { enabled: false, updatedAt: new Date(0).toISOString(), actor: "none" };

/** Narrow probe used by the runtime and the tool gate (keeps them decoupled from the store). */
export interface PlanModeProbe {
  isEnabled(clientId: string, conversationId: string): Promise<boolean>;
}

export class PlanModeStore implements PlanModeProbe {
  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly audit: AuditLog
  ) {}

  /** Deterministic metadata path for one conversation (ids may contain arbitrary UI input). */
  private path(conversationId: string): string {
    const safe = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(conversationId)
      ? conversationId
      : `c-${createHash("sha256").update(conversationId).digest("hex").slice(0, 16)}`;
    return `conversations/${safe}/plan-mode.json`;
  }

  async get(clientId: string, conversationId: string): Promise<PlanModeState> {
    const content = await this.workspace.readText(clientId, this.path(conversationId));
    if (!content) return DEFAULT_STATE;
    try {
      return PlanModeState.parse(JSON.parse(content));
    } catch {
      return DEFAULT_STATE; // corrupt metadata fails closed to the default (off) state
    }
  }

  async isEnabled(clientId: string, conversationId: string): Promise<boolean> {
    return (await this.get(clientId, conversationId)).enabled;
  }

  /** Persists the switch and chains the toggle into the audit log. */
  async set(clientId: string, conversationId: string, enabled: boolean, actor: string): Promise<PlanModeState> {
    const state = PlanModeState.parse({ enabled, updatedAt: new Date().toISOString(), actor: actor.trim() || "workspace-owner" });
    await this.workspace.writeJson(clientId, this.path(conversationId), state);
    await this.audit.append({
      clientId,
      actor: state.actor,
      action: enabled ? "plan_mode_enabled" : "plan_mode_disabled",
      status: "succeeded",
      details: { conversationId, enabled }
    });
    return state;
  }
}

/** System-prompt instructions injected into every run of a plan-mode conversation. */
export const PLAN_MODE_SYSTEM_PROMPT = [
  "[PLAN MODE ACTIVE]",
  "This conversation is in plan mode, a read-only exploration mode.",
  "Your available tools are restricted to read-only operations (read, grep, find, ls, read_workspace, read_visual_table, deterministic analysis tools and read-only skills). Write tools, edit, bash, and approval preparation are unavailable, and the runtime gate blocks any non-read call.",
  "Do NOT attempt to make changes. Instead, investigate freely and produce a detailed numbered plan under a 'Plan:' header:",
  "Plan:",
  "1. First step description",
  "2. Second step description",
  "Explain what each step would do and which evidence supports it. When the user is satisfied and disables plan mode, the plan executes through the normal approval chain."
].join("\n");

/** True when a tool stays available in plan mode. */
export function isPlanModeTool(toolName: string): boolean {
  return PLAN_MODE_READ_TOOL_NAMES.includes(toolName);
}

/** Read-classified skills are the only ones plan mode keeps. */
export function isPlanModeSkill(skillName: string): boolean {
  return READ_ONLY_SKILL_NAMES.includes(skillName);
}
