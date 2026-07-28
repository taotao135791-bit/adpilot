import {
  ComputerControlState,
  ComputerProtocolError,
  type ComputerControlState as ComputerControlStateValue
} from "./protocol.js";

const TERMINAL_STATES = new Set<ComputerControlStateValue>(["stopped", "failed"]);

const ALLOWED_TRANSITIONS: Readonly<Record<ComputerControlStateValue, ReadonlySet<ComputerControlStateValue>>> = {
  agent_observing: new Set(["agent_proposing", "agent_executing", "paused", "user_control", "stopped", "failed"]),
  agent_proposing: new Set(["agent_observing", "awaiting_approval", "agent_executing", "paused", "user_control", "stopped", "failed"]),
  awaiting_approval: new Set(["agent_observing", "agent_executing", "paused", "user_control", "stopped", "failed"]),
  agent_executing: new Set(["verifying", "agent_observing", "paused", "user_control", "stopped", "failed"]),
  verifying: new Set(["agent_observing", "paused", "user_control", "stopped", "failed"]),
  paused: new Set(["recovering", "user_control", "stopped", "failed"]),
  user_control: new Set(["recovering", "paused", "stopped", "failed"]),
  recovering: new Set(["agent_observing", "paused", "user_control", "stopped", "failed"]),
  stopped: new Set(),
  failed: new Set(["stopped"])
};

export interface ComputerControlSnapshot {
  state: ComputerControlStateValue;
  revision: number;
  requiresFreshObservation: boolean;
  reason?: string;
}

export interface ComputerControlLease {
  readonly revision: number;
  readonly signal: AbortSignal;
  assertCurrent(expectedState?: ComputerControlStateValue): void;
}

/**
 * Synchronous control authority for one Computer Session.
 *
 * Any pause, takeover, stop, or failure increments the revision and aborts all
 * outstanding leases. Async work must assert its lease after every await and
 * immediately before native input.
 */
export class ComputerControlStateMachine {
  private stateValue: ComputerControlStateValue = "agent_observing";
  private revisionValue = 0;
  private freshObservationRequired = true;
  private reasonValue: string | undefined;
  private readonly leases = new Set<AbortController>();

  snapshot(): ComputerControlSnapshot {
    return {
      state: this.stateValue,
      revision: this.revisionValue,
      requiresFreshObservation: this.freshObservationRequired,
      ...(this.reasonValue ? { reason: this.reasonValue } : {})
    };
  }

  transition(nextInput: ComputerControlStateValue, reason?: string): ComputerControlSnapshot {
    const next = ComputerControlState.parse(nextInput);
    if (next === this.stateValue) return this.snapshot();
    if (!ALLOWED_TRANSITIONS[this.stateValue].has(next)) {
      throw new ComputerProtocolError(
        "INVALID_CONTROL_TRANSITION",
        `computer control cannot transition from ${this.stateValue} to ${next}`
      );
    }
    this.interrupt(reason);
    this.stateValue = next;
    this.reasonValue = reason;
    if (next === "paused" || next === "user_control" || next === "recovering") {
      this.freshObservationRequired = true;
    }
    return this.snapshot();
  }

  pause(reason = "paused by user"): ComputerControlSnapshot {
    if (TERMINAL_STATES.has(this.stateValue)) return this.snapshot();
    if (this.stateValue === "paused") return this.snapshot();
    return this.transition("paused", reason);
  }

  takeover(reason = "user took control"): ComputerControlSnapshot {
    if (TERMINAL_STATES.has(this.stateValue)) return this.snapshot();
    if (this.stateValue === "user_control") return this.snapshot();
    return this.transition("user_control", reason);
  }

  resume(reason = "agent control requested"): ComputerControlSnapshot {
    if (this.stateValue !== "paused") {
      throw new ComputerProtocolError("INVALID_CONTROL_TRANSITION", "only a paused Computer Session can resume");
    }
    return this.transition("recovering", reason);
  }

  returnControl(reason = "user returned control"): ComputerControlSnapshot {
    if (this.stateValue !== "user_control") {
      throw new ComputerProtocolError("INVALID_CONTROL_TRANSITION", "only a user-controlled Computer Session can return control");
    }
    return this.transition("recovering", reason);
  }

  recovered(): ComputerControlSnapshot {
    if (this.stateValue !== "recovering") {
      throw new ComputerProtocolError("INVALID_CONTROL_TRANSITION", "Computer Session is not recovering");
    }
    return this.transition("agent_observing", "fresh observation accepted after control recovery");
  }

  stop(reason = "Computer Session stopped"): ComputerControlSnapshot {
    if (this.stateValue === "stopped") return this.snapshot();
    if (this.stateValue === "failed") return this.transition("stopped", reason);
    return this.transition("stopped", reason);
  }

  fail(reason: string): ComputerControlSnapshot {
    if (!reason) throw new Error("failure reason is required");
    if (this.stateValue === "failed" || this.stateValue === "stopped") return this.snapshot();
    return this.transition("failed", reason);
  }

  lease(allowedStates: readonly ComputerControlStateValue[]): ComputerControlLease {
    if (!allowedStates.includes(this.stateValue)) {
      throw new ComputerControlInterruptedError(this.stateValue, this.reasonValue);
    }
    const controller = new AbortController();
    const revision = this.revisionValue;
    this.leases.add(controller);
    const assertCurrent = (expectedState?: ComputerControlStateValue): void => {
      if (
        controller.signal.aborted
        || revision !== this.revisionValue
        || (expectedState !== undefined && this.stateValue !== expectedState)
      ) {
        throw new ComputerControlInterruptedError(this.stateValue, this.reasonValue);
      }
    };
    return { revision, signal: controller.signal, assertCurrent };
  }

  release(lease: ComputerControlLease): void {
    for (const controller of this.leases) {
      if (controller.signal === lease.signal) {
        this.leases.delete(controller);
        return;
      }
    }
  }

  consumeFreshObservation(): void {
    this.freshObservationRequired = false;
  }

  private interrupt(reason?: string): void {
    this.revisionValue += 1;
    for (const controller of this.leases) controller.abort(reason);
    this.leases.clear();
  }
}

export class ComputerControlInterruptedError extends Error {
  readonly code = "CONTROL_INTERRUPTED" as const;

  constructor(readonly state: ComputerControlStateValue, reason?: string) {
    super(`Computer Session control changed to ${state}${reason ? `: ${reason}` : ""}`);
    this.name = "ComputerControlInterruptedError";
  }
}
