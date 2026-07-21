import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { AdPilotSystem } from "@adpilot/application";
import { ApprovalExecutionPlan, ApprovalOperation } from "@adpilot/approvals";
import { SettingsUpdate } from "@adpilot/configuration";
import { ConversationMessage } from "@adpilot/shared";

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

  app.get("/api/health", async () => ({ status: "ok", chatConfigured: system.modelStatus.chatConfigured, guiConfigured: system.modelStatus.guiConfigured }));
  app.get("/api/about", async () => ({
    name: "AdPilot", version: "0.1.0",
    runtime: { name: "Pi", version: "0.80.10", license: "MIT" },
    computerUse: { name: "UI-TARS", version: "1.2.3", license: "Apache-2.0" },
    advertisingCore: { upstream: "codex-ads", version: "1.9.2", license: "MIT" }
  }));
  app.get("/api/settings", async () => {
    const view = await system.settings.publicView();
    const credentialList = await system.credentials.list();
    const stored = new Set(credentialList.map((item) => item.providerId));
    const providerConfigured = Object.fromEntries(view.catalog.providers.map((provider) => [provider.id, stored.has(provider.id) || provider.fields.some((field) => view.configured[field.env])]));
    return { ...view, providerConfigured, providerCredentials: Object.fromEntries(credentialList.map((item) => [item.providerId, item.type])), runtimeModels: system.modelStatus, restartAvailable: Boolean(options.onRestartRequested) };
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
    const query = z.object({ clientId: z.string().optional() }).parse(request.query);
    const clients = await system.workspace.listClients();
    const clientId = query.clientId ?? clients[0]?.id;
    if (!clientId) return { clients, tasks: [], approvals: [], experiments: [], audit: [], messages: [], events: system.events.history(), models: system.modelStatus };
    const [tasks, approvals, experiments, audit, messages] = await Promise.all([
      system.workspace.listTasks(clientId), system.approvals.list(clientId), system.experiments.list(clientId), system.audit.list(clientId),
      system.workspace.readJsonl(clientId, "conversation.jsonl", ConversationMessage)
    ]);
    return { clients, selectedClientId: clientId, tasks, approvals, experiments, audit, messages, events: system.events.history(), models: system.modelStatus };
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
    const body = z.object({ clientId: z.string(), goal: z.string().min(1), sharedFacts: z.record(z.unknown()).default({}) }).parse(request.body);
    system.events.publish({ type: "task", status: "running", message: body.goal });
    try {
      const result = await system.agent.runTask(body.clientId, body.goal, body.sharedFacts);
      system.events.publish({ type: "task", status: result.task.phase, taskId: result.task.id, message: result.result.summary });
      reply.code(201); return result;
    } catch (error) {
      system.events.publish({ type: "error", message: error instanceof Error ? error.message : String(error), retryable: true });
      throw error;
    }
  });

  app.post("/api/messages", async (request, reply) => {
    const body = z.object({ clientId: z.string().optional(), message: z.string().trim().min(1).max(20_000), locale: z.enum(["zh-CN", "en"]).default("zh-CN") }).parse(request.body);
    const clients = await system.workspace.listClients();
    const clientId = body.clientId ?? clients[0]?.id;
    if (!clientId) return reply.code(409).send({ error: "workspace is not available" });
    const existing = await system.workspace.readJsonl(clientId, "conversation.jsonl", ConversationMessage);
    const userMessage = ConversationMessage.parse({ id: crypto.randomUUID(), clientId, role: "user", content: body.message, at: new Date().toISOString() });
    await system.workspace.appendJsonl(clientId, "conversation.jsonl", userMessage);
    system.events.publish({ type: "task", status: "running", message: body.message });
    try {
      const response = await system.agent.respond(clientId, body.message, { interfaceLocale: body.locale, recentConversation: existing.slice(-12).map(({ role, content }) => ({ role, content })) });
      const assistantMessage = ConversationMessage.parse({ id: crypto.randomUUID(), clientId, role: "assistant", content: response.reply, ...(response.task ? { taskId: response.task.id } : {}), at: new Date().toISOString() });
      await system.workspace.appendJsonl(clientId, "conversation.jsonl", assistantMessage);
      system.events.publish({ type: "task", status: response.task?.phase ?? "completed", ...(response.task ? { taskId: response.task.id } : {}), message: response.reply });
      reply.code(201); return { message: assistantMessage, task: response.task };
    } catch (error) {
      const content = error instanceof Error ? error.message : String(error);
      await system.workspace.appendJsonl(clientId, "conversation.jsonl", ConversationMessage.parse({ id: crypto.randomUUID(), clientId, role: "system", content, status: "error", at: new Date().toISOString() }));
      system.events.publish({ type: "error", message: content, retryable: true });
      throw error;
    }
  });

  app.post("/api/computer/pause", async () => { system.computer?.pause(); return { status: "paused" }; });
  app.post("/api/computer/takeover", async () => { system.computer?.pause(); return { status: "user_takeover" }; });
  app.post("/api/computer/resume", async () => { system.computer?.resume(); return { status: "running" }; });

  app.post("/api/approvals", async (request, reply) => {
    const body = z.object({ clientId: z.string(), taskId: z.string().uuid(), operation: ApprovalOperation, executionPlan: ApprovalExecutionPlan.optional() }).parse(request.body);
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
      sharedFacts: {}
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
    const visualTask = {
      instruction: approval.executionPlan.instruction, target: approval.executionPlan.target,
      expectedResult: approval.executionPlan.expectedResult,
      surface: {
        app: approval.executionPlan.surface.app,
        browserProfile: approval.executionPlan.surface.browserProfile,
        allowedApps: approval.executionPlan.surface.allowedApps,
        allowedDomains: approval.executionPlan.surface.allowedDomains,
        ...(approval.executionPlan.surface.domain ? { domain: approval.executionPlan.surface.domain } : {})
      },
      riskLevel: approval.operation.riskLevel,
      permission: approval.operation.riskLevel === "destructive" ? "DESTRUCTIVE" as const : "MUTATE" as const
    };
    const result = await system.tools.commitApprovedVisualAction({ clientId: body.clientId, taskId: approval.taskId, actor: "account_operator", permission: visualTask.permission }, params.id, token, approval.operation, visualTask);
    system.events.publish({ type: "approval", approvalId: params.id, status: result.status === "done" ? "executed" : "failed" });
    return result;
  });

  app.setErrorHandler((error, _request, reply) => { reply.status(400).send({ error: error instanceof Error ? error.message : String(error) }); });

  const uiRoot = options.uiRoot ?? resolve(process.cwd(), "dist", "desktop");
  if (existsSync(uiRoot)) {
    await app.register(fastifyStatic, { root: uiRoot, wildcard: false });
    app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  }
  return app;
}
