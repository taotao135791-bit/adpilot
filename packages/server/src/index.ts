import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { SessionError } from "@earendil-works/pi-agent-core";
import type { AdPilotSystem } from "@adpilot/application";
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
import { StartBrowserSessionInput, type BrowserSession } from "@adpilot/computer-use";
import { SettingsUpdate } from "@adpilot/configuration";
import { resolvePiSessionId, type SessionModelOverride } from "@adpilot/runtime";
import { ConversationMessage, MonitoringAlert, MonitoringAlertInput, Platform } from "@adpilot/shared";
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

const BrowserSessionStartRequest = z.object({
  clientId: z.string().min(1),
  browserProfile: z.string().min(1).optional(),
  platform: Platform.default("google_ads")
});
const BrowserSessionLookup = z.object({ clientId: z.string().min(1), browserProfile: z.string().min(1).optional() });

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

export async function createServer(system: AdPilotSystem, options: { uiRoot?: string; onRestartRequested?: () => void } = {}) {
  const app = Fastify({ logger: false });
  type AuthSession = { id: string; providerId: string; status: "running" | "complete" | "failed"; events: AuthEvent[]; prompt?: AuthPrompt; answer?: (value: string) => void; error?: string };
  const authSessions = new Map<string, AuthSession>();
  await app.register(cors, { origin: false });

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
    const computerUse = await computerUseState(system, clientId);
    const models = { ...system.modelStatus, browserSession: computerUse.browserStatus };
    if (!clientId) return { clients, tasks: [], approvals: [], experiments: [], audit: [], messages: [], sessions: [], selectedSessionId: null, browserSessions: computerUse.sessions, computerUse, events: [], models };
    const [tasks, approvals, experiments, audit, messages, settings, planMode, autonomy, sessions] = await Promise.all([
      system.workspace.listTasks(clientId), system.approvals.list(clientId), system.experiments.list(clientId), system.audit.list(clientId),
      system.workspace.readJsonl(clientId, "conversation.jsonl", ConversationMessage), system.settings.publicView(),
      system.planMode.get(clientId, query.conversationId),
      system.autonomy.get(clientId),
      system.sessions.list({ clientId })
    ]);
    return {
      clients,
      selectedClientId: clientId,
      selectedConversationId: query.conversationId,
      selectedSessionId: sessions.find((session) => session.runtimeConversationId === query.conversationId)?.id ?? null,
      tasks,
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
    const body = z.object({ clientId: z.string(), goal: z.string().min(1) }).strict().parse(request.body);
    system.events.publish({ type: "task", clientId: body.clientId, status: "running", message: body.goal });
    try {
      const result = await system.agent.runTask(body.clientId, body.goal);
      system.events.publish({ type: "task", clientId: body.clientId, status: result.task.phase, taskId: result.task.id, message: result.result.summary });
      reply.code(201); return result;
    } catch (error) {
      system.events.publish({ type: "error", clientId: body.clientId, message: error instanceof Error ? error.message : String(error), retryable: true });
      throw error;
    }
  });

  app.post("/api/messages", async (request, reply) => {
    const body = z.object({ clientId: z.string().optional(), conversationId: z.string().trim().min(1).max(120).default("primary"), sessionId: z.string().uuid().optional(), message: z.string().trim().min(1).max(20_000), locale: z.enum(["zh-CN", "en"]).default("zh-CN") }).parse(request.body);
    const clients = await system.workspace.listClients();
    let clientId = body.clientId ?? clients[0]?.id;
    if (!clientId) return reply.code(409).send({ error: "workspace is not available" });
    // An explicit product Session wins over the legacy conversationId: the
    // session owns the client and its runtimeConversationId becomes the
    // durable Pi/conversation key. A legacy conversation keeps working and is
    // imported into a Session on first sight (see below).
    let session: ProductSessionEntity | undefined;
    if (body.sessionId) {
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
      system.events.publish({ type: "task", clientId, status: "completed", message: markdown });
      reply.code(201);
      return { message: systemMessage, task: null, command: commandName };
    };
    // Shared tail of this route: publish + model call + persistence, so
    // built-in and user-template expansions take the identical path.
    const runConversation = async (prompt: string) => {
      system.events.publish({ type: "task", clientId, status: "running", message: body.message });
      await setSessionStatus("running");
      try {
        const response = await system.agent.respond(clientId, prompt, { conversationId, interfaceLocale: body.locale, userMessageId: userMessage.id, ...(session ? { sessionId: session.id } : {}), ...(modelOverride ? { modelOverride } : {}), recentConversation: existing.slice(-12).map((item) => sanitizeLegacyConversationError(item, body.locale)).map(({ role, content }) => ({ role, content })) });
        const assistantMessage = ConversationMessage.parse({ id: crypto.randomUUID(), clientId, conversationId, ...(session ? { sessionId: session.id } : {}), role: "assistant", content: response.reply, ...(response.task ? { taskId: response.task.id } : {}), at: new Date().toISOString() });
        await system.workspace.appendJsonl(clientId, "conversation.jsonl", assistantMessage);
        await setSessionStatus("completed");
        system.events.publish({ type: "task", clientId, status: response.task?.phase ?? "completed", ...(response.task ? { taskId: response.task.id } : {}), message: response.reply });
        reply.code(201); return { message: assistantMessage, task: response.task };
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

  app.post("/api/computer/pause", async (_request, reply) => {
    const computer = system.computer;
    if (!computer) return reply.code(409).send(computerUnavailableResponse());
    computer.pause();
    return { status: computer.executionStatus(), executionStatus: computer.executionStatus() };
  });
  app.post("/api/computer/takeover", async (_request, reply) => {
    const computer = system.computer;
    if (!computer) return reply.code(409).send(computerUnavailableResponse());
    computer.pause();
    // Takeover is a user intent, not a second runtime state. The actual state
    // exposed to every client remains `paused` until the user explicitly resumes.
    return { status: "user_takeover", executionStatus: computer.executionStatus() };
  });
  app.post("/api/computer/resume", async (_request, reply) => {
    const computer = system.computer;
    if (!computer) return reply.code(409).send(computerUnavailableResponse());
    computer.resume();
    return { status: computer.executionStatus(), executionStatus: computer.executionStatus() };
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
    reply.status(code === "BROWSER_SESSION_LOST" ? 409 : code === "PRIVACY_MODE_REMOTE_PROVIDER_BLOCKED" ? 403 : 400)
      .send({ error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) });
  });

  const uiRoot = options.uiRoot ?? resolve(process.cwd(), "dist", "desktop");
  if (existsSync(uiRoot)) {
    await app.register(fastifyStatic, { root: uiRoot, wildcard: false });
    app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  }
  return app;
}

async function computerUseState(system: AdPilotSystem, clientId?: string, refresh = true, browserProfile?: string) {
  if (refresh) await system.browserSessions.recover();
  const sessions = (await system.browserSessions.list())
    .filter((session) => (!clientId || session.clientId === clientId) && (!browserProfile || session.browserProfile === browserProfile));
  const publicSessions = sessions.map(publicBrowserSession);
  const currentBrowser = publicSessions.find((session) => session.sessionStatus === "connected") ?? publicSessions[0] ?? null;
  const browserStatus = sessions.some((session) => session.sessionStatus === "connected")
    ? "connected"
    : sessions.some((session) => session.sessionStatus === "starting")
      ? "starting"
      : sessions.some((session) => session.sessionStatus === "lost")
        ? "lost"
        : sessions.some((session) => session.sessionStatus === "closed")
          ? "closed"
          : "not_connected";
  return {
    status: system.computer && system.modelStatus.guiConfigured ? "ready" : "not_ready",
    executionStatus: system.computer?.executionStatus() ?? "unavailable",
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
    lostAt: session.lostAt ?? null,
    lostReason: session.lostReason ?? null
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
