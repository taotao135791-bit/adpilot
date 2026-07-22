import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { AdPilotAgent, WorkspaceSharedFactRepository } from "@adpilot/agent-orchestrator";
import {
  BrowserSessionBoundOperator,
  BrowserSessionManager,
  DualVisualIdentityVerifier,
  FileScreenshotArtifactStore,
  FileScreenshotModelCallAuditStore,
  GuiGroundingProviderRouter,
  OpenAICompatibleVisualIdentityReviewer,
  OpenAICompatibleUiTarsProvider,
  OpenAICompatibleVisualVerifier,
  PiVisualIdentityReviewer,
  PiVisionModel,
  PrivacyAwareGroundingProvider,
  PrivacyAwareVisualIdentityReviewer,
  PrivacyAwareVisualVerifier,
  ScreenshotPrivacyPipeline,
  UiTarsNativeOperator,
  VisualComputerRuntime,
  defaultBrowserContentRoi,
  type ModelPrivacyDescriptor,
  type Screenshot,
  type ScreenshotPrivacyMode,
  type VisualMicroTask,
  type VisualRuntimeEvent,
  type VisualGroundingProvider,
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
import { SharedFactLedger } from "@adpilot/shared";
import { PiVisualTableModel, PiVisualTableVerifier, VisualTableReader } from "@adpilot/visual-table-reader";

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
  browserSessions: BrowserSessionManager;
  screenshotAudits: FileScreenshotModelCallAuditStore;
  visualTableReader: VisualTableReader | undefined;
  events: ProductEventBus;
  approvalTokens: Map<string, string>;
  modelStatus: {
    fast: string;
    strong: string;
    gui: string;
    guiStrong: string;
    chatConfigured: boolean;
    guiConfigured: boolean;
    browserSession: string;
    route: string;
    privacyMode: "standard" | "local-only";
    permission: "OBSERVE";
  };
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
  const privacyMode: ScreenshotPrivacyMode = env.ADPILOT_PRIVACY_MODE === "local-only" ? "local-only" : "minimized";
  const screenshotArtifacts = new FileScreenshotArtifactStore(workspaceRoot);
  const screenshotAudits = new FileScreenshotModelCallAuditStore(workspaceRoot);
  const screenshotPrivacy = new ScreenshotPrivacyPipeline(screenshotArtifacts, screenshotAudits);
  const browserSessions = new BrowserSessionManager(workspaceRoot);
  await browserSessions.recover();
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
  const primaryVisionPrivacy = primaryVision ? modelPrivacy(primaryVision.provider, primaryVision.id) : undefined;
  const strongVisionPrivacy = strongVision ? modelPrivacy(strongVision.provider, strongVision.id) : undefined;
  const rawDedicatedGrounding = env.ADPILOT_GUI_BASE_URL && env.ADPILOT_GUI_MODEL && env.ADPILOT_GUI_IMAGE_INPUT !== "false"
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
  const dedicatedGroundingPrivacy = rawDedicatedGrounding
    ? endpointPrivacy(env.ADPILOT_GUI_BASE_URL!, env.ADPILOT_GUI_MODEL!)
    : undefined;
  const dedicatedGrounding = rawDedicatedGrounding && dedicatedGroundingPrivacy
    ? new PrivacyAwareGroundingProvider(
        rawDedicatedGrounding,
        screenshotPrivacy,
        requireTaskClient,
        taskModelRoi,
        () => dedicatedGroundingPrivacy,
        () => privacyMode
      )
    : undefined;
  const piGrounding = piVision && primaryVisionPrivacy && strongVisionPrivacy
    ? new PrivacyAwareGroundingProvider(
        piVision,
        screenshotPrivacy,
        requireTaskClient,
        taskModelRoi,
        (tier) => tier === "strong" ? strongVisionPrivacy : primaryVisionPrivacy,
        () => privacyMode
      )
    : undefined;
  const grounding = dedicatedGrounding || piGrounding ? new GuiGroundingProviderRouter(dedicatedGrounding, piGrounding) : undefined;
  const verifyMode = env.ADPILOT_VERIFY_MODE ?? "auto";
  const verifierEndpoint = verifyMode === "gui" ? env.ADPILOT_GUI_BASE_URL : env.ADPILOT_VERIFY_BASE_URL;
  const verifierModel = verifyMode === "gui" ? env.ADPILOT_GUI_MODEL : env.ADPILOT_VERIFY_MODEL;
  const verifierKey = verifyMode === "gui" ? env.ADPILOT_GUI_API_KEY : env.ADPILOT_VERIFY_API_KEY;
  const rawDedicatedVerifier = verifyMode !== "strong" && verifierEndpoint && verifierModel
    ? new OpenAICompatibleVisualVerifier({
        baseURL: verifierEndpoint,
        ...(verifierKey ? { apiKey: verifierKey } : {}),
        model: verifierModel,
        ...(verifyMode === "gui" && env.ADPILOT_GUI_STRONG_MODEL ? { strongModel: env.ADPILOT_GUI_STRONG_MODEL } : {}),
        timeoutMs: positiveInteger(env.ADPILOT_VERIFY_TIMEOUT_MS, 20_000)
      })
    : undefined;
  const dedicatedVerifierPrivacy = rawDedicatedVerifier && verifierEndpoint && verifierModel
    ? endpointPrivacy(verifierEndpoint, verifierModel)
    : undefined;
  const canUseDedicatedVerifier = rawDedicatedVerifier && dedicatedVerifierPrivacy
    && (privacyMode !== "local-only" || dedicatedVerifierPrivacy.location === "local");
  const rawVerifier: VisualVerifier | undefined = canUseDedicatedVerifier ? rawDedicatedVerifier : piVision;
  const verifierPrivacy = canUseDedicatedVerifier ? dedicatedVerifierPrivacy : strongVisionPrivacy;
  const verifier: VisualVerifier | undefined = rawVerifier && verifierPrivacy
    ? new PrivacyAwareVisualVerifier(
        rawVerifier,
        screenshotPrivacy,
        (_expected, task) => ({ clientId: requireTaskClient(task), taskId: requireTaskId(task) }),
        (_expected, before, after) => ({ before: taskSafeRoi(before.width, before.height), after: taskSafeRoi(after.width, after.height) }),
        verifierPrivacy,
        () => privacyMode
      )
    : undefined;

  const rawGuiIdentity = canUseDedicatedVerifier && verifierEndpoint && verifierModel
    ? new OpenAICompatibleVisualIdentityReviewer(`gui-verification:${verifierModel}`, {
        baseURL: verifierEndpoint,
        model: verifierModel,
        ...(verifierKey ? { apiKey: verifierKey } : {}),
        timeoutMs: positiveInteger(env.ADPILOT_VERIFY_TIMEOUT_MS, 20_000)
      })
    : strongVision
      ? new PiVisualIdentityReviewer(models, strongVision, `gui-verification:${strongVision.provider}/${strongVision.id}`)
      : undefined;
  const rawDeepIdentity = strongVision
    ? new PiVisualIdentityReviewer(models, strongVision, `deep-vision:${strongVision.provider}/${strongVision.id}`)
    : undefined;
  const guiIdentityPrivacy = canUseDedicatedVerifier ? dedicatedVerifierPrivacy : strongVisionPrivacy;
  const guiIdentity = rawGuiIdentity && guiIdentityPrivacy
    ? new PrivacyAwareVisualIdentityReviewer(rawGuiIdentity, screenshotPrivacy, (_expected, screenshot) => taskSafeRoi(screenshot.width, screenshot.height), guiIdentityPrivacy, () => privacyMode)
    : undefined;
  const deepIdentity = rawDeepIdentity && strongVisionPrivacy
    ? new PrivacyAwareVisualIdentityReviewer(rawDeepIdentity, screenshotPrivacy, (_expected, screenshot) => taskSafeRoi(screenshot.width, screenshot.height), strongVisionPrivacy, () => privacyMode)
    : undefined;
  const visualIdentity = guiIdentity && deepIdentity
    && (privacyMode !== "local-only" || (guiIdentityPrivacy?.location === "local" && strongVisionPrivacy?.location === "local"))
    ? new DualVisualIdentityVerifier(guiIdentity, deepIdentity)
    : undefined;
  const guiConfigured = Boolean(grounding && verifier && visualIdentity);
  const computer = grounding && verifier
    ? new VisualComputerRuntime(
        new BrowserSessionBoundOperator(new UiTarsNativeOperator(), browserSessions),
        grounding,
        verifier,
        undefined,
        (event) => events.publish({ type: "computer", event }),
        positiveInteger(env.ADPILOT_GUI_TIMEOUT_MS, 20_000),
        Math.min(3, positiveInteger(env.ADPILOT_GUI_MAX_RETRIES, 2) + 1)
      )
    : undefined;
  const sharedFacts = new SharedFactLedger(new WorkspaceSharedFactRepository(workspace));
  const visualTableReader = primaryVision && strongVision
    && (privacyMode !== "local-only" || (primaryVisionPrivacy?.location === "local" && strongVisionPrivacy?.location === "local"))
    ? new VisualTableReader({
        model: new PiVisualTableModel(models, primaryVision, strongVision),
        verifier: new PiVisualTableVerifier(models, strongVision),
        factSink: sharedFacts
      })
    : undefined;
  const visualTableTools = visualTableReader && primaryVisionPrivacy && strongVisionPrivacy
    ? {
        reader: visualTableReader,
        screenshotPrivacy,
        readerModel: primaryVisionPrivacy,
        verifierModel: strongVisionPrivacy,
        privacyMode
      }
    : undefined;
  const tools = new AdPilotTools(workspace, audit, approvals, experiments, computer, visualIdentity, browserSessions, visualTableTools);
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
  }), sharedFacts);
  const connectedSessions = (await browserSessions.list()).filter((session) => session.sessionStatus === "connected");
  return {
    workspace, settings, credentials, models, audit, approvals, experiments, tools, skills, runtime, specialists, agent, computer,
    browserSessions, screenshotAudits, visualTableReader, events,
    approvalTokens: new Map(),
    modelStatus: {
      fast: `${fastModel.provider}/${fastModel.id}`,
      strong: `${strongModel.provider}/${strongModel.id}`,
      gui: dedicatedGrounding ? `UI-TARS/${env.ADPILOT_GUI_MODEL}` : primaryVisionCandidate ? `${primaryVisionCandidate.provider}/${primaryVisionCandidate.id}` : "not configured",
      guiStrong: canUseDedicatedVerifier ? `Verifier/${verifierModel}` : strongVisionCandidate ? `${strongVisionCandidate.provider}/${strongVisionCandidate.id}` : "not configured",
      chatConfigured: fastAuth,
      guiConfigured,
      browserSession: connectedSessions.length === 1 ? "connected" : connectedSessions.length > 1 ? `${connectedSessions.length} connected` : "not connected",
      route: dedicatedGrounding && piGrounding ? "Built-in GUI → Fast Vision → Deep Vision" : dedicatedGrounding ? "Built-in GUI → Deep Vision" : piGrounding ? "Fast Vision → Deep Vision" : "not configured",
      privacyMode: env.ADPILOT_PRIVACY_MODE === "local-only" ? "local-only" : "standard",
      permission: "OBSERVE"
    }
  };
}

