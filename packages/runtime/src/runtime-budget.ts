import type { Agent } from "@earendil-works/pi-agent-core";

export interface RuntimeBudgetLimits {
  maxTurns: number;
  maxToolCalls: number;
  wallClockMs: number;
}

export type RuntimeBudgetOverride = Partial<RuntimeBudgetLimits>;

export type RuntimeBudgetExceededReason = keyof RuntimeBudgetLimits;

/**
 * Defaults are deliberately finite: one request cannot silently become an
 * unbounded autonomous loop. Callers may tune them per runtime or per request,
 * but every override is clamped to the hard safety envelope below.
 */
export const DEFAULT_RUNTIME_BUDGET: Readonly<RuntimeBudgetLimits> = Object.freeze({
  maxTurns: 24,
  maxToolCalls: 48,
  wallClockMs: 10 * 60_000
});

export const MAX_RUNTIME_BUDGET: Readonly<RuntimeBudgetLimits> = Object.freeze({
  maxTurns: 64,
  maxToolCalls: 128,
  wallClockMs: 30 * 60_000
});

const MIN_RUNTIME_BUDGET: Readonly<RuntimeBudgetLimits> = Object.freeze({
  maxTurns: 1,
  maxToolCalls: 1,
  wallClockMs: 10
});

export class RuntimeBudgetExceeded extends Error {
  readonly code = "RUNTIME_BUDGET_EXCEEDED";

  constructor(
    readonly reason: RuntimeBudgetExceededReason,
    readonly turns: number,
    readonly toolCalls: number,
    readonly elapsedMs: number
  ) {
    super(`runtime budget exceeded (${reason}): ${turns} turns, ${toolCalls} tool calls, ${elapsedMs}ms elapsed`);
    this.name = "RuntimeBudgetExceeded";
  }
}

export function resolveRuntimeBudgetLimits(
  override: RuntimeBudgetOverride | undefined,
  base: Readonly<RuntimeBudgetLimits> = DEFAULT_RUNTIME_BUDGET
): RuntimeBudgetLimits {
  return {
    maxTurns: boundedInteger(override?.maxTurns, base.maxTurns, MIN_RUNTIME_BUDGET.maxTurns, MAX_RUNTIME_BUDGET.maxTurns),
    maxToolCalls: boundedInteger(override?.maxToolCalls, base.maxToolCalls, MIN_RUNTIME_BUDGET.maxToolCalls, MAX_RUNTIME_BUDGET.maxToolCalls),
    wallClockMs: boundedInteger(override?.wallClockMs, base.wallClockMs, MIN_RUNTIME_BUDGET.wallClockMs, MAX_RUNTIME_BUDGET.wallClockMs)
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const finiteFallback = Number.isFinite(fallback) ? Math.floor(fallback) : minimum;
  const candidate = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : finiteFallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

/**
 * Mutable counter shared by every model attempt belonging to one public
 * runtime request, including primary/strong fallback and structured repairs.
 */
export class RuntimeBudgetController {
  private readonly startedAt = performance.now();
  private readonly abortController = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly deadlinePromise: Promise<RuntimeBudgetExceeded>;
  private resolveDeadline: (failure: RuntimeBudgetExceeded) => void = () => undefined;
  private activeAgent: Agent | undefined;
  private failure: RuntimeBudgetExceeded | undefined;
  private stoppedByUser = false;
  private turnCount = 0;
  private toolCallCount = 0;

  constructor(readonly limits: RuntimeBudgetLimits) {
    this.deadlinePromise = new Promise((resolve) => {
      this.resolveDeadline = resolve;
    });
    this.timer = setTimeout(() => {
      this.exceed("wallClockMs");
    }, limits.wallClockMs);
    this.timer.unref?.();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get turns(): number {
    return this.turnCount;
  }

  get toolCalls(): number {
    return this.toolCallCount;
  }

  get wasStoppedByUser(): boolean {
    return this.stoppedByUser;
  }

  /**
   * Make the wall-clock limit observable by the public caller even while the
   * underlying operation is awaiting code that does not honor AbortSignal.
   * The operation remains observed by Promise.race, and every later runtime
   * boundary checks the latched failure before doing more work.
   */
  enforceDeadline<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([
      operation,
      this.deadlinePromise.then((failure): never => {
        throw failure;
      })
    ]);
  }

  /**
   * Wait for an abort-aware maintenance operation without trusting it to
   * settle promptly. User Stop resolves as an ordinary cancellation; a budget
   * abort is converted back to RuntimeBudgetExceeded by throwIfExceeded().
   */
  settleUntilAbort<T>(operation: Promise<T>): Promise<{ aborted: true } | { aborted: false; value: T }> {
    if (this.signal.aborted) {
      // The operation may already have rejected while aborting synchronously
      // (for example a counted compaction call). Keep observing it.
      void operation.catch(() => undefined);
      return Promise.resolve({ aborted: true });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (outcome: { aborted: true } | { aborted: false; value: T }): void => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = (): void => finish({ aborted: true });
      this.signal.addEventListener("abort", onAbort, { once: true });
      if (this.signal.aborted) {
        onAbort();
        return;
      }
      operation.then(
        (value) => finish({ aborted: false, value }),
        (error: unknown) => {
          if (settled) return;
          settled = true;
          this.signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  bind(agent: Agent): void {
    this.activeAgent = agent;
    if (this.failure) this.stopAgent(agent);
    this.throwIfExceeded();
  }

  unbind(agent: Agent): void {
    if (this.activeAgent === agent) this.activeAgent = undefined;
  }

  claimTurn(): void {
    if (this.stoppedByUser) return;
    this.throwIfExceeded();
    if (this.turnCount >= this.limits.maxTurns) {
      this.exceed("maxTurns");
      this.throwIfExceeded();
    }
    this.turnCount += 1;
  }

  claimToolCall(): void {
    if (this.stoppedByUser) return;
    this.throwIfExceeded();
    if (this.toolCallCount >= this.limits.maxToolCalls) {
      this.exceed("maxToolCalls");
      this.throwIfExceeded();
    }
    this.toolCallCount += 1;
  }

  throwIfExceeded(): void {
    if (!this.failure && !this.stoppedByUser && this.elapsedMs() >= this.limits.wallClockMs) {
      this.exceed("wallClockMs");
    }
    if (this.failure) throw this.failure;
  }

  /**
   * User Stop remains a distinct, non-error cancellation path. Clearing the
   * deadline prevents an already requested Stop from racing into a budget
   * failure while the Agent is settling its abort events.
   */
  cancelForUserStop(): void {
    if (this.failure) return;
    this.stoppedByUser = true;
    clearTimeout(this.timer);
    this.abortController.abort(new Error("Runtime stopped by user"));
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.activeAgent = undefined;
  }

  private exceed(reason: RuntimeBudgetExceededReason): void {
    if (this.failure || this.stoppedByUser) return;
    this.failure = new RuntimeBudgetExceeded(reason, this.turnCount, this.toolCallCount, this.elapsedMs());
    clearTimeout(this.timer);
    if (reason === "wallClockMs") this.resolveDeadline(this.failure);
    this.abortController.abort(this.failure);
    if (this.activeAgent) this.stopAgent(this.activeAgent);
  }

  private stopAgent(agent: Agent): void {
    try {
      agent.clearAllQueues();
    } catch {
      // Budget enforcement must still reach abort if queue cleanup fails.
    }
    try {
      agent.abort();
    } catch {
      // Preserve the typed budget failure as the externally visible error.
    }
  }

  private elapsedMs(): number {
    return Math.max(0, Math.round(performance.now() - this.startedAt));
  }
}
