import { createHash, randomUUID } from "node:crypto";
import {
  ActionExecution,
  ActionProposal,
  ComputerActionRecord,
  ComputerProtocolError,
  ComputerSession,
  ExecuteActionRequest,
  GroundingRequest,
  Observation,
  ObserveRequest,
  ProposedComputerAction,
  StartComputerSession,
  VerificationRequest,
  VerificationResult,
  assertObservationSelfConsistent,
  controlOwnerForState,
  isMutationRisk,
  type ActionExecution as ActionExecutionValue,
  type ActionProposal as ActionProposalValue,
  type ComputerAction,
  type ComputerActionRecord as ComputerActionRecordValue,
  type ComputerControlState,
  type ComputerSession as ComputerSessionValue,
  type ExecuteActionRequest as ExecuteActionRequestValue,
  type GroundingRequest as GroundingRequestValue,
  type Observation as ObservationValue,
  type ObserveRequest as ObserveRequestValue,
  type ProposedComputerAction as ProposedComputerActionValue,
  type StartComputerSession as StartComputerSessionValue,
  type VerificationRequest as VerificationRequestValue,
  type VerificationResult as VerificationResultValue
} from "./protocol.js";
import {
  ComputerControlInterruptedError,
  ComputerControlStateMachine,
  type ComputerControlLease
} from "./control-state.js";
import {
  MemoryMutationReplayStore,
  type MutationReplayStore
} from "./replay.js";

export interface ComputerRuntimeBackend {
  observe(session: ComputerSessionValue, signal: AbortSignal): Promise<ObservationValue>;
  propose(
    request: GroundingRequestValue,
    observation: ObservationValue,
    signal: AbortSignal
  ): Promise<ProposedComputerActionValue>;
  execute(
    action: ComputerAction,
    observation: ObservationValue,
    context: { session: ComputerSessionValue; actionId: string; signal: AbortSignal }
  ): Promise<unknown>;
  verify(
    request: VerificationRequestValue,
    context: {
      session: ComputerSessionValue;
      record: ComputerActionRecordValue;
      before: ObservationValue;
      after: ObservationValue;
      signal: AbortSignal;
    }
  ): Promise<VerificationResultValue>;
  /** Drop work that has not yet posted native input. Control state changes first. */
  cancelPendingInput?(sessionId: string): void | Promise<void>;
  stopSession?(sessionId: string): void | Promise<void>;
}

export interface ComputerActionRecordStore {
  save(record: ComputerActionRecordValue): Promise<void>;
  get(actionId: string): Promise<ComputerActionRecordValue | undefined>;
  list(sessionId: string): Promise<ComputerActionRecordValue[]>;
}

export class MemoryComputerActionRecordStore implements ComputerActionRecordStore {
  private readonly records = new Map<string, ComputerActionRecordValue>();

  async save(recordInput: ComputerActionRecordValue): Promise<void> {
    const record = ComputerActionRecord.parse(recordInput);
    this.records.set(record.id, record);
  }

  async get(actionId: string): Promise<ComputerActionRecordValue | undefined> {
    return this.records.get(actionId);
  }

