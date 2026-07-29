import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { AdPilotAgent, WorkspaceSharedFactRepository, type AgentKnowledge } from "@adpilot/agent-orchestrator";
import type { Session as ProductSessionEntity } from "@adpilot/session-service";
import {
  BrowserSessionBoundOperator,
  BrowserSessionManager,
  DualVisualIdentityVerifier,
  FileScreenshotArtifactStore,
  FileScreenshotModelCallAuditStore,
  FileComputerActionRecordStore,
  FileMutationReplayStore,
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
  NativeHelperOperator,
  NativeHelperBrowserPageIdentity,
  NativeHelperSurfaceIdentity,
  VisualComputerRuntime,
  defaultBrowserContentRoi,
  masksOutsideProtectedRegions,
  minimumIdentityDisclosure,
  type ExpectedVisualIdentity,
  type ModelPrivacyDescriptor,
  type NativeOperator,
  type Screenshot,
  type ScreenshotPrivacyMode,
  type VisualMicroTask,
  type VisualAction,
  type VisualRuntimeEvent,
  type VisualGroundingProvider,
  type VisualVerifier,
  type ComputerActionRecordStore
} from "@adpilot/computer-use";
import {
  NATIVE_HELPER_BUNDLE_ID,
  NativeComputerHostSupervisor,
  type NativeComputerService,
  resolveNativeHelperExecutable
} from "@adpilot/native-computer-host";
import { ExperimentStore } from "@adpilot/experiments";
import {
  UnavailableStepExecutor,
  VisualRuntimeStepExecutor,
  browserSessionSurfaceProvider,
  type StepExecutor
} from "@adpilot/workflows";
import { ArtifactService, FileArtifactStore } from "@adpilot/artifacts";
import { KernelService } from "@adpilot/kernel";
import { createPiModels, modelRouterFromEnv, resolvePiModel } from "@adpilot/model-router";
import { PiAgentRuntime, AuditRuntimeExtension, AutonomyStore, PlanModeStore, type ReasoningPolicy } from "@adpilot/runtime";
import { SkillRegistry } from "@adpilot/skills";
import { AccountOperator, CreativeStrategist, MediaBuyer, MeasurementReviewer, PerformanceAnalyst, ReportingAnalyst, RiskReviewer, SpecialistCoordinator } from "@adpilot/specialist-agents";
import { AdPilotTools } from "@adpilot/tools";
import { WorkspaceStore } from "@adpilot/workspace";
import { SettingsStore, WorkspaceCredentialStore } from "@adpilot/configuration";
import type { Models } from "@earendil-works/pi-ai";
import { SharedFactLedger, type MonitoringAlert } from "@adpilot/shared";
import { PiVisualTableModel, PiVisualTableVerifier, VisualTableReader } from "@adpilot/visual-table-reader";
import { AlertMonitor, type AlertDeliveryStatus } from "./alert-monitor.js";
import { PromptTemplateStore } from "./prompt-templates.js";
import { createMergedAgentKnowledge, UserSkillStore } from "./user-skills.js";
import { createSessionAuthority, type SessionAuthority } from "./session-authority.js";
import { createPluginService, type PluginService } from "./plugins.js";

export { AlertMonitor, renderAlertMessage } from "./alert-monitor.js";
export type { AlertDeliveryStatus, AlertMonitorOptions, PendingAlertRecord } from "./alert-monitor.js";
export { acquireWorkspaceWriterLease, createSessionAuthority } from "./session-authority.js";
export type { SessionAuthority } from "./session-authority.js";
export {
  DeletedSessionError,
  FileSessionRepository,
  PermissionEscalationRequiresApprovalError,
  ProjectNotFoundError,
  RevisionConflictError,
  SessionModelBinding,
  SessionNotFoundError,
  SessionPermissionProfile,
  SessionPlatform,
  SessionService,
  SessionStatus,
  WorkspaceWriterLease,
  WorkspaceWriterLeaseHeldError
} from "@adpilot/session-service";
export type {
  CreateSessionInput,
  LegacyMigrationResult,
  Session as ProductSessionEntity,
  SessionFilter
} from "@adpilot/session-service";
export {
  expandPromptTemplateBody,
  parsePromptTemplate,
  PromptTemplateStore,
  tokenizePromptArguments
} from "./prompt-templates.js";
export type { PromptTemplate, PromptTemplateSummary, PromptTemplateWarning } from "./prompt-templates.js";
export { createMergedAgentKnowledge, matchSkillSummaries, parseSkillMarkdown, UserSkillStore } from "./user-skills.js";
export type { UserSkill, UserSkillSource, UserSkillWarning } from "./user-skills.js";
export { createPluginService, PluginPermissionReviewError, PluginService } from "./plugins.js";
export { resolvePluginResourceLayout } from "./plugin-roots.js";
export type { PluginResourceLayout, PluginResourceRootsOverride } from "./plugin-roots.js";
export type {
  PluginCatalogResponse,
  PluginDetailsResponse,
  PluginMutationOptions,
  PluginServiceDeps,
  PluginServiceStatus,
  PluginToolInvocation,
  PluginVerificationDto
} from "./plugins.js";
export { PluginRuntimeError } from "@adpilot/plugin-runtime";

