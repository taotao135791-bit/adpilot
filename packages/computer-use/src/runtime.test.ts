import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ControlledComputerRuntime,
  MemoryMutationReplayStore,
  fingerprintObservationSurface,
  mutationKeyFor,
  type ActionProposal,
  type ComputerAction,
  type ComputerRuntimeBackend,
  type ComputerSession,
  type GroundingRequest,
  type Observation,
  type ProposedComputerAction,
  type VerificationResult
} from "./index.js";

function createBackend() {
  let frameHash = "a".repeat(64);
  let proposed: ComputerAction = { kind: "click", x: 20, y: 30, coordinateSpace: "frame_pixels" };
  let risk: GroundingRequest["riskLevel"] = "interact";
  const execute = vi.fn(async () => {
    frameHash = "b".repeat(64);
    return { posted: true };
  });
  const verification = vi.fn(async (request): Promise<VerificationResult> => ({
    actionId: request.actionId,
    sessionId: request.sessionId,
    status: "passed",
    levels: [{ level: 1, status: "passed", evidence: ["native:posted"], reason: "posted" }],
    identityMatch: true,
    independentVerifier: "test-verifier",
    verifiedAt: "2026-07-28T00:00:05.000Z",
    reason: "visible result matched"
  }));
  const backend: ComputerRuntimeBackend = {
    observe: async (session) => observation(session, frameHash),
    propose: async () => ({
      action: proposed,
      proposedBy: "test-grounder",
      confidence: 1,
      reason: "target is visible"
    }),
    execute,
    verify: verification
  };
  return {
    backend,
    execute,
    verification,
    setFrameHash: (value: string) => { frameHash = value; },
    setProposal: (action: ComputerAction, nextRisk: GroundingRequest["riskLevel"]) => {
      proposed = action;
      risk = nextRisk;
    },
    get risk() { return risk; }
  };
}

async function start(runtime: ControlledComputerRuntime): Promise<ComputerSession> {
  return runtime.startSession({
    runId: "run-1",
    binding: {
      adPilotSessionId: "product-session-1",
      browserSessionId: "browser-session-1",
      clientId: "client-a",
      browserProfileId: "profile-a",
      platform: "google_ads"
    }
  });
}

function observation(session: ComputerSession, frameHash: string): Observation {
  const provisional: Observation = {
    id: randomUUID(),
    sessionId: session.id,
    frame: {
      id: randomUUID(),
      format: "png",
      base64: "pixels",
      width: 800,
      height: 600,
      sha256: frameHash,
      capturedAt: "2026-07-28T00:00:00.000Z",
      displayId: "display-1",
      displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
      scaleFactor: 2
    },
    activeApp: { pid: 42, bundleId: "com.google.Chrome", name: "Google Chrome" },
    activeWindow: {
      id: "window-1",
      title: "Google Ads",
      bounds: { x: 100, y: 50, width: 800, height: 600 }
    },
    browser: {
      url: "https://ads.google.com/campaigns/123",
      title: "Campaign",
      profileId: "profile-a",
      tabId: "tab-1",
      accountId: "account-1",
      pageType: "campaign",
      campaignId: "campaign-1"
    },
    surfaceFingerprint: "0".repeat(64)
  };
  return { ...provisional, surfaceFingerprint: fingerprintObservationSurface(provisional) };
}

function grounding(sessionId: string, observationId: string, riskLevel: GroundingRequest["riskLevel"]): GroundingRequest {
  return {
    sessionId,
    observationId,
    instruction: "perform one visible action",
    target: "target",
    expectedResult: "expected result is visible",
    riskLevel,
    allowedActions: ["click", "type"],
    allowedRegion: { x: 0, y: 0, width: 400, height: 300 }
  };
}

function policy(requiresApproval: boolean) {
  return {
    id: "policy-decision-1",
    decision: "allow" as const,
    reason: "allowed by test policy",
    evaluatedAt: "2026-07-28T00:00:01.000Z",
    requiresApproval
  };
}

async function proposalFor(
  runtime: ControlledComputerRuntime,
  session: ComputerSession,
  riskLevel: GroundingRequest["riskLevel"]
): Promise<ActionProposal> {
  const observed = await runtime.observe({ sessionId: session.id });
  return runtime.propose(grounding(session.id, observed.id, riskLevel));
}

