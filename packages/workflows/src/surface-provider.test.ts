import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserSession,
  type VisualComputerRuntime,
  type VisualMicroTask
} from "@adpilot/computer-use";
import {
  MemoryWorkflowRunStore,
  MemoryWorkflowStore,
  VisualRuntimeStepExecutor,
  Workflow,
  WorkflowRun,
  WorkflowRunner,
  WorkflowStep,
  browserSessionSurfaceProvider,
  deriveWorkflowPermissions,
  type StepExecutionRequest
} from "./index.js";

const NOW = "2026-07-29T00:00:00.000Z";

function makeStep(): ReturnType<typeof WorkflowStep.parse> {
  return WorkflowStep.parse({
    id: randomUUID(),
    order: 1,
    title: "点击保存",
    action: { kind: "click", x: 10, y: 20 },
    expectedResult: "保存成功",
    mutation: false
  });
}

function makeWorkflow(step: ReturnType<typeof WorkflowStep.parse>): ReturnType<typeof Workflow.parse> {
  return Workflow.parse({
    id: randomUUID(),
    workspaceId: "personal",
    title: "录制回放",
    source: { kind: "manual" },
    parameters: [],
    steps: [step],
    permissions: deriveWorkflowPermissions([step]),
    status: "published",
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1
  });
}

function makeRun(
  workflow: ReturnType<typeof Workflow.parse>,
  step: ReturnType<typeof WorkflowStep.parse>
): ReturnType<typeof WorkflowRun.parse> {
  return WorkflowRun.parse({
    id: randomUUID(),
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    workspaceId: workflow.workspaceId,
    parameters: {},
    status: "running",
    steps: [{ stepId: step.id, status: "pending", attempts: 0, evidenceIds: [] }],
    evidenceIds: [],
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1
  });
}

function makeRequest(): StepExecutionRequest {
  const step = makeStep();
  const workflow = makeWorkflow(step);
  const run = makeRun(workflow, step);
  return { workflow, run, step, renderedAction: step.action, expectedResult: step.expectedResult };
}

function makeConnectedSession(overrides: Record<string, unknown> = {}): BrowserSession {
  const sessionId = "a".repeat(32);
  return BrowserSession.parse({
    sessionId,
    clientId: "personal",
    browserProfile: "ads-profile",
    profileDirectory: "/profiles/ads-profile",
    nativeProfileFingerprint: "native-proof-1",
    processId: 4242,
    windowId: "window-9",
    windowBounds: { x: 0, y: 0, width: 1280, height: 800 },
    platform: "google_ads",
    runtimePlatform: "darwin",
    browserApplicationId: "com.google.Chrome",
    browserApp: "Google Chrome",
    sessionStatus: "connected",
    startedAt: NOW,
    updatedAt: NOW,
    pageIdentity: {
      status: "available",
      source: "macos_accessibility",
      browserSessionId: sessionId,
      clientId: "personal",
      browserProfile: "ads-profile",
      nativeProfileFingerprint: "native-proof-1",
      processId: 4242,
      windowId: "window-9",
      applicationId: "com.google.Chrome",
      observedAt: NOW,
      url: "https://ads.google.com/aw/campaigns",
      origin: "https://ads.google.com",
      title: "Google Ads — Campaigns",
      fingerprint: "b".repeat(64)
    },
    ...overrides
  });
}

