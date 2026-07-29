import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileComputerActionRecordStore, type NativeOperator } from "@adpilot/computer-use";
import {
  UnavailableStepExecutor,
  VisualRuntimeStepExecutor,
  Workflow,
  WorkflowRun,
  WorkflowStep,
  deriveWorkflowPermissions,
  type StepExecutionRequest
} from "@adpilot/workflows";
import { createAdPilotSystem } from "./index.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const NOW = "2026-07-29T00:00:00.000Z";

function clickRequest(workspaceId = "personal"): StepExecutionRequest {
  const step = WorkflowStep.parse({
    id: randomUUID(),
    order: 1,
    title: "点击保存",
    action: { kind: "click", x: 10, y: 20 },
    expectedResult: "保存成功",
    mutation: false
  });
  const workflow = Workflow.parse({
    id: randomUUID(),
    workspaceId,
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
  const run = WorkflowRun.parse({
    id: randomUUID(),
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    workspaceId,
    parameters: {},
    status: "running",
    steps: [{ stepId: step.id, status: "pending", attempts: 0, evidenceIds: [] }],
    evidenceIds: [],
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1
  });
  return { workflow, run, step, renderedAction: step.action, expectedResult: step.expectedResult };
}

describe("application workflow executor assembly", () => {
  it("exposes a fail-closed executor and the durable action record store without Computer Use", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-application-workflow-"));
    roots.push(root);
    const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });

    expect(system.computer).toBeUndefined();
    expect(system.workflowExecutor).toBeInstanceOf(UnavailableStepExecutor);
    expect(system.workflowActionRecords).toBeInstanceOf(FileComputerActionRecordStore);

    // Fail-closed is an ordinary step failure, never a crash.
    await expect(system.workflowExecutor.executeStep(clickRequest())).resolves.toEqual({
      status: "failed",
      error: "Computer Use is unavailable on this system"
    });
    await system.shutdown();
  });

  it("wires the real runtime with the browser-session surface provider when Computer Use exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-application-workflow-"));
    roots.push(root);
    const operator: NativeOperator = {
      capture: vi.fn(async () => {
        throw new Error("capture must not run without a browser session surface");
      }),
      execute: vi.fn(async () => undefined)
    };
    const system = await createAdPilotSystem({
      workspaceRoot: root,
      env: {
        ADPILOT_GUI_BASE_URL: "http://127.0.0.1:9",
        ADPILOT_GUI_MODEL: "gui-test",
        ADPILOT_VERIFY_MODE: "gui"
      },
      nativeOperator: operator
    });

    expect(system.computer).toBeDefined();
    expect(system.workflowExecutor).toBeInstanceOf(VisualRuntimeStepExecutor);

    // No connected browser session for the workspace: the surface provider
    // returns undefined, the step fails closed, and the runtime is untouched.
    const outcome = await system.workflowExecutor.executeStep(clickRequest());
    expect(outcome).toEqual({
      status: "failed",
      error: "no live execution surface is bound to this workflow run"
    });
    expect(operator.capture).not.toHaveBeenCalled();
    expect(operator.execute).not.toHaveBeenCalled();
    await system.shutdown();
  });
});
