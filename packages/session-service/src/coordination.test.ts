import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "@adpilot/workspace";
import { RunCoordinator } from "./actors.js";
import { FileSessionRepository } from "./repository.js";
import { SessionService } from "./service.js";
import {
  CorruptWorkspaceWriterLeaseError,
  WorkspaceWriterLease,
  WorkspaceWriterLeaseHeldError
} from "./lease.js";

interface CompetitionWorkerResult {
  status: "success" | "revision-conflict" | "not-found" | "error";
  revision?: number;
  created?: number;
  reused?: number;
  acquired?: number;
  message?: string;
}

function runCompetitionWorker(args: string[]): Promise<CompetitionWorkerResult> {
  const workerPath = fileURLToPath(
    new URL("./competition-worker.ts", import.meta.url)
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", workerPath, ...args],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.trim().split("\n").at(-1);
      if (!line) {
        reject(new Error(`competition worker produced no result: ${stderr}`));
        return;
      }
      try {
        const result = JSON.parse(line) as CompetitionWorkerResult;
        if (code !== 0 || result.status === "error") {
          reject(
            new Error(
              result.message ?? `competition worker exited ${code}: ${stderr}`
            )
          );
          return;
        }
        resolve(result);
      } catch (error) {
        reject(
          new Error(
            `invalid competition worker output: ${stdout}\n${stderr}\n${String(error)}`
          )
        );
      }
    });
  });
}

describe("RunCoordinator", () => {
  it("serializes one session while allowing different sessions to run concurrently", async () => {
    const coordinator = new RunCoordinator();
    const sessionA = crypto.randomUUID();
    const sessionB = crypto.randomUUID();
    const order: string[] = [];
    let releaseA = (): void => undefined;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalAStarted = (): void => undefined;
    const aStarted = new Promise<void>((resolve) => {
      signalAStarted = resolve;
    });

    const firstA = coordinator.enqueue(sessionA, async () => {
      order.push("a1:start");
      signalAStarted();
      await holdA;
      order.push("a1:end");
      return "a1";
    });
    await aStarted;
    const secondA = coordinator.enqueue(sessionA, async () => {
      order.push("a2:start");
      order.push("a2:end");
      return "a2";
    });
    const runB = coordinator.enqueue(sessionB, async () => {
      order.push("b:start");
      order.push("b:end");
      return "b";
    });

    await expect(runB.completion).resolves.toBe("b");
    expect(order).toEqual(["a1:start", "b:start", "b:end"]);
    expect(coordinator.get(secondA.runId)?.status).toBe("queued");
    releaseA();
    await expect(Promise.all([firstA.completion, secondA.completion])).resolves.toEqual([
      "a1",
      "a2"
    ]);
    expect(order).toEqual([
      "a1:start",
      "b:start",
      "b:end",
      "a1:end",
      "a2:start",
      "a2:end"
    ]);
    expect(coordinator.list(sessionA).map((run) => run.status)).toEqual([
      "succeeded",
      "succeeded"
    ]);
  });
});

