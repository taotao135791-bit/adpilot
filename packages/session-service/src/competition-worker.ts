import { WorkspaceStore } from "@adpilot/workspace";
import {
  FileSessionRepository,
  RevisionConflictError,
  SessionNotFoundError
} from "./repository.js";
import { SessionService } from "./service.js";
import {
  WorkspaceWriterLease,
  WorkspaceWriterLeaseHeldError
} from "./lease.js";

type WorkerResult =
  | {
      status: "success";
      revision?: number;
      created?: number;
      reused?: number;
      acquired?: number;
    }
  | { status: "revision-conflict" | "not-found" }
  | { status: "error"; message: string };

async function acquireWithRetry(root: string): Promise<WorkspaceWriterLease> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      return await WorkspaceWriterLease.acquire(root, {
        owner: `competition-worker-${process.pid}`
      });
    } catch (error) {
      if (!(error instanceof WorkspaceWriterLeaseHeldError) || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function main(): Promise<WorkerResult> {
  const [mode, root, sessionId, value] = process.argv.slice(2);
  if (!mode || !root) throw new Error("worker mode and workspace root are required");
  if (mode === "lease-stress") {
    const startAt = Number.parseInt(sessionId ?? "", 10);
    const iterations = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(startAt) || !Number.isSafeInteger(iterations) || iterations < 1) {
      throw new Error("lease stress worker arguments missing or invalid");
    }
    const delay = startAt - Date.now();
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const lease = await acquireWithRetry(root);
      await lease.assertHeld();
      await lease.release();
    }
    return { status: "success", acquired: iterations };
  }

  const lease = await acquireWithRetry(root);
  try {
    const workspace = new WorkspaceStore(root);
    const repository = new FileSessionRepository(workspace, {
      writerLease: lease
    });
    const service = new SessionService(repository);
    if (mode === "revision") {
      if (!sessionId || !value) throw new Error("revision worker arguments missing");
      try {
        const session = await service.rename(sessionId, value, 1);
        return { status: "success", revision: session.revision };
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          return { status: "revision-conflict" };
        }
        if (error instanceof SessionNotFoundError) return { status: "not-found" };
        throw error;
      }
    }
    if (mode === "migrate") {
      const result = await service.migrateLegacy(workspace);
      return {
        status: "success",
        created: result.created,
        reused: result.reused
      };
    }
    if (mode === "purge") {
      if (!sessionId || !value) throw new Error("purge worker arguments missing");
      try {
        await service.permanentPurge(sessionId, Number.parseInt(value, 10));
        return { status: "success" };
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          return { status: "revision-conflict" };
        }
        if (error instanceof SessionNotFoundError) return { status: "not-found" };
        throw error;
      }
    }
    throw new Error(`unknown worker mode: ${mode}`);
  } finally {
    await lease.release();
  }
}

main()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })
  .catch((error) => {
    const result: WorkerResult = {
      status: "error",
      message: error instanceof Error ? error.stack ?? error.message : String(error)
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  });