  async list(sessionId: string): Promise<ComputerActionRecordValue[]> {
    return [...this.records.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }
}

export interface ComputerRuntimeOptions {
  mutationReplay?: MutationReplayStore;
  records?: ComputerActionRecordStore;
  now?: () => Date;
  id?: () => string;
  proposalTtlMs?: number;
  onSessionChanged?: (session: ComputerSessionValue) => void | Promise<void>;
}

export interface ComputerRuntime {
  startSession(input: StartComputerSessionValue): Promise<ComputerSessionValue>;
  observe(input: ObserveRequestValue): Promise<ObservationValue>;
  propose(input: GroundingRequestValue): Promise<ActionProposalValue>;
  execute(input: ExecuteActionRequestValue): Promise<ActionExecutionValue>;
  verify(input: VerificationRequestValue): Promise<VerificationResultValue>;
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  takeover(sessionId: string): Promise<void>;
  returnControl(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
}

type SessionEntry = {
  session: ComputerSessionValue;
  machine: ComputerControlStateMachine;
  observations: Map<string, ObservationValue>;
  currentObservationId: string | undefined;
  proposals: Map<string, ActionProposalValue>;
};

/**
 * Session-scoped Computer Runtime. It owns control authority and ordering, while
 * the backend owns observation, model grounding, native execution, and
 * independent verification.
 */
export class ControlledComputerRuntime implements ComputerRuntime {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly activeBindings = new Map<string, string>();
  private readonly busySessions = new Set<string>();
  private readonly mutationReplay: MutationReplayStore;
  private readonly records: ComputerActionRecordStore;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly proposalTtlMs: number;
  private readonly onSessionChanged: (session: ComputerSessionValue) => void | Promise<void>;

  constructor(private readonly backend: ComputerRuntimeBackend, options: ComputerRuntimeOptions = {}) {
    this.mutationReplay = options.mutationReplay ?? new MemoryMutationReplayStore();
    this.records = options.records ?? new MemoryComputerActionRecordStore();
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.proposalTtlMs = options.proposalTtlMs ?? 30_000;
    this.onSessionChanged = options.onSessionChanged ?? (() => undefined);
    if (!Number.isInteger(this.proposalTtlMs) || this.proposalTtlMs < 1_000 || this.proposalTtlMs > 300_000) {
      throw new Error("proposalTtlMs must be an integer between 1000 and 300000");
    }
  }

  async startSession(input: StartComputerSessionValue): Promise<ComputerSessionValue> {
    const parsed = StartComputerSession.parse(input);
    const bindingKey = sessionBindingKey(parsed.binding.adPilotSessionId, parsed.binding.browserSessionId);
    const activeId = this.activeBindings.get(bindingKey);
    if (activeId) {
      const active = this.sessions.get(activeId)?.session;
      if (active && active.state !== "stopped" && active.state !== "failed") {
        throw new ComputerProtocolError(
          "SESSION_BINDING_IN_USE",
          "this AdPilot Session and Browser Session are already controlled by another Computer Session"
        );
      }
    }
    const now = this.now().toISOString();
    const machine = new ComputerControlStateMachine();
    const snapshot = machine.snapshot();
    const session = ComputerSession.parse({
      id: this.id(),
      runId: parsed.runId,
      binding: parsed.binding,
      state: snapshot.state,
      controlOwner: controlOwnerForState(snapshot.state),
      revision: snapshot.revision,
      requiresFreshObservation: snapshot.requiresFreshObservation,
      startedAt: now,
      updatedAt: now
    });
    this.sessions.set(session.id, {
      session,
      machine,
      observations: new Map(),
      currentObservationId: undefined,
      proposals: new Map()
    });
    this.activeBindings.set(bindingKey, session.id);
    await this.onSessionChanged(session);
    return session;
  }

  async observe(input: ObserveRequestValue): Promise<ObservationValue> {
    const request = ObserveRequest.parse(input);
    return this.exclusive(request.sessionId, async (entry) => {
      const allowed: ComputerControlState[] = entry.session.state === "recovering"
        ? ["recovering"]
        : entry.session.state === "paused"
          ? ["paused"]
          : entry.session.state === "user_control"
            ? ["user_control"]
            : ["agent_observing"];
      const lease = entry.machine.lease(allowed);
      try {
        const observed = await this.backend.observe(entry.session, lease.signal);
        lease.assertCurrent(allowed[0]);
        const observation = this.acceptObservation(entry, observed);
        if (entry.session.state === "recovering") {
          entry.machine.consumeFreshObservation();
          entry.machine.recovered();
          entry.currentObservationId = observation.id;
          await this.syncSession(entry, observation);
        } else if (entry.session.state === "agent_observing") {
          entry.machine.consumeFreshObservation();
          entry.currentObservationId = observation.id;
          await this.syncSession(entry, observation);
        } else {
          // Paused/user-control captures are for monitoring and Live View only.
          // They can never become an executable grounding source.
          await this.syncSession(entry);
        }
        return observation;
      } finally {
        entry.machine.release(lease);
      }
    });
  }

