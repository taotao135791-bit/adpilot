import { z } from "zod";
import {
  CoordinatedRun,
  type CoordinatedRun as CoordinatedRunType
} from "./schemas.js";

export class KeyedSessionActor {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly active = new Set<string>();

  async run<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
    const key = z.string().uuid().parse(sessionId);
    const prior = this.tails.get(key) ?? Promise.resolve();
    const settledPrior = prior.catch(() => undefined);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = settledPrior.then(() => gate);
    this.tails.set(key, tail);

    await settledPrior;
    this.active.add(key);
    try {
      return await operation();
    } finally {
      this.active.delete(key);
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  hasPending(sessionId: string): boolean {
    return this.tails.has(sessionId);
  }

  get trackedSessionCount(): number {
    return this.tails.size;
  }
}

export interface CoordinatedRunContext {
  runId: string;
  sessionId: string;
  queuedAt: string;
  startedAt: string;
}

export interface CoordinatedRunHandle<T> {
  runId: string;
  sessionId: string;
  completion: Promise<T>;
}

export interface RunCoordinatorOptions {
  now?: () => Date;
  actor?: KeyedSessionActor;
}

export class RunCoordinator {
  readonly actor: KeyedSessionActor;

  private readonly now: () => Date;
  private readonly runs = new Map<string, CoordinatedRunType>();

  constructor(options: RunCoordinatorOptions = {}) {
    this.actor = options.actor ?? new KeyedSessionActor();
    this.now = options.now ?? (() => new Date());
  }

  enqueue<T>(
    sessionId: string,
    operation: (context: CoordinatedRunContext) => Promise<T> | T
  ): CoordinatedRunHandle<T> {
    const normalizedSessionId = z.string().uuid().parse(sessionId);
    const runId = crypto.randomUUID();
    const queuedAt = this.now().toISOString();
    this.runs.set(
      runId,
      CoordinatedRun.parse({
        id: runId,
        sessionId: normalizedSessionId,
        status: "queued",
        queuedAt
      })
    );

    const completion = this.actor.run(normalizedSessionId, async () => {
      const startedAt = this.now().toISOString();
      this.runs.set(
        runId,
        CoordinatedRun.parse({
          id: runId,
          sessionId: normalizedSessionId,
          status: "running",
          queuedAt,
          startedAt
        })
      );
      try {
        const result = await operation({
          runId,
          sessionId: normalizedSessionId,
          queuedAt,
          startedAt
        });
        this.runs.set(
          runId,
          CoordinatedRun.parse({
            id: runId,
            sessionId: normalizedSessionId,
            status: "succeeded",
            queuedAt,
            startedAt,
            completedAt: this.now().toISOString()
          })
        );
        return result;
      } catch (error) {
        this.runs.set(
          runId,
          CoordinatedRun.parse({
            id: runId,
            sessionId: normalizedSessionId,
            status: "failed",
            queuedAt,
            startedAt,
            completedAt: this.now().toISOString(),
            error: error instanceof Error ? error.message : String(error)
          })
        );
        throw error;
      }
    });

    return { runId, sessionId: normalizedSessionId, completion };
  }

  async run<T>(
    sessionId: string,
    operation: (context: CoordinatedRunContext) => Promise<T> | T
  ): Promise<T> {
    return this.enqueue(sessionId, operation).completion;
  }

  get(runId: string): CoordinatedRunType | undefined {
    const value = this.runs.get(runId);
    return value ? CoordinatedRun.parse(value) : undefined;
  }

  list(sessionId?: string): CoordinatedRunType[] {
    const normalizedSessionId =
      sessionId === undefined ? undefined : z.string().uuid().parse(sessionId);
    return [...this.runs.values()]
      .filter(
        (run) =>
          normalizedSessionId === undefined || run.sessionId === normalizedSessionId
      )
      .map((run) => CoordinatedRun.parse(run))
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
  }
}