export interface PublicVisualRuntimeEvent {
  type: VisualRuntimeEvent["type"];
  clientId?: string;
  taskId?: string;
  phase?: "before" | "after";
  attempt?: number;
  tier?: string;
  screenshot?: Pick<Screenshot, "width" | "height" | "scaleFactor" | "capturedAt" | "sha256" | "surfaceFingerprint">;
  action?: { action: string; target: string; reason: string; confidence: number; expectedResult: string; riskLevel: string };
  overlay?: {
    coordinateSpace: "screenshot_pixels";
    targetBox?: { x: number; y: number; width: number; height: number };
    pointer?: { x: number; y: number };
    dragTo?: { x: number; y: number };
  };
  matched?: boolean;
  confidence?: number;
  reason?: string;
  code?: string;
}

export type ProductEvent =
  | { type: "task"; clientId: string; status: string; taskId?: string; message: string }
  | { type: "computer"; clientId: string; taskId?: string; event: PublicVisualRuntimeEvent }
  | { type: "approval"; clientId: string; approvalId: string; status: string }
  | { type: "alert"; clientId: string; status: AlertDeliveryStatus; alert: MonitoringAlert; conversationId?: string }
  | { type: "conversation"; clientId: string; conversationId: string; status: string; forkedFrom?: string }
  | { type: "session"; clientId: string; sessionId: string; status: string; session: ProductSessionEntity }
  | { type: "plugin"; clientId: string; pluginId: string; status: string }
  | { type: "error"; clientId?: string; message: string; retryable: boolean };