  async propose(input: GroundingRequestValue): Promise<ActionProposalValue> {
    const request = GroundingRequest.parse(input);
    return this.exclusive(request.sessionId, async (entry) => {
      if (entry.session.requiresFreshObservation || entry.currentObservationId !== request.observationId) {
        throw new ComputerProtocolError(
          "STALE_OBSERVATION",
          "grounding requires the latest fresh observation for this Computer Session"
        );
      }
      const observation = entry.observations.get(request.observationId);
      if (!observation) throw new ComputerProtocolError("OBSERVATION_NOT_FOUND", "grounding observation is unavailable");
      entry.machine.transition("agent_proposing", "grounding one atomic action");
      await this.syncSession(entry);
      const lease = entry.machine.lease(["agent_proposing"]);
      try {
        const raw = ProposedComputerAction.parse(await this.backend.propose(request, observation, lease.signal));
        lease.assertCurrent("agent_proposing");
        if (!request.allowedActions.includes(raw.action.kind)) {
          throw new ComputerProtocolError("POLICY_BLOCKED", `action ${raw.action.kind} is not allowed by this grounding request`);
        }
        assertActionInsideObservation(raw.action, observation, request.allowedRegion);
        const createdAt = this.now();
        const proposal = ActionProposal.parse({
          id: this.id(),
          actionId: this.id(),
          sessionId: entry.session.id,
          observationId: observation.id,
          surfaceFingerprint: observation.surfaceFingerprint,
          action: raw.action,
          proposedBy: raw.proposedBy,
          confidence: raw.confidence,
          reason: raw.reason,
          target: request.target,
          expectedResult: request.expectedResult,
          riskLevel: request.riskLevel,
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(createdAt.getTime() + this.proposalTtlMs).toISOString()
        });
        entry.proposals.clear();
        entry.proposals.set(proposal.id, proposal);
        entry.machine.transition(
          isMutationRisk(proposal.riskLevel) ? "awaiting_approval" : "agent_observing",
          isMutationRisk(proposal.riskLevel) ? "atomic mutation proposal awaits approval" : "atomic proposal is ready"
        );
        await this.syncSession(entry);
        return proposal;
      } catch (error) {
        if (entry.machine.snapshot().state === "agent_proposing") {
          entry.machine.transition("agent_observing", "grounding failed");
          await this.syncSession(entry);
        }
        throw error;
      } finally {
        entry.machine.release(lease);
      }
    });
  }

