import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { SessionError } from "@earendil-works/pi-agent-core";
import type { AdPilotSystem } from "@adpilot/application";
import { buildAgentToolRegistry } from "@adpilot/agent-tools";
import {
  DailyBriefService,
  DecisionService,
  FileAdAccountStore,
  FileAdvertisingDecisionStore,
  FileCampaignStore,
  FileCreativeAssetStore,
  PythonUacEngine
} from "@adpilot/ads-intelligence";
import { CheckpointStore, GitRepository, WorktreeManager } from "@adpilot/git-tools";
import { FileWorkflowRunStore, FileWorkflowStore, WorkflowRunner } from "@adpilot/workflows";
import {
  DeletedSessionError,
  PermissionEscalationRequiresApprovalError,
  PluginPermissionReviewError,
  PluginRuntimeError,
  ProjectNotFoundError,
  RevisionConflictError,
  SessionModelBinding,
  SessionNotFoundError,
  SessionPermissionProfile,
  SessionPlatform,
  SessionStatus,
  type ProductSessionEntity,
  type SessionFilter
} from "@adpilot/application";
import { ApprovalOperation } from "@adpilot/approvals";
import {
  StartBrowserSessionInput,
  type BrowserSession,
  type VisualComputerControlSnapshot
} from "@adpilot/computer-use";
import { SettingsUpdate } from "@adpilot/configuration";
import { resolvePiSessionId, type SessionModelOverride } from "@adpilot/runtime";
import { ConversationMessage, MonitoringAlert, MonitoringAlertInput, Platform, TaskState, type TaskState as TaskStateValue } from "@adpilot/shared";
import { ApprovalGuardrailEvidenceInput, VisualApprovalPlanInput, visualTaskFromExecutionPlan } from "@adpilot/tools";
import {
  expandSlashCommand,
  expandUserSlashCommand,
  isDirectSlashCommand,
  parseSlashCommand,
  renderApprovalsHistory,
  renderSkillsCatalog,
  renderSlashHelp,
  renderSlashParseError,
  splitSlashInput
} from "./slash-commands.js";
import {
  DesktopLiveFrame,
  DesktopLiveFrameBroker,
  DesktopNativeBindingError,
  DesktopNativeUnavailableError,
  DesktopPermissionCenter,
  DesktopPermissionId,
  DesktopPermissionTestResult,
  type DesktopNativeBridge,
  type DesktopNativeContext
} from "./desktop-native.js";
import { registerKernelRoutes } from "./kernel-routes.js";
import { registerWorkflowRoutes } from "./workflow-routes.js";
import { registerGitRoutes } from "./git-routes.js";
import { registerAdsRoutes } from "./ads-routes.js";
import { registerAutomationRoutes } from "./automation-routes.js";
import { registerTerminalRoutes } from "./terminal-routes.js";
import { registerFsRoutes } from "./fs-routes.js";
import { TerminalService } from "./terminal-service.js";
import { ensureProjectSession } from "./session-binding.js";
import type { Project as KernelProject } from "@adpilot/kernel";

export * from "./desktop-native.js";

const BrowserSessionStartRequest = z.object({
  clientId: z.string().min(1),
  browserProfile: z.string().min(1).optional(),
  platform: Platform.default("google_ads")
});
const BrowserSessionLookup = z.object({ clientId: z.string().min(1), browserProfile: z.string().min(1).optional() });
const ComputerControlRequest = z.object({
  clientId: z.string().min(1).max(256).optional(),
  productSessionId: z.string().uuid().optional(),
  browserSessionId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  computerSessionId: z.string().min(1).max(256).optional(),
  computerRevision: z.number().int().nonnegative().optional()
}).strict();

const SessionClientParams = z.object({ id: z.string().min(1) });
const SessionParams = z.object({ id: z.string().min(1), sid: z.string().uuid() });
const SessionActor = z.string().trim().min(1).max(120).default("workspace-owner");
const SessionListQuery = z.object({
  pinned: z.enum(["true", "false"]).optional(),
  archived: z.enum(["true", "false"]).optional(),
  status: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  deleted: z.enum(["true"]).optional()
});
const SessionCreateBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  projectId: z.string().uuid().optional(),
  agentProfileId: z.string().trim().min(1).max(256).optional(),
  advertisingWorkspaceId: z.string().trim().min(1).max(256).optional(),
  platforms: z.array(SessionPlatform).max(SessionPlatform.options.length).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
  modelBinding: SessionModelBinding.optional(),
  permissionProfile: SessionPermissionProfile.optional(),
  actor: SessionActor
}).strict();
const SessionPatchBody = z.object({
  revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  actor: SessionActor
}).strict().refine((value) => value.title !== undefined || value.pinned !== undefined, {
  message: "at least one of title or pinned is required"
});
const SessionComputerUseBody = z.object({
  revision: z.number().int().positive(),
  browserProfile: z.string().trim().min(1).max(1_024),
  computerUse: z.enum(["disabled", "observe", "interactive", "execute"]),
  confirm: z.literal(true)
}).strict();
const SessionMutationBody = z.object({
  revision: z.number().int().positive().optional(),
  actor: SessionActor
}).strict();
const SessionDuplicateBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  projectId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
  actor: SessionActor
}).strict();
const SessionBranchBody = z.object({
  atMessageId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  actor: SessionActor
}).strict();
const SessionDeleteQuery = z.object({ revision: z.coerce.number().int().positive().optional() });

const PluginParams = z.object({ pid: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/) });
const PluginMutationBody = z.object({
  clientId: z.string().min(1).optional(),
  actor: z.string().trim().min(1).max(120).default("workspace-owner"),
  version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/).optional(),
  allowUnsigned: z.literal(true).optional(),
  acceptPermissions: z.literal(true).optional()
}).strict();