describe("WorkspaceWriterLease", () => {
  it("rejects a second live writer and permits acquisition after release", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-writer-lease-"));
    const first = await WorkspaceWriterLease.acquire(root, { owner: "first" });
    await expect(
      WorkspaceWriterLease.acquire(root, { owner: "second" })
    ).rejects.toBeInstanceOf(WorkspaceWriterLeaseHeldError);
    expect((await stat(first.lockPath)).mode & 0o777).toBe(0o600);
    await first.assertHeld();
    await first.release();

    const second = await WorkspaceWriterLease.acquire(root, { owner: "second" });
    await second.assertHeld();
    await second.release();
  });

  it("atomically publishes leases under repeated real-process contention", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-lease-stress-"));
    const contenders = 6;
    const iterations = 8;

    for (let round = 0; round < 3; round += 1) {
      const startAt = Date.now() + 750;
      const results = await Promise.all(
        Array.from({ length: contenders }, () =>
          runCompetitionWorker([
            "lease-stress",
            root,
            String(startAt),
            String(iterations)
          ])
        )
      );
      expect(
        results.reduce((total, result) => total + (result.acquired ?? 0), 0)
      ).toBe(contenders * iterations);
      expect(
        (await readdir(join(root, ".adpilot"))).filter((name) =>
          name.startsWith("writer.lock.pending.")
        )
      ).toEqual([]);
    }
  }, 30_000);

  it("does not let stale recovery move a concurrently published live lease", async () => {
    const contenders = 6;
    for (let round = 0; round < 8; round += 1) {
      const root = await mkdtemp(join(tmpdir(), "adpilot-stale-race-"));
      const controlRoot = join(root, ".adpilot");
      const lockPath = join(root, WorkspaceWriterLease.relativeLockPath);
      await mkdir(controlRoot, { recursive: true, mode: 0o700 });
      const staleId = crypto.randomUUID();
      await writeFile(
        lockPath,
        `${JSON.stringify({
          schemaVersion: 1,
          id: staleId,
          pid: 2_147_483_647,
          hostname: hostname(),
          workspaceRoot: root,
          owner: "dead-race-owner",
          acquiredAt: new Date().toISOString()
        })}\n`,
        { encoding: "utf8", mode: 0o600 }
      );

      const startAt = Date.now() + 750;
      const results = await Promise.all(
        Array.from({ length: contenders }, () =>
          runCompetitionWorker([
            "lease-stress",
            root,
            String(startAt),
            "1"
          ])
        )
      );
      expect(
        results.reduce((total, result) => total + (result.acquired ?? 0), 0)
      ).toBe(contenders);

      const controlFiles = await readdir(controlRoot);
      const staleFiles = controlFiles.filter((name) =>
        name.startsWith("writer.lock.stale.")
      );
      expect(staleFiles).toHaveLength(1);
      expect(
        JSON.parse(await readFile(join(controlRoot, staleFiles[0]!), "utf8"))
      ).toMatchObject({ id: staleId });
      expect(
        controlFiles.filter(
          (name) =>
            name === "writer.lock" ||
            name === "writer.recovery.lock" ||
            name.includes(".pending.") ||
            name.includes(".released.")
        )
      ).toEqual([]);
    }
  }, 30_000);

  it("serializes release behind an in-flight ownership-gated commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-lease-gate-"));
    const lease = await WorkspaceWriterLease.acquire(root);
    let signalStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let allowCommit = (): void => undefined;
    const commitAllowed = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    let committed = false;
    const commit = lease.runWhileHeld(async () => {
      signalStarted();
      await commitAllowed;
      await lease.assertHeld();
      committed = true;
    });
    await started;

    let released = false;
    const release = lease.release().then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(released).toBe(false);
    allowCommit();
    await commit;
    await release;
    expect(committed).toBe(true);
    expect(released).toBe(true);
  });

  it("serializes revision, legacy migration and purge across real processes", async () => {
    const revisionRoot = await mkdtemp(
      join(tmpdir(), "adpilot-process-revision-")
    );
    const setupLease = await WorkspaceWriterLease.acquire(revisionRoot, {
      owner: "revision-setup"
    });
    const setupService = new SessionService(
      new FileSessionRepository(revisionRoot, { writerLease: setupLease })
    );
    const session = await setupService.create({
      clientId: "client-a",
      title: "revision-source"
    });
    await setupLease.release();

    const revisionResults = await Promise.all([
      runCompetitionWorker([
        "revision",
        revisionRoot,
        session.id,
        "writer-one"
      ]),
      runCompetitionWorker([
        "revision",
        revisionRoot,
        session.id,
        "writer-two"
      ])
    ]);
    expect(revisionResults.map((result) => result.status).sort()).toEqual([
      "revision-conflict",
      "success"
    ]);
    await expect(
      new FileSessionRepository(revisionRoot).requireSession(session.id)
    ).resolves.toMatchObject({ revision: 2 });

    const legacyRoot = await mkdtemp(
      join(tmpdir(), "adpilot-process-legacy-")
    );
    const workspace = new WorkspaceStore(legacyRoot);
    await workspace.initializeClient({
      profile: { id: "client-a", name: "Client A" },
      kpi: { primary: "CPA", target: 10, currency: "USD" }
    });
    await workspace.appendJsonl("client-a", "conversation.jsonl", {
      id: crypto.randomUUID(),
      clientId: "client-a",
      conversationId: "primary",
      role: "user",
      content: "legacy",
      at: new Date().toISOString()
    });

    const migrationResults = await Promise.all([
      runCompetitionWorker(["migrate", legacyRoot]),
      runCompetitionWorker(["migrate", legacyRoot])
    ]);
    expect(
      migrationResults.reduce((total, result) => total + (result.created ?? 0), 0)
    ).toBe(1);
    expect(
      migrationResults.reduce((total, result) => total + (result.reused ?? 0), 0)
    ).toBe(1);

    const purgeSetupLease = await WorkspaceWriterLease.acquire(legacyRoot, {
      owner: "purge-setup"
    });
    const purgeRepository = new FileSessionRepository(workspace, {
      writerLease: purgeSetupLease
    });
    const purgeService = new SessionService(purgeRepository);
    const migrated = (await purgeRepository.listSessions())[0]!;
    const deleted = await purgeService.softDelete(
      migrated.id,
      migrated.revision
    );
    await purgeSetupLease.release();

    const purgeResults = await Promise.all([
      runCompetitionWorker([
        "purge",
        legacyRoot,
        migrated.id,
        String(deleted.revision)
      ]),
      runCompetitionWorker([
        "purge",
        legacyRoot,
        migrated.id,
        String(deleted.revision)
      ])
    ]);
    expect(purgeResults.map((result) => result.status).sort()).toEqual([
      "not-found",
      "success"
    ]);

    const verifyLease = await WorkspaceWriterLease.acquire(legacyRoot, {
      owner: "purge-verification"
    });
    const verifyRepository = new FileSessionRepository(workspace, {
      writerLease: verifyLease
    });
    const rerun = await new SessionService(verifyRepository).migrateLegacy(
      workspace
    );
    expect(rerun).toMatchObject({ created: 0, skippedPurged: 1 });
    await expect(verifyRepository.getSession(migrated.id)).resolves.toBeUndefined();
    await verifyLease.release();
  }, 30_000);

  it("recovers only a definitely dead same-host pid and preserves the stale record", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-stale-writer-"));
    const controlRoot = join(root, ".adpilot");
    const lockPath = join(root, WorkspaceWriterLease.relativeLockPath);
    await mkdir(controlRoot, { recursive: true, mode: 0o700 });
    const staleId = crypto.randomUUID();
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: staleId,
        pid: 2_147_483_647,
        hostname: hostname(),
        workspaceRoot: root,
        owner: "dead-test-process",
        acquiredAt: new Date().toISOString()
      })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );

    const lease = await WorkspaceWriterLease.acquire(root);
    expect(lease.record.id).not.toBe(staleId);
    const staleFiles = (await readdir(controlRoot)).filter((name) =>
      name.includes(".stale.")
    );
    expect(staleFiles).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(controlRoot, staleFiles[0]!), "utf8"))
    ).toMatchObject({ id: staleId });
    await lease.release();
  });

  it("never removes a malformed lock automatically", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-corrupt-writer-"));
    const controlRoot = join(root, ".adpilot");
    const lockPath = join(root, WorkspaceWriterLease.relativeLockPath);
    await mkdir(controlRoot, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, "{\"broken\":", { encoding: "utf8", mode: 0o600 });

    await expect(WorkspaceWriterLease.acquire(root)).rejects.toBeInstanceOf(
      CorruptWorkspaceWriterLeaseError
    );
    await expect(readFile(lockPath, "utf8")).resolves.toBe("{\"broken\":");
  });
});