describe("browserSessionSurfaceProvider", () => {
  it("resolves the exact connected browser session into the step surface context", async () => {
    const session = makeConnectedSession();
    const provider = browserSessionSurfaceProvider({ list: async () => [session] });

    const context = await provider(makeRequest());

    expect(context).toBeDefined();
    expect(context?.clientId).toBe("personal");
    expect(context?.platform).toBe("google_ads");
    expect(context?.surface).toEqual({
      app: "Google Chrome",
      applicationId: "com.google.Chrome",
      processId: 4242,
      windowId: "window-9",
      domain: "ads.google.com",
      url: "https://ads.google.com/aw/campaigns",
      origin: "https://ads.google.com",
      pageTitle: "Google Ads — Campaigns",
      browserProfile: "ads-profile",
      nativeProfileFingerprint: "native-proof-1",
      allowedApps: ["Google Chrome", "com.google.Chrome"],
      allowedDomains: ["ads.google.com"]
    });
  });

  it("omits page fields when no fresh page identity was observed", async () => {
    const session = makeConnectedSession({ pageIdentity: undefined });
    const provider = browserSessionSurfaceProvider({ list: async () => [session] });

    const context = await provider(makeRequest());

    expect(context?.surface.domain).toBeUndefined();
    expect(context?.surface.url).toBeUndefined();
    expect(context?.surface.allowedDomains).toEqual([]);
    expect(context?.surface.windowId).toBe("window-9");
  });

  it("returns undefined without a connected session for the run's workspace", async () => {
    const foreign = makeConnectedSession({ clientId: "someone-else" });
    const lost = makeConnectedSession({ sessionStatus: "lost", processId: undefined, windowId: undefined, windowBounds: undefined });

    for (const sessions of [
      { list: async () => [] as BrowserSession[] },
      { list: async () => [foreign] },
      { list: async () => [lost] }
    ]) {
      const provider = browserSessionSurfaceProvider(sessions);
      await expect(provider(makeRequest())).resolves.toBeUndefined();
    }
  });

  it("fails the step closed (recoverable) when no session exists instead of crashing", async () => {
    const step = makeStep();
    const workflow = makeWorkflow(step);
    const runtime = {
      runMicroTask: vi.fn(async () => {
        throw new Error("runtime must never be reached without a surface");
      }),
      verifyVisible: vi.fn()
    } as unknown as VisualComputerRuntime;
    const executor = new VisualRuntimeStepExecutor(
      runtime,
      browserSessionSurfaceProvider({ list: async () => [] })
    );
    const workflows = new MemoryWorkflowStore();
    await workflows.save(workflow);
    const runner = new WorkflowRunner({
      workflows,
      runs: new MemoryWorkflowRunStore(),
      executor
    });

    const created = await runner.createRun({ workflowId: workflow.id, workspaceId: "personal", parameters: {} });
    const finished = await runner.execute(created.id);

    // The default failure policy pauses for a human: the error is recoverable,
    // the run record is truthful, and nothing threw.
    expect(finished.status).toBe("paused");
    expect(finished.failureReason).toContain("no live execution surface is bound to this workflow run");
    expect(finished.steps[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(runtime.runMicroTask).not.toHaveBeenCalled();

    // Resume re-evaluates and fails closed the same way.
    const resumed = await runner.resume(created.id);
    expect(resumed.status).toBe("paused");
  });

  it("binds the provider surface into the micro-task handed to the runtime", async () => {
    const session = makeConnectedSession();
    const shot = {
      base64: "AAAA",
      width: 800,
      height: 600,
      scaleFactor: 2,
      capturedAt: NOW,
      sha256: "c".repeat(64)
    };
    const runtime = {
      runMicroTask: vi.fn(async (task: VisualMicroTask) => ({
        status: "done" as const,
        attempts: 1,
        action: {
          action: "click" as const,
          x: 10,
          y: 20,
          target: task.target,
          reason: "grounded",
          confidence: 1,
          expected_result: task.expectedResult,
          risk_level: "interact" as const
        },
        before: shot,
        after: shot,
        executed: true,
        verified: true
      }))
    } as unknown as VisualComputerRuntime;
    const executor = new VisualRuntimeStepExecutor(
      runtime,
      browserSessionSurfaceProvider({ list: async () => [session] })
    );

    const outcome = await executor.executeStep(makeRequest());

    expect(outcome.status).toBe("succeeded");
    expect(outcome.verification?.matched).toBe(true);
    expect(runtime.runMicroTask).toHaveBeenCalledTimes(1);
    const task = (runtime.runMicroTask as ReturnType<typeof vi.fn>).mock.calls[0]![0] as VisualMicroTask;
    expect(task.clientId).toBe("personal");
    expect(task.platform).toBe("google_ads");
    expect(task.surface).toMatchObject({
      app: "Google Chrome",
      applicationId: "com.google.Chrome",
      processId: 4242,
      windowId: "window-9",
      browserProfile: "ads-profile",
      nativeProfileFingerprint: "native-proof-1",
      url: "https://ads.google.com/aw/campaigns",
      origin: "https://ads.google.com"
    });
  });
});
