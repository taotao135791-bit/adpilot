import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { AdPilotAgent } from "@adpilot/agent-orchestrator";
import {
  GuiGroundingProviderRouter,
  OpenAICompatibleUiTarsProvider,
  OpenAICompatibleVisualVerifier,
  PiVisionModel,
  UiTarsNativeOperator,
  VisualComputerRuntime,
  type VisualRuntimeEvent,
  type VisualVerifier
} from "@adpilot/computer-use";
import { ExperimentStore } from "@adpilot/experiments";
import { createPiModels, modelRouterFromEnv, resolvePiModel } from "@adpilot/model-router";
import { PiAgentRuntime } from "@adpilot/runtime";
import { SkillRegistry } from "@adpilot/skills";
import { AccountOperator, CreativeStrategist, MediaBuyer, MeasurementReviewer, PerformanceAnalyst, RiskReviewer, SpecialistCoordinator } from "@adpilot/specialist-agents";
import { AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { SettingsStore, WorkspaceCredentialStore } from "@adpilot/configuration";
import type { Models } from "@earendil-works/pi-ai";

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
  credentials: WorkspaceCredentialStore;
  models: Models;
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
  modelStatus: { fast: string; strong: string; gui: string; guiStrong: string; chatConfigured: boolean; guiConfigured: boolean };
}