function requireTaskClient(task: VisualMicroTask | undefined): string {
  if (!task?.clientId) throw new Error("Computer Use task is missing its client privacy context");
  return task.clientId;
}

function requireTaskId(task: VisualMicroTask | undefined): string {
  if (!task?.taskId) throw new Error("Computer Use task is missing its task privacy context");
  return task.taskId;
}

function taskSafeRoi(width: number, height: number) {
  return defaultBrowserContentRoi(width, height);
}

function taskModelRoi(task: VisualMicroTask, screenshot: Screenshot) {
  const allowed = task.allowedRegion;
  if (!allowed) return taskSafeRoi(screenshot.width, screenshot.height);
  const scale = allowed.coordinateSpace === "screen_points" ? screenshot.scaleFactor : 1;
  const x = allowed.x * scale;
  const y = allowed.y * scale;
  const width = allowed.width * scale;
  const height = allowed.height * scale;
  const marginX = Math.max(24, width * 0.75);
  const marginY = Math.max(24, height * 0.75);
  const left = Math.max(0, Math.floor(x - marginX));
  const top = Math.max(1, Math.floor(y - marginY));
  const right = Math.min(screenshot.width, Math.ceil(x + width + marginX));
  const bottom = Math.min(screenshot.height, Math.ceil(y + height + marginY));
  if (left === 0 && top === 0 && right === screenshot.width && bottom === screenshot.height) {
    return taskSafeRoi(screenshot.width, screenshot.height);
  }
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function modelPrivacy(provider: string, modelId: string): ModelPrivacyDescriptor {
  const location = /(?:^|[-_.])(ollama|lmstudio|llama.cpp|local|mlx)(?:$|[-_.])/i.test(provider) ? "local" : "remote";
  return {
    provider,
    modelId,
    location,
    retentionPolicy: location === "local" ? "local process; no network transmission" : "provider-configured retention; AdPilot stores no remote image copy"
  };
}

function endpointPrivacy(baseURL: string, modelId: string): ModelPrivacyDescriptor {
  let local = false;
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    local = false;
  }
  return {
    provider: "openai-compatible-gui",
    modelId,
    location: local ? "local" : "remote",
    retentionPolicy: local ? "local process; no network transmission" : "provider-configured retention; AdPilot stores no remote image copy"
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
