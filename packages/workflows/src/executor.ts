import {
  VisualRuntimeBlocker,
  type SurfaceContext,
  type VisualAction,
  type VisualComputerRuntime,
  type VisualComputerSessionBinding,
  type VisualMicroTask
} from "@adpilot/computer-use";
import type {
  Workflow as WorkflowValue,
  WorkflowRun as WorkflowRunValue,
  WorkflowStep as WorkflowStepValue,
  WorkflowStepAction,
  WorkflowStepVerification
} from "./model.js";

/** One step handed to the executor with parameters already rendered. */
export interface StepExecutionRequest {
  workflow: WorkflowValue;
  run: WorkflowRunValue;
  step: WorkflowStepValue;
  /** Step action after `{{name}}` substitution. */
  renderedAction: WorkflowStepAction;
  /** Step expectedResult after `{{name}}` substitution. */
  expectedResult: string;
  /** Present only when the run was created with one; required for mutation steps. */
  approvalId?: string;
}

export interface StepExecutionOutcome {
  status: "succeeded" | "failed";
  /**
   * Post-step verification of the expected result. Required on success: a
   * reported success without verification evidence is treated as a failure.
   */
  verification?: WorkflowStepVerification;
  /** Executor-owned record id (e.g. a Computer Action record id). */
  recordId?: string;
  evidenceIds?: string[];
  error?: string;
  /** The executor lost the exact window/session identity; the run should pause. */
  pauseRequested?: boolean;
}

/**
 * Execution seam between WorkflowRunner and the outside world. The production
 * implementation bridges VisualComputerRuntime; tests inject a fake.
 */
export interface StepExecutor {
  executeStep(request: StepExecutionRequest): Promise<StepExecutionOutcome>;
}

/** Fail-closed executor used when no visual runtime (or surface binding) exists. */
export class UnavailableStepExecutor implements StepExecutor {
  constructor(private readonly reason: string) {}

  async executeStep(): Promise<StepExecutionOutcome> {
    return { status: "failed", error: this.reason };
  }
}

export interface VisualStepExecutionContext {
  surface: SurfaceContext;
  binding?: VisualComputerSessionBinding;
  clientId?: string;
  platform?: string;
}

/**
 * Resolves the live execution surface for one step. Returning `undefined`
 * fails the step closed — a recorded workflow may only replay on an exact,
 * caller-supplied surface, never on a guessed one.
 */
export type VisualStepSurfaceProvider = (
  request: StepExecutionRequest
) => Promise<VisualStepExecutionContext | undefined>;

const PAUSE_BLOCKER_CODES = new Set([
  "SURFACE_CHANGED",
  "BROWSER_SESSION_LOST",
  "BROWSER_PAGE_IDENTITY_UNAVAILABLE",
  "BROWSER_PAGE_IDENTITY_CHANGED",
  "PAUSED",
  "USER_TAKEOVER"
]);

/**
 * Production bridge: converts each workflow step into a VisualMicroTask and
 * lets VisualComputerRuntime re-ground it on the live screen (recorded
 * coordinates survive only as instruction hints). `assert` steps use the
 * read-only verifyVisible preflight; `wait` steps never touch the runtime.
 */
export class VisualRuntimeStepExecutor implements StepExecutor {
  constructor(
    private readonly runtime: VisualComputerRuntime,
    private readonly provideContext: VisualStepSurfaceProvider,
    private readonly now: () => Date = () => new Date()
  ) {}