export async function createAdPilotSystem(options: { workspaceRoot?: string; env?: NodeJS.ProcessEnv; models?: Models } = {}): Promise<AdPilotSystem> {
  const baseEnv = options.env ?? process.env;
  const workspaceRoot = options.workspaceRoot ?? baseEnv.ADPILOT_WORKSPACE ?? resolve(process.cwd(), "workspace");
  const settings = new SettingsStore(workspaceRoot, baseEnv);
  const credentials = new WorkspaceCredentialStore(workspaceRoot);
  const env = await settings.effectiveEnv();
  const workspace = new WorkspaceStore(workspaceRoot);
  const events = new ProductEventBus();
  const secret = await loadApprovalSecret(workspaceRoot, env.ADPILOT_APPROVAL_SECRET);
  const audit = new AuditLog(workspace);
  const approvals = new ApprovalService(workspace, secret);
  for (const client of await workspace.listClients()) await approvals.recoverInterrupted(client.id);
  const experiments = new ExperimentStore(workspace);
  const router = modelRouterFromEnv(env);
  const models = options.models ?? createPiModels(env, credentials);
  const fastRef = { provider: env.ADPILOT_FAST_PROVIDER ?? "openai", model: env.ADPILOT_FAST_MODEL ?? "gpt-5-mini" };
  const strongRef = { provider: env.ADPILOT_STRONG_PROVIDER ?? fastRef.provider, model: env.ADPILOT_STRONG_MODEL ?? "gpt-5.2" };
  const fastModel = resolvePiModel(models, fastRef);
  const strongModel = resolvePiModel(models, strongRef);
  const fastAuth = Boolean(await models.checkAuth(fastModel.provider).catch(() => undefined));
  const strongAuth = fastModel.provider === strongModel.provider ? fastAuth : Boolean(await models.checkAuth(strongModel.provider).catch(() => undefined));
  const primaryVisionCandidate = fastModel.input.includes("image") ? fastModel : strongModel.input.includes("image") ? strongModel : undefined;
  const strongVisionCandidate = strongModel.input.includes("image") ? strongModel : primaryVisionCandidate;
  const primaryVision = primaryVisionCandidate === fastModel ? (fastAuth ? fastModel : strongModel.input.includes("image") && strongAuth ? strongModel : undefined) : strongAuth ? primaryVisionCandidate : undefined;
  const strongVision = strongVisionCandidate === strongModel && strongAuth ? strongModel : primaryVision;
  const piVision = primaryVision && strongVision ? new PiVisionModel(models, primaryVision, strongVision) : undefined;
  const dedicatedGrounding = env.ADPILOT_GUI_BASE_URL && env.ADPILOT_GUI_MODEL && env.ADPILOT_GUI_IMAGE_INPUT !== "false"
    ? new OpenAICompatibleUiTarsProvider({
        baseURL: env.ADPILOT_GUI_BASE_URL,
        ...(env.ADPILOT_GUI_API_KEY ? { apiKey: env.ADPILOT_GUI_API_KEY } : {}),
        model: env.ADPILOT_GUI_MODEL,
        ...(env.ADPILOT_GUI_STRONG_MODEL ? { strongModel: env.ADPILOT_GUI_STRONG_MODEL } : {}),
        timeoutMs: positiveInteger(env.ADPILOT_GUI_TIMEOUT_MS, 20_000),
        protocol: env.ADPILOT_GUI_PROTOCOL === "adpilot-json" ? "adpilot-json" : "ui-tars",
        coordinateFormat: env.ADPILOT_GUI_COORDINATE_FORMAT === "normalized" ? "normalized" : env.ADPILOT_GUI_COORDINATE_FORMAT === "pixels" ? "pixels" : "ui-tars-1000",
        normalization: env.ADPILOT_GUI_NORMALIZATION === "screenshot" ? "screenshot" : "window"
      })
    : undefined;
  const grounding = dedicatedGrounding || piVision ? new GuiGroundingProviderRouter(dedicatedGrounding, piVision) : undefined;
  const verifyMode = env.ADPILOT_VERIFY_MODE ?? "auto";
  const verifierEndpoint = verifyMode === "gui" ? env.ADPILOT_GUI_BASE_URL : env.ADPILOT_VERIFY_BASE_URL;
  const verifierModel = verifyMode === "gui" ? env.ADPILOT_GUI_MODEL : env.ADPILOT_VERIFY_MODEL;
  const verifierKey = verifyMode === "gui" ? env.ADPILOT_GUI_API_KEY : env.ADPILOT_VERIFY_API_KEY;
  const dedicatedVerifier = verifyMode !== "strong" && verifierEndpoint && verifierModel
    ? new OpenAICompatibleVisualVerifier({
        baseURL: verifierEndpoint,
        ...(verifierKey ? { apiKey: verifierKey } : {}),
        model: verifierModel,
        ...(verifyMode === "gui" && env.ADPILOT_GUI_STRONG_MODEL ? { strongModel: env.ADPILOT_GUI_STRONG_MODEL } : {}),
        timeoutMs: positiveInteger(env.ADPILOT_VERIFY_TIMEOUT_MS, 20_000)
      })
    : undefined;
  const verifier: VisualVerifier | undefined = dedicatedVerifier ?? piVision;
  const guiConfigured = Boolean(grounding && verifier);
  const computer = grounding && verifier
    ? new VisualComputerRuntime(
        new UiTarsNativeOperator(),
        grounding,
        verifier,
        undefined,
        (event) => events.publish({ type: "computer", event }),
        positiveInteger(env.ADPILOT_GUI_TIMEOUT_MS, 20_000),
        Math.min(3, positiveInteger(env.ADPILOT_GUI_MAX_RETRIES, 2) + 1)
      )
    : undefined;
  const tools = new AdPilotTools(workspace, audit, approvals, experiments, computer);
  const skills = new SkillRegistry();
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
    workspace, settings, credentials, models, audit, approvals, experiments, tools, skills, runtime, specialists, agent, computer, events,
    approvalTokens: new Map(),
    modelStatus: {
      fast: `${fastModel.provider}/${fastModel.id}`,
      strong: `${strongModel.provider}/${strongModel.id}`,
      gui: dedicatedGrounding ? `UI-TARS/${env.ADPILOT_GUI_MODEL}` : primaryVisionCandidate ? `${primaryVisionCandidate.provider}/${primaryVisionCandidate.id}` : "not configured",
      guiStrong: dedicatedVerifier ? `Verifier/${verifierModel}` : strongVisionCandidate ? `${strongVisionCandidate.provider}/${strongVisionCandidate.id}` : "not configured",
      chatConfigured: fastAuth,
      guiConfigured
    }
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
