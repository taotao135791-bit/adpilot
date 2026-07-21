import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { AdPilotAgent } from "@adpilot/agent-orchestrator";
import { UiTarsGroundingModel, UiTarsNativeOperator, VisualComputerRuntime, OpenAICompatibleVisualVerifier, type VisualRuntimeEvent } from "@adpilot/computer-use";
import { ExperimentStore } from "@adpilot/experiments";
import { createPiModels, modelRouterFromEnv } from "@adpilot/model-router";
import { PiAgentRuntime } from "@adpilot/runtime";
import { SkillRegistry } from "@adpilot/skills";
import { AccountOperator, CreativeStrategist, MediaBuyer, MeasurementReviewer, PerformanceAnalyst, RiskReviewer, SpecialistCoordinator } from "@adpilot/specialist-agents";
import { AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { SettingsStore } from "@adpilot/configuration";

export type ProductEvent =
  | { type: "task"; status: string; taskId?: string; message: string }
  | { type: "computer"; event: VisualRuntimeEvent }
  | { type: "approval"; approvalId: string; status: string }
  | { type: "error"; message: string; retryable: boolean };

export class ProductEventBus {
  private readonly emitter = new EventEmitter();
  private recent: ProductEvent[] = [];
  publish(event: ProductEvent): void { this.recent = [...this.recent.slice(-99), event]; this.emitter.emit("event", event); }
  subscribe(listener: (event: ProductEvent) => void): () => void { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  history(): ProductEvent[] { return this.recent.slice(); }
}

export interface AdPilotSystem {
  workspace: WorkspaceStore;
  settings: SettingsStore;
  audit: AuditLog;
  approvals: ApprovalService;
  experiments: ExperimentStore;
  tools: AdPilotTools;
  skills: SkillRegistry;
  runtime: PiAgentRuntime;
  specialists: SpecialistCoordinator;
  agent: AdPilotAgent;
  computer: VisualComputerRuntime | undefined;
  events: ProductEventBus;
  approvalTokens: Map<string, string>;
  modelStatus: { fast: string; strong: string; gui: string; guiStrong: string; guiConfigured: boolean };
}

export async function createAdPilotSystem(options: { workspaceRoot?: string; env?: NodeJS.ProcessEnv } = {}): Promise<AdPilotSystem> {
  const baseEnv = options.env ?? process.env;
  const workspaceRoot = options.workspaceRoot ?? baseEnv.ADPILOT_WORKSPACE ?? resolve(process.cwd(), "workspace");
  const settings = new SettingsStore(workspaceRoot, baseEnv);
  const env = await settings.effectiveEnv();
  const workspace = new WorkspaceStore(workspaceRoot);
  const events = new ProductEventBus();
  const secret = await loadApprovalSecret(workspaceRoot, env.ADPILOT_APPROVAL_SECRET);
  const audit = new AuditLog(workspace);
  const approvals = new ApprovalService(workspace, secret);
  const experiments = new ExperimentStore(workspace);
  const guiConfigured = Boolean(env.ADPILOT_GUI_BASE_URL && env.ADPILOT_GUI_API_KEY && env.ADPILOT_GUI_MODEL);
  const computer = guiConfigured
    ? new VisualComputerRuntime(
        new UiTarsNativeOperator(),
        new UiTarsGroundingModel({ baseURL: env.ADPILOT_GUI_BASE_URL!, apiKey: env.ADPILOT_GUI_API_KEY!, model: env.ADPILOT_GUI_MODEL!, ...(env.ADPILOT_GUI_STRONG_MODEL ? { strongModel: env.ADPILOT_GUI_STRONG_MODEL } : {}) }),
        new OpenAICompatibleVisualVerifier({ baseURL: env.ADPILOT_GUI_BASE_URL!, apiKey: env.ADPILOT_GUI_API_KEY!, model: env.ADPILOT_GUI_MODEL! }),
        undefined,
        (event) => events.publish({ type: "computer", event })
      )
    : undefined;
  const tools = new AdPilotTools(workspace, audit, approvals, experiments, computer);
  const skills = new SkillRegistry();
  const router = modelRouterFromEnv(env);
  const models = createPiModels();
  const runtime = new PiAgentRuntime(models, router, workspace, skills, tools, [{
    name: "product-events",
    onError: (error) => events.publish({ type: "error", message: error.message, retryable: true })
  }]);
  const specialists = new SpecialistCoordinator([
    new AccountOperator(tools),
    new PerformanceAnalyst(runtime),
    new MediaBuyer(runtime),
    new MeasurementReviewer(runtime),
    new CreativeStrategist(runtime),
    new RiskReviewer(runtime, tools)
  ]);
  const agent = new AdPilotAgent(runtime, specialists, workspace, tools, (task) => events.publish({
    type: "task", status: task.phase, taskId: task.id,
    message: task.owner ? `${task.owner} is working` : task.nextStep ?? task.goal
  }));
  return {
    workspace, settings, audit, approvals, experiments, tools, skills, runtime, specialists, agent, computer, events,
    approvalTokens: new Map(),
    modelStatus: {
      fast: `${env.ADPILOT_FAST_PROVIDER ?? "openai"}/${env.ADPILOT_FAST_MODEL ?? "gpt-5-mini"}`,
      strong: `${env.ADPILOT_STRONG_PROVIDER ?? "openai"}/${env.ADPILOT_STRONG_MODEL ?? "gpt-5.2"}`,
      gui: env.ADPILOT_GUI_MODEL ?? "not configured",
      guiStrong: env.ADPILOT_GUI_STRONG_MODEL ?? env.ADPILOT_GUI_MODEL ?? "not configured",
      guiConfigured
    }
  };
}

async function loadApprovalSecret(root: string, configured?: string): Promise<string> {
  if (configured) return configured;
  const directory = resolve(root, ".adpilot"); const path = resolve(directory, "approval-secret");
  try { const value = (await readFile(path, "utf8")).trim(); if (value.length >= 32) return value; } catch {}
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const value = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await writeFile(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return (await readFile(path, "utf8")).trim();
}