  async execute(input: ExecuteActionRequestValue): Promise<ActionExecutionValue> {
    const request = ExecuteActionRequest.parse(input);
    return this.exclusive(request.sessionId, async (entry) => {
      const proposal = entry.proposals.get(request.proposalId);
      if (!proposal || proposal.actionId !== request.actionId) {
        throw new ComputerProtocolError("PROPOSAL_NOT_FOUND", "action proposal is missing, stale, or belongs to another action");
      }
      if (Date.parse(proposal.expiresAt) <= this.now().getTime()) {
        entry.proposals.delete(proposal.id);
        throw new ComputerProtocolError("PROPOSAL_EXPIRED", "action proposal expired before execution");
      }
      if (request.policyDecision.decision !== "allow") {
        return this.blockedExecution(entry, proposal, request, "POLICY_DENIED", request.policyDecision.reason);
      }
      const mutation = isMutationRisk(proposal.riskLevel);
      if (mutation && (!request.policyDecision.requiresApproval || !request.approvalId || !request.mutationKey)) {
        throw new ComputerProtocolError(
          "APPROVAL_REQUIRED",
          "mutation execution requires an approval-bound policy decision and mutation key"
        );
      }
      if (!mutation && request.policyDecision.requiresApproval && !request.approvalId) {
        throw new ComputerProtocolError("APPROVAL_REQUIRED", "policy requires an approval for this action");
      }
      if (mutation) {
        const expectedKey = mutationKeyFor(proposal, request.approvalId!);
        if (request.mutationKey !== expectedKey) {
          throw new ComputerProtocolError("MUTATION_KEY_INVALID", "mutation key is not bound to this proposal and approval");
        }
      }

      const expectedState: ComputerControlState = mutation ? "awaiting_approval" : "agent_observing";
      if (entry.session.state !== expectedState) {
        throw new ComputerControlInterruptedError(entry.session.state);
      }
      const groundingObservation = entry.observations.get(proposal.observationId);
      if (!groundingObservation || entry.currentObservationId !== groundingObservation.id) {
        throw new ComputerProtocolError("STALE_OBSERVATION", "proposal no longer has its exact grounding observation");
      }

      // Capture immediately before native input. Any pixel or identity change
      // invalidates the coordinates and the proposal, even if the window stayed open.
      const preflightLease = entry.machine.lease([expectedState]);
      let before: ObservationValue;
      try {
        before = this.acceptObservation(
          entry,
          await this.backend.observe(entry.session, preflightLease.signal)
        );
        preflightLease.assertCurrent(expectedState);
      } finally {
        entry.machine.release(preflightLease);
      }
      if (
        before.surfaceFingerprint !== proposal.surfaceFingerprint
        || before.frame.sha256 !== groundingObservation.frame.sha256
      ) {
        entry.proposals.delete(proposal.id);
        entry.currentObservationId = before.id;
        entry.machine.consumeFreshObservation();
        if (entry.session.state === "awaiting_approval") {
          entry.machine.transition("agent_observing", "surface changed before approved input");
        }
        await this.syncSession(entry, before);
        throw new ComputerProtocolError(
          "SURFACE_CHANGED",
          "pixels or surface identity changed after grounding; observe, ground, and approve again"
        );
      }

      if (mutation) {
        const claimed = await this.mutationReplay.claim({
          mutationKey: request.mutationKey!,
          sessionId: entry.session.id,
          actionId: proposal.actionId,
          approvalId: request.approvalId!,
          claimedAt: this.now().toISOString()
        });
        if (!claimed) {
          return this.blockedExecution(
            entry,
            proposal,
            request,
            "DUPLICATE_MUTATION",
            "this approved mutation was already attempted and cannot be replayed"
          );
        }
      }

      entry.machine.transition("agent_executing", "posting one atomic native action");
      await this.syncSession(entry);
      const lease = entry.machine.lease(["agent_executing"]);
      const startedAt = this.now().toISOString();
      let record = actionRecord(entry.session, proposal, request, before, startedAt);
      await this.records.save(record);
      try {
        // Replay protection is already reserved before entering this call.
        lease.assertCurrent("agent_executing");
        const executionResult = await this.backend.execute(proposal.action, before, {
          session: entry.session,
          actionId: proposal.actionId,
          signal: lease.signal
        });
        lease.assertCurrent("agent_executing");
        const after = this.acceptObservation(entry, await this.backend.observe(entry.session, lease.signal));
        lease.assertCurrent("agent_executing");
        entry.currentObservationId = after.id;
        entry.machine.consumeFreshObservation();
        entry.machine.transition("verifying", "native action returned; independent verification required");
        const completedAt = this.now().toISOString();
        record = ComputerActionRecord.parse({
          ...record,
          completedAt,
          afterFrameId: after.frame.id,
          executionResult,
          userTookOver: false
        });
        await this.records.save(record);
        entry.proposals.delete(proposal.id);
        await this.syncSession(entry, after);
        return ActionExecution.parse({
          actionId: proposal.actionId,
          sessionId: entry.session.id,
          status: "executed",
          startedAt,
          completedAt,
          beforeFrameId: before.frame.id,
          afterFrameId: after.frame.id,
          executionResult,
          userTookOver: false
        });
      } catch (error) {
        const state = entry.machine.snapshot().state;
        const interrupted = error instanceof ComputerControlInterruptedError || lease.signal.aborted;
        const userTookOver = state === "user_control";
        const status = mutation ? "unknown" : "blocked";
        const code = mutation ? "MUTATION_OUTCOME_UNKNOWN" : interrupted ? "CONTROL_INTERRUPTED" : "ACTION_FAILED";
        const reason = errorMessage(error);
        const completedAt = this.now().toISOString();
        record = ComputerActionRecord.parse({
          ...record,
          completedAt,
          executionResult: { status, code, reason },
          userTookOver
        });
        await this.records.save(record);
        entry.proposals.delete(proposal.id);
        if (state === "agent_executing") {
          entry.machine.transition("agent_observing", "native action failed");
          await this.syncSession(entry);
        }
        return ActionExecution.parse({
          actionId: proposal.actionId,
          sessionId: entry.session.id,
          status,
          startedAt,
          completedAt,
          beforeFrameId: before.frame.id,
          blockerCode: code,
          blockerReason: reason,
          userTookOver
        });
      } finally {
        entry.machine.release(lease);
      }
    });
  }

