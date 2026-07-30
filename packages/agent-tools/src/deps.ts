import type { DailyBriefService, DecisionService, PythonUacEngine } from "@adpilot/ads-intelligence";
import type { AdAccountStore, CampaignStore, CreativeAssetStore } from "@adpilot/ads-intelligence";
import type { ArtifactService } from "@adpilot/artifacts";
import type { AutomationScheduler } from "@adpilot/automations";
import type { CheckpointStore, GitRepository, WorktreeManager } from "@adpilot/git-tools";
import type { KernelService } from "@adpilot/kernel";
import type { NativeComputerService } from "@adpilot/native-computer-host";
import type { FileWorkflowStore, WorkflowRunner } from "@adpilot/workflows";
import type { TerminalService } from "../../server/src/terminal-service.js";

/**
 * Real subsystems the registry tools call. Nothing here is a stub: every
 * entry is the 0.3 production service the composition root already wires.
 *
 * `ads.stores` is optional because the ads services themselves do not expose
 * account/campaign/creative persistence; when the composition root provides
 * the stores, ads.list_accounts / ads.list_campaigns / ads.generate_daily_brief
 * read live entities, otherwise they answer with a recoverable
 * STORE_NOT_CONFIGURED error instead of fabricating data.
 */
export interface AgentToolDeps {
  kernel: KernelService;
  git: {
    repository(root: string): GitRepository;
    worktrees(root: string): WorktreeManager;
    checkpoints(root: string): CheckpointStore;
  };
  terminal: TerminalService;
  artifacts: ArtifactService;
  ads: {
    decisions: DecisionService;
    brief: DailyBriefService;
    uac: PythonUacEngine;
    stores?: {
      accounts?: AdAccountStore;
      campaigns?: CampaignStore;
      creatives?: CreativeAssetStore;
    };
  };
  automations: AutomationScheduler;
  workflows: {
    store: FileWorkflowStore;
    runner: WorkflowRunner;
  };
  /**
   * The authenticated native Helper actor. Optional: computer.observe is only
   * visible when a live host is present; everything fails closed without it.
   */
  computer?: {
    host: NativeComputerService | undefined;
  };
  /**
   * Injected audit sink (the composition root binds AuditLog.append):
   * returns the persisted audit event id.
   */
  audit(clientId: string, action: string, details: Record<string, unknown>): Promise<string>;
  now(): Date;
}
