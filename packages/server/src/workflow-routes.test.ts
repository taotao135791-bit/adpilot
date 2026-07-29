import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdPilotSystem, type AdPilotSystem } from "@adpilot/application";
import {
  FileComputerActionRecordStore,
  type ComputerAction,
  type ComputerActionRecord
} from "@adpilot/computer-use";
import type {
  StepExecutionOutcome,
  StepExecutionRequest,
  StepExecutor
} from "@adpilot/workflows";
import { createServer } from "./index.js";

const SESSION_ID = randomUUID();
const RUN_ID = "task-route-demo";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Planned = StepExecutionOutcome | ((request: StepExecutionRequest) => StepExecutionOutcome | Promise<StepExecutionOutcome>);

class FakeExecutor implements StepExecutor {
  readonly calls: StepExecutionRequest[] = [];
  private readonly plan: Planned[] = [];

  push(outcome: Planned): void {
    this.plan.push(outcome);
  }

  async executeStep(request: StepExecutionRequest): Promise<StepExecutionOutcome> {
    this.calls.push(request);
    const next = this.plan.shift();
    const outcome = typeof next === "function" ? await next(request) : next;
    return outcome ?? {
      status: "succeeded",
      verification: { matched: true, confidence: 0.95, reason: `step ${request.step.order} verified` },
      evidenceIds: [`evidence:step-${request.step.order}`],
      recordId: randomUUID()
    };
  }
}

async function boot(executor: FakeExecutor) {
  const root = await mkdtemp(join(tmpdir(), "adpilot-workflow-routes-"));
  roots.push(root);
  const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
  (system as AdPilotSystem & { workflowExecutor?: StepExecutor }).workflowExecutor = executor;
  await seedRecords(root);
  const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
  return { server, system };
}

async function seedRecords(root: string) {
  const store = new FileComputerActionRecordStore(join(root, ".adpilot", "computer-actions"));
  const stamp = (minute: number) => `2026-07-28T11:${String(minute).padStart(2, "0")}:00.000Z`;
  const entries: Array<[ComputerAction, Partial<ComputerActionRecord>, number]> = [
    [{ kind: "click", x: 100, y: 200, coordinateSpace: "frame_pixels" }, {}, 0],
    [{ kind: "type", text: "Acme Spring Campaign" }, {}, 1],
    [{ kind: "wait", milliseconds: 500 }, {}, 2],
    [{ kind: "keypress", keys: ["CMD", "S"] }, { approvalId: randomUUID() }, 3]
  ];
  for (const [action, overrides, minute] of entries) {
    await store.save(recordFor(action, { ...overrides, startedAt: stamp(minute) }));
  }
}

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
    startedAt: "2026-07-28T11:00:00.000Z",
    completedAt: "2026-07-28T11:00:01.000Z",
    userTookOver: false,
    ...overrides
  };
}