export async function createServer(system: AdPilotSystem, options: {
  uiRoot?: string;
  onRestartRequested?: () => void;
  desktopNative?: DesktopNativeBridge;
  desktopNativeAuthToken?: string;
  /** Automation scheduler tick interval in ms; defaults to 30s, <= 0 disables. */
  automationTickMs?: number;
} = {}) {
  const app = Fastify({ logger: false });
  const desktopFrames = new DesktopLiveFrameBroker();
  type AuthSession = { id: string; providerId: string; status: "running" | "complete" | "failed"; events: AuthEvent[]; prompt?: AuthPrompt; answer?: (value: string) => void; error?: string };
  const authSessions = new Map<string, AuthSession>();
  await app.register(cors, { origin: false });
  if (options.desktopNative) {
    if (!options.desktopNativeAuthToken || options.desktopNativeAuthToken.length < 32) {
      throw new Error("desktop native routes require an instance-bound authentication token");
    }
    app.addHook("onRequest", async (request, reply) => {
      const path = request.url.split("?")[0]!;
      const productComputerPermission = /^\/api\/clients\/[^/]+\/sessions\/[^/]+\/computer-use$/.test(path);
      if (!path.startsWith("/api/desktop-native/")
        && !path.startsWith("/api/computer/")
        && !productComputerPermission) return;
      const fetchSite = request.headers["sec-fetch-site"];
      if (fetchSite !== undefined && fetchSite !== "same-origin") {
        return reply.code(403).send({ error: "desktop native routes require a same-origin request", code: "DESKTOP_NATIVE_FORBIDDEN" });
      }
      const token = cookieValue(request.headers.cookie, "adpilot_native_instance");
      if (!token || !constantTimeTextEqual(token, options.desktopNativeAuthToken!)) {
        return reply.code(403).send({ error: "desktop native instance authentication failed", code: "DESKTOP_NATIVE_FORBIDDEN" });
      }
    });
  }

  if ((await system.workspace.listClients()).length === 0) {
    await system.workspace.initializeClient({
      profile: { id: "personal", name: "AdPilot", industry: "unknown", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" },
      kpi: { primary: "CPA", target: 1, currency: "USD" }
    });
  }
  // A client now exists: drain boot-time plugin verification findings
  // (degraded installs, developer-mode fallback) into the audit chain.
  await system.plugins.flushStartup();

  app.get("/api/health", async () => {
    const runtime = await computerUseState(system);
    return { status: "ok", chatConfigured: system.modelStatus.chatConfigured, guiConfigured: system.modelStatus.guiConfigured, computerUse: runtime };
  });
  app.get("/api/about", async () => ({
    name: "AdPilot", version: "0.1.1",
    runtime: { name: "Pi", version: "0.80.10", license: "MIT" },
    computerUse: { name: "UI-TARS", version: "1.2.3", license: "Apache-2.0" },
    advertisingCore: { upstream: "codex-ads", version: "1.9.2", license: "MIT" }
  }));
  app.get("/api/settings", async () => {
    const [view, credentialList, computerUse] = await Promise.all([
      system.settings.publicView(), system.credentials.list(), computerUseState(system)
    ]);
    const stored = new Set(credentialList.map((item) => item.providerId));
    const providerConfigured = Object.fromEntries(view.catalog.providers.map((provider) => [provider.id, stored.has(provider.id) || provider.fields.some((field) => view.configured[field.env])]));
    return {
      ...view,
      providerConfigured,
      providerCredentials: Object.fromEntries(credentialList.map((item) => [item.providerId, item.type])),
      runtimeModels: { ...system.modelStatus, browserSession: computerUse.browserStatus },
      computerUse,
      restartAvailable: Boolean(options.onRestartRequested)
    };
  });
  app.put("/api/settings", async (request) => {
    const body = SettingsUpdate.parse(request.body);
    await system.settings.save(body);
    return { saved: true, restartRequired: true };
  });
  app.post("/api/settings/restart", async (_request, reply) => {
    if (!options.onRestartRequested) return reply.code(409).send({ error: "restart is only available in the native desktop app" });
    reply.send({ restarting: true });
    setTimeout(options.onRestartRequested, 80);
  });
  app.get("/api/desktop-native/permissions", async (request, reply) => {
    const query = z.object({
      clientId: z.string().min(1).max(256).optional(),
      productSessionId: z.string().uuid().optional(),
      browserSessionId: z.string().regex(/^[a-f0-9]{32}$/).optional()
    }).strict().parse(request.query);
    const native = requireDesktopNative(options.desktopNative);
    const context = await desktopNativeContext(system, query.clientId, query.productSessionId, query.browserSessionId);
    const result = DesktopPermissionCenter.parse(await native.permissionCenter(context));
    reply.header("cache-control", "no-store");
    return result;
  });
  app.post("/api/desktop-native/permissions/request", async (request, reply) => {
    const body = z.object({
      clientId: z.string().min(1).max(256).optional(),
      productSessionId: z.string().uuid().optional(),
      browserSessionId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
      permissions: z.array(z.enum(["screen-recording", "accessibility"]))
        .min(1)
        .max(2)
        .refine((items) => new Set(items).size === items.length, "permissions must not contain duplicates")
    }).strict().parse(request.body);
    const native = requireDesktopNative(options.desktopNative);
    const context = await desktopNativeContext(system, body.clientId, body.productSessionId, body.browserSessionId);
    const result = DesktopPermissionCenter.parse(await native.requestPermissions(body.permissions, context));
    reply.header("cache-control", "no-store");
    return result;
  });
  app.post("/api/desktop-native/permissions/open", async (request) => {
    const body = z.object({ permission: DesktopPermissionId }).strict().parse(request.body);
    const native = requireDesktopNative(options.desktopNative);
    await native.openPermissionSettings(body.permission);
    return { opened: true, permission: body.permission };
  });
  app.post("/api/desktop-native/permissions/test", async (request, reply) => {
    const body = z.object({
      permission: DesktopPermissionId,
      clientId: z.string().min(1).max(256).optional(),
      productSessionId: z.string().uuid().optional(),
      browserSessionId: z.string().regex(/^[a-f0-9]{32}$/).optional()
    }).strict().parse(request.body);
    const native = requireDesktopNative(options.desktopNative);
    const context = await desktopNativeContext(system, body.clientId, body.productSessionId, body.browserSessionId);
    const result = DesktopPermissionTestResult.parse(await native.testPermission(body.permission, context));
    reply.header("cache-control", "no-store");
    return result;
  });
  app.get("/api/desktop-native/live-frame", async (request, reply) => {
    const query = z.object({
      clientId: z.string().min(1).max(256),
      productSessionId: z.string().uuid(),
      browserSessionId: z.string().regex(/^[a-f0-9]{32}$/)
    }).strict().parse(request.query);
    const native = requireDesktopNative(options.desktopNative);
    const context = await requiredDesktopLiveContext(system, query.clientId, query.productSessionId, query.browserSessionId);
    const binding = context.browserSession;
    const frame = await desktopFrames.capture(
      `${query.clientId}:${query.productSessionId}:${query.browserSessionId}:${binding.processId}:${binding.windowId}`,
      async () => {
        const captured = DesktopLiveFrame.parse(await native.captureLiveFrame(context));
        assertDesktopFrameBinding(captured, context);
        return captured;
      }
    );
    reply.headers({
      "cache-control": "no-store, max-age=0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff"
    });
    return frame;
  });
  app.post("/api/settings/oauth/:providerId", async (request, reply) => {
    const { providerId } = z.object({ providerId: z.string() }).parse(request.params);
    const provider = system.models.getProvider(providerId);
    if (!provider?.auth.oauth) return reply.code(400).send({ error: "provider does not support OAuth" });
    const id = crypto.randomUUID();
    const session: AuthSession = { id, providerId, status: "running", events: [] };
    authSessions.set(id, session);
    void system.models.login(providerId, "oauth", {
      notify: (event) => { session.events.push(event); },
      prompt: (prompt) => new Promise<string>((resolve, reject) => {
        session.prompt = prompt;
        session.answer = (value) => { delete session.prompt; delete session.answer; resolve(value); };
        prompt.signal?.addEventListener("abort", () => reject(new Error("authorization prompt cancelled")), { once: true });
      })
    }).then(() => { session.status = "complete"; }).catch((error) => { session.status = "failed"; session.error = error instanceof Error ? error.message : String(error); });
    reply.code(202); return { id };
  });
  app.get("/api/settings/oauth/session/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const session = authSessions.get(id);
    if (!session) return reply.code(404).send({ error: "authorization session not found" });
    return { id: session.id, providerId: session.providerId, status: session.status, events: session.events, prompt: session.prompt ? { ...session.prompt, signal: undefined } : undefined, error: session.error };
  });
  app.post("/api/settings/oauth/session/:id/respond", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { value } = z.object({ value: z.string() }).parse(request.body);
    const session = authSessions.get(id);
    if (!session?.answer) return reply.code(409).send({ error: "authorization is not waiting for input" });
    session.answer(value); return { accepted: true };
  });
  app.delete("/api/settings/oauth/:providerId", async (request) => {
    const { providerId } = z.object({ providerId: z.string() }).parse(request.params);
    await system.models.logout(providerId);
    return { disconnected: true };
  });
  app.get("/api/state", async (request) => {
    const query = z.object({ clientId: z.string().optional(), conversationId: z.string().min(1).default("primary") }).parse(request.query);
    const clients = await system.workspace.listClients();
    const clientId = query.clientId ?? clients[0]?.id;
    if (!clientId) {
      const computerUse = await computerUseState(system);
      const models = { ...system.modelStatus, browserSession: computerUse.browserStatus };
      return { clients, tasks: [], approvals: [], experiments: [], audit: [], messages: [], sessions: [], selectedSessionId: null, browserSessions: computerUse.sessions, computerUse, events: [], models };
    }
    const [tasks, approvals, experiments, audit, messages, settings, planMode, autonomy, sessions] = await Promise.all([
      system.workspace.listTasks(clientId), system.approvals.list(clientId), system.experiments.list(clientId), system.audit.list(clientId),
      system.workspace.readJsonl(clientId, "conversation.jsonl", ConversationMessage), system.settings.publicView(),
      system.planMode.get(clientId, query.conversationId),
      system.autonomy.get(clientId),
      system.sessions.list({ clientId })
    ]);
    const selectedProductSession = sessions.find((session) => session.runtimeConversationId === query.conversationId);
    const computerUse = await computerUseState(
      system,
      clientId,
      false,
      selectedProductSession?.permissionProfile.browserProfile,
      selectedProductSession?.id,
      selectedProductSession?.permissionProfile.computerUse
    );
    const models = { ...system.modelStatus, browserSession: computerUse.browserStatus };
    return {
      clients,
      selectedClientId: clientId,
      selectedConversationId: query.conversationId,
      selectedSessionId: selectedProductSession?.id ?? null,
      // Tasks are scoped to the selected conversation (like messages) and each
      // carries its resolved conversationId/sessionId; archived tasks are
      // dismissed and never listed. See scopeTasksForConversation.
      tasks: scopeTasksForConversation(tasks, messages, sessions, query.conversationId),
      approvals,
      experiments,
      audit,
      planMode,
      autonomy,
      conversations: [...new Set(messages.map((message) => message.conversationId))],
      sessions,
      messages: messages.filter((message) => message.conversationId === query.conversationId).map((message) => sanitizeLegacyConversationError(message, settings.locale)),
      browserSessions: computerUse.sessions,
      computerUse,
      events: system.events.history(clientId),
      models
    };
  });

  app.get("/events", async (request, reply) => {
    const query = z.object({ clientId: z.string().min(1) }).parse(request.query);
    await system.workspace.readClient(query.clientId);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    reply.raw.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    const unsubscribe = system.events.subscribe((event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`), query.clientId);
    reply.raw.on("close", unsubscribe);
  });

  app.post("/api/clients", async (request, reply) => {
    const body = z.object({ profile: z.object({ id: z.string(), name: z.string(), industry: z.string().optional(), timezone: z.string().optional() }), kpi: z.object({ primary: z.enum(["CPI", "CPA", "ROAS", "LTV_CAC", "REVENUE", "LEADS"]), target: z.number().positive(), currency: z.string().length(3).optional() }) }).parse(request.body);
    await system.workspace.initializeClient(body);
    reply.code(201); return { id: body.profile.id };
  });

  app.post("/api/tasks", async (request, reply) => {
    const body = z.object({
      clientId: z.string(),
      goal: z.string().min(1),
      conversationId: z.string().trim().min(1).max(120).optional(),
      sessionId: z.string().uuid().optional()
    }).strict().parse(request.body);
    system.events.publish({ type: "task", clientId: body.clientId, status: "running", message: body.goal });
    try {
      const result = await system.agent.runTask(body.clientId, body.goal, {
        ...(body.conversationId ? { conversationId: body.conversationId } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {})
      });
      system.events.publish({ type: "task", clientId: body.clientId, status: result.task.phase, taskId: result.task.id, message: result.result.summary });
      reply.code(201); return result;
    } catch (error) {
      system.events.publish({ type: "error", clientId: body.clientId, message: error instanceof Error ? error.message : String(error), retryable: true });
      throw error;
    }
  });

  /**
   * Dismisses a task from every conversation view: the phase flips to the
   * terminal `archived` state, the task stays on disk for audit, and
   * /api/state stops listing it. Idempotent — re-archiving returns the task.
   */
  app.post("/api/tasks/:id/archive", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ clientId: z.string().min(1) }).strict().parse(request.body ?? {});
    let task: TaskStateValue;
    try {
      task = await system.workspace.readTask(body.clientId, params.id);
    } catch {
      return reply.code(404).send({ error: `task not found: ${params.id}`, code: "TASK_NOT_FOUND" });
    }
    if (task.phase !== "archived") {
      task = TaskState.parse({ ...task, phase: "archived", updatedAt: new Date().toISOString() });
      await system.workspace.saveTask(task);
      system.events.publish({ type: "task", clientId: body.clientId, status: "archived", taskId: task.id, message: task.goal });
    }
    return { task };
  });

  app.post("/api/messages", async (request, reply) => {
    const body = z.object({ clientId: z.string().optional(), conversationId: z.string().trim().min(1).max(120).default("primary"), sessionId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), goalId: z.string().uuid().optional(), taskId: z.string().uuid().optional(), message: z.string().trim().min(1).max(20_000), locale: z.enum(["zh-CN", "en"]).default("zh-CN") }).parse(request.body);
    const clients = await system.workspace.listClients();
    let clientId = body.clientId ?? clients[0]?.id;
    if (!clientId) return reply.code(409).send({ error: "workspace is not available" });
    // A project-bound message rides the project's durable Session: the kernel
    // project is validated against the client first, then the bound session is
    // resolved (or lazily created) and the execution context is threaded into
    // the agent turn.
    let project: KernelProject | undefined;
    if (body.projectId) {
      project = await system.kernel.getProject(body.projectId);
      if (!project) return reply.code(404).send({ error: `project not found: ${body.projectId}`, code: "PROJECT_NOT_FOUND" });
      if (body.clientId && project.workspaceId !== body.clientId) {
        return reply.code(400).send({ error: `project ${body.projectId} belongs to client ${project.workspaceId}`, code: "PROJECT_CLIENT_MISMATCH" });
      }
      clientId = project.workspaceId;
    }
    // An explicit product Session wins over the legacy conversationId: the
    // session owns the client and its runtimeConversationId becomes the
    // durable Pi/conversation key. A legacy conversation keeps working and is
    // imported into a Session on first sight (see below).
    let session: ProductSessionEntity | undefined;
    if (project) {
      if (body.sessionId) {
        session = await system.sessions.get(body.sessionId);
        if (!session) return reply.code(404).send({ error: `session not found: ${body.sessionId}`, code: "SESSION_NOT_FOUND" });
        if (session.projectId !== project.id) {
          return reply.code(409).send({ error: `session ${body.sessionId} is not bound to project ${project.id}`, code: "SESSION_PROJECT_MISMATCH" });
        }
        clientId = session.clientId;
      } else {
        session = (await ensureProjectSession(system, { workspaceId: project.workspaceId, projectId: project.id, title: project.name })).session;
      }
    } else if (body.sessionId) {
      session = await system.sessions.get(body.sessionId);
      if (!session) return reply.code(404).send({ error: `session not found: ${body.sessionId}`, code: "SESSION_NOT_FOUND" });
      if (body.clientId && session.clientId !== body.clientId) {
        return reply.code(400).send({ error: `session ${body.sessionId} belongs to client ${session.clientId}`, code: "SESSION_CLIENT_MISMATCH" });
      }
      clientId = session.clientId;
    } else {
      // Legacy compatibility: a previously imported conversation resolves to
      // its product Session through the persisted mapping, so follow-up
      // messages bind the session immediately.
      const mapping = await system.sessions.repository.findLegacyMapping(clientId, body.conversationId);
      if (mapping) session = await system.sessions.get(mapping.sessionId);
    }
    const conversationId = session ? session.runtimeConversationId : body.conversationId;
    const existing = (await system.workspace.readJsonl(clientId, "conversation.jsonl", ConversationMessage)).filter((message) => message.conversationId === conversationId);
    const userMessage = ConversationMessage.parse({ id: crypto.randomUUID(), clientId, conversationId, ...(session ? { sessionId: session.id } : {}), role: "user", content: body.message, at: new Date().toISOString() });
    await system.workspace.appendJsonl(clientId, "conversation.jsonl", userMessage);
    if (!session && !body.sessionId) {
      // First sight of a legacy conversation: import not-yet-migrated
      // conversations (including this one) through the idempotent migration.
      // Legacy data itself is never rewritten.
      await system.sessions.migrateLegacy(system.workspace);
      const mapping = await system.sessions.repository.findLegacyMapping(clientId, conversationId);
      if (mapping) session = await system.sessions.get(mapping.sessionId);
    }
    const modelOverride = session ? sessionModelOverride(session.modelBinding) : undefined;
    const setSessionStatus = async (status: "running" | "completed" | "failed") => {
      if (!session) return;
      session = await system.sessions.setStatus(session.id, status);
      publishSession(system, session, status);
    };
    const slash = parseSlashCommand(body.message);
    const directAnswer = async (markdown: string, commandName: string) => {
      const systemMessage = ConversationMessage.parse({ id: crypto.randomUUID(), clientId, conversationId, ...(session ? { sessionId: session.id } : {}), role: "system", content: markdown, status: "complete", at: new Date().toISOString() });
      await system.workspace.appendJsonl(clientId, "conversation.jsonl", systemMessage);
      if (session && isUntitledSession(session.title)) {
        const renamed = await system.sessions.rename(session.id, sessionTitleFromMessage(body.message)).catch(() => undefined);
        if (renamed) {
          session = renamed;
          publishSession(system, session, "renamed");
        }
      }
      system.events.publish({ type: "task", clientId, status: "completed", message: markdown });
      reply.code(201);
      return { message: systemMessage, task: null, command: commandName, ...(session ? { session } : {}) };
    };
    // Shared tail of this route: publish + model call + persistence, so
    // built-in and user-template expansions take the identical path.
    const runConversation = async (prompt: string) => {
      system.events.publish({ type: "task", clientId, status: "running", message: body.message });
      await setSessionStatus("running");
      try {
        const response = await system.agent.respond(clientId, prompt, { conversationId, interfaceLocale: body.locale, userMessageId: userMessage.id, ...(session ? { sessionId: session.id } : {}), ...(modelOverride ? { modelOverride } : {}), ...(project ? { executionContext: { projectId: project.id, ...(body.goalId ? { goalId: body.goalId } : {}), ...(body.taskId ? { taskId: body.taskId } : {}), rootPaths: project.rootPaths, enabledCapabilityPacks: project.enabledCapabilityPacks } } : {}), recentConversation: existing.slice(-12).map((item) => sanitizeLegacyConversationError(item, body.locale)).map(({ role, content }) => ({ role, content })) });
        const assistantMessage = ConversationMessage.parse({ id: crypto.randomUUID(), clientId, conversationId, ...(session ? { sessionId: session.id } : {}), role: "assistant", content: response.reply, ...(response.task ? { taskId: response.task.id } : {}), at: new Date().toISOString() });
        await system.workspace.appendJsonl(clientId, "conversation.jsonl", assistantMessage);
        if (session) {
          if (isUntitledSession(session.title)) {
            // Name the session from its first real exchange instead of leaving a
            // bare "New session" or raw UUID in the list forever.
            const renamed = await system.sessions.rename(session.id, sessionTitleFromMessage(body.message)).catch(() => undefined);
            if (renamed) session = renamed;
          }
          const sessionId = session.id;
          const previewed = await system.sessions.setPreview(sessionId, response.reply).catch(() => undefined);
          if (previewed) session = previewed;
        }
        await setSessionStatus("completed");
        system.events.publish({ type: "task", clientId, status: response.task?.phase ?? "completed", ...(response.task ? { taskId: response.task.id } : {}), message: response.reply });
        reply.code(201); return { message: assistantMessage, task: response.task, ...(session ? { session } : {}), ...(project ? { projectId: project.id } : {}) };
      } catch (error) {
        await setSessionStatus("failed").catch(() => undefined);
        const incidentId = crypto.randomUUID();
        const detail = error instanceof Error ? error.message : String(error);
        const content = conversationErrorMessage(body.locale, detail, incidentId);
        await system.workspace.appendJsonl(clientId, "diagnostics/errors.jsonl", {
          id: incidentId, at: new Date().toISOString(), route: "/api/messages",
          error: { name: error instanceof Error ? error.name : "Error", message: detail }
        });
        await system.workspace.appendJsonl(clientId, "conversation.jsonl", ConversationMessage.parse({ id: crypto.randomUUID(), clientId, conversationId, ...(session ? { sessionId: session.id } : {}), role: "system", content, status: "error", at: new Date().toISOString() }));
        system.events.publish({ type: "error", clientId, message: content, retryable: true });
        return reply.code(502).send({ error: content, incidentId });
      }
    };
    if (slash && !slash.ok) {
      // A name the built-in parser rejects may still be a user prompt
      // template; templates lose every conflict with a built-in command
      // because the built-ins bind typed, audited pipelines.
      const invocation = slash.error.code === "unknown_command" ? splitSlashInput(body.message) : null;
      const template = invocation ? await system.promptTemplates.find(invocation.name) : undefined;
      if (invocation && template) {
        const expanded = await system.promptTemplates.expand(invocation.name, invocation.argument);
        if (expanded) return runConversation(expandUserSlashCommand(template.name, expanded, body.locale));
      }
      return directAnswer(renderSlashParseError(slash.error, body.locale), "error");
    }
    const slashCommand = slash?.command;
    if (slashCommand && isDirectSlashCommand(slashCommand)) {
      const markdown = slashCommand.name === "approvals"
        ? renderApprovalsHistory(await system.approvals.list(clientId), body.locale)
        : slashCommand.name === "skills"
          ? renderSkillsCatalog(system.skills.list(), await system.knowledge.list(), body.locale)
          : renderSlashHelp(body.locale, await system.promptTemplates.list());
      return directAnswer(markdown, slashCommand.name);
    }
    // Slash investigation commands (/report, /audit) travel the normal
    // pipeline with an explicit advisory expansion; plain chat passes through.
    const prompt = slashCommand ? expandSlashCommand(slashCommand, body.locale) : body.message;
    return runConversation(prompt);
  });

  app.post("/api/computer/pause", async (request, reply) => {
    const computer = system.computer;
    if (!computer) return reply.code(409).send(computerUnavailableResponse());
    const authority = await validateComputerControlBinding(system, ComputerControlRequest.parse(request.body ?? {}), "emergency");
    computer.pause(authority.computerSessionId, authority.computerRevision);
    desktopFrames.clear();
    return computerControlResponse(computer, authority.computerSessionId);
  });
  app.post("/api/computer/takeover", async (request, reply) => {
    const computer = system.computer;
    if (!computer) return reply.code(409).send(computerUnavailableResponse());
    const authority = await validateComputerControlBinding(system, ComputerControlRequest.parse(request.body ?? {}), "emergency");
    computer.takeover(authority.computerSessionId, authority.computerRevision);
    desktopFrames.clear();
    return computerControlResponse(computer, authority.computerSessionId);
  });
  app.post("/api/computer/resume", async (request, reply) => {
    const computer = system.computer;
    if (!computer) return reply.code(409).send(computerUnavailableResponse());
    const authority = await validateComputerControlBinding(system, ComputerControlRequest.parse(request.body ?? {}), "interactive");
    computer.resume(authority.computerSessionId, authority.computerRevision);
    desktopFrames.clear();
    return computerControlResponse(computer, authority.computerSessionId);
  });
  app.post("/api/computer/return-control", async (request, reply) => {
    const computer = system.computer;
    if (!computer) return reply.code(409).send(computerUnavailableResponse());
    const authority = await validateComputerControlBinding(system, ComputerControlRequest.parse(request.body ?? {}), "interactive");
    computer.returnControl(authority.computerSessionId, authority.computerRevision);
    desktopFrames.clear();
    return computerControlResponse(computer, authority.computerSessionId);
  });
  app.post("/api/computer/stop", async (request, reply) => {
    const computer = system.computer;
    if (!computer) return reply.code(409).send(computerUnavailableResponse());
    const authority = await validateComputerControlBinding(system, ComputerControlRequest.parse(request.body ?? {}), "emergency");
    computer.stop(authority.computerSessionId, authority.computerRevision);
    desktopFrames.clear();
    return computerControlResponse(computer, authority.computerSessionId);
  });
  app.post("/api/computer/step", async (request, reply) => {
    const computer = system.computer;
    if (!computer) return reply.code(409).send(computerUnavailableResponse());
    const authority = await validateComputerControlBinding(system, ComputerControlRequest.parse(request.body ?? {}), "interactive");
    return reply.code(409).send({
      error: "no queued atomic Computer Use action is available for single-step execution",
      code: "COMPUTER_STEP_UNAVAILABLE",
      ...computerControlResponse(computer, authority.computerSessionId)
    });
  });

  const startManagedBrowser = async (bodyInput: unknown) => {
    const requested = BrowserSessionStartRequest.parse(bodyInput);
    const body = await resolveBrowserStartRequest(system, requested);
    const session = await system.browserSessions.start(StartBrowserSessionInput.parse(body));
    await system.agent.sharedFacts.invalidateVisualEvidence(body.clientId, { reason: "managed browser session was replaced" });
    return { session: publicBrowserSession(session), computerUse: await computerUseState(system, body.clientId, false) };
  };
  const resumeManagedBrowser = async (bodyInput: unknown) => {
    const body = BrowserSessionLookup.parse(bodyInput);
    await system.workspace.readClient(body.clientId);
    const session = await system.browserSessions.resume(body.clientId, body.browserProfile);
    await system.agent.sharedFacts.invalidateVisualEvidence(body.clientId, { reason: "managed browser session was resumed and requires fresh evidence" });
    return { session: publicBrowserSession(session), computerUse: await computerUseState(system, body.clientId, false) };
  };
  const closeManagedBrowser = async (bodyInput: unknown) => {
    const body = BrowserSessionLookup.parse(bodyInput);
    await system.workspace.readClient(body.clientId);
    const session = await system.browserSessions.close(body.clientId, body.browserProfile);
    await system.agent.sharedFacts.invalidateVisualEvidence(body.clientId, { reason: "managed browser session was closed" });
    return { session: publicBrowserSession(session), computerUse: await computerUseState(system, body.clientId, false) };
  };

  app.get("/api/browser-session", async (request) => {
    const query = BrowserSessionLookup.parse(request.query);
    return browserSessionView(system, query.clientId, query.browserProfile);
  });

  app.post("/api/browser-session/start", async (request, reply) => {
    const result = await startManagedBrowser(request.body);
    reply.code(201);
    return result;
  });

  app.post("/api/browser-session/resume", async (request) => resumeManagedBrowser(request.body));
  app.post("/api/browser-session/close", async (request) => closeManagedBrowser(request.body));

  app.post("/api/browser-sessions/start", async (request, reply) => {
    const result = await startManagedBrowser(request.body);
    reply.code(201);
    return result;
  });

  app.get("/api/browser-sessions/status", async (request) => {
    const query = BrowserSessionLookup.parse(request.query);
    await system.workspace.readClient(query.clientId);
    return computerUseState(system, query.clientId, true, query.browserProfile);
  });

  app.post("/api/browser-sessions/resume", async (request) => resumeManagedBrowser(request.body));
  app.post("/api/browser-sessions/close", async (request) => closeManagedBrowser(request.body));

  app.get("/api/privacy/screenshot-audits", async (request) => {
    const query = z.object({ clientId: z.string().min(1), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    await system.workspace.readClient(query.clientId);
    const records = await system.screenshotAudits.list(query.clientId);
    return { total: records.length, audits: records.slice(-query.limit) };
  });

  registerKernelRoutes(app, system);
  registerWorkflowRoutes(app, system);
  const terminalService = new TerminalService();
  app.addHook("onClose", async () => terminalService.shutdown());
  registerTerminalRoutes(app, terminalService);
  registerGitRoutes(app, system);
  registerFsRoutes(app, system);
  registerAdsRoutes(app, system);
  const automationScheduler = registerAutomationRoutes(app, system);

  // One agent runtime drives every capability: the shared terminal sessions
  // and automation scheduler are the same instances the REST boundary uses,
  // so the UI watches agent-driven work live.
  const workflowDefinitionStore = new FileWorkflowStore(system.workspace.root);
  system.agent.setAgentTools({
    registry: buildAgentToolRegistry(),
    deps: {
      kernel: system.kernel,
      git: {
        repository: (root) => new GitRepository(root),
        worktrees: (root) => new WorktreeManager(root),
        checkpoints: (root) => new CheckpointStore(join(root, ".adpilot", "checkpoints"))
      },
      terminal: terminalService,
      artifacts: system.artifacts,
      ads: {
        decisions: new DecisionService(
          new FileAdvertisingDecisionStore(system.workspace.root),
          async (projectId) => (await system.kernel.getProject(projectId)) !== undefined
        ),
        brief: new DailyBriefService(),
        uac: new PythonUacEngine(),
        stores: {
          accounts: new FileAdAccountStore(system.workspace.root),
          campaigns: new FileCampaignStore(system.workspace.root),
          creatives: new FileCreativeAssetStore(system.workspace.root)
        }
      },
      automations: automationScheduler,
      workflows: {
        store: workflowDefinitionStore,
        runner: new WorkflowRunner({
          workflows: workflowDefinitionStore,
          runs: new FileWorkflowRunStore(system.workspace.root),
          executor: system.workflowExecutor
        })
      },
      computer: { host: system.nativeComputerHost },
      audit: async (clientId, action, details) => {
        const event = await system.audit.append({ clientId, actor: "adpilot_agent", action, status: "succeeded", details });
        return event.id;
      },
      now: () => new Date()
    }
  });
  const automationTickMs = options.automationTickMs ?? 30_000;
  if (automationTickMs > 0) {
    const automationTimer = setInterval(() => {
      void automationScheduler.tick().catch(() => undefined);
    }, automationTickMs);
    automationTimer.unref();
    app.addHook("onClose", async () => clearInterval(automationTimer));
  }

  app.post("/api/approvals", async (request, reply) => {
    const body = z.object({
      clientId: z.string().min(1),
      taskId: z.string().uuid(),
      operation: ApprovalOperation,
      executionPlan: VisualApprovalPlanInput.optional(),
      guardrailEvidence: ApprovalGuardrailEvidenceInput.optional()
    }).superRefine((value, context) => {
      if ((value.operation.riskLevel === "mutate" || value.operation.riskLevel === "destructive") && !value.executionPlan) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["executionPlan"], message: "a complete visual approval plan is required for mutations" });
      }
      if ((value.operation.riskLevel === "mutate" || value.operation.riskLevel === "destructive") && !value.guardrailEvidence) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["guardrailEvidence"], message: "verified deterministic guardrail evidence is required for mutations" });
      }
    }).parse(request.body);
    const approval = await system.tools.createApproval(
      { clientId: body.clientId, taskId: body.taskId, actor: "adpilot_agent", permission: "OBSERVE" },
      body.operation,
      body.executionPlan,
      body.guardrailEvidence
    );
    system.events.publish({ type: "approval", clientId: body.clientId, approvalId: approval.id, status: approval.status });
    reply.code(201); return approval;
  });

  app.post("/api/approvals/:id/risk-review", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ clientId: z.string() }).parse(request.body);
    const approval = await system.tools.validateApprovalGuardrail(body.clientId, params.id, true);
    const [audit, screenshotDisclosures] = await Promise.all([
      system.audit.list(body.clientId),
      system.screenshotAudits.list(body.clientId)
    ]);
    const screenshotHashes = new Set(audit.flatMap((event) => {
      if (event.action !== "execute_visual_task" || event.status !== "succeeded") return [];
      return [event.details.beforeHash, event.details.afterHash].filter((value): value is string => typeof value === "string");
    }));
    for (const disclosure of screenshotDisclosures) {
      screenshotHashes.add(disclosure.screenshotId);
      screenshotHashes.add(disclosure.screenshotSha256);
    }
    const result = await system.specialists.dispatch("risk_reviewer", {
      context: { clientId: body.clientId, taskId: approval.taskId, actor: "adpilot_agent", permission: "OBSERVE" },
      input: {
        approvalId: params.id,
        guardrailAllowed: Boolean(approval.guardrail?.decision.allowed && !approval.guardrail.decision.requiresFreshReview),
        guardrailReasons: approval.guardrail?.decision.reasons ?? ["deterministic guardrail binding is missing"],
        evidenceCount: approval.operation.evidence.length,
        hasBeforeScreenshot: approval.operation.evidence.some((item) => item.startsWith("screenshot:") && screenshotHashes.has(item.slice("screenshot:".length))),
        executionPlanPresent: approval.executionPlan !== null,
        singleVariable: approval.guardrail?.singleVariable ?? false, rollbackDefined: Boolean(approval.operation.rollbackCondition),
        operationSummary: `${approval.operation.operation} ${approval.operation.campaign}`
      },
      sharedFacts: []
    });
    system.events.publish({ type: "approval", clientId: body.clientId, approvalId: params.id, status: (result as { approved: boolean }).approved ? "pending_user" : "rejected" });
    return result;
  });

  app.post("/api/approvals/:id/approve", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ clientId: z.string(), approvedBy: z.string().min(1) }).parse(request.body);
    await system.tools.validateApprovalGuardrail(body.clientId, params.id, true);
    const { approval, token } = await system.approvals.approveByUser(body.clientId, params.id, body.approvedBy);
    system.approvalTokens.set(params.id, token);
    system.events.publish({ type: "approval", clientId: body.clientId, approvalId: params.id, status: approval.status });
    return { approval, tokenStored: true };
  });

  app.post("/api/approvals/:id/commit", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ clientId: z.string() }).parse(request.body);
    const approval = await system.approvals.get(body.clientId, params.id);
    if (!approval.executionPlan) throw new Error("approved operation has no visual execution plan");
    if (approval.operation.riskLevel !== "mutate" && approval.operation.riskLevel !== "destructive") throw new Error("commit endpoint only accepts mutations");
    const token = system.approvalTokens.get(params.id); if (!token) throw new Error("approval token is absent or already consumed");
    system.approvalTokens.delete(params.id);
    const client = await system.workspace.readClient(body.clientId);
    const permission = approval.operation.riskLevel === "destructive" ? "DESTRUCTIVE" as const : "MUTATE" as const;
    const visualTask = visualTaskFromExecutionPlan(approval.executionPlan, client.kpi.currency, permission);
    const result = await system.tools.commitApprovedVisualAction({ clientId: body.clientId, taskId: approval.taskId, actor: "account_operator", permission: visualTask.permission }, params.id, token, approval.operation, visualTask);
    system.events.publish({ type: "approval", clientId: body.clientId, approvalId: params.id, status: result.status === "done" ? "executed" : "failed" });
    return result;
  });

  app.post("/api/clients/:id/conversations/:cid/fork", async (request, reply) => {
    const params = z.object({ id: z.string().min(1), cid: z.string().trim().min(1).max(120) }).parse(request.params);
    const body = z.object({ atMessageId: z.string().uuid(), actor: z.string().trim().min(1).max(120).default("workspace-owner") }).parse(request.body);
    await system.workspace.readClient(params.id);
    try {
      const result = await system.runtime.forkConversation(params.id, params.cid, body.atMessageId, { actor: body.actor });
      system.events.publish({ type: "conversation", clientId: params.id, conversationId: result.conversationId, status: "forked", forkedFrom: params.cid });
      reply.code(201);
      return result;
    } catch (error) {
      if (error instanceof SessionError) {
        const statusCode = error.code === "not_found" ? 404 : 409;
        return reply.code(statusCode).send({ error: error.message, code: error.code === "not_found" ? "FORK_TARGET_NOT_FOUND" : "FORK_TARGET_UNAVAILABLE" });
      }
      throw error;
    }
  });

  /* ------------------------- product Session authority ------------------------- */

  /** Loads a session and hides cross-client ids behind the same 404. */
  const requireClientSession = async (clientId: string, sessionId: string, options: { includeDeleted?: boolean } = {}) => {
    const session = await system.sessions.require(sessionId, options);
    if (session.clientId !== clientId) throw new SessionNotFoundError(sessionId);
    return session;
  };
  const auditSession = async (session: ProductSessionEntity, actor: string, action: string, details: Record<string, unknown> = {}) => {
    await system.audit.append({
      clientId: session.clientId,
      sessionId: session.id,
      actor,
      action,
      status: "succeeded",
      details: { runtimeConversationId: session.runtimeConversationId, ...details }
    });
  };

  app.get("/api/clients/:id/sessions", async (request) => {
    const params = SessionClientParams.parse(request.params);
    const query = SessionListQuery.parse(request.query);
    await system.workspace.readClient(params.id);
    const statuses = query.status
      ?.split(",")
      .map((value) => SessionStatus.parse(value.trim()));
    const filter: SessionFilter = {
      clientId: params.id,
      ...(query.pinned !== undefined ? { pinned: query.pinned === "true" } : {}),
      ...(query.archived !== undefined ? { archived: query.archived === "true" } : {}),
      ...(statuses && statuses.length > 0 ? { statuses } : {}),
      ...(query.deleted === "true" ? { deleted: true } : {})
    };
    const sessions = query.q
      ? await system.sessions.search(query.q, filter)
      : await system.sessions.list(filter);
    return { sessions };
  });

  app.post("/api/clients/:id/sessions", async (request, reply) => {
    const params = SessionClientParams.parse(request.params);
    const body = SessionCreateBody.parse(request.body);
    await system.workspace.readClient(params.id);
    const session = await system.sessions.create({
      clientId: params.id,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      ...(body.agentProfileId !== undefined ? { agentProfileId: body.agentProfileId } : {}),
      ...(body.advertisingWorkspaceId !== undefined ? { advertisingWorkspaceId: body.advertisingWorkspaceId } : {}),
      ...(body.platforms !== undefined ? { platforms: body.platforms } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.modelBinding !== undefined ? { modelBinding: body.modelBinding } : {}),
      ...(body.permissionProfile !== undefined ? { permissionProfile: body.permissionProfile } : {})
    });
    await auditSession(session, body.actor, "session_create", { title: session.title });
    publishSession(system, session, "created");
    reply.code(201);
    return session;
  });

  app.get("/api/clients/:id/sessions/:sid", async (request, reply) => {
    const params = SessionParams.parse(request.params);
    const query = z.object({ deleted: z.enum(["true"]).optional() }).parse(request.query);
    await system.workspace.readClient(params.id);
    const session = await system.sessions.get(params.sid, { includeDeleted: query.deleted === "true" });
    if (!session || session.clientId !== params.id) {
      return reply.code(404).send({ error: `session not found: ${params.sid}`, code: "SESSION_NOT_FOUND" });
    }
    return session;
  });

  app.patch("/api/clients/:id/sessions/:sid", async (request) => {
    const params = SessionParams.parse(request.params);
    const body = SessionPatchBody.parse(request.body);
    await system.workspace.readClient(params.id);
    await requireClientSession(params.id, params.sid);
    let session: ProductSessionEntity | undefined;
    let revision = body.revision;
    if (body.title !== undefined) {
      session = await system.sessions.rename(params.sid, body.title, revision);
      revision = session.revision;
    }
    if (body.pinned !== undefined) {
      session = body.pinned
        ? await system.sessions.pin(params.sid, revision)
        : await system.sessions.unpin(params.sid, revision);
    }
    if (!session) throw new Error("session patch produced no mutation");
    await auditSession(session, body.actor, "session_update", {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      revision: session.revision
    });
    publishSession(system, session, "updated");
    return session;
  });

  app.put("/api/clients/:id/sessions/:sid/computer-use", async (request) => {
    const params = SessionParams.parse(request.params);
    const body = SessionComputerUseBody.parse(request.body);
    const client = await system.workspace.readClient(params.id);
    const current = await requireClientSession(params.id, params.sid);
    if (body.revision !== current.revision) {
      throw new RevisionConflictError(current.id, body.revision, current.revision);
    }
    await system.browserSessions.recover();
    const managedProfiles = new Set([
      ...(client.accounts?.accounts ?? []).map((account) => account.browserProfile),
      ...(await system.browserSessions.list())
        .filter((session) => session.clientId === params.id)
        .map((session) => session.browserProfile)
    ]);
    if (!managedProfiles.has(body.browserProfile)) {
      throw new DesktopNativeBindingError("the selected browser Profile is not an existing managed browser Profile");
    }
    const requestedProfile = SessionPermissionProfile.parse({
      ...current.permissionProfile,
      level: body.computerUse === "execute"
        ? "EXECUTE"
        : body.computerUse === "interactive"
          ? "PREPARE"
          : "OBSERVE",
      browserProfile: body.browserProfile,
      computerUse: body.computerUse,
      // Mutation approval is never disabled by this UI. Preserve stricter
      // legacy profiles and force it on for execute.
      approvalRequired: body.computerUse === "execute"
        ? true
        : current.permissionProfile.approvalRequired
    });
    const escalation = isComputerPermissionEscalation(current.permissionProfile, requestedProfile);
    const actor = "workspace-owner";
    const approval = escalation
      ? await system.audit.append({
          clientId: params.id,
          sessionId: current.id,
          actor,
          action: "session_permission_escalation_reviewed",
          status: "succeeded",
          details: {
            expectedRevision: body.revision,
            requestedProfile
          }
        })
      : undefined;
    const session = await system.sessions.setPermissionProfile(
      current.id,
      requestedProfile,
      body.revision,
      approval
        ? {
            approvalId: approval.id,
            approvedBy: actor,
            approvedAt: approval.at
          }
        : undefined
    );
    await auditSession(session, actor, "session_permission_profile_update", {
      previousComputerUse: current.permissionProfile.computerUse,
      computerUse: session.permissionProfile.computerUse,
      browserProfile: session.permissionProfile.browserProfile,
      escalated: escalation,
      revision: session.revision
    });
    publishSession(system, session, "permission_updated");
    return session;
  });

  const sessionStatusMutation = (
    action: "archive" | "unarchive" | "restore",
    mutate: (sessionId: string, revision?: number) => Promise<ProductSessionEntity>
  ) => async (request: import("fastify").FastifyRequest) => {
    const params = SessionParams.parse(request.params);
    const body = SessionMutationBody.parse(request.body ?? {});
    await system.workspace.readClient(params.id);
    await requireClientSession(params.id, params.sid, { includeDeleted: true });
    const session = await mutate(params.sid, body.revision);
    await auditSession(session, body.actor, `session_${action}`, { revision: session.revision });
    publishSession(system, session, `${action}d`);
    return session;
  };
  app.post("/api/clients/:id/sessions/:sid/archive", sessionStatusMutation("archive", (sid, revision) => system.sessions.archive(sid, revision)));
  app.post("/api/clients/:id/sessions/:sid/unarchive", sessionStatusMutation("unarchive", (sid, revision) => system.sessions.unarchive(sid, revision)));
  app.post("/api/clients/:id/sessions/:sid/restore", sessionStatusMutation("restore", (sid, revision) => system.sessions.restore(sid, revision)));

  app.delete("/api/clients/:id/sessions/:sid", async (request) => {
    const params = SessionParams.parse(request.params);
    const query = SessionDeleteQuery.parse(request.query);
    await system.workspace.readClient(params.id);
    await requireClientSession(params.id, params.sid, { includeDeleted: true });
    const session = await system.sessions.softDelete(params.sid, query.revision);
    await auditSession(session, "workspace-owner", "session_delete", { revision: session.revision });
    publishSession(system, session, "deleted");
    return session;
  });

  app.post("/api/clients/:id/sessions/:sid/duplicate", async (request, reply) => {
    const params = SessionParams.parse(request.params);
    const body = SessionDuplicateBody.parse(request.body ?? {});
    await system.workspace.readClient(params.id);
    const source = await requireClientSession(params.id, params.sid);
    const copy = await system.sessions.duplicate(params.sid, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {})
    });
    try {
      // Empty sessions have no persisted Pi history yet; there is nothing to copy.
      const hasHistory = await system.workspace.readText(params.id, `sessions/${resolvePiSessionId(params.id, source.runtimeConversationId)}.jsonl`);
      if (hasHistory) {
        await system.runtime.duplicateConversationInto(params.id, source.runtimeConversationId, copy.runtimeConversationId, { actor: body.actor });
      }
    } catch (error) {
      await rollbackCreatedSession(system, copy.id);
      throw error;
    }
    await auditSession(copy, body.actor, "session_duplicate", { sourceSessionId: source.id });
    publishSession(system, copy, "duplicated");
    reply.code(201);
    return copy;
  });

  app.post("/api/clients/:id/sessions/:sid/branch", async (request, reply) => {
    const params = SessionParams.parse(request.params);
    const body = SessionBranchBody.parse(request.body ?? {});
    await system.workspace.readClient(params.id);
    const source = await requireClientSession(params.id, params.sid);
    const branch = await system.sessions.branch(params.sid, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      sourceMessageId: body.atMessageId
    });
    try {
      await system.runtime.forkConversationInto(params.id, source.runtimeConversationId, body.atMessageId, branch.runtimeConversationId, { actor: body.actor });
    } catch (error) {
      await rollbackCreatedSession(system, branch.id);
      if (error instanceof SessionError) {
        const statusCode = error.code === "not_found" ? 404 : 409;
        return reply.code(statusCode).send({ error: error.message, code: error.code === "not_found" ? "FORK_TARGET_NOT_FOUND" : "FORK_TARGET_UNAVAILABLE" });
      }
      throw error;
    }
    await auditSession(branch, body.actor, "session_branch", { parentSessionId: source.id, sourceMessageId: body.atMessageId });
    publishSession(system, branch, "branched");
    reply.code(201);
    return branch;
  });

  const planModeParams = z.object({ id: z.string().min(1), cid: z.string().trim().min(1).max(120) });

  app.get("/api/clients/:id/conversations/:cid/plan-mode", async (request) => {
    const params = planModeParams.parse(request.params);
    await system.workspace.readClient(params.id);
    const state = await system.planMode.get(params.id, params.cid);
    return { clientId: params.id, conversationId: params.cid, ...state };
  });

  app.post("/api/clients/:id/conversations/:cid/plan-mode", async (request) => {
    const params = planModeParams.parse(request.params);
    const body = z.object({ enabled: z.boolean(), actor: z.string().trim().min(1).max(120).default("workspace-owner") }).parse(request.body);
    await system.workspace.readClient(params.id);
    const state = await system.planMode.set(params.id, params.cid, body.enabled, body.actor);
    system.events.publish({ type: "conversation", clientId: params.id, conversationId: params.cid, status: body.enabled ? "plan_mode_enabled" : "plan_mode_disabled" });
    return { clientId: params.id, conversationId: params.cid, ...state };
  });

  app.get("/api/clients/:id/autonomy", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    await system.workspace.readClient(params.id);
    const state = await system.autonomy.get(params.id);
    return { clientId: params.id, ...state };
  });

  app.put("/api/clients/:id/autonomy", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ mode: z.enum(["guarded", "full_access"]), actor: z.string().trim().min(1).max(120).default("workspace-owner") }).parse(request.body);
    await system.workspace.readClient(params.id);
    const state = await system.autonomy.set(params.id, body.mode, body.actor);
    system.events.publish({ type: "task", clientId: params.id, status: body.mode === "full_access" ? "autonomy_full_access" : "autonomy_guarded", message: `Autonomy mode: ${body.mode}` });
    return { clientId: params.id, ...state };
  });

  app.post("/api/clients/:id/alerts", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = MonitoringAlertInput.parse(request.body);
    await system.workspace.readClient(params.id);
    const alert = MonitoringAlert.parse({
      ...body,
      alertId: crypto.randomUUID(),
      clientId: params.id,
      createdAt: new Date().toISOString()
    });
    const result = await system.alerts.submit(alert);
    reply.code(201);
    return result;
  });

  app.get("/api/clients/:id/alerts/pending", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    await system.workspace.readClient(params.id);
    return { clientId: params.id, pending: await system.alerts.pending(params.id) };
  });

  /* ------------------------- curated plugin subsystem ------------------------- */

  const pluginMutation = (
    action: (pluginId: string, body: z.infer<typeof PluginMutationBody>) => Promise<unknown>,
    created = false
  ) => async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const params = PluginParams.parse(request.params);
    const body = PluginMutationBody.parse(request.body ?? {});
    if (body.clientId) await system.workspace.readClient(body.clientId);
    await system.plugins.flushStartup();
    const result = await action(params.pid, body);
    if (created) reply.code(201);
    return result;
  };

  app.get("/api/plugins", async () => {
    await system.plugins.flushStartup();
    return system.plugins.catalog();
  });

  app.get("/api/plugins/:pid", async (request) => {
    const params = PluginParams.parse(request.params);
    const query = z.object({ version: z.string().optional() }).parse(request.query);
    await system.plugins.flushStartup();
    return system.plugins.details(params.pid, query.version);
  });

  app.post("/api/plugins/:pid/install", pluginMutation((pid, body) => system.plugins.install(pid, body), true));
  app.post("/api/plugins/:pid/uninstall", pluginMutation((pid, body) => system.plugins.uninstall(pid, body)));
  app.post("/api/plugins/:pid/disable", pluginMutation((pid, body) => system.plugins.disable(pid, body)));
  app.post("/api/plugins/:pid/enable", pluginMutation((pid, body) => system.plugins.enable(pid, body)));
  app.post("/api/plugins/:pid/update", pluginMutation((pid, body) => system.plugins.update(pid, body)));

  app.setErrorHandler((error, _request, reply) => {
    const sessionError = sessionErrorResponse(error);
    if (sessionError) return reply.code(sessionError.status).send(sessionError.body);
    const pluginError = pluginErrorResponse(error);
    if (pluginError) return reply.code(pluginError.status).send(pluginError.body);
    const code = errorCode(error);
    reply.status(
      code === "BROWSER_SESSION_LOST"
        || code === "DESKTOP_NATIVE_BINDING_MISMATCH"
        || code === "COMPUTER_CONTROL_REVISION_CONFLICT"
        || code === "COMPUTER_SESSION_NOT_FOUND"
        || code === "TASK_CYCLE"
        || code === "CHECKPOINT_DIVERGED"
        || code === "DIRTY_WORKTREE"
        ? 409
        : code === "PRIVACY_MODE_REMOTE_PROVIDER_BLOCKED" || code === "DESKTOP_NATIVE_FORBIDDEN"
          ? 403
          : code === "DESKTOP_NATIVE_UNAVAILABLE"
            ? 503
            : code?.endsWith("_NOT_FOUND")
              ? 404
              : 400
    )
      .send({ error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) });
  });

  const uiRoot = options.uiRoot ?? resolve(process.cwd(), "dist", "desktop");
  if (existsSync(uiRoot)) {
    await app.register(fastifyStatic, { root: uiRoot, wildcard: false });
    app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  }
  return app;
}

const UNTITLED_SESSION_PATTERN = /^(?:new session|untitled session|未命名会话|新建会话|新建对话|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}.*)$/i;

function isUntitledSession(title: string): boolean {
  return UNTITLED_SESSION_PATTERN.test(title.trim());
}

function sessionTitleFromMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length > 32 ? `${collapsed.slice(0, 32)}…` : collapsed || "Untitled session";
}

function requireDesktopNative(native: DesktopNativeBridge | undefined): DesktopNativeBridge {
  if (!native) throw new DesktopNativeUnavailableError();
  return native;
}

async function desktopNativeContext(
  system: AdPilotSystem,
  clientId?: string,
  productSessionId?: string,
  browserSessionId?: string
): Promise<DesktopNativeContext> {
  if (!clientId) {
    if (productSessionId || browserSessionId) {
      throw new DesktopNativeBindingError("Product Session or browser session context requires a client");
    }
    return {};
  }
  await system.workspace.readClient(clientId);
  const productSession = productSessionId
    ? await requiredProductSessionBinding(system, clientId, productSessionId)
    : undefined;
  if (browserSessionId && !productSession) {
    throw new DesktopNativeBindingError("browser session context requires the selected Product Session");
  }
  const sessions = await system.browserSessions.list();
  const connected = sessions.filter((candidate) =>
    candidate.clientId === clientId
    && candidate.sessionStatus === "connected"
    && (!productSession
      || (productSession.permissionProfile.browserProfile !== undefined
        && candidate.browserProfile === productSession.permissionProfile.browserProfile))
  );
  const session = browserSessionId
    ? connected.find((candidate) => candidate.sessionId === browserSessionId)
    : connected.length === 1 ? connected[0] : undefined;
  if (browserSessionId && !session) {
    throw new DesktopNativeBindingError("permission context browser session does not match the selected client");
  }
  return {
    clientId,
    ...(productSession ? { productSessionId: productSession.id } : {}),
    ...(session?.processId && session.windowId
      ? { browserSession: desktopBrowserSessionContext(session) }
      : {})
  };
}

async function requiredDesktopLiveContext(
  system: AdPilotSystem,
  clientId: string,
  productSessionId: string,
  browserSessionId: string
): Promise<DesktopNativeContext & { browserSession: NonNullable<DesktopNativeContext["browserSession"]> }> {
  await system.workspace.readClient(clientId);
  await system.browserSessions.recover();
  const sessions = await system.browserSessions.list();
  const session = sessions.find((candidate) => candidate.sessionId === browserSessionId);
  if (!session) throw new DesktopNativeBindingError("the requested browser session does not exist");
  if (session.clientId !== clientId) {
    throw new DesktopNativeBindingError("the requested browser session belongs to another client");
  }
  if (session.sessionStatus !== "connected" || !session.processId || !session.windowId) {
    throw new DesktopNativeBindingError("the requested browser session is not connected");
  }
  await requiredProductSessionBinding(system, clientId, productSessionId, session.browserProfile, "observe");
  return { clientId, productSessionId, browserSession: desktopBrowserSessionContext(session) };
}

async function requiredProductSessionBinding(
  system: AdPilotSystem,
  clientId: string,
  productSessionId: string,
  browserProfile?: string,
  minimumComputerUse?: "observe" | "interactive" | "execute"
): Promise<ProductSessionEntity> {
  let productSession: ProductSessionEntity;
  try {
    productSession = await system.sessions.require(productSessionId);
  } catch {
    throw new DesktopNativeBindingError("the selected Product Session is not active");
  }
  if (productSession.clientId !== clientId) {
    throw new DesktopNativeBindingError("the selected Product Session belongs to another client");
  }
  if (browserProfile !== undefined
    && productSession.permissionProfile.browserProfile !== browserProfile) {
    throw new DesktopNativeBindingError("the browser profile is not bound to the selected Product Session");
  }
  if (minimumComputerUse !== undefined) {
    const ranks = { disabled: 0, observe: 1, interactive: 2, execute: 3 } as const;
    if (ranks[productSession.permissionProfile.computerUse] < ranks[minimumComputerUse]) {
      throw new DesktopNativeBindingError(
        `the selected Product Session does not allow ${minimumComputerUse} Computer Use`
      );
    }
  }
  return productSession;
}

function desktopBrowserSessionContext(session: BrowserSession): NonNullable<DesktopNativeContext["browserSession"]> {
  if (!session.processId || !session.windowId) {
    throw new DesktopNativeBindingError("browser session has no authoritative process and window binding");
  }
  return {
    sessionId: session.sessionId,
    clientId: session.clientId,
    processId: session.processId,
    windowId: session.windowId,
    bundleId: session.browserApplicationId,
    applicationName: session.browserApp,
    browserProfile: session.browserProfile,
    nativeProfileFingerprint: session.nativeProfileFingerprint
  };
}

function assertDesktopFrameBinding(
  frame: z.infer<typeof DesktopLiveFrame>,
  context: DesktopNativeContext & { browserSession: NonNullable<DesktopNativeContext["browserSession"]> }
): void {
  const binding = context.browserSession;
  const mismatches: string[] = [];
  if (frame.clientId !== context.clientId) mismatches.push("client");
  if (frame.browserSessionId !== binding.sessionId) mismatches.push("browser session");
  if (frame.application.pid !== binding.processId) mismatches.push("process");
  if (frame.application.bundleId !== binding.bundleId) mismatches.push("application");
  if (frame.window.id !== binding.windowId) mismatches.push("window");
  if (frame.browser.profile !== binding.browserProfile) mismatches.push("browser profile");
  if (mismatches.length) {
    throw new DesktopNativeBindingError(`native live frame differs from the authoritative ${mismatches.join(", ")} binding`);
  }
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

async function validateComputerControlBinding(
  system: AdPilotSystem,
  input: z.infer<typeof ComputerControlRequest>,
  requiredPermission: "emergency" | "interactive" | "execute"
): Promise<{ computerSessionId?: string; computerRevision?: number }> {
  await system.browserSessions.recover();
  const sessions = await system.browserSessions.list();
  const connected = sessions.filter((session) => session.sessionStatus === "connected");
  const strictRequested = input.clientId !== undefined
    || input.productSessionId !== undefined
    || input.browserSessionId !== undefined
    || input.computerSessionId !== undefined
    || input.computerRevision !== undefined;
  // Legacy test and headless configurations can control a runtime before any
  // native browser exists. Any scoped request, and every request once a real
  // surface is connected, must present the complete optimistic-control tuple.
  if (!strictRequested && !connected.length) return {};
  if (!input.clientId
    || !input.productSessionId
    || !input.browserSessionId
    || !input.computerSessionId
    || input.computerRevision === undefined) {
    throw new DesktopNativeBindingError(
      "Computer control requires Product Session, browser session, Computer Session, and revision bindings"
    );
  }
  const target = sessions.find((session) => session.sessionId === input.browserSessionId);
  if (!target || target.clientId !== input.clientId) {
    throw new DesktopNativeBindingError("Computer control browser session does not match the authoritative binding");
  }
  const computer = system.computer;
  if (!computer) throw new DesktopNativeBindingError("Computer controller is unavailable");
  const snapshot = computer.controlSnapshot(input.computerSessionId);
  if (snapshot.computerSessionId !== input.computerSessionId
    || snapshot.adPilotSessionId !== input.productSessionId
    || snapshot.browserSessionId !== input.browserSessionId) {
    throw new DesktopNativeBindingError("Computer Session does not match the selected Product and browser sessions");
  }
  await requiredProductSessionBinding(
    system,
    input.clientId,
    input.productSessionId,
    target.browserProfile,
    requiredPermission === "emergency" ? undefined : requiredPermission
  );
  return {
    computerSessionId: snapshot.computerSessionId,
    computerRevision: input.computerRevision
  };
}

function computerControlResponse(
  computer: NonNullable<AdPilotSystem["computer"]>,
  selector?: string
) {
  if (!selector) {
    const controlState = computer.controlStatus();
    return {
      status: controlState === "user_control" ? "user_takeover" : computer.executionStatus(),
      executionStatus: computer.executionStatus(),
      controlState
    };
  }
  const snapshot = computer.controlSnapshot(selector);
  return {
    status: snapshot.controlState === "user_control" ? "user_takeover" : snapshot.executionStatus,
    executionStatus: snapshot.executionStatus,
    controlState: snapshot.controlState,
    productSessionId: snapshot.adPilotSessionId,
    browserSessionId: snapshot.browserSessionId,
    computerSessionId: snapshot.computerSessionId,
    computerRevision: snapshot.revision
  };
}

async function computerUseState(
  system: AdPilotSystem,
  clientId?: string,
  refresh = true,
  browserProfile?: string,
  productSessionId?: string,
  computerUsePermission?: ProductSessionEntity["permissionProfile"]["computerUse"]
) {
  if (refresh) await system.browserSessions.recover();
  let sessions = (await system.browserSessions.list())
    .filter((session) => (!clientId || session.clientId === clientId) && (!browserProfile || session.browserProfile === browserProfile));
  const pageCandidate = sessions.filter((session) => session.sessionStatus === "connected");
  if (refresh && clientId && pageCandidate.length === 1) {
    // Status/Live View remains observable when Accessibility is unavailable.
    // The manager records an explicit unavailable page state in production;
    // a stale test/embedding adapter must not turn a read-only status route
    // into a control mutation or a blind fallback URL.
    await system.browserSessions.observePageIdentity(
      clientId,
      pageCandidate[0]!.browserProfile,
      pageCandidate[0]!.platform
    ).catch(() => undefined);
    sessions = (await system.browserSessions.list())
      .filter((session) => session.clientId === clientId && (!browserProfile || session.browserProfile === browserProfile));
  }
  const publicSessions = sessions.map(publicBrowserSession);
  const connected = publicSessions.filter((session) => session.sessionStatus === "connected");
  const currentBrowser = connected.length === 1
    ? connected[0]!
    : connected.length > 1
      ? null
      : publicSessions.length === 1
        ? publicSessions[0]!
        : null;
  const browserStatus = sessions.some((session) => session.sessionStatus === "connected")
    ? "connected"
    : sessions.some((session) => session.sessionStatus === "starting")
      ? "starting"
      : sessions.some((session) => session.sessionStatus === "lost")
        ? "lost"
        : sessions.some((session) => session.sessionStatus === "closed")
          ? "closed"
          : "not_connected";
  const existingControlSnapshot = system.computer && productSessionId && currentBrowser
    ? system.computer.listControlSnapshots().find((snapshot) =>
        snapshot.adPilotSessionId === productSessionId
        && snapshot.browserSessionId === currentBrowser.sessionId
      )
    : undefined;
  const controlSnapshot: VisualComputerControlSnapshot | undefined = existingControlSnapshot
    ?? (system.computer
      && productSessionId
      && currentBrowser?.sessionStatus === "connected"
      && computerUsePermission !== "disabled"
        ? system.computer.ensureControlSession({
            adPilotSessionId: productSessionId,
            browserSessionId: currentBrowser.sessionId
          })
        : undefined);
  return {
    status: system.computer && system.modelStatus.guiConfigured ? "ready" : "not_ready",
    executionStatus: controlSnapshot?.executionStatus
      ?? (productSessionId ? "unavailable" : system.computer?.executionStatus() ?? "unavailable"),
    controlState: controlSnapshot?.controlState
      ?? (productSessionId ? "unavailable" : system.computer?.controlStatus() ?? "unavailable"),
    ...(controlSnapshot ? {
      productSessionId: controlSnapshot.adPilotSessionId,
      computerSessionId: controlSnapshot.computerSessionId,
      computerRevision: controlSnapshot.revision
    } : {}),
    visualExecution: "automatic",
    failureEscalation: system.modelStatus.guiConfigured ? "enabled" : "unavailable",
    currentVisualModel: system.modelStatus.gui,
    route: system.modelStatus.route,
    browserStatus,
    currentBrowser,
    sessions: publicSessions,
    permission: system.modelStatus.permission,
    privacyMode: system.modelStatus.privacyMode
  } as const;
}

function computerUnavailableResponse() {
  return {
    error: "Computer Use is unavailable because no visual runtime is configured",
    code: "COMPUTER_USE_UNAVAILABLE"
  } as const;
}

function isComputerPermissionEscalation(
  current: ProductSessionEntity["permissionProfile"],
  requested: ProductSessionEntity["permissionProfile"]
): boolean {
  const levelRank = { OBSERVE: 0, PREPARE: 1, EXECUTE: 2 } as const;
  const computerUseRank = { disabled: 0, observe: 1, interactive: 2, execute: 3 } as const;
  return levelRank[requested.level] > levelRank[current.level]
    || computerUseRank[requested.computerUse] > computerUseRank[current.computerUse]
    || (current.approvalRequired && !requested.approvalRequired)
    || (requested.browserProfile !== undefined && requested.browserProfile !== current.browserProfile);
}

async function browserSessionView(system: AdPilotSystem, clientId: string, browserProfile?: string) {
  const client = await system.workspace.readClient(clientId);
  const computerUse = await computerUseState(system, clientId, true, browserProfile);
  const profiles = (client.accounts?.accounts ?? []).flatMap((account) => {
    const platform = Platform.safeParse(account.platform);
    return platform.success ? [{ browserProfile: account.browserProfile, platform: platform.data, accountRef: account.accountRef }] : [];
  });
  return { session: computerUse.currentBrowser, profiles, ...computerUse };
}

async function resolveBrowserStartRequest(system: AdPilotSystem, requested: z.infer<typeof BrowserSessionStartRequest>) {
  const client = await system.workspace.readClient(requested.clientId);
  const accounts = client.accounts?.accounts ?? [];
  const configured = requested.browserProfile
    ? accounts.find((account) => account.browserProfile === requested.browserProfile)
    : accounts.find((account) => account.platform === requested.platform);
  if (accounts.length && !configured) {
    throw new Error("browser Profile is not configured for this client and platform");
  }
  const platform = configured ? Platform.parse(configured.platform) : requested.platform;
  return {
    clientId: requested.clientId,
    browserProfile: requested.browserProfile ?? configured?.browserProfile ?? `${requested.clientId}-${platform.replaceAll("_", "-")}`,
    platform
  };
}

function publicBrowserSession(session: BrowserSession) {
  return {
    sessionId: session.sessionId,
    clientId: session.clientId,
    browserProfile: session.browserProfile,
    processId: session.processId ?? null,
    windowId: session.windowId ?? null,
    windowBounds: session.windowBounds ?? null,
    platform: session.platform,
    runtimePlatform: session.runtimePlatform,
    browserApplicationId: session.browserApplicationId,
    browserApp: session.browserApp,
    sessionStatus: session.sessionStatus,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    lastValidatedAt: session.lastValidatedAt ?? null,
    pageIdentity: session.pageIdentity ? publicBrowserPageIdentity(session.pageIdentity) : null,
    lostAt: session.lostAt ?? null,
    lostReason: session.lostReason ?? null
  };
}

function publicBrowserPageIdentity(identity: NonNullable<BrowserSession["pageIdentity"]>) {
  if (identity.status === "unavailable") {
    return {
      status: identity.status,
      observedAt: identity.observedAt,
      code: identity.code,
      reason: identity.reason
    };
  }
  return {
    status: identity.status,
    source: identity.source,
    observedAt: identity.observedAt,
    url: identity.url,
    origin: identity.origin,
    title: identity.title,
    fingerprint: identity.fingerprint,
    ...(identity.tabId ? { tabId: identity.tabId } : {})
  };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Maps plugin-runtime errors onto the REST contract: 403 trust, 404 missing, 409 state, 503 degraded. */
function pluginErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } | undefined {
  if (!(error instanceof PluginRuntimeError)) return undefined;
  const code = error.code;
  const body: Record<string, unknown> = { error: error.message, code };
  if (error instanceof PluginPermissionReviewError) {
    return { status: 409, body: { ...body, update: error.update } };
  }
  const notFound = new Set(["PLUGIN_NOT_FOUND", "VERSION_NOT_FOUND", "NOT_INSTALLED", "TOOL_NOT_DECLARED"]);
  const forbidden = new Set([
    "UNSIGNED_REJECTED",
    "UNSIGNED_REQUIRES_DEVELOPER_MODE",
    "SIGNATURE_INVALID",
    "INTEGRITY_MISMATCH",
    "UNTRUSTED_SIGNER",
    "SIGNER_CONTINUITY_VIOLATION",
    "ACTIVE_BUNDLE_MISMATCH",
    "STAGED_BUNDLE_MISMATCH",
    "CAPABILITY_DENIED",
    "READ_ONLY_CAPABILITY_DENIED",
    "CAPABILITY_EFFECT_DENIED",
    "PATH_DENIED",
    "APPROVAL_RECEIPT_INVALID",
    "APPROVAL_RECEIPT_MISMATCH",
    "APPROVAL_RECEIPT_REPLAY"
  ]);
  const conflict = new Set([
    "ALREADY_INSTALLED",
    "UPDATE_ALREADY_PENDING",
    "NO_PENDING_UPDATE",
    "DOWNGRADE_REJECTED",
    "DATA_DOWNGRADE_REJECTED",
    "STATE_CAS_FAILED",
    "PLUGIN_INACTIVE",
    "RECONCILIATION_REQUIRED",
    "PLUGIN_MUTABLE_TOOL_GATED",
    "VERSION_CONFLICT",
    "APPROVAL_VERIFIER_REQUIRED",
    "IDEMPOTENCY_KEY_REPLAY",
    "CORRUPT_STATE",
    "REVIEW_REQUIRED"
  ]);
  const unavailable = new Set([
    "PLUGIN_CATALOG_UNAVAILABLE",
    "CURATED_ROOT_MISSING",
    "TRUST_STORE_MISSING",
    "PLUGIN_SANDBOX_UNSUPPORTED",
    "PLUGIN_HOST_MISSING"
  ]);
  if (notFound.has(code)) return { status: 404, body };
  if (forbidden.has(code)) return { status: 403, body };
  if (conflict.has(code)) return { status: 409, body };
  if (unavailable.has(code)) return { status: 503, body };
  return { status: 400, body };
}

/** Maps Session-authority errors onto the REST contract: 404 / 409 (+field detail). */
function sessionErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } | undefined {
  if (error instanceof SessionNotFoundError) {
    return { status: 404, body: { error: error.message, code: "SESSION_NOT_FOUND" } };
  }
  if (error instanceof ProjectNotFoundError) {
    return { status: 404, body: { error: error.message, code: "PROJECT_NOT_FOUND" } };
  }
  if (error instanceof RevisionConflictError) {
    return {
      status: 409,
      body: {
        error: error.message,
        code: "REVISION_CONFLICT",
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision
      }
    };
  }
  if (error instanceof DeletedSessionError) {
    return { status: 409, body: { error: error.message, code: "SESSION_DELETED" } };
  }
  if (error instanceof PermissionEscalationRequiresApprovalError) {
    return { status: 409, body: { error: error.message, code: "PERMISSION_ESCALATION_REQUIRES_APPROVAL" } };
  }
  return undefined;
}

/** Session-scoped SSE: every mutation and run-lifecycle change reaches subscribers. */
function publishSession(system: AdPilotSystem, session: ProductSessionEntity, status: string): void {
  system.events.publish({
    type: "session",
    clientId: session.clientId,
    sessionId: session.id,
    status,
    session
  });
}

/**
 * Resolves a run's model selection from the Session binding. A pinned binding
 * replaces global routing; a router binding only forces the strong route when
 * it says so; anything else keeps the existing global router behavior.
 */
function sessionModelOverride(binding: ProductSessionEntity["modelBinding"]): SessionModelOverride | undefined {
  if (binding.mode === "pinned") {
    return {
      ref: { provider: binding.providerId, model: binding.modelId },
      ...(binding.fallbackRoute === "fast" ? { fallbackRoute: "fast" as const } : {})
    };
  }
  return binding.route === "strong" ? { route: "strong" as const } : undefined;
}

/**
 * Best-effort compensation when the Pi-history copy behind a freshly created
 * branch/duplicate Session fails: the new Session carries no legacy mapping
 * and no user-visible history, so it is soft-deleted and purged rather than
 * left as an orphan pointing at an empty conversation.
 */
async function rollbackCreatedSession(system: AdPilotSystem, sessionId: string): Promise<void> {
  try {
    const deleted = await system.sessions.softDelete(sessionId);
    await system.sessions.permanentPurge(sessionId, deleted.revision);
  } catch {
    // The failed endpoint already reports the primary error; the orphaned
    // session remains listed as deleted for an explicit later purge.
  }
}

function conversationErrorMessage(locale: "zh-CN" | "en", detail: string, incidentId: string): string {
  const reference = incidentId.slice(0, 8);
  const authenticationFailure = /(?:401|403|unauthori[sz]ed|authentication|api[ _-]?key|credential|登录|认证|密钥)/i.test(detail);
  if (locale === "en") {
    return authenticationFailure
      ? `The model connection was rejected. Check the provider credential in Settings and try again. Reference: ${reference}`
      : `The model response could not be completed, so AdPilot stopped safely. Please retry; if it continues, try another model in Settings. Reference: ${reference}`;
  }
  return authenticationFailure
    ? `模型连接被拒绝。请检查“设置”中的供应商凭据后重试。参考编号：${reference}`
    : `这次模型响应未能完成，AdPilot 已安全停止。请重试；如果持续发生，请在“设置”中更换模型。参考编号：${reference}`;
}

function sanitizeLegacyConversationError(message: z.infer<typeof ConversationMessage>, locale: "zh-CN" | "en"): z.infer<typeof ConversationMessage> {
  if (message.role !== "system" || message.status !== "error") return message;
  const exposesInternalValidation = /(?:"code"\s*:\s*"invalid_type"|"expected"\s*:|ZodError|structured agent output|model response did not contain)/i.test(message.content);
  if (!exposesInternalValidation) return message;
  return {
    ...message,
    content: locale === "en"
      ? "A previous model response used an unsupported format, so AdPilot stopped safely. Please send the message again."
      : "上一次模型响应使用了不兼容的格式，AdPilot 已安全停止。请重新发送消息。"
  };
}

/**
 * Scopes the task list to one conversation for GET /api/state.
 *
 * Attribution contract (desktop: read this before rendering a task banner):
 * - A task persisted with a conversationId keeps it; legacy tasks without one
 *   are attributed to the most recently active conversation (the latest
 *   message in conversation.jsonl), or to no conversation (null) when the
 *   workspace has no messages yet — they then show in no conversation view.
 * - sessionId comes from the persisted task field, falling back to the
 *   Product Session whose runtimeConversationId matches the resolved
 *   conversation, else null.
 * - Tasks with phase "archived" are user-dismissed and never listed.
 * - Every returned task carries non-undefined conversationId/sessionId
 *   (string or null), so the desktop never has to re-derive attribution.
 */
export function scopeTasksForConversation(
  tasks: TaskStateValue[],
  messages: Array<z.infer<typeof ConversationMessage>>,
  sessions: ProductSessionEntity[],
  conversationId: string
): Array<Omit<TaskStateValue, "conversationId" | "sessionId"> & { conversationId: string | null; sessionId: string | null }> {
  const mostRecentConversationId = messages.at(-1)?.conversationId ?? null;
  const sessionIdByConversation = new Map(sessions.map((session) => [session.runtimeConversationId, session.id]));
  return tasks
    .filter((task) => task.phase !== "archived")
    .map((task) => {
      const resolvedConversationId = task.conversationId ?? mostRecentConversationId;
      const resolvedSessionId = task.sessionId ?? (resolvedConversationId ? sessionIdByConversation.get(resolvedConversationId) : undefined) ?? null;
      return { ...task, conversationId: resolvedConversationId, sessionId: resolvedSessionId };
    })
    .filter((task) => task.conversationId === conversationId);
}
