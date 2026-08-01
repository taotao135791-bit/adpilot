import { realpath, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdPilotSystem } from "@adpilot/application";
import { KernelError } from "@adpilot/kernel";
import {
  TerminalError,
  TerminalService,
  type TerminalSessionScope
} from "./terminal-service.js";
import { broadProjectRootReason } from "./project-root-policy.js";

const CreateBody = z.object({
  clientId: z.string().min(1).max(256),
  projectId: z.string().uuid(),
  cwd: z.string().min(1).max(4_096),
  env: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  title: z.string().trim().min(1).max(256).optional()
}).strict();

const IdParams = z.object({ id: z.string().min(1).max(64) });

const ScopeQuery = z.object({
  clientId: z.string().min(1).max(256),
  projectId: z.string().uuid(),
  root: z.string().min(1).max(4_096)
}).strict();

const OutputQuery = z.object({
  clientId: z.string().min(1).max(256),
  projectId: z.string().uuid(),
  root: z.string().min(1).max(4_096),
  since: z.coerce.number().int().nonnegative().optional()
}).strict();

const InputBody = z.object({
  data: z.string().min(1).max(64_000),
  approved: z.boolean().optional()
}).strict();

const ExecBody = z.object({
  command: z.string().min(1).max(64_000),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  approved: z.boolean().optional()
}).strict();

/**
 * Universal Workspace terminal routes: every REST session is bound to one
 * existing client, project, and canonical root. Every later request repeats
 * that scope; a mismatched terminal id is indistinguishable from a missing
 * one. Write-classified exec failures surface as 409 for explicit approval,
 * while deny-classified commands return 403 and can never be overridden.
 */
export function registerTerminalRoutes(
  app: FastifyInstance,
  service: TerminalService,
  system: AdPilotSystem
): void {
  async function resolveScope(input: {
    clientId: string;
    projectId: string;
    root: string;
  }): Promise<TerminalSessionScope> {
    await system.workspace.readClient(input.clientId);
    const project = await system.kernel.getProject(input.projectId);
    if (
      !project
      || project.workspaceId !== input.clientId
      || project.status !== "active"
    ) {
      throw new KernelError(
        `project not found in this workspace: ${input.projectId}`,
        "PROJECT_NOT_FOUND"
      );
    }
    const root = await canonicalDirectory(input.root);
    const projectRoots = await Promise.all(project.rootPaths.map(canonicalDirectory));
    if (!projectRoots.includes(root)) {
      throw new TerminalError(
        "terminal cwd must be one of the project's canonical root paths",
        "TERMINAL_CWD_INVALID"
      );
    }
    return { clientId: input.clientId, projectId: input.projectId, root };
  }

  app.post("/api/terminals", async (request, reply) => {
    const body = CreateBody.parse(request.body);
    const scope = await resolveScope({
      clientId: body.clientId,
      projectId: body.projectId,
      root: body.cwd
    });
    const session = await service.create({
      cwd: scope.root,
      scope,
      ...(body.env !== undefined ? { env: body.env } : {}),
      ...(body.title !== undefined ? { title: body.title } : {})
    });
    reply.code(201);
    return session;
  });

  app.get("/api/terminals", async (request) => {
    const query = ScopeQuery.parse(request.query);
    const scope = await resolveScope(query);
    return { sessions: service.list(scope) };
  });

  app.get("/api/terminals/:id/output", async (request) => {
    const params = IdParams.parse(request.params);
    const query = OutputQuery.parse(request.query);
    const scope = await resolveScope(query);
    return service.output(params.id, query.since, scope);
  });

  app.post("/api/terminals/:id/input", async (request, reply) => {
    const params = IdParams.parse(request.params);
    const query = ScopeQuery.parse(request.query);
    const body = InputBody.parse(request.body);
    const scope = await resolveScope(query);
    try {
      service.write(params.id, body.data, scope, body.approved === true);
    } catch (error) {
      if (error instanceof TerminalError && error.code === "COMMAND_APPROVAL_REQUIRED") {
        return sendCommandError(reply, error, 409);
      }
      if (error instanceof TerminalError && error.code === "COMMAND_DENIED") {
        return sendCommandError(reply, error, 403);
      }
      throw error;
    }
    return { ok: true };
  });

  app.post("/api/terminals/:id/exec", async (request, reply) => {
    const params = IdParams.parse(request.params);
    const query = ScopeQuery.parse(request.query);
    const body = ExecBody.parse(request.body);
    const scope = await resolveScope(query);
    try {
      return await service.exec(params.id, body.command, {
        ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        ...(body.approved !== undefined ? { approved: body.approved } : {}),
        scope
      });
    } catch (error) {
      if (error instanceof TerminalError && error.code === "COMMAND_APPROVAL_REQUIRED") {
        return sendCommandError(reply, error, 409);
      }
      if (error instanceof TerminalError && error.code === "COMMAND_DENIED") {
        return sendCommandError(reply, error, 403);
      }
      throw error;
    }
  });

  app.post("/api/terminals/:id/interrupt", async (request) => {
    const params = IdParams.parse(request.params);
    const query = ScopeQuery.parse(request.query);
    const scope = await resolveScope(query);
    service.interrupt(params.id, scope);
    return { ok: true };
  });

  app.delete("/api/terminals/:id", async (request) => {
    const params = IdParams.parse(request.params);
    const query = ScopeQuery.parse(request.query);
    const scope = await resolveScope(query);
    await service.kill(params.id, scope);
    return { ok: true };
  });
}

async function canonicalDirectory(path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    throw new TerminalError(
      `terminal cwd does not exist: ${path}`,
      "TERMINAL_CWD_INVALID",
      { cause: error }
    );
  }
  const metadata = await stat(canonical).catch(() => null);
  if (!metadata?.isDirectory()) {
    throw new TerminalError(
      `terminal cwd is not a directory: ${path}`,
      "TERMINAL_CWD_INVALID"
    );
  }
  const broadReason = await broadProjectRootReason(canonical);
  if (broadReason) {
    throw new TerminalError(
      `terminal cwd is too broad for confinement (${broadReason})`,
      "TERMINAL_CWD_INVALID"
    );
  }
  return canonical;
}

function sendCommandError(
  reply: import("fastify").FastifyReply,
  error: TerminalError,
  status: 403 | 409
) {
  return reply.code(status).send({
    error: error.message,
    code: error.code,
    classification: error.classification ?? null
  });
}