  async verify(input: VerificationRequestValue): Promise<VerificationResultValue> {
    const request = VerificationRequest.parse(input);
    return this.exclusive(request.sessionId, async (entry) => {
      if (entry.session.state !== "verifying") {
        throw new ComputerProtocolError("NOT_VERIFYING", "Computer Session has no executed action awaiting verification");
      }
      const record = await this.records.get(request.actionId);
      if (!record || record.sessionId !== entry.session.id || !record.afterFrameId) {
        throw new ComputerProtocolError("ACTION_NOT_FOUND", "executed action record is unavailable for verification");
      }
      const before = findObservationByFrame(entry, record.beforeFrameId);
      const after = findObservationByFrame(entry, record.afterFrameId);
      if (!before || !after) {
        throw new ComputerProtocolError("EVIDENCE_NOT_FOUND", "before/after observations are unavailable for verification");
      }
      const lease = entry.machine.lease(["verifying"]);
      try {
        let result: VerificationResultValue;
        try {
          result = VerificationResult.parse(await this.backend.verify(request, {
            session: entry.session,
            record,
            before,
            after,
            signal: lease.signal
          }));
          lease.assertCurrent("verifying");
          if (result.actionId !== request.actionId || result.sessionId !== request.sessionId) {
            throw new ComputerProtocolError("VERIFICATION_BINDING_INVALID", "verification result is bound to another action or session");
          }
          if (request.mutation && !mutationVerificationIsComplete(result, request.requirePersistence)) {
            result = VerificationResult.parse({
              ...result,
              status: "unknown",
              reason: "mutation verification is incomplete; exact value, persistence, identity, and all five levels must pass"
            });
          }
        } catch (error) {
          if (error instanceof ComputerControlInterruptedError || lease.signal.aborted) throw error;
          result = VerificationResult.parse({
            actionId: request.actionId,
            sessionId: request.sessionId,
            status: "unknown",
            levels: [{
              level: 1,
              status: "unknown",
              evidence: [],
              reason: "independent verification did not return a valid result"
            }],
            identityMatch: false,
            independentVerifier: "runtime-fail-closed",
            verifiedAt: this.now().toISOString(),
            reason: errorMessage(error)
          });
        }
        const updated = ComputerActionRecord.parse({ ...record, verificationResult: result });
        await this.records.save(updated);
        entry.machine.transition("agent_observing", `verification ${result.status}`);
        await this.syncSession(entry, after);
        return result;
      } finally {
        entry.machine.release(lease);
      }
    });
  }