  async executeStep(request: StepExecutionRequest): Promise<StepExecutionOutcome> {
    const { step, renderedAction } = request;
    if (renderedAction.kind === "wait") {
      await delay(renderedAction.milliseconds);
      return {
        status: "succeeded",
        verification: {
          matched: true,
          confidence: 1,
          reason: `waited ${renderedAction.milliseconds} ms`
        }
      };
    }
    const context = await this.provideContext(request);
    if (!context) {
      return { status: "failed", error: "no live execution surface is bound to this workflow run" };
    }
    const task = this.buildTask(request, context);
    try {
      if (renderedAction.kind === "assert") {
        const result = await this.runtime.verifyVisible(request.expectedResult, task);
        return {
          status: result.matched ? "succeeded" : "failed",
          verification: { matched: result.matched, confidence: result.confidence, reason: result.reason },
          evidenceIds: [`frame:${result.screenshot.sha256}`],
          ...(result.matched ? {} : { error: result.reason })
        };
      }
      const result = await this.runtime.runMicroTask(task);
      if (result.status === "done") {
        const evidenceIds = [
          `frame:${result.before.sha256}`,
          `frame:${result.after.sha256}`,
          ...(result.actionRecordId ? [`action:${result.actionRecordId}`] : [])
        ];
        return {
          status: result.verified || !result.executed ? "succeeded" : "failed",
          verification: {
            matched: result.verified,
            confidence: result.verified ? 1 : 0,
            reason: result.action.reason
          },
          ...(result.actionRecordId ? { recordId: result.actionRecordId } : {}),
          evidenceIds,
          ...(result.verified || !result.executed ? {} : { error: "the action executed but verification did not match" })
        };
      }
      return {
        status: "failed",
        error: result.blocker,
        ...(result.actionRecordId ? { recordId: result.actionRecordId } : {}),
        ...(result.blockerCode && PAUSE_BLOCKER_CODES.has(result.blockerCode) ? { pauseRequested: true } : {})
      };
    } catch (error) {
      if (error instanceof VisualRuntimeBlocker && PAUSE_BLOCKER_CODES.has(error.code)) {
        return { status: "failed", error: error.message, pauseRequested: true };
      }
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private buildTask(request: StepExecutionRequest, context: VisualStepExecutionContext): VisualMicroTask {
    const { workflow, run, step, renderedAction, expectedResult } = request;
    const anchorHints = [step.anchor.text, step.anchor.ocrText, step.anchor.accessibilityRole]
      .filter((hint): hint is string => typeof hint === "string");
    const coordinateHint = "x" in renderedAction && renderedAction.x !== undefined
      ? ` near recorded point (${renderedAction.x}, ${renderedAction.y ?? 0})`
      : "";
    const target = step.anchor.text ?? step.anchor.ocrText ?? step.title;
    const allowedActions = allowedActionsFor(renderedAction);
    return {
      ...(context.clientId ? { clientId: context.clientId } : {}),
      ...(context.binding ? {
        adPilotSessionId: context.binding.adPilotSessionId,
        browserSessionId: context.binding.browserSessionId
      } : {}),
      taskId: run.id,
      stepId: step.id,
      planId: `${run.id}:${step.id}`,
      ...(request.approvalId ? { approvalId: request.approvalId } : {}),
      ...(context.platform ? { platform: context.platform } : {}),
      instruction: [
        `Replay recorded workflow "${workflow.title}" step ${step.order}: ${step.title}`,
        ...anchorHints.length ? [`Visual anchor: ${anchorHints.join("; ")}`] : [],
        `Perform exactly one ${renderedAction.kind} action${coordinateHint}.`
      ].join("\n"),
      target,
      expectedResult,
      riskLevel: step.mutation ? "mutate" : "interact",
      permission: step.mutation ? "MUTATE" : "INTERACT",
      allowedActions,
      ...(renderedAction.kind === "type" ? { allowedText: renderedAction.text } : {}),
      ...(renderedAction.kind === "scroll" ? { allowedScrollDirections: [renderedAction.direction] } : {}),
      retryPolicy: step.mutation ? "none" : "default",
      surface: context.surface
    };
  }
}

function allowedActionsFor(action: WorkflowStepAction): VisualAction["action"][] {
  switch (action.kind) {
    case "click": return ["click"];
    case "type": return ["type"];
    case "keypress": return ["hotkey"];
    case "scroll": return ["scroll"];
    case "navigate": return ["type", "hotkey"];
    case "assert": return ["screenshot", "done"];
    case "wait": return ["wait"];
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref?.();
  });
}
