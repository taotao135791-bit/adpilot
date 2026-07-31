import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryComputerActionRecordStore,
  type ComputerAction,
  type ComputerActionRecord
} from "@adpilot/computer-use";
import { SkillRegistry } from "@adpilot/skills";
import {
  FileWorkflowRunStore,
  FileWorkflowStore,
  MemoryWorkflowRunStore,
  MemoryWorkflowStore,
  Workflow,
  WorkflowError,
  WorkflowRun,
  WorkflowRecorder,
  WorkflowRunner,
  publishAsSkill,
  workflowSkillName,
  type StepExecutionOutcome,
  type StepExecutionRequest,
  type StepExecutor,
  type WorkflowRun as WorkflowRunValue,
  type WorkflowRunFilter,
  type WorkflowRunStore,
  type WorkflowStep,
  type WorkflowStepAction
} from "./index.js";

const SESSION_ID = randomUUID();
const RUN_ID = "task-record-demo";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/* ------------------------------------------------------------------------ */
/* Recorder                                                                  */
/* ------------------------------------------------------------------------ */

describe("WorkflowRecorder", () => {
  it("converts a recorded run into a parameterized draft workflow", async () => {
    const records = new MemoryComputerActionRecordStore();
    const stamp = (minute: number) => `2026-07-28T10:${String(minute).padStart(2, "0")}:00.000Z`;
    const entries: Array<[ComputerAction, Partial<ComputerActionRecord>, number]> = [
      [{ kind: "click", x: 120, y: 240, coordinateSpace: "frame_pixels" }, {}, 0],
      [{ kind: "type", text: "Acme Spring Campaign" }, {}, 1],
      [{ kind: "type", text: "2026-07-28" }, {}, 2],
      [{ kind: "type", text: "Acme Spring Campaign" }, {}, 3],
      [{ kind: "scroll", x: 400, y: 300, deltaX: 0, deltaY: 640, coordinateSpace: "frame_pixels" }, {}, 4],
      [{ kind: "wait", milliseconds: 800 }, {}, 5],
      [{ kind: "keypress", keys: ["CMD", "S"] }, { approvalId: randomUUID() }, 6],
      [{ kind: "move", x: 10, y: 10, coordinateSpace: "frame_pixels" }, {}, 7],
      [{ kind: "click", x: 1, y: 1, coordinateSpace: "frame_pixels" }, { executionResult: { status: "blocked" } }, 8]
    ];
    for (const [action, overrides, minute] of entries) {
      await records.save(recordFor(action, { ...overrides, startedAt: stamp(minute) }));
    }
    const workflows = new MemoryWorkflowStore();
    const recorder = new WorkflowRecorder({ records, workflows });

    const draft = await recorder.createDraft({
      workspaceId: "personal",
      sessionId: SESSION_ID,
      runId: RUN_ID,
      title: "录制：创建春季 campaign"
    });

    expect(draft.status).toBe("draft");
    expect(draft.workspaceId).toBe("personal");
    expect(draft.source).toMatchObject({ kind: "recorded", sessionId: SESSION_ID, runId: RUN_ID });

    // move + blocked records are skipped; the rest map 1:1 in startedAt order.
    expect(draft.steps.map((step) => step.action.kind)).toEqual([
      "click", "type", "type", "type", "scroll", "wait", "keypress"
    ]);
    expect(draft.steps.map((step) => step.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Parameter extraction: two distinct typed texts become two parameters,
    // the repeated text reuses the first one.
    expect(draft.parameters).toHaveLength(2);
    expect(draft.parameters[0]).toMatchObject({
      name: "value",
      required: true,
      defaultValue: "Acme Spring Campaign",
      example: "Acme Spring Campaign"
    });
    expect(draft.parameters[1]).toMatchObject({ name: "value2", defaultValue: "2026-07-28" });
    expect(draft.steps[1]!.action).toEqual({ kind: "type", text: "{{value}}" });
    expect(draft.steps[2]!.action).toEqual({ kind: "type", text: "{{value2}}" });
    expect(draft.steps[3]!.action).toEqual({ kind: "type", text: "{{value}}" });
    expect(draft.steps[1]!.parameters).toEqual(["value"]);

    // Anchors never invent data the record does not contain.
    for (const step of draft.steps) expect(step.anchor).toEqual({});

    // Recorded coordinates and deltas survive as action hints.
    expect(draft.steps[0]!.action).toEqual({ kind: "click", x: 120, y: 240 });
    expect(draft.steps[4]!.action).toMatchObject({ kind: "scroll", direction: "down", x: 400, y: 300 });
    expect(draft.steps[5]!.action).toEqual({ kind: "wait", milliseconds: 800 });

    // The approval-bound record becomes the only mutation step.
    expect(draft.steps.filter((step) => step.mutation).map((step) => step.order)).toEqual([7]);
    expect(draft.permissions).toMatchObject({
      requiresMutation: true,
      requiresApproval: true
    });
    expect(draft.permissions.requiredPermissions).toContain("MUTATE");
    expect(draft.permissions.requiredPermissions).toContain("INTERACT");

    // The draft is persisted.
    expect((await workflows.get(draft.id))?.id).toBe(draft.id);
  });

  it("rejects runs without replayable records", async () => {
    const recorder = new WorkflowRecorder({
      records: new MemoryComputerActionRecordStore(),
      workflows: new MemoryWorkflowStore()
    });
    await expect(
      recorder.createDraft({ workspaceId: "personal", sessionId: SESSION_ID, runId: "missing", title: "x" })
    ).rejects.toMatchObject({ code: "RECORDED_RUN_EMPTY" });
  });
});

/* ------------------------------------------------------------------------ */
/* Runner                                                                    */
/* ------------------------------------------------------------------------ */

class FakeExecutor implements StepExecutor {
  readonly calls: StepExecutionRequest[] = [];
  private readonly plan: Array<StepExecutionOutcome | ((request: StepExecutionRequest) => StepExecutionOutcome)> = [];

  push(outcome: StepExecutionOutcome | ((request: StepExecutionRequest) => StepExecutionOutcome)): void {
    this.plan.push(outcome);
  }

  callsFor(stepId: string): StepExecutionRequest[] {
    return this.calls.filter((call) => call.step.id === stepId);
  }

  async executeStep(request: StepExecutionRequest): Promise<StepExecutionOutcome> {
    this.calls.push(request);
    const next = this.plan.shift();
    const outcome = typeof next === "function" ? next(request) : next;
    return outcome ?? ok(`step ${request.step.order} verified`);
  }
}

/**
 * Deterministically opens the old lost-update window: execute() has built a
 * transition from revision N but cannot submit its CAS until the test lets it.
 * cancel() is not blocked, so it can commit N+1 first.
 */
class BlockingRunStore implements WorkflowRunStore {
  private readonly inner = new MemoryWorkflowRunStore();
  private blockNextExecutionTransition = true;
  private readonly entered: () => void;
  private readonly releaseBlocked: () => void;
  readonly executionTransitionEntered: Promise<void>;
  private readonly releaseGate: Promise<void>;

  constructor() {
    let entered: () => void = () => undefined;
    let releaseBlocked: () => void = () => undefined;
    this.executionTransitionEntered = new Promise<void>((resolveEntered) => {
      entered = resolveEntered;
    });
    this.releaseGate = new Promise<void>((resolveRelease) => {
      releaseBlocked = resolveRelease;
    });
    this.entered = entered;
    this.releaseBlocked = releaseBlocked;
  }

  create(run: WorkflowRunValue): Promise<void> {
    return this.inner.create(run);
  }

  async compareAndSwap(run: WorkflowRunValue, expectedRevision: number): Promise<void> {
    if (this.blockNextExecutionTransition && run.status !== "cancelled") {
      this.blockNextExecutionTransition = false;
      this.entered();
      await this.releaseGate;
    }
    await this.inner.compareAndSwap(run, expectedRevision);
  }

  get(id: string): Promise<WorkflowRunValue | undefined> {
    return this.inner.get(id);
  }

  list(filter?: WorkflowRunFilter): Promise<WorkflowRunValue[]> {
    return this.inner.list(filter);
  }

  releaseExecutionTransition(): void {
    this.releaseBlocked();
  }
}

function ok(reason: string, extra: Partial<StepExecutionOutcome> = {}): StepExecutionOutcome {
  return {
    status: "succeeded",
    verification: { matched: true, confidence: 0.95, reason },
    evidenceIds: [`evidence:${reason}`],
    recordId: randomUUID(),
    ...extra
  };
}

function fail(error: string): StepExecutionOutcome {
  return { status: "failed", error };
}

function makeStep(order: number, action: WorkflowStepAction, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: randomUUID(),
    order,
    title: `Step ${order}`,
    action,
    anchor: {},
    parameters: [],
    expectedResult: `step ${order} takes effect`,
    mutation: false,
    ...overrides
  };
}

async function makeRunner(
  steps: WorkflowStep[],
  executor: FakeExecutor,
  overrides: Partial<Workflow> = {}
) {
  const workflows = new MemoryWorkflowStore();
  const runs = new MemoryWorkflowRunStore();
  const workflow = workflowFor(steps, overrides);
  await workflows.save(workflow);
  const runner = new WorkflowRunner({ workflows, runs, executor });
  return { workflow, runner, runs, workflows };
}

function workflowFor(steps: WorkflowStep[], overrides: Partial<Workflow> = {}): Workflow {
  const now = new Date().toISOString();
  return Workflow.parse({
    id: randomUUID(),
    workspaceId: "personal",
    title: "演示 workflow",
    description: "",
    source: { kind: "manual" },
    parameters: [
      { name: "value", label: "Campaign name", required: true, defaultValue: "Default Campaign" }
    ],
    steps,
    permissions: {
      requiresMutation: steps.some((step) => step.mutation),
      requiresApproval: steps.some((step) => step.mutation),
      requiredPermissions: steps.some((step) => step.mutation) ? ["INTERACT", "MUTATE"] : ["INTERACT"]
    },
    successCriteria: [],
    failurePolicy: "pause-for-user",
    status: "published",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    ...overrides
  });
}

describe("WorkflowRunner", () => {
  it("runs every step with rendered parameters and collects evidence", async () => {
    const typeStep = makeStep(2, { kind: "type", text: "{{value}}" }, {
      parameters: ["value"],
      expectedResult: "field shows {{value}}"
    });
    const steps = [makeStep(1, { kind: "click", x: 10, y: 20 }), typeStep, makeStep(3, { kind: "keypress", keys: ["ENTER"] })];
    const executor = new FakeExecutor();
    const { workflow, runner } = await makeRunner(steps, executor);

    const created = await runner.createRun({
      workflowId: workflow.id,
      workspaceId: "personal",
      parameters: { value: "Acme Campaign" }
    });
    const run = await runner.execute(created.id);

    expect(run.status).toBe("completed");
    expect(run.steps.map((step) => step.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(run.completedAt).toBeDefined();
    expect(executor.calls).toHaveLength(3);
    const typeCall = executor.callsFor(typeStep.id)[0]!;
    expect(typeCall.renderedAction).toEqual({ kind: "type", text: "Acme Campaign" });
    expect(typeCall.expectedResult).toBe("field shows Acme Campaign");
    // Evidence: three executor record ids plus their evidence entries.
    expect(run.evidenceIds.filter((id) => id.startsWith("action:"))).toHaveLength(3);
    expect(run.evidenceIds.some((id) => id.startsWith("evidence:"))).toBe(true);
  });

  it("stops the run when a step fails under the stop failure policy", async () => {
    const steps = [makeStep(1, { kind: "click" }), makeStep(2, { kind: "click" }), makeStep(3, { kind: "click" })];
    const executor = new FakeExecutor();
    executor.push(ok("first"));
    executor.push(() => ({ status: "failed", verification: { matched: false, confidence: 0.9, reason: "target missing" } }));
    const { workflow, runner } = await makeRunner(steps, executor, { failurePolicy: "stop" });

    const created = await runner.createRun({ workflowId: workflow.id, workspaceId: "personal", parameters: {} });
    const run = await runner.execute(created.id);

    expect(run.status).toBe("failed");
    expect(run.failureReason).toContain("target missing");
    expect(run.steps.map((step) => step.status)).toEqual(["succeeded", "failed", "pending"]);
    expect(executor.calls).toHaveLength(2);
  });

  it("treats success without verification evidence and low confidence as failures", async () => {
    const steps = [makeStep(1, { kind: "click" }), makeStep(2, { kind: "click" })];
    const executor = new FakeExecutor();
    executor.push({ status: "succeeded" });
    const { workflow, runner } = await makeRunner(steps, executor, { failurePolicy: "stop" });
    const created = await runner.createRun({ workflowId: workflow.id, workspaceId: "personal", parameters: {} });
    const noEvidence = await runner.execute(created.id);
    expect(noEvidence.status).toBe("failed");
    expect(noEvidence.failureReason).toContain("verification evidence");

    const executor2 = new FakeExecutor();
    executor2.push(ok("close but not enough", { verification: { matched: true, confidence: 0.2, reason: "unsure" } }));
    const { workflow: workflow2, runner: runner2 } = await makeRunner(steps, executor2, { failurePolicy: "stop" });
    const created2 = await runner2.createRun({ workflowId: workflow2.id, workspaceId: "personal", parameters: {} });
    const lowConfidence = await runner2.execute(created2.id);
    expect(lowConfidence.status).toBe("failed");
    expect(lowConfidence.failureReason).toContain("confidence");
  });

  it("pauses for the user and resumes without re-executing succeeded steps", async () => {
    const steps = [makeStep(1, { kind: "click" }), makeStep(2, { kind: "click" }), makeStep(3, { kind: "click" })];
    const executor = new FakeExecutor();
    executor.push(ok("first"));
    executor.push(fail("window lost"));
    const { workflow, runner } = await makeRunner(steps, executor); // pause-for-user default

    const created = await runner.createRun({ workflowId: workflow.id, workspaceId: "personal", parameters: {} });
    const paused = await runner.execute(created.id);
    expect(paused.status).toBe("paused");
    expect(paused.steps.map((step) => step.status)).toEqual(["succeeded", "failed", "pending"]);

    executor.push(ok("recovered"));
    executor.push(ok("final"));
    const resumed = await runner.resume(created.id);
    expect(resumed.status).toBe("completed");
    // Idempotency: step 1 ran exactly once; step 2 retried, step 3 ran once.
    expect(executor.callsFor(steps[0]!.id)).toHaveLength(1);
    expect(executor.callsFor(steps[1]!.id)).toHaveLength(2);
    expect(executor.callsFor(steps[2]!.id)).toHaveLength(1);
    expect(resumed.steps.map((step) => step.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });

  it("rejects mutation workflows without an approvalId and passes it to the executor", async () => {
    const mutationStep = makeStep(1, { kind: "keypress", keys: ["ENTER"] }, { mutation: true });
    const executor = new FakeExecutor();
    const { workflow, runner } = await makeRunner([mutationStep], executor);

    await expect(
      runner.createRun({ workflowId: workflow.id, workspaceId: "personal", parameters: {} })
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(executor.calls).toHaveLength(0);

    const approvalId = randomUUID();
    const created = await runner.createRun({
      workflowId: workflow.id,
      workspaceId: "personal",
      parameters: {},
      approvalId
    });
    const run = await runner.execute(created.id);
    expect(run.status).toBe("completed");
    expect(executor.calls[0]!.approvalId).toBe(approvalId);
  });

  it("validates parameters and refuses draft workflows", async () => {
    const executor = new FakeExecutor();
    const { workflow, runner } = await makeRunner([makeStep(1, { kind: "click" })], executor);

    await expect(
      runner.createRun({ workflowId: workflow.id, workspaceId: "personal", parameters: { nope: "x" } })
    ).rejects.toMatchObject({ code: "UNKNOWN_PARAMETER" });
    await expect(
      runner.createRun({ workflowId: workflow.id, workspaceId: "someone-else", parameters: {} })
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });

    const draft = workflowFor([makeStep(1, { kind: "click" })], { status: "draft" });
    const workflows = new MemoryWorkflowStore();
    await workflows.save(draft);
    const draftRunner = new WorkflowRunner({ workflows, runs: new MemoryWorkflowRunStore(), executor });
    await expect(
      draftRunner.createRun({ workflowId: draft.id, workspaceId: "personal", parameters: {} })
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_PUBLISHED" });
  });

  it("cancels a paused run and rejects resuming it", async () => {
    const executor = new FakeExecutor();
    executor.push(fail("broken"));
    const { workflow, runner } = await makeRunner([makeStep(1, { kind: "click" })], executor);
    const created = await runner.createRun({ workflowId: workflow.id, workspaceId: "personal", parameters: {} });
    await runner.execute(created.id);

    const cancelled = await runner.cancel(created.id);
    expect(cancelled.status).toBe("cancelled");
    await expect(runner.resume(created.id)).rejects.toMatchObject({ code: "RUN_NOT_PAUSED" });
  });

  it("makes cancellation win over a stale in-flight transition and keeps it terminal", async () => {
    const step = makeStep(1, { kind: "click" });
    const workflow = workflowFor([step]);
    const workflows = new MemoryWorkflowStore();
    const runs = new BlockingRunStore();
    const executor = new FakeExecutor();
    await workflows.save(workflow);
    const runner = new WorkflowRunner({ workflows, runs, executor });
    const created = await runner.createRun({
      workflowId: workflow.id,
      workspaceId: "personal",
      parameters: {}
    });

    const executing = runner.execute(created.id);
    await runs.executionTransitionEntered;
    const cancelled = await runner.cancel(created.id);
    expect(cancelled.status).toBe("cancelled");

    // Release the stale revision-1 "step is running" update only after cancel
    // committed revision 2. Its CAS must fail instead of restoring `running`.
    runs.releaseExecutionTransition();
    const settled = await executing;
    expect(settled.status).toBe("cancelled");
    expect(executor.calls).toHaveLength(0);

    const persisted = await runs.get(created.id);
    expect(persisted).toMatchObject({
      status: "cancelled",
      revision: cancelled.revision,
      failureReason: "cancelled by user"
    });
    await expect(runs.compareAndSwap({
      ...persisted!,
      status: "completed",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      revision: persisted!.revision + 1
    }, persisted!.revision)).rejects.toMatchObject({ code: "WORKFLOW_RUN_TERMINAL" });
  });
});

/* ------------------------------------------------------------------------ */
/* Skill publication                                                         */
/* ------------------------------------------------------------------------ */

describe("publishAsSkill", () => {
  it("registers the workflow as a skill whose payload carries the workflowId", async () => {
    const workflow = workflowFor([makeStep(1, { kind: "click" }), makeStep(2, { kind: "type", text: "{{value}}" })]);
    const registry = new SkillRegistry([]);
    const started: Array<{ workflowId: string; parameters: Record<string, string> }> = [];
    const result = publishAsSkill(workflow, registry, {
      runWorkflow: async (input) => {
        started.push(input);
        return { runId: randomUUID(), status: "running" };
      }
    });

    expect(result.alreadyRegistered).toBe(false);
    expect(result.skillName).toBe(workflowSkillName(workflow));
    expect(result.skillName).toMatch(/^workflow-/);
    const skill = registry.get(result.skillName);
    expect(skill.description).toContain(workflow.title);
    expect(skill.description).toContain("Step 1");

    const output = await skill.execute(
      {} as never,
      { workflowId: workflow.id, workspaceId: "personal", parameters: { value: "Acme" } },
      {} as never
    );
    expect(output).toMatchObject({ workflowId: workflow.id, status: "running" });
    expect(started).toEqual([{ workflowId: workflow.id, workspaceId: "personal", parameters: { value: "Acme" } }]);

    // A payload for another workflow is rejected by the bound skill.
    await expect(
      skill.execute({} as never, { workflowId: randomUUID(), workspaceId: "personal", parameters: {} }, {} as never)
    ).rejects.toThrow(/bound to workflow/);

    // Re-publishing is idempotent.
    const again = publishAsSkill(workflow, registry, { runWorkflow: async () => ({ runId: randomUUID(), status: "running" }) });
    expect(again).toEqual({ skillName: result.skillName, alreadyRegistered: true });
  });
});

/* ------------------------------------------------------------------------ */
/* File stores                                                               */
/* ------------------------------------------------------------------------ */

describe("workflow file stores", () => {
  it("round-trips workflows and runs with private files and fails closed on symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-workflows-"));
    roots.push(root);
    const workflows = new FileWorkflowStore(root);
    const runs = new FileWorkflowRunStore(root);
    const workflow = workflowFor([makeStep(1, { kind: "click" })]);
    await workflows.save(workflow);
    expect((await workflows.get(workflow.id))?.title).toBe(workflow.title);
    expect(await workflows.list({ workspaceId: "personal" })).toHaveLength(1);
    expect(await workflows.list({ workspaceId: "other" })).toHaveLength(0);

    const now = new Date().toISOString();
    await runs.create({
      id: randomUUID(),
      workflowId: workflow.id,
      workflowRevision: 1,
      workspaceId: "personal",
      parameters: {},
      status: "completed",
      steps: [],
      evidenceIds: ["action:abc"],
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    expect(await runs.list({ workflowId: workflow.id })).toHaveLength(1);

    const fileMode = (await stat(join(workflows.directory, `${workflow.id}.json`))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = (await stat(workflows.directory)).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it("fails closed when the store directory is a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-workflows-symlink-"));
    roots.push(root);
    const real = join(root, "real-target");
    const parent = join(root, ".adpilot", "workflows");
    await mkdir(real, { recursive: true });
    await mkdir(parent, { recursive: true });
    await symlink(real, join(parent, "definitions"), "dir");
    const workflows = new FileWorkflowStore(root);
    await expect(workflows.save(workflowFor([makeStep(1, { kind: "click" })]))).rejects.toThrow(/symlink/);
  });

  it("serializes compare-and-swap across file-store instances and preserves cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-workflow-run-cas-"));
    roots.push(root);
    const workflow = workflowFor([makeStep(1, { kind: "click" })]);
    const first = new FileWorkflowRunStore(root);
    const second = new FileWorkflowRunStore(root);
    const now = new Date().toISOString();
    const run = WorkflowRun.parse({
      id: randomUUID(),
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      workspaceId: workflow.workspaceId,
      parameters: {},
      status: "running",
      steps: [],
      evidenceIds: [],
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    await first.create(run);
    const cancelled = WorkflowRun.parse({
      ...run,
      status: "cancelled",
      failureReason: "cancelled by user",
      completedAt: now,
      revision: 2
    });
    const staleCompletion = WorkflowRun.parse({
      ...run,
      status: "completed",
      completedAt: now,
      revision: 2
    });

    const cancelWrite = first.compareAndSwap(cancelled, 1);
    const staleWrite = second.compareAndSwap(staleCompletion, 1);
    await Promise.all([
      expect(cancelWrite).resolves.toBeUndefined(),
      expect(staleWrite).rejects.toMatchObject({
        code: "WORKFLOW_RUN_TERMINAL",
        status: "cancelled"
      })
    ]);
    await expect(second.get(run.id)).resolves.toMatchObject({
      status: "cancelled",
      revision: 2
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

function recordFor(action: ComputerAction, overrides: Partial<ComputerActionRecord> = {}): ComputerActionRecord {
  return {
    id: randomUUID(),
    sessionId: SESSION_ID,
    runId: RUN_ID,
    appPid: 4321,
    appBundleId: "com.google.Chrome",
    windowId: "window-1",
    windowTitle: "Google Ads — Campaigns",
    displayId: "display-1",
    scaleFactor: 2,
    beforeFrameId: randomUUID(),
    action,
    proposedBy: "visual-grounding-runtime",
    policyDecision: "visual-policy:allow",
    startedAt: "2026-07-28T10:00:00.000Z",
    completedAt: "2026-07-28T10:00:01.000Z",
    userTookOver: false,
    ...overrides
  };
}