  async pause(sessionId: string): Promise<void> {
    const entry = this.requireEntry(sessionId);
    entry.machine.pause();
    entry.currentObservationId = undefined;
    entry.proposals.clear();
    await this.syncSession(entry);
    await this.backend.cancelPendingInput?.(sessionId);
  }

  async resume(sessionId: string): Promise<void> {
    const entry = this.requireEntry(sessionId);
    entry.machine.resume();
    entry.currentObservationId = undefined;
    entry.proposals.clear();
    await this.syncSession(entry);
  }

  async takeover(sessionId: string): Promise<void> {
    const entry = this.requireEntry(sessionId);
    entry.machine.takeover();
    entry.currentObservationId = undefined;
    entry.proposals.clear();
    await this.syncSession(entry);
    await this.backend.cancelPendingInput?.(sessionId);
  }

  async returnControl(sessionId: string): Promise<void> {
    const entry = this.requireEntry(sessionId);
    entry.machine.returnControl();
    entry.currentObservationId = undefined;
    entry.proposals.clear();
    await this.syncSession(entry);
  }

  async stop(sessionId: string): Promise<void> {
    const entry = this.requireEntry(sessionId);
    entry.machine.stop();
    entry.currentObservationId = undefined;
    entry.proposals.clear();
    await this.syncSession(entry);
    await this.backend.cancelPendingInput?.(sessionId);
    await this.backend.stopSession?.(sessionId);
    this.activeBindings.delete(sessionBindingKey(
      entry.session.binding.adPilotSessionId,
      entry.session.binding.browserSessionId
    ));
  }

  /** Real mouse/keyboard activity is an immediate takeover, never a hint. */
  async notifyUserInput(sessionId: string, detail = "physical user input detected"): Promise<void> {
    await this.takeoverWithReason(sessionId, detail);
  }

  async getSession(sessionId: string): Promise<ComputerSessionValue> {
    return this.requireEntry(sessionId).session;
  }

  async getActionRecord(actionId: string): Promise<ComputerActionRecordValue | undefined> {
    return this.records.get(actionId);
  }

  async listActionRecords(sessionId: string): Promise<ComputerActionRecordValue[]> {
    this.requireEntry(sessionId);
    return this.records.list(sessionId);
  }

  private async takeoverWithReason(sessionId: string, reason: string): Promise<void> {
    const entry = this.requireEntry(sessionId);
    entry.machine.takeover(reason);
    entry.currentObservationId = undefined;
    entry.proposals.clear();
    await this.syncSession(entry);
    await this.backend.cancelPendingInput?.(sessionId);
  }

  private acceptObservation(entry: SessionEntry, input: ObservationValue): ObservationValue {
    const observation = assertObservationSelfConsistent(input);
    if (observation.sessionId !== entry.session.id) {
      throw new ComputerProtocolError("SESSION_MISMATCH", "observation belongs to another Computer Session");
    }
    entry.session = ComputerSession.parse({
      ...entry.session,
      binding: bindOrAssertIdentity(entry.session.binding, observation)
    });
    entry.observations.set(observation.id, observation);
    return observation;
  }

  private async blockedExecution(
    entry: SessionEntry,
    proposal: ActionProposalValue,
    request: ExecuteActionRequestValue,
    blockerCode: string,
    blockerReason: string
  ): Promise<ActionExecutionValue> {
    const before = entry.observations.get(proposal.observationId);
    if (!before) throw new ComputerProtocolError("OBSERVATION_NOT_FOUND", "proposal observation is unavailable");
    const now = this.now().toISOString();
    const record = ComputerActionRecord.parse({
      ...actionRecord(entry.session, proposal, request, before, now),
      completedAt: now,
      executionResult: { status: "blocked", blockerCode, blockerReason }
    });
    await this.records.save(record);
    entry.proposals.delete(proposal.id);
    if (entry.machine.snapshot().state === "awaiting_approval") {
      entry.machine.transition("agent_observing", `action blocked: ${blockerCode}`);
      await this.syncSession(entry);
    }
    return ActionExecution.parse({
      actionId: proposal.actionId,
      sessionId: entry.session.id,
      status: "blocked",
      startedAt: now,
      completedAt: now,
      beforeFrameId: before.frame.id,
      blockerCode,
      blockerReason,
      userTookOver: false
    });
  }

