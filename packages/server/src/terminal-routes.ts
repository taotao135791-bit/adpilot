import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TerminalError, TerminalService } from "./terminal-service.js";

const CreateBody = z.object({
  cwd: z.string().min(1).max(4_096),
  env: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  title: z.string().trim().min(1).max(256).optional()
}).strict();

const IdParams = z.object({ id: z.string().min(1).max(64) });

const OutputQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional()
}).strict();

const InputBody = z.object({
  data: z.string().min(1).max(64_000)
}).strict();

const ExecBody = z.object({
  command: z.string().min(1).max(64_000),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  approved: z.boolean().optional()
}).strict();

/**
 * Universal Workspace terminal routes: persistent interactive shell sessions
 * backed by TerminalService. Approval-gated exec failures surface as 409 with
 * the classifier verdict so the UI can render an approval affordance; all
 * other coded errors flow through the global error handler.
 */
export function registerTerminalRoutes(app: FastifyInstance, service: TerminalService): void {
  app.post("/api/terminals", async (request, reply) => {
    const body = CreateBody.parse(request.body);
    const session = await service.create({
      cwd: body.cwd,
      ...(body.env !== undefined ? { env: body.env } : {}),
      ...(body.title !== undefined ? { title: body.title } : {})
    });
    reply.code(201);
    return session;
  });

  app.get("/api/terminals", async () => ({ sessions: service.list() }));

  app.get("/api/terminals/:id/output", async (request) => {
    const params = IdParams.parse(request.params);
    const query = OutputQuery.parse(request.query);
    return service.output(params.id, query.since);
  });

  app.post("/api/terminals/:id/input", async (request) => {
    const params = IdParams.parse(request.params);
    const body = InputBody.parse(request.body);
    service.write(params.id, body.data);
    return { ok: true };
  });

  app.post("/api/terminals/:id/exec", async (request, reply) => {
    const params = IdParams.parse(request.params);
    const body = ExecBody.parse(request.body);
    try {
      return await service.exec(params.id, body.command, {
        ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        ...(body.approved !== undefined ? { approved: body.approved } : {})
      });
    } catch (error) {
      if (error instanceof TerminalError && error.code === "COMMAND_APPROVAL_REQUIRED") {
        return reply.code(409).send({
          error: error.message,
          code: error.code,
          classification: error.classification ?? null
        });
      }
      throw error;
    }
  });

  app.post("/api/terminals/:id/interrupt", async (request) => {
    const params = IdParams.parse(request.params);
    service.interrupt(params.id);
    return { ok: true };
  });

  app.delete("/api/terminals/:id", async (request) => {
    const params = IdParams.parse(request.params);
    await service.kill(params.id);
    return { ok: true };
  });
}
