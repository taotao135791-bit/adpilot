import { randomUUID } from "node:crypto";
import type {
  ComputerAction,
  ComputerActionRecord as ComputerActionRecordValue,
  ComputerActionRecordStore
} from "@adpilot/computer-use";
import {
  Workflow,
  WorkflowError,
  deriveWorkflowPermissions,
  type Workflow as WorkflowValue,
  type WorkflowParameter,
  type WorkflowStep,
  type WorkflowStepAction
} from "./model.js";
import type { WorkflowStore } from "./store.js";

export interface RecordWorkflowInput {
  workspaceId: string;
  /** Computer Session whose action records should be converted. */
  sessionId: string;
  /** Run (Computer Use task id) inside that session. */
  runId: string;
  title: string;
  projectId?: string;
}

export interface WorkflowRecorderOptions {
  records: ComputerActionRecordStore;
  workflows: WorkflowStore;
  now?: () => Date;
  id?: () => string;
}

/**
 * Kinds that carry no replayable intent: cursor moves, drags, and window/app
 * activation are positioning artifacts of the live demo, not workflow steps.
 */
const SKIPPED_ACTION_KINDS = new Set<ComputerAction["kind"]>([
  "move",
  "drag",
  "focus_window",
  "activate_app"
]);

/**
 * Converts one recorded Computer Use run into a draft Workflow.
 *
 * Honesty rule: a step only carries data that exists in the underlying
 * Computer Action record. Coordinates, typed text, keys, scroll deltas, wait
 * durations, window titles, and approval ids come straight from the record;
 * visual anchors stay empty because Computer Action records contain no OCR
 * or element text — anchors are meant to be enriched by a human editor.
 */
export class WorkflowRecorder {
  private readonly records: ComputerActionRecordStore;
  private readonly workflows: WorkflowStore;
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(options: WorkflowRecorderOptions) {
    this.records = options.records;
    this.workflows = options.workflows;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async createDraft(input: RecordWorkflowInput): Promise<WorkflowValue> {
    const sessionRecords = await this.records.list(input.sessionId);
    const runRecords = sessionRecords.filter((record) => record.runId === input.runId);
    if (runRecords.length === 0) {
      throw new WorkflowError(
        `no Computer Action records for run ${input.runId} in session ${input.sessionId}`,
        "RECORDED_RUN_EMPTY"
      );
    }
    const steps: WorkflowStep[] = [];
    const parameters: WorkflowParameter[] = [];
    const parameterByValue = new Map<string, string>();
    let order = 0;
    for (const record of runRecords) {
      if (recordWasBlocked(record)) continue;
      const mapped = mapAction(record.action);
      if (!mapped) continue;
      order += 1;
      const stepParameters: string[] = [];
      let action = mapped.action;
      if (action.kind === "type") {
        const original = action.text;
        let name = parameterByValue.get(original);
        if (!name) {
          name = parameters.length === 0 ? "value" : `value${parameters.length + 1}`;
          parameterByValue.set(original, name);
          parameters.push({
            name,
            label: `Recorded input ${parameters.length} (“${truncate(original, 32)}”)`,
            required: true,
            defaultValue: original,
            example: original
          });
        }
        action = { kind: "type", text: `{{${name}}}` };
        stepParameters.push(name);
      }
      steps.push({
        id: this.id(),
        order,
        title: mapped.title,
        action,
        anchor: {},
        parameters: stepParameters,
        expectedResult: expectedResultFor(record, mapped.title),
        mutation: record.approvalId !== undefined
      });
    }
    if (steps.length === 0) {
      throw new WorkflowError(
        `run ${input.runId} contains no replayable actions`,
        "RECORDED_RUN_EMPTY"
      );
    }
    const nowIso = this.now().toISOString();
    const workflow = Workflow.parse({
      id: this.id(),
      workspaceId: input.workspaceId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      title: input.title,
      description: `Recorded from Computer Use run ${input.runId} (${steps.length} replayable steps).`,
      source: { kind: "recorded", sessionId: input.sessionId, runId: input.runId, recordedAt: nowIso },
      parameters,
      steps,
      permissions: deriveWorkflowPermissions(steps),
      successCriteria: [],
      failurePolicy: "pause-for-user",
      status: "draft",
      createdAt: nowIso,
      updatedAt: nowIso,
      revision: 1
    });
    await this.workflows.save(workflow);
    return workflow;
  }
}

function recordWasBlocked(record: ComputerActionRecordValue): boolean {
  const result: unknown = record.executionResult;
  return (
    typeof result === "object"
    && result !== null
    && "status" in result
    && (result as { status?: unknown }).status === "blocked"
  );
}

function mapAction(action: ComputerAction): { action: WorkflowStepAction; title: string } | undefined {
  if (SKIPPED_ACTION_KINDS.has(action.kind)) return undefined;
  switch (action.kind) {
    case "click":
      return { action: { kind: "click", x: action.x, y: action.y }, title: `Click at (${action.x}, ${action.y})` };
    case "double_click":
      return { action: { kind: "click", x: action.x, y: action.y }, title: `Double-click at (${action.x}, ${action.y})` };
    case "right_click":
      return { action: { kind: "click", x: action.x, y: action.y }, title: `Right-click at (${action.x}, ${action.y})` };
    case "type":
      return { action: { kind: "type", text: action.text }, title: `Type “${truncate(action.text, 24)}”` };
    case "keypress":
      return { action: { kind: "keypress", keys: action.keys }, title: `Press ${action.keys.join("+")}` };
    case "scroll": {
      const direction = Math.abs(action.deltaY) >= Math.abs(action.deltaX)
        ? (action.deltaY > 0 ? "down" : "up")
        : (action.deltaX > 0 ? "right" : "left");
      return {
        action: { kind: "scroll", direction, x: action.x, y: action.y },
        title: `Scroll ${direction} at (${action.x}, ${action.y})`
      };
    }
    case "wait":
      return {
        action: { kind: "wait", milliseconds: action.milliseconds },
        title: `Wait ${action.milliseconds} ms`
      };
    default:
      return undefined;
  }
}

function expectedResultFor(record: ComputerActionRecordValue, fallback: string): string {
  if (record.verificationResult?.status === "passed") return record.verificationResult.reason;
  const surface = record.windowTitle ?? record.appBundleId;
  return `${fallback} takes effect on ${surface}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