async function createDraft(server: Awaited<ReturnType<typeof boot>>["server"], title = "录制 workflow") {
  const response = await server.inject({
    method: "POST",
    url: "/api/workflows/from-run",
    payload: { workspaceId: "personal", sessionId: SESSION_ID, runId: RUN_ID, title }
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function waitForRun(server: Awaited<ReturnType<typeof boot>>["server"], runId: string, targets: string[]) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const response = await server.inject({
      method: "GET",
      url: `/api/workflow-runs/${runId}?workspaceId=personal`
    });
    const run = response.json();
    if (targets.includes(run.status) || Date.now() > deadline) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("workflow REST routes", () => {
  it("runs the from-run → edit → publish → run → publish-skill flow end to end", async () => {
    const executor = new FakeExecutor();
    const { server, system } = await boot(executor);

    // from-run → draft
    const draft = await createDraft(server);
    expect(draft).toMatchObject({ status: "draft", workspaceId: "personal", title: "录制 workflow" });
    expect(draft.steps.map((step: { action: { kind: string } }) => step.action.kind)).toEqual([
      "click", "type", "wait", "keypress"
    ]);
    expect(draft.parameters).toHaveLength(1);
    expect(draft.parameters[0]).toMatchObject({ name: "value", defaultValue: "Acme Spring Campaign" });
    expect(draft.permissions.requiresApproval).toBe(true);

    // list + get
    const list = await server.inject({ method: "GET", url: "/api/workflows?workspaceId=personal" });
    expect(list.json().workflows.map((workflow: { id: string }) => workflow.id)).toEqual([draft.id]);
    const detail = await server.inject({ method: "GET", url: `/api/workflows/${draft.id}?workspaceId=personal` });
    expect(detail.statusCode).toBe(200);

    // edit while draft
    const patched = await server.inject({
      method: "PATCH",
      url: `/api/workflows/${draft.id}`,
      payload: {
        workspaceId: "personal",
        title: "春季 campaign 创建流程",
        description: "从一次真实演示录制",
        successCriteria: ["campaign 创建成功"],
        failurePolicy: "stop"
      }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      title: "春季 campaign 创建流程",
      failurePolicy: "stop",
      successCriteria: ["campaign 创建成功"],
      revision: draft.revision + 1
    });

    // publish
    const published = await server.inject({
      method: "POST",
      url: `/api/workflows/${draft.id}/publish`,
      payload: { workspaceId: "personal" }
    });
    expect(published.json().status).toBe("published");

    // published workflows reject structural edits but accept description edits
    const structural = await server.inject({
      method: "PATCH",
      url: `/api/workflows/${draft.id}`,
      payload: { workspaceId: "personal", failurePolicy: "pause-for-user" }
    });
    expect(structural.statusCode).toBe(400);
    expect(structural.json().code).toBe("WORKFLOW_PUBLISHED_READONLY");
    const descriptionOnly = await server.inject({
      method: "PATCH",
      url: `/api/workflows/${draft.id}`,
      payload: { workspaceId: "personal", description: "已发布说明" }
    });
    expect(descriptionOnly.statusCode).toBe(200);
    expect(descriptionOnly.json().description).toBe("已发布说明");

    // the workflow has a mutation step: runs require an approvalId
    const noApproval = await server.inject({
      method: "POST",
      url: `/api/workflows/${draft.id}/runs`,
      payload: { workspaceId: "personal", parameters: { value: "Acme Campaign" } }
    });
    expect(noApproval.statusCode).toBe(400);
    expect(noApproval.json().code).toBe("APPROVAL_REQUIRED");

    // run with approval + parameters
    const approvalId = randomUUID();
    const created = await server.inject({
      method: "POST",
      url: `/api/workflows/${draft.id}/runs`,
      payload: { workspaceId: "personal", parameters: { value: "Acme Campaign" }, approvalId }
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;
    const run = await waitForRun(server, runId, ["completed", "failed"]);
    expect(run.status).toBe("completed");
    expect(run.steps.map((step: { status: string }) => step.status)).toEqual([
      "succeeded", "succeeded", "succeeded", "succeeded"
    ]);
    expect(run.evidenceIds.some((id: string) => id.startsWith("action:"))).toBe(true);

    // parameters were rendered before reaching the executor, approval forwarded
    const typeCall = executor.calls.find((call) => call.renderedAction.kind === "type");
    expect(typeCall?.renderedAction).toEqual({ kind: "type", text: "Acme Campaign" });
    const mutationCall = executor.calls.find((call) => call.step.mutation);
    expect(mutationCall?.approvalId).toBe(approvalId);

    // publish-skill registers into the SkillRegistry; republishing is idempotent
    const skill = await server.inject({
      method: "POST",
      url: `/api/workflows/${draft.id}/publish-skill`,
      payload: { workspaceId: "personal" }
    });
    expect(skill.statusCode).toBe(201);
    expect(skill.json().skillName).toMatch(/^workflow-/);
    const registered = system.skills.get(skill.json().skillName);
    expect(registered.input.parse({ workflowId: draft.id, workspaceId: "personal" })).toMatchObject({
      workflowId: draft.id
    });
    const again = await server.inject({
      method: "POST",
      url: `/api/workflows/${draft.id}/publish-skill`,
      payload: { workspaceId: "personal" }
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ skillName: skill.json().skillName, alreadyRegistered: true });

    // cross-workspace access is refused
    const cross = await server.inject({
      method: "GET",
      url: `/api/workflows/${draft.id}?workspaceId=someone-else`
    });
    expect(cross.statusCode).toBe(400);

    // audit chain recorded the writes
    const actions = (await system.audit.list("personal")).map((event) => event.action);
    for (const expected of ["workflow_record", "workflow_publish", "workflow_run_create", "workflow_publish_skill"]) {
      expect(actions).toContain(expected);
    }
  });

  it("pauses a failing run, resumes it, and supports cancel", async () => {
    const executor = new FakeExecutor();
    executor.push({
      status: "succeeded",
      verification: { matched: true, confidence: 0.95, reason: "step 1 ok" }
    });
    executor.push({ status: "failed", error: "element not found" });
    const { server } = await boot(executor);
    const draft = await createDraft(server, "可暂停 workflow");
    await server.inject({ method: "POST", url: `/api/workflows/${draft.id}/publish`, payload: { workspaceId: "personal" } });

    const approvalId = randomUUID();
    const created = await server.inject({
      method: "POST",
      url: `/api/workflows/${draft.id}/runs`,
      payload: { workspaceId: "personal", parameters: {}, approvalId }
    });
    const runId = created.json().id;
    const paused = await waitForRun(server, runId, ["paused", "failed", "completed"]);
    expect(paused.status).toBe("paused");
    expect(paused.steps.map((step: { status: string }) => step.status)).toEqual([
      "succeeded", "failed", "pending", "pending"
    ]);

    // resume after the user fixed the screen; remaining steps succeed
    const resumed = await server.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/resume`,
      payload: { workspaceId: "personal" }
    });
    expect(resumed.statusCode).toBe(200);
    const finished = await waitForRun(server, runId, ["completed", "failed"]);
    expect(finished.status).toBe("completed");
    expect(finished.steps.map((step: { status: string }) => step.status)).toEqual([
      "succeeded", "succeeded", "succeeded", "succeeded"
    ]);
    // resume is only valid from paused
    const invalidResume = await server.inject({
      method: "POST",
      url: `/api/workflow-runs/${runId}/resume`,
      payload: { workspaceId: "personal" }
    });
    expect(invalidResume.statusCode).toBe(400);
    expect(invalidResume.json().code).toBe("RUN_NOT_PAUSED");

    // cancel a run whose executor is blocked mid-step
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    executor.push(async () => {
      await gate;
      return { status: "succeeded", verification: { matched: true, confidence: 0.95, reason: "gated" } };
    });
    const blocking = await server.inject({
      method: "POST",
      url: `/api/workflows/${draft.id}/runs`,
      payload: { workspaceId: "personal", parameters: {}, approvalId }
    });
    const blockingRunId = blocking.json().id;
    const cancelled = await server.inject({
      method: "POST",
      url: `/api/workflow-runs/${blockingRunId}/cancel`,
      payload: { workspaceId: "personal" }
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");
    release!();
    const after = await waitForRun(server, blockingRunId, ["cancelled"]);
    expect(after.status).toBe("cancelled");
  });

  it("archives workflows and rejects runs and unknown ids with coded errors", async () => {
    const executor = new FakeExecutor();
    const { server } = await boot(executor);
    const draft = await createDraft(server, "将归档 workflow");
    await server.inject({ method: "POST", url: `/api/workflows/${draft.id}/publish`, payload: { workspaceId: "personal" } });

    const archived = await server.inject({
      method: "POST",
      url: `/api/workflows/${draft.id}/archive`,
      payload: { workspaceId: "personal" }
    });
    expect(archived.json().status).toBe("archived");

    const runArchived = await server.inject({
      method: "POST",
      url: `/api/workflows/${draft.id}/runs`,
      payload: { workspaceId: "personal", parameters: {} }
    });
    expect(runArchived.statusCode).toBe(400);
    expect(runArchived.json().code).toBe("WORKFLOW_NOT_PUBLISHED");

    const missing = await server.inject({
      method: "GET",
      url: `/api/workflows/${randomUUID()}?workspaceId=personal`
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("WORKFLOW_NOT_FOUND");

    const missingRun = await server.inject({
      method: "GET",
      url: `/api/workflow-runs/${randomUUID()}?workspaceId=personal`
    });
    expect(missingRun.statusCode).toBe(404);
    expect(missingRun.json().code).toBe("WORKFLOW_RUN_NOT_FOUND");
  });
});
