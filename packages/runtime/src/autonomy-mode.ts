/**
 * Autonomy mode (Codex-style "full access"): a client-level switch between
 * `guarded` (the default, status quo) and `full_access`.
 *
 * In `full_access`, the runtime tool gate waives the executed-approval
 * reference for the general local write surface only — write/edit and
 * write-classified bash commands — so everyday local work (creating files,
 * organizing the workspace, `open`-ing apps and URLs) runs without a
 * per-command approval. `guarded` keeps the approval chain for everything.
 *
 * Three red lines never move, in either mode:
 * - deny-classified bash commands (network egress, screen capture, credential
 *   or browser-profile stores, privilege/process control, protected paths,
 *   rm -rf) stay hard-denied inside the tool — the gate never waives a
 *   destructive classification;
 * - advertising-account mutations (commit_approved_action, MUTATE/DESTRUCTIVE
 *   visual dispatches) keep their token-gated approval authority in every
 *   mode;
 * - every gate decision and every mode switch is chained into the audit log.
 *
 * The switch persists as client metadata (`autonomy.json`), mirroring the
 * plan-mode store, and toggles are audited with actor and timestamp.
 */
import { z } from "zod";
import type { AuditLog } from "@adpilot/audit";
import type { WorkspaceStore } from "@adpilot/workspace";

export const AutonomyMode = z.enum(["guarded", "full_access"]);
export type AutonomyMode = z.infer<typeof AutonomyMode>;

export const AutonomyState = z.object({
  mode: AutonomyMode,
  updatedAt: z.string().datetime(),
  actor: z.string().min(1)
});
export type AutonomyState = z.infer<typeof AutonomyState>;

const DEFAULT_STATE: AutonomyState = { mode: "guarded", updatedAt: new Date(0).toISOString(), actor: "none" };

/** Narrow probe used by the tool gate (keeps the gate decoupled from the store). */
export interface AutonomyProbe {
  mode(clientId: string): Promise<AutonomyMode>;
}

export class AutonomyStore implements AutonomyProbe {
  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly audit: AuditLog
  ) {}

  async get(clientId: string): Promise<AutonomyState> {
    const content = await this.workspace.readText(clientId, "autonomy.json");
    if (!content) return DEFAULT_STATE;
    try {
      return AutonomyState.parse(JSON.parse(content));
    } catch {
      return DEFAULT_STATE; // corrupt metadata fails closed to guarded
    }
  }

  async mode(clientId: string): Promise<AutonomyMode> {
    return (await this.get(clientId)).mode;
  }

  /** Persists the switch and chains the transition into the audit log. */
  async set(clientId: string, mode: AutonomyMode, actor: string): Promise<AutonomyState> {
    const previous = await this.get(clientId);
    const state = AutonomyState.parse({ mode, updatedAt: new Date().toISOString(), actor: actor.trim() || "workspace-owner" });
    await this.workspace.writeJson(clientId, "autonomy.json", state);
    await this.audit.append({
      clientId,
      actor: state.actor,
      action: "autonomy_mode_changed",
      status: "succeeded",
      details: { from: previous.mode, to: mode }
    });
    return state;
  }
}