describe("ControlledComputerRuntime", () => {
  it("runs one bound observe-propose-execute-verify cycle and records it", async () => {
    const fixture = createBackend();
    const runtime = new ControlledComputerRuntime(fixture.backend);
    const session = await start(runtime);
    const proposal = await proposalFor(runtime, session, "interact");
    const execution = await runtime.execute({
      sessionId: session.id,
      proposalId: proposal.id,
      actionId: proposal.actionId,
      policyDecision: policy(false)
    });
    expect(execution).toMatchObject({ status: "executed", actionId: proposal.actionId });
    const verification = await runtime.verify({
      sessionId: session.id,
      actionId: proposal.actionId,
      expectedResult: proposal.expectedResult,
      mutation: false,
      requirePersistence: false
    });
    expect(verification.status).toBe("passed");
    expect(await runtime.getSession(session.id)).toMatchObject({
      state: "agent_observing",
      controlOwner: "agent",
      requiresFreshObservation: false
    });
    expect(await runtime.getActionRecord(proposal.actionId)).toMatchObject({
      id: proposal.actionId,
      appPid: 42,
      appBundleId: "com.google.Chrome",
      windowId: "window-1",
      verificationResult: { status: "passed" }
    });
  });

  it("invalidates old coordinates when pixels change between grounding and execution", async () => {
    const fixture = createBackend();
    const runtime = new ControlledComputerRuntime(fixture.backend);
    const session = await start(runtime);
    const proposal = await proposalFor(runtime, session, "interact");
    fixture.setFrameHash("c".repeat(64));
    await expect(runtime.execute({
      sessionId: session.id,
      proposalId: proposal.id,
      actionId: proposal.actionId,
      policyDecision: policy(false)
    })).rejects.toMatchObject({ code: "SURFACE_CHANGED" });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("atomically blocks a replayed mutation before native input", async () => {
    const fixture = createBackend();
    fixture.setProposal({ kind: "type", text: "120" }, "mutate");
    const replay = new MemoryMutationReplayStore();
    const runtime = new ControlledComputerRuntime(fixture.backend, { mutationReplay: replay });
    const session = await start(runtime);
    const proposal = await proposalFor(runtime, session, "mutate");
    const approvalId = randomUUID();
    const mutationKey = mutationKeyFor(proposal, approvalId);
    await replay.claim({
      mutationKey,
      sessionId: session.id,
      actionId: proposal.actionId,
      approvalId,
      claimedAt: "2026-07-28T00:00:02.000Z"
    });
    await expect(runtime.execute({
      sessionId: session.id,
      proposalId: proposal.id,
      actionId: proposal.actionId,
      policyDecision: policy(true),
      approvalId,
      mutationKey
    })).resolves.toMatchObject({
      status: "blocked",
      blockerCode: "DUPLICATE_MUTATION"
    });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(await runtime.getSession(session.id)).toMatchObject({ state: "agent_observing" });
  });

  it("downgrades incomplete mutation verification to unknown", async () => {
    const fixture = createBackend();
    fixture.setProposal({ kind: "type", text: "120" }, "mutate");
    const runtime = new ControlledComputerRuntime(fixture.backend);
    const session = await start(runtime);
    const proposal = await proposalFor(runtime, session, "mutate");
    const approvalId = randomUUID();
    const mutationKey = mutationKeyFor(proposal, approvalId);
    await expect(runtime.execute({
      sessionId: session.id,
      proposalId: proposal.id,
      actionId: proposal.actionId,
      policyDecision: policy(true),
      approvalId,
      mutationKey
    })).resolves.toMatchObject({ status: "executed" });
    await expect(runtime.verify({
      sessionId: session.id,
      actionId: proposal.actionId,
      expectedResult: proposal.expectedResult,
      expectedValue: 120,
      mutation: true,
      requirePersistence: true
    })).resolves.toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("incomplete")
    });
  });

  it("aborts pending grounding on takeover and requires a fresh recovery observation", async () => {
    let release!: (value: ProposedComputerAction) => void;
    let started!: () => void;
    const groundingStarted = new Promise<void>((resolve) => { started = resolve; });
    const groundingResult = new Promise<ProposedComputerAction>((resolve) => { release = resolve; });
    const fixture = createBackend();
    fixture.backend.propose = async () => {
      started();
      return groundingResult;
    };
    fixture.backend.cancelPendingInput = vi.fn(async () => undefined);
    const runtime = new ControlledComputerRuntime(fixture.backend);
    const session = await start(runtime);
    const observed = await runtime.observe({ sessionId: session.id });
    const proposing = runtime.propose(grounding(session.id, observed.id, "interact"));
    await groundingStarted;
    await runtime.takeover(session.id);
    release({
      action: { kind: "click", x: 20, y: 30, coordinateSpace: "frame_pixels" },
      proposedBy: "late-grounder",
      confidence: 1,
      reason: "late"
    });
    await expect(proposing).rejects.toMatchObject({ code: "CONTROL_INTERRUPTED" });
    expect(await runtime.getSession(session.id)).toMatchObject({
      state: "user_control",
      controlOwner: "user",
      requiresFreshObservation: true
    });
    await runtime.returnControl(session.id);
    expect(await runtime.getSession(session.id)).toMatchObject({ state: "recovering" });
    await runtime.observe({ sessionId: session.id });
    expect(await runtime.getSession(session.id)).toMatchObject({
      state: "agent_observing",
      requiresFreshObservation: false
    });
  });

  it("turns physical user input during a mutation into unknown outcome without retry", async () => {
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => { executionStarted = resolve; });
    const fixture = createBackend();
    fixture.setProposal({ kind: "type", text: "120" }, "mutate");
    fixture.backend.execute = vi.fn(async (_action, _observation, context) => {
      executionStarted();
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("aborted before helper reply")), { once: true });
      });
    });
    const runtime = new ControlledComputerRuntime(fixture.backend);
    const session = await start(runtime);
    const proposal = await proposalFor(runtime, session, "mutate");
    const approvalId = randomUUID();
    const running = runtime.execute({
      sessionId: session.id,
      proposalId: proposal.id,
      actionId: proposal.actionId,
      policyDecision: policy(true),
      approvalId,
      mutationKey: mutationKeyFor(proposal, approvalId)
    });
    await started;
    await runtime.notifyUserInput(session.id);
    await expect(running).resolves.toMatchObject({
      status: "unknown",
      blockerCode: "MUTATION_OUTCOME_UNKNOWN",
      userTookOver: true
    });
    expect(fixture.backend.execute).toHaveBeenCalledOnce();
    expect(await runtime.getSession(session.id)).toMatchObject({ state: "user_control" });
  });
});
