import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { AdPilotSystem } from "@adpilot/application";
import { ApprovalOperation } from "@adpilot/approvals";
import { StartBrowserSessionInput, type BrowserSession } from "@adpilot/computer-use";
import { SettingsUpdate } from "@adpilot/configuration";
import { ConversationMessage, Platform } from "@adpilot/shared";
import { VisualApprovalPlanInput, visualTaskFromExecutionPlan } from "@adpilot/tools";

const BrowserSessionStartRequest = z.object({
  clientId: z.string().min(1),
  browserProfile: z.string().min(1).optional(),
  platform: Platform.default("google_ads")
});
const BrowserSessionLookup = z.object({ clientId: z.string().min(1), browserProfile: z.string().min(1).optional() });

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
    if (!clientId) return { clients, tasks: [], approvals: [], experiments: [], audit: [], messages: [], browserSessions: computerUse.sessions, computerUse, events: system.events.history(), models };
    const [tasks, approvals, experiments, audit, messages, settings] = await Promise.all([
      system.workspace.listTasks(clientId), system.approvals.list(clientId), system.experiments.list(clientId), system.audit.list(clientId),
      system.workspace.readJsonl(clientId, "conversation.jsonl", ConversationMessage), system.settings.publicView()
    ]);
    return {
      clients,
      selectedClientId: clientId,
      selectedConversationId: query.conversationId,
      tasks,
      approvals,
      experiments,
      audit,
      messages: messages.filter((message) => message.conversationId === query.conversationId).map((message) => sanitizeLegacyConversationError(message, settings.locale)),
      browserSessions: computerUse.sessions,
      computerUse,
      events: system.events.history(),
      models
    };
  });

  app.get("/events", async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    reply.raw.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    const unsubscribe = system.events.subscribe((event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`));
    reply.raw.on("close", unsubscribe);
  });

  app.post("/api/clients", async (request, reply) => {
    const body = z.object({ profile: z.object({ id: z.string(), name: z.string(), industry: z.string().optional(), timezone: z.string().optional() }), kpi: z.object({ primary: z.enum(["CPI", "CPA", "ROAS", "LTV_CAC", "REVENUE", "LEADS"]), target: z.number().positive(), currency: z.string().length(3).optional() }) }).parse(request.body);
    await system.workspace.initializeClient(body);
    reply.code(201); return { id: body.profile.id };
  });

  app.post("/api/tasks", async (request, reply) => {
    const body = z.object({ clientId: z.string(), goal: z.string().min(1) }).strict().parse(request.body);
    system.events.publish({ type: "task", status: "running", message: body.goal });
    try {
      const result = await system.agent.runTask(body.clientId, body.goal);
      system.events.publish({ type: "task", status: result.task.phase, taskId: result.task.id, message: result.result.summary });
      reply.code(201); return result;
    } catch (error) {
      system.events.publish({ type: "error", message: error instanceof Error ? error.message : String(error), retryable: true });
      throw error;
    }
  });

  app.post("/api/messages", async (request, reply) => {
    const body = z.object({ clientId: z.string().optional(), conversationId: z.string().trim().min(1).max(120).default("primary"), message: z.string().trim().min(1).max(20_000), locale: z.enum(["zh-CN", "en"]).default("zh-CN") }).parse(request.body);
    const clients = await system.workspace.listClients();
    const clientId = body.clientId ?? clients[0]?.id;
    if (!clientId) return reply.code(409).send({ error: "workspace is not available" });
    const existing = (await system.workspace.readJsonl(clientId, "conversation.jsonl", ConversationMessage)).filter((message) => message.conversationId === body.conversationId);
    const userMessage = ConversationMessage.parse({ id: crypto.randomUUID(), clientId, conversationId: body.conversationId, role: "user", content: body.message, at: new Date().toISOString() });
    await system.workspace.appendJsonl(clientId, "conversation.jsonl", userMessage);
    system.events.publish({ type: "task", status: "running", message: body.message });
    try {
      const response = await system.agent.respond(clientId, body.message, { conversationId: body.conversationId, interfaceLocale: body.locale, recentConversation: existing.slice(-12).map((item) => sanitizeLegacyConversationError(item, body.locale)).map(({ role, content }) => ({ role, content })) });
      const assistantMessage = ConversationMessage.parse({ id: crypto.randomUUID(), clientId, conversationId: body.conversationId, role: "assistant", content: response.reply, ...(response.task ? { taskId: response.task.id } : {}), at: new Date().toISOString() });
      await system.workspace.appendJsonl(clientId, "conversation.jsonl", assistantMessage);
      system.events.publish({ type: "task", status: response.task?.phase ?? "completed", ...(response.task ? { taskId: response.task.id } : {}), message: response.reply });
      reply.code(201); return { message: assistantMessage, task: response.task };
    } catch (error) {
      const incidentId = crypto.randomUUID();
      const detail = error instanceof Error ? error.message : String(error);
      const content = conversationErrorMessage(body.locale, detail, incidentId);
      await system.workspace.appendJsonl(clientId, "diagnostics/errors.jsonl", {
        id: incidentId, at: new Date().toISOString(), route: "/api/messages",
        error: { name: error instanceof Error ? error.name : "Error", message: detail }
      });
      await system.workspace.appendJsonl(clientId, "conversation.jsonl", ConversationMessage.parse({ id: crypto.randomUUID(), clientId, conversationId: body.conversationId, role: "system", content, status: "error", at: new Date().toISOString() }));
      system.events.publish({ type: "error", message: content, retryable: true });
      return reply.code(502).send({ error: content, incidentId });
    }
  });

  app.post("/api/computer/pause", async () => { system.computer?.pause(); return { status: "paused" }; });
  app.post("/api/computer/takeover", async () => { system.computer?.pause(); return { status: "user_takeover" }; });
  app.post("/api/computer/resume", async () => { system.computer?.resume(); return { status: "running" }; });

  const startManagedBrowser = async (bodyInput: unknown) => {
    const requested = BrowserSessionStartRequest.parse(bodyInput);
    const body = await resolveBrowserStartRequest(system, requested);
    const session = await system.browserSessions.start(StartBrowserSessionInput.parse(body));
    return { session: publicBrowserSession(session), computerUse: await computerUseState(system, body.clientId, false) };
  };
  const resumeManagedBrowser = async (bodyInput: unknown) => {
    const body = BrowserSessionLookup.parse(bodyInput);
    await system.workspace.readClient(body.clientId);
    const session = await system.browserSessions.resume(body.clientId, body.browserProfile);
    return { session: publicBrowserSession(session), computerUse: await computerUseState(system, body.clientId, false) };
  };
  const closeManagedBrowser = async (bodyInput: unknown) => {
    const body = BrowserSessionLookup.parse(bodyInput);
    await system.workspace.readClient(body.clientId);
    const session = await system.browserSessions.close(body.clientId, body.browserProfile);
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
      executionPlan: VisualApprovalPlanInput.optional()
    }).superRefine((value, context) => {
      if ((value.operation.riskLevel === "mutate" || value.operation.riskLevel === "destructive") && !value.executionPlan) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["executionPlan"], message: "a complete visual approval plan is required for mutations" });
      }
    }).parse(request.body);
    const approval = await system.tools.createApproval({ clientId: body.clientId, taskId: body.taskId, actor: "adpilot_agent", permission: "OBSERVE" }, body.operation, body.executionPlan);
    system.events.publish({ type: "approval", approvalId: approval.id, status: approval.status });
    reply.code(201); return approval;
  });

  app.post("/api/approvals/:id/risk-review", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ clientId: z.string() }).parse(request.body);
    const approval = await system.approvals.get(body.clientId, params.id);
    const audit = await system.audit.list(body.clientId);
    const screenshotHashes = new Set(audit.flatMap((event) => {
      if (event.action !== "execute_visual_task" || event.status !== "succeeded") return [];
      return [event.details.beforeHash, event.details.afterHash].filter((value): value is string => typeof value === "string");
    }));
    const result = await system.specialists.dispatch("risk_reviewer", {
      context: { clientId: body.clientId, taskId: approval.taskId, actor: "adpilot_agent", permission: "OBSERVE" },
      input: {
        approvalId: params.id, guardrailAllowed: true, guardrailReasons: [],
        evidenceCount: approval.operation.evidence.length,
        hasBeforeScreenshot: approval.operation.evidence.some((item) => item.startsWith("screenshot:") && screenshotHashes.has(item.slice("screenshot:".length))),
        executionPlanPresent: approval.executionPlan !== null,
        singleVariable: true, rollbackDefined: Boolean(approval.operation.rollbackCondition),
        operationSummary: `${approval.operation.operation} ${approval.operation.campaign}`
      },
      sharedFacts: []
    });
    system.events.publish({ type: "approval", approvalId: params.id, status: (result as { approved: boolean }).approved ? "pending_user" : "rejected" });
    return result;
  });

  app.post("/api/approvals/:id/approve", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ clientId: z.string(), approvedBy: z.string().min(1) }).parse(request.body);
    const { approval, token } = await system.approvals.approveByUser(body.clientId, params.id, body.approvedBy);
    system.approvalTokens.set(params.id, token);
    system.events.publish({ type: "approval", approvalId: params.id, status: approval.status });
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
    system.events.publish({ type: "approval", approvalId: params.id, status: result.status === "done" ? "executed" : "failed" });
    return result;
  });

  app.setErrorHandler((error, _request, reply) => {
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