  private async exclusive<T>(sessionId: string, operation: (entry: SessionEntry) => Promise<T>): Promise<T> {
    const entry = this.requireEntry(sessionId);
    if (this.busySessions.has(sessionId)) {
      throw new ComputerProtocolError("SESSION_BUSY", "Computer Session already has an in-flight operation");
    }
    this.busySessions.add(sessionId);
    try {
      return await operation(entry);
    } finally {
      this.busySessions.delete(sessionId);
    }
  }

  private requireEntry(sessionId: string): SessionEntry {
    const parsed = ComputerSession.shape.id.parse(sessionId);
    const entry = this.sessions.get(parsed);
    if (!entry) throw new ComputerProtocolError("SESSION_NOT_FOUND", "Computer Session does not exist");
    return entry;
  }

  private async syncSession(entry: SessionEntry, observation?: ObservationValue): Promise<void> {
    const snapshot = entry.machine.snapshot();
    entry.session = ComputerSession.parse({
      ...entry.session,
      state: snapshot.state,
      controlOwner: controlOwnerForState(snapshot.state),
      revision: snapshot.revision,
      requiresFreshObservation: snapshot.requiresFreshObservation,
      updatedAt: this.now().toISOString(),
      ...(observation && entry.currentObservationId === observation.id
        ? { lastObservationId: observation.id, surfaceFingerprint: observation.surfaceFingerprint }
        : {}),
      ...(snapshot.state === "failed" && snapshot.reason ? { failureReason: snapshot.reason } : {})
    });
    await this.onSessionChanged(entry.session);
  }
}

export function mutationKeyFor(proposalInput: ActionProposalValue, approvalId: string): string {
  const proposal = ActionProposal.parse(proposalInput);
  const parsedApprovalId = ComputerSession.shape.id.parse(approvalId);
  return createHash("sha256").update(JSON.stringify({
    sessionId: proposal.sessionId,
    proposalId: proposal.id,
    actionId: proposal.actionId,
    observationId: proposal.observationId,
    surfaceFingerprint: proposal.surfaceFingerprint,
    action: proposal.action,
    riskLevel: proposal.riskLevel,
    approvalId: parsedApprovalId
  })).digest("hex");
}

function bindOrAssertIdentity(
  binding: ComputerSessionValue["binding"],
  observation: ObservationValue
): ComputerSessionValue["binding"] {
  const browser = observation.browser;
  if (!browser) throw new ComputerProtocolError("BROWSER_IDENTITY_MISSING", "browser observation is required");
  const actualOrigin = browser.url ? new URL(browser.url).origin : undefined;
  const mismatches: string[] = [];
  compareIdentity("application", binding.applicationId, observation.activeApp.bundleId, mismatches);
  compareIdentity("process", binding.appPid, observation.activeApp.pid, mismatches);
  compareIdentity("window", binding.windowId, observation.activeWindow.id, mismatches);
  compareIdentity("browser Profile", binding.browserProfileId, browser.profileId, mismatches);
  compareIdentity("browser tab", binding.tabId, browser.tabId, mismatches);
  compareIdentity("browser origin", binding.urlOrigin, actualOrigin, mismatches);
  compareIdentity("account", binding.accountId, browser.accountId, mismatches);
  compareIdentity("page type", binding.pageType, browser.pageType, mismatches);
  compareIdentity("Campaign", binding.campaignId, browser.campaignId, mismatches);
  if (mismatches.length) {
    throw new ComputerProtocolError("BROWSER_IDENTITY_CHANGED", mismatches.join("; "));
  }
  return {
    ...binding,
    applicationId: binding.applicationId ?? observation.activeApp.bundleId,
    appPid: binding.appPid ?? observation.activeApp.pid,
    windowId: binding.windowId ?? observation.activeWindow.id,
    ...(binding.tabId ?? browser.tabId ? { tabId: binding.tabId ?? browser.tabId } : {}),
    ...(binding.urlOrigin ?? actualOrigin ? { urlOrigin: binding.urlOrigin ?? actualOrigin } : {}),
    ...(binding.accountId ?? browser.accountId ? { accountId: binding.accountId ?? browser.accountId } : {}),
    ...(binding.pageType ?? browser.pageType ? { pageType: binding.pageType ?? browser.pageType } : {}),
    ...(binding.campaignId ?? browser.campaignId ? { campaignId: binding.campaignId ?? browser.campaignId } : {})
  };
}

function compareIdentity(
  label: string,
  expected: string | number | undefined,
  actual: string | number | undefined,
  mismatches: string[]
): void {
  if (expected === undefined) return;
  if (actual === undefined) {
    mismatches.push(`${label} proof is missing`);
  } else if (expected !== actual) {
    mismatches.push(`${label} changed (${expected} -> ${actual})`);
  }
}

function assertActionInsideObservation(
  action: ComputerAction,
  observation: ObservationValue,
  allowedRegion?: { x: number; y: number; width: number; height: number }
): void {
  const points: Array<[number, number]> = [];
  if ("x" in action) points.push([action.x, action.y]);
  if (action.kind === "drag") points.push([action.endX, action.endY]);
  for (const [x, y] of points) {
    if (x >= observation.frame.width || y >= observation.frame.height) {
      throw new ComputerProtocolError("COORDINATES_OUT_OF_BOUNDS", "action coordinates are outside the current frame");
    }
    if (
      allowedRegion
      && (
        x < allowedRegion.x
        || y < allowedRegion.y
        || x >= allowedRegion.x + allowedRegion.width
        || y >= allowedRegion.y + allowedRegion.height
      )
    ) {
      throw new ComputerProtocolError("POLICY_BLOCKED", "action coordinates are outside the approved region");
    }
  }
}

function actionRecord(
  session: ComputerSessionValue,
  proposal: ActionProposalValue,
  request: ExecuteActionRequestValue,
  before: ObservationValue,
  startedAt: string
): ComputerActionRecordValue {
  return ComputerActionRecord.parse({
    id: proposal.actionId,
    sessionId: session.id,
    runId: session.runId,
    appPid: before.activeApp.pid,
    appBundleId: before.activeApp.bundleId,
    windowId: before.activeWindow.id,
    ...(before.activeWindow.title ? { windowTitle: before.activeWindow.title } : {}),
    displayId: before.frame.displayId,
    scaleFactor: before.frame.scaleFactor,
    beforeFrameId: before.frame.id,
    action: proposal.action,
    proposedBy: proposal.proposedBy,
    policyDecision: request.policyDecision.id,
    ...(request.approvalId ? { approvalId: request.approvalId } : {}),
    startedAt,
    userTookOver: false
  });
}

function mutationVerificationIsComplete(result: VerificationResultValue, requirePersistence: boolean): boolean {
  const levels = new Map(result.levels.map((level) => [level.level, level.status]));
  return result.status === "passed"
    && [1, 2, 3, 4, 5].every((level) => levels.get(level as 1 | 2 | 3 | 4 | 5) === "passed")
    && result.exactValueMatch === true
    && result.identityMatch
    && (!requirePersistence || result.persistedAfterRefresh === true);
}

function findObservationByFrame(entry: SessionEntry, frameId: string): ObservationValue | undefined {
  return [...entry.observations.values()].find((observation) => observation.frame.id === frameId);
}

function sessionBindingKey(adPilotSessionId: string, browserSessionId: string): string {
  return `${adPilotSessionId}\u0000${browserSessionId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
