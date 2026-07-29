import { join } from "node:path";
import {
  DailyBriefService,
  DecisionService,
  FileAdAccountStore,
  FileAdvertisingDecisionStore,
  FileCampaignStore,
  FileCreativeAssetStore,
  PythonUacEngine
} from "@adpilot/ads-intelligence";
import { ArtifactService, FileArtifactStore } from "@adpilot/artifacts";
import {
  AutomationScheduler,
  FileAutomationRunStore,
  FileAutomationStore,
  FileNotificationStore
} from "@adpilot/automations";
import { CheckpointStore, GitRepository, WorktreeManager } from "@adpilot/git-tools";
import { KernelService } from "@adpilot/kernel";
import { FileWorkflowRunStore, FileWorkflowStore, WorkflowRunner, type StepExecutor } from "@adpilot/workflows";
import { TerminalService } from "../../server/src/terminal-service.js";
import type { AgentExecutionContext } from "./context.js";
import type { AgentToolDeps } from "./deps.js";

export interface RecordedAuditEvent {
  clientId: string;
  action: string;
  details: Record<string, unknown>;
}

export interface TestDeps {
  deps: AgentToolDeps;
  kernel: KernelService;
  terminal: TerminalService;
  auditEvents: RecordedAuditEvent[];
  workflowStore: FileWorkflowStore;
}

/**
 * Real 0.3 subsystems over one temporary workspace root: real kernel stores,
 * real artifact store and renderers, real TerminalService, real ads stores
 * and services (UAC engine pointed at a nonexistent interpreter unless
 * overridden), a real automation scheduler with executor stubs at its
 * sanctioned seam, and a real workflow runner over a fake step executor (the
 * workflow package's own computer-use seam).
 */
export function makeTestDeps(root: string, options: { uacPythonPath?: string; now?: Date } = {}): TestDeps {
  const kernel = KernelService.fromRoot(root);
  const terminal = new TerminalService();
  const auditEvents: RecordedAuditEvent[] = [];
  const workflowStore = new FileWorkflowStore(root);
  const executor: StepExecutor = {
    executeStep: async () => ({ status: "succeeded", verification: { matched: true, confidence: 1, reason: "ok" } })
  };
  const deps: AgentToolDeps = {
    kernel,
    git: {
      repository: (repoRoot) => new GitRepository(repoRoot),
      worktrees: (repoRoot) => new WorktreeManager(repoRoot),
      checkpoints: (repoRoot) => new CheckpointStore(join(repoRoot, ".adpilot", "checkpoints"))
    },
    terminal,
    artifacts: new ArtifactService(new FileArtifactStore(root)),
    ads: {
      decisions: new DecisionService(
        new FileAdvertisingDecisionStore(root),
        async (projectId) => (await kernel.getProject(projectId)) !== undefined
      ),
      brief: new DailyBriefService(),
      uac: new PythonUacEngine({ pythonPath: options.uacPythonPath ?? "/nonexistent/adpilot-test-python" }),
      stores: {
        accounts: new FileAdAccountStore(root),
        campaigns: new FileCampaignStore(root),
        creatives: new FileCreativeAssetStore(root)
      }
    },
    automations: new AutomationScheduler({
      automations: new FileAutomationStore(root),
      runs: new FileAutomationRunStore(root),
      notifications: new FileNotificationStore(root),
      executors: {
        dailyBrief: async () => ({ ok: true }),
        createTask: async (task) => ({ created: task.title })
      },
      // The tools never call approveRun; the fail-closed verifier stays a stub here.
      verifyApproval: async () => undefined
    }),
    workflows: {
      store: workflowStore,
      runner: new WorkflowRunner({ workflows: workflowStore, runs: new FileWorkflowRunStore(root), executor })
    },
    audit: async (clientId, action, details) => {
      auditEvents.push({ clientId, action, details });
      return `audit-${auditEvents.length}`;
    },
    now: () => options.now ?? new Date("2026-07-29T00:00:00.000Z")
  };
  return { deps, kernel, terminal, auditEvents, workflowStore };
}

export function makeCtx(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    workspaceId: "client-a",
    sessionId: "session-1",
    rootPaths: [],
    enabledCapabilityPacks: ["code", "git", "artifact", "ads", "automation", "workflow"],
    permissions: { read: true, write: true, destructive: true, computerUse: false, network: false },
    locale: "en",
    createdAt: "2026-07-29T00:00:00.000Z",
    ...overrides
  };
}
