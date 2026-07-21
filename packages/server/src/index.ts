import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";
import type { AdPilotSystem } from "@adpilot/application";
import { ApprovalExecutionPlan, ApprovalOperation } from "@adpilot/approvals";

export async function createServer(system: AdPilotSystem, options: { uiRoot?: string } = {}) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: false });

  app.get("/api/health", async () => ({ status: "ok", guiConfigured: system.modelStatus.guiConfigured }));
  app.get("/api/about", async () => ({
    name: "AdPilot", version: "0.1.0",
    runtime: { name: "Pi", version: "0.80.10", license: "MIT" },
    computerUse: { name: "UI-TARS", version: "1.2.3", license: "Apache-2.0" },
    advertisingCore: { upstream: "codex-ads", version: "1.9.2", license: "MIT" }
  }));
  app.get("/api/state", async (request) => {
    const query = z.object({ clientId: z.string().optional() }).parse(request.query);
    const clients = await system.workspace.listClients();
    const clientId = query.clientId ?? clients[0]?.id;
    if (!clientId) return { clients, tasks: [], approvals: [], experiments: [], audit: [], events: system.events.history(), models: system.modelStatus };
    const [tasks, approvals, experiments, audit] = await Promise.all([
      system.workspace.listTasks(clientId), system.approvals.list(clientId), system.experiments.list(clientId), system.audit.list(clientId)
    ]);
    return { clients, selectedClientId: clientId, tasks, approvals, experiments, audit, events: system.events.history(), models: system.modelStatus };
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
    const result = await system.specialists.dispatch("risk_reviewer", {
      context: { clientId: body.clientId, taskId: approval.taskId, actor: "adpilot_agent", permission: "OBSERVE" },
      input: {
        approvalId: params.id, guardrailAllowed: true, guardrailReasons: [],
        evidenceCount: approval.operation.evidence.length,
        hasBeforeScreenshot: approval.operation.evidence.some((item) => /^screenshot:[a-f0-9]{64}$/i.test(item)),
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