export class ProductEventBus {
  private readonly emitter = new EventEmitter();
  private recent: ProductEvent[] = [];
  publish(event: ProductEvent): void { this.recent = [...this.recent.slice(-99), event]; this.emitter.emit("event", event); }
  subscribe(listener: (event: ProductEvent) => void, clientId?: string): () => void {
    const scoped = (event: ProductEvent) => { if (!clientId || event.clientId === clientId) listener(event); };
    this.emitter.on("event", scoped);
    return () => this.emitter.off("event", scoped);
  }
  history(clientId: string): ProductEvent[] { return this.recent.filter((event) => event.clientId === clientId); }
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
  /** Product Session authority: durable sessions backed by the workspace writer lease. */
  sessions: SessionAuthority["service"];
  /** Boot-time authority details: writer lease, idempotent legacy import result, interrupted runs. */
  sessionAuthority: SessionAuthority;
  /** Conversation-level plan-mode switch state (persisted conversation metadata). */
  planMode: PlanModeStore;
  /** Client-level autonomy switch: guarded (default) or full_access. */
  autonomy: AutonomyStore;
  specialists: SpecialistCoordinator;
  agent: AdPilotAgent;
  alerts: AlertMonitor;
  /** Universal Workspace kernel: projects, goals, task graphs, artifact ids. */
  kernel: KernelService;
  /** Unified artifact runtime: renderers, versioning, previews. */
  artifacts: ArtifactService;
  computer: VisualComputerRuntime | undefined;
  /**
   * Production workflow step executor. With a VisualComputerRuntime it is the
   * real VisualRuntimeStepExecutor whose surface provider resolves the exact
   * connected Browser Session of the run's workspace; without one it is the
   * fail-closed UnavailableStepExecutor.
   */
  workflowExecutor: StepExecutor;
  /** Durable Computer Action records backing workflow recording and replay evidence. */
  workflowActionRecords: ComputerActionRecordStore;
  /** The single authenticated Helper actor shared by execution and Electron UI. */
  nativeComputerHost: NativeComputerService | undefined;
  /** Fail-closed launch/discovery reason. Never causes a NutJS fallback. */
  nativeHelperError: string | undefined;
  /** Releases application-owned native resources. Safe to call more than once. */
  shutdown(): Promise<void>;
  browserSessions: BrowserSessionManager;
  screenshotAudits: FileScreenshotModelCallAuditStore;
  visualTableReader: VisualTableReader | undefined;
  events: ProductEventBus;
  approvalTokens: Map<string, string>;
  /** Embedded playbooks merged with the discovered user skills (advisory knowledge only). */
  knowledge: AgentKnowledge;
  /** User skill discovery layer (~/.adpilot/skills and the workspace .adpilot/skills). */
  userSkills: UserSkillStore;
  /** User prompt templates backing custom slash commands. */
  promptTemplates: PromptTemplateStore;
  /** Curated plugin subsystem: catalog, lifecycle, verification, and the isolated tool boundary. */
  plugins: PluginService;
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

export interface CreateAdPilotSystemOptions {
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  models?: Models;
  adpilotHome?: string;
  pluginCatalog?: { repositoryRoot?: string; curatedRoot?: string; trustRoot?: string };
  /** Explicit test/embedding seam. Production macOS composition uses the Helper. */
  nativeOperator?: NativeOperator;
  /** Inject one already-authenticated actor; application does not own its lifecycle. */
  nativeComputerHost?: NativeComputerService;
  nativeHelper?: false | {
    explicitPath?: string;
    resourcesPath?: string;
    repositoryRoot?: string;
  };
}

export async function createAdPilotSystem(options: CreateAdPilotSystemOptions = {}): Promise<AdPilotSystem> {
  const baseEnv = options.env ?? process.env;
  const workspaceRoot = options.workspaceRoot ?? baseEnv.ADPILOT_WORKSPACE ?? resolve(process.cwd(), "workspace");
  const settings = new SettingsStore(workspaceRoot, baseEnv);
  const credentials = new WorkspaceCredentialStore(workspaceRoot);
  const env = await settings.effectiveEnv();
  const workspace = new WorkspaceStore(workspaceRoot);
  const events = new ProductEventBus();
  const native = await resolveApplicationNativeComputer(options, env);
  try {
  const nativeHelperOperator = native.host ? new NativeHelperOperator(native.host) : undefined;
  const nativeOperator = options.nativeOperator
    ?? nativeHelperOperator;
  const nativeSurfaceIdentity = native.host ? new NativeHelperSurfaceIdentity(native.host) : undefined;
  // User-extension roots: the user-global AdPilot home and the per-workspace
  // .adpilot directory. Both are optional and simply empty when missing.
  const adpilotHome = resolve(options.adpilotHome ?? env.ADPILOT_HOME ?? join(homedir(), ".adpilot"));
  const userSkills = new UserSkillStore([
    { root: join(adpilotHome, "skills"), source: "user" },
    { root: join(workspaceRoot, ".adpilot", "skills"), source: "workspace" }
  ]);
  const knowledge = createMergedAgentKnowledge(userSkills);
  const promptTemplates = new PromptTemplateStore([
    join(adpilotHome, "prompts"),
    join(workspaceRoot, ".adpilot", "prompts")
  ]);
  const secret = await loadApprovalSecret(workspaceRoot, env.ADPILOT_APPROVAL_SECRET);
  const audit = new AuditLog(workspace);
  const approvals = new ApprovalService(workspace, secret);
  for (const client of await workspace.listClients()) await approvals.recoverInterrupted(client.id);
  // The Session authority boots before any run is accepted: it acquires the
  // workspace writer lease (a live foreign holder is a hard startup error),
  // imports legacy conversations idempotently, and resets interrupted runs.
  const sessionAuthority = await createSessionAuthority({ workspace, audit });
  const experiments = new ExperimentStore(workspace);
  const privacyMode: ScreenshotPrivacyMode = env.ADPILOT_PRIVACY_MODE === "local-only" ? "local-only" : "minimized";
  const screenshotArtifacts = new FileScreenshotArtifactStore(workspaceRoot);
  const screenshotAudits = new FileScreenshotModelCallAuditStore(workspaceRoot);
  const screenshotPrivacy = new ScreenshotPrivacyPipeline(screenshotArtifacts, screenshotAudits);
  const browserSessions = new BrowserSessionManager(workspaceRoot, {
    ...(nativeSurfaceIdentity ? { surfaceIdentity: nativeSurfaceIdentity } : {}),
    ...(native.host ? { pageIdentity: new NativeHelperBrowserPageIdentity(native.host) } : {})
  });
  await browserSessions.recover();
  const router = modelRouterFromEnv(env);
  const models = options.models ?? createPiModels(env, credentials);
  const fastRef = { provider: env.ADPILOT_FAST_PROVIDER ?? "openai", model: env.ADPILOT_FAST_MODEL ?? "gpt-5-mini" };
  // Single-model semantics: an unconfigured strong role follows the fast one.
  const strongRef = { provider: env.ADPILOT_STRONG_PROVIDER ?? fastRef.provider, model: env.ADPILOT_STRONG_MODEL ?? env.ADPILOT_FAST_MODEL ?? "gpt-5.2" };
  const fastModel = resolvePiModel(models, fastRef);
  const strongModel = resolvePiModel(models, strongRef);
  const fastAuth = Boolean(await models.checkAuth(fastModel.provider).catch(() => undefined));
  const strongAuth = fastModel.provider === strongModel.provider ? fastAuth : Boolean(await models.checkAuth(strongModel.provider).catch(() => undefined));
  // Settings-driven reasoning (thinking) mode: strong role by default, every
  // role when the scope is "all". Unsupported models drop it silently.
  const reasoningEffort = env.ADPILOT_REASONING_EFFORT;
  const reasoningPolicy: ReasoningPolicy | undefined = reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high"
    ? { effort: reasoningEffort, scope: env.ADPILOT_REASONING_SCOPE === "all" ? "all" : "strong" }
    : undefined;
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
        (task, screenshot) => taskModelRoi(task, screenshot),
        () => dedicatedGroundingPrivacy,
        () => privacyMode,
        taskSensitiveMasks
      )
    : undefined;
  const piGrounding = piVision && primaryVisionPrivacy && strongVisionPrivacy
    ? new PrivacyAwareGroundingProvider(
        piVision,
        screenshotPrivacy,
        requireTaskClient,
        (task, screenshot) => taskModelRoi(task, screenshot),
        (tier) => tier === "strong" ? strongVisionPrivacy : primaryVisionPrivacy,
        () => privacyMode,
        taskSensitiveMasks
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
        (_expected, before, after, task) => ({ before: taskModelRoi(task, before), after: taskModelRoi(task, after) }),
        verifierPrivacy,
        () => privacyMode,
        (_expected, screenshot, _phase, task) => taskSensitiveMasks(task, screenshot)
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
    ? new PrivacyAwareVisualIdentityReviewer(
        rawGuiIdentity,
        screenshotPrivacy,
        (expected, screenshot) => identitySafeRoi(expected, screenshot.width, screenshot.height),
        guiIdentityPrivacy,
        () => privacyMode,
        (expected, screenshot) => identitySensitiveMasks(expected, screenshot.width, screenshot.height),
        false,
        "locator"
      )
    : undefined;
  const deepIdentity = rawDeepIdentity && strongVisionPrivacy
    ? new PrivacyAwareVisualIdentityReviewer(
        rawDeepIdentity,
        screenshotPrivacy,
        (expected, screenshot) => identitySafeRoi(expected, screenshot.width, screenshot.height),
        strongVisionPrivacy,
        () => privacyMode,
        (expected, screenshot) => identitySensitiveMasks(expected, screenshot.width, screenshot.height),
        false
      )
    : undefined;
  const visualIdentity = guiIdentity && deepIdentity
    && (privacyMode !== "local-only" || (guiIdentityPrivacy?.location === "local" && strongVisionPrivacy?.location === "local"))
    ? new DualVisualIdentityVerifier(guiIdentity, deepIdentity)
    : undefined;
  const guiConfigured = Boolean(grounding && verifier && visualIdentity);
  const sharedFacts = new SharedFactLedger(new WorkspaceSharedFactRepository(workspace));
  const computerActionRecords = new FileComputerActionRecordStore(
    join(workspaceRoot, ".adpilot", "computer-actions")
  );
  const computerMutationReplay = new FileMutationReplayStore(
    join(workspaceRoot, ".adpilot", "computer-mutation-replay")
  );
  const kernel = KernelService.fromRoot(workspaceRoot);
  const artifacts = new ArtifactService(new FileArtifactStore(workspaceRoot));
  const computer = grounding && verifier && nativeOperator
    ? new VisualComputerRuntime(
        new BrowserSessionBoundOperator(nativeOperator, browserSessions),
        grounding,
        verifier,
        undefined,
        async (event) => {
          if (!event.clientId) return;
          if (event.taskId && (event.type === "executed" || (event.type === "blocked" && event.code === "SURFACE_CHANGED"))) {
            await sharedFacts.invalidateVisualEvidence(event.clientId, {
              taskId: event.taskId,
              reason: event.type === "executed"
                ? "native visual action changed the observed page"
                : "native surface changed during Computer Use"
            });
          }
          events.publish({
            type: "computer",
            clientId: event.clientId,
            ...(event.taskId ? { taskId: event.taskId } : {}),
            event: sanitizeVisualRuntimeEvent(event)
          });
        },
        positiveInteger(env.ADPILOT_GUI_TIMEOUT_MS, 20_000),
        Math.min(3, positiveInteger(env.ADPILOT_GUI_MAX_RETRIES, 2) + 1),
        computerActionRecords,
        computerMutationReplay
      )
    : undefined;
  if (computer && nativeHelperOperator) {
    nativeHelperOperator.setUserInputHandler((binding) => {
      computer.notifyUserInput(binding);
    });
  }
  // Workflow execution seam (consumed by the server's workflow routes): the
  // real runtime plus the browser-session surface provider when Computer Use
  // is configured, fail-closed otherwise. Replay never guesses a window.
  const workflowExecutor: StepExecutor = computer
    ? new VisualRuntimeStepExecutor(computer, browserSessionSurfaceProvider(browserSessions))
    : new UnavailableStepExecutor("Computer Use is unavailable on this system");
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
  // The general read-only tools may additionally read the skill/prompt
  // directories so the agent can load skill bodies and templates on demand
  // (progressive disclosure); the workspace .adpilot private subtree stays
  // denied except those two public subdirectories.
  const generalReadRoots = [
    join(adpilotHome, "skills"),
    join(adpilotHome, "prompts"),
    join(workspaceRoot, ".adpilot", "skills"),
    join(workspaceRoot, ".adpilot", "prompts")
  ];
  const tools = new AdPilotTools(workspace, audit, approvals, experiments, computer, visualIdentity, browserSessions, visualTableTools, sharedFacts, generalReadRoots);
  const skills = new SkillRegistry();
  const planMode = new PlanModeStore(workspace, audit);
  const autonomy = new AutonomyStore(workspace, audit);
  const runtime = new PiAgentRuntime(models, router, workspace, skills, tools, [
    {
      name: "product-events",
      onError: (error) => events.publish({ type: "error", message: error.message, retryable: true })
    },
    new AuditRuntimeExtension(audit)
  ], { generalReadTools: tools.generalReadTools(), planMode, autonomy, ...(reasoningPolicy ? { reasoning: reasoningPolicy } : {}) });
  const alertMonitor = new AlertMonitor({ workspace, runtime, audit, events });
  runtime.registerExtension(alertMonitor.extension);
  const specialists = new SpecialistCoordinator([
    new AccountOperator(tools),
    new PerformanceAnalyst(runtime),
    new MediaBuyer(runtime),
    new MeasurementReviewer(runtime),
    new CreativeStrategist(runtime),
    new RiskReviewer(runtime, tools),
    new ReportingAnalyst(runtime)
  ]);
  const agent = new AdPilotAgent(runtime, specialists, workspace, tools, (task) => events.publish({
    type: "task", clientId: task.clientId, status: task.phase, taskId: task.id,
    message: task.owner ? `${task.owner} is working` : task.nextStep ?? task.goal
  }), sharedFacts, knowledge);
  // The plugin subsystem boots after the audit chain and event bus exist so
  // every verification finding and lifecycle transition is recorded; a
  // tampered curated catalog degrades the subsystem, never the product boot.
  const plugins = await createPluginService({
    workspace,
    audit,
    events,
    env,
    ...(options.pluginCatalog ? { roots: options.pluginCatalog } : {})
  });
  const connectedSessions = (await browserSessions.list()).filter((session) => session.sessionStatus === "connected");
  return {
    workspace, settings, credentials, models, audit, approvals, experiments, tools, skills, runtime, planMode, autonomy, specialists, agent,
    sessions: sessionAuthority.service, sessionAuthority,
    alerts: alertMonitor, computer,
    workflowExecutor,
    workflowActionRecords: computerActionRecords,
    kernel, artifacts,
    nativeComputerHost: native.host,
    nativeHelperError: native.error,
    shutdown: async () => {
      nativeHelperOperator?.setUserInputHandler(undefined);
      if (native.owned && native.host && !native.host.closed) await native.host.close();
    },
    browserSessions, screenshotAudits, visualTableReader, events,
    approvalTokens: new Map(),
    knowledge, userSkills, promptTemplates, plugins,
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
  } catch (error) {
    if (native.owned && native.host && !native.host.closed) {
      await native.host.close().catch(() => undefined);
    }
    throw error;
  }
}

/** Never expose complete screenshot bytes or native window titles through UI events. */
export function sanitizeVisualRuntimeEvent(event: VisualRuntimeEvent): PublicVisualRuntimeEvent {
  if (event.type === "screenshot") {
    return {
      type: event.type,
      phase: event.phase,
      ...(event.clientId ? { clientId: event.clientId } : {}),
      ...(event.taskId ? { taskId: event.taskId } : {}),
      screenshot: {
        width: event.screenshot.width,
        height: event.screenshot.height,
        scaleFactor: event.screenshot.scaleFactor,
        capturedAt: event.screenshot.capturedAt,
        sha256: event.screenshot.sha256,
        ...(event.screenshot.surfaceFingerprint ? { surfaceFingerprint: event.screenshot.surfaceFingerprint } : {})
      }
    };
  }
  if (event.type === "grounded" || event.type === "executed") {
    const overlay = publicActionOverlay(event.action);
    return {
      type: event.type,
      attempt: event.attempt,
      ...(event.type === "grounded" ? { tier: event.tier } : {}),
      ...(event.clientId ? { clientId: event.clientId } : {}),
      ...(event.taskId ? { taskId: event.taskId } : {}),
      action: {
        action: event.action.action,
        target: event.action.target,
        reason: event.action.reason,
        confidence: event.action.confidence,
        expectedResult: event.action.expected_result,
        riskLevel: event.action.risk_level
      },
      ...(overlay ? { overlay } : {})
    };
  }
  return structuredClone(event) as PublicVisualRuntimeEvent;
}

function publicActionOverlay(action: VisualAction): NonNullable<PublicVisualRuntimeEvent["overlay"]> | undefined {
  const allowed = action.allowedRegion?.coordinateSpace === "screenshot_pixels"
    ? {
        x: action.allowedRegion.x,
        y: action.allowedRegion.y,
        width: action.allowedRegion.width,
        height: action.allowedRegion.height
      }
    : undefined;
  const pointer = "x" in action && "y" in action && action.x !== undefined && action.y !== undefined
    ? { x: action.x, y: action.y }
    : undefined;
  const dragTo = action.action === "drag"
    ? { x: action.end_x, y: action.end_y }
    : undefined;
  if (!allowed && !pointer && !dragTo) return undefined;
  return {
    coordinateSpace: "screenshot_pixels",
    ...(allowed ? { targetBox: allowed } : {}),
    ...(pointer ? { pointer } : {}),
    ...(dragTo ? { dragTo } : {})
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

/** Returns only the tight bounding box around four locally supplied identity regions. */
export function identitySafeRoi(expected: ExpectedVisualIdentity, width: number, height: number) {
  return expected.evidenceRegions
    ? minimumIdentityDisclosure(expected.evidenceRegions, width, height).roi
    : defaultBrowserContentRoi(width, height);
}

/** Redacts all pixels between the four explicit identity evidence regions. */
export function identitySensitiveMasks(expected: ExpectedVisualIdentity, width: number, height: number) {
  return minimumIdentityDisclosure(expected.evidenceRegions, width, height).masks;
}

function taskModelRoi(task: VisualMicroTask | undefined, screenshot: Screenshot) {
  const target = taskAllowedPixelRegion(task, screenshot);
  if (!target) return defaultBrowserContentRoi(screenshot.width, screenshot.height);
  const { x, y, width, height } = target;
  const marginX = Math.max(8, Math.min(24, Math.round(width * 0.25)));
  const marginY = Math.max(8, Math.min(24, Math.round(height * 0.25)));
  const left = Math.max(0, Math.floor(x - marginX));
  const top = Math.max(0, Math.floor(y - marginY));
  const right = Math.min(screenshot.width, Math.ceil(x + width + marginX));
  const bottom = Math.min(screenshot.height, Math.ceil(y + height + marginY));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function taskSensitiveMasks(task: VisualMicroTask | undefined, screenshot: Screenshot) {
  const target = taskAllowedPixelRegion(task, screenshot);
  if (!target) return [];
  return masksOutsideProtectedRegions(taskModelRoi(task, screenshot), [target]);
}

function taskAllowedPixelRegion(task: VisualMicroTask | undefined, screenshot: Screenshot) {
  if (!task?.allowedRegion) return undefined;
  const scale = task.allowedRegion.coordinateSpace === "screen_points" ? screenshot.scaleFactor : 1;
  const region = {
    x: Math.round(task.allowedRegion.x * scale),
    y: Math.round(task.allowedRegion.y * scale),
    width: Math.round(task.allowedRegion.width * scale),
    height: Math.round(task.allowedRegion.height * scale)
  };
  if (region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1
    || region.x + region.width > screenshot.width || region.y + region.height > screenshot.height) {
    throw new Error("task allowed region is outside screenshot bounds");
  }
  return region;
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

async function resolveApplicationNativeComputer(
  options: CreateAdPilotSystemOptions,
  env: NodeJS.ProcessEnv
): Promise<{
  host: NativeComputerService | undefined;
  error: string | undefined;
  owned: boolean;
}> {
  if (options.nativeComputerHost) {
    return options.nativeComputerHost.closed
      ? { host: undefined, error: "injected native Helper host is already closed", owned: false }
      : { host: options.nativeComputerHost, error: undefined, owned: false };
  }
  // An explicit operator is a test/embedding seam and never causes a second
  // Helper actor to be discovered or launched.
  if (options.nativeOperator) return { host: undefined, error: undefined, owned: false };
  if (options.nativeHelper === false) {
    return { host: undefined, error: "native Helper was explicitly disabled", owned: false };
  }
  if (process.platform !== "darwin") {
    return { host: undefined, error: `native Computer Use is unavailable on ${process.platform}`, owned: false };
  }

  const explicitPath = options.nativeHelper?.explicitPath ?? env.ADPILOT_NATIVE_HELPER_PATH;
  const repositoryRoot = options.nativeHelper?.repositoryRoot
    // Vitest systems must opt in to a real child process. This is not a
    // production fallback; production and development discover the stable path.
    ?? (process.env.VITEST ? undefined : process.cwd());
  try {
    const executablePath = await resolveNativeHelperExecutable({
      ...(explicitPath ? { explicitPath } : {}),
      ...(options.nativeHelper?.resourcesPath ? { resourcesPath: options.nativeHelper.resourcesPath } : {}),
      ...(repositoryRoot ? { repositoryRoot } : {})
    });
    if (!executablePath) {
      return { host: undefined, error: "native Helper executable was not found at a supported stable path", owned: false };
    }
    const packaged = executablePath.includes(".app/Contents/MacOS/");
    const host = await NativeComputerHostSupervisor.launch({
      executablePath,
      sessionId: `adpilot-application-${process.pid}`,
      ...(packaged
        ? {
            expectedIdentity: {
              bundleIdentifier: NATIVE_HELPER_BUNDLE_ID,
              signingIdentifier: NATIVE_HELPER_BUNDLE_ID
            }
          }
        : {})
    });
    return { host, error: undefined, owned: true };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code ?? "NATIVE_HELPER_UNAVAILABLE")
      : "NATIVE_HELPER_UNAVAILABLE";
    return {
      host: undefined,
      error: `${code}: ${error instanceof Error ? error.message : String(error)}`,
      owned: false
    };
  }
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
