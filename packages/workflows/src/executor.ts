import {
  VisualRuntimeBlocker,
  visualComputerBindingFromTask,
  type BrowserSession,
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
  /**
   * Aborted as soon as the durable run reaches `cancelled`. Optional only for
   * backwards-compatible direct executor callers; WorkflowRunner always sets it.
   */
  signal?: AbortSignal;
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

/** Anything that can list durable Browser Sessions (BrowserSessionManager does). */
export interface BrowserSessionSurfaceSource {
  list(): Promise<BrowserSession[]>;
}

/**
 * Production surface provider: resolve the run's live execution surface from
 * the exact connected Browser Session owned by the run's workspace. Every
 * field comes from the durable session binding — native PID, window id,
 * application identity, the non-reversible Profile proof, and the latest
 * observed page identity — never invented. No connected session for the
 * workspace means `undefined`, and the step fails closed.
 */
export function browserSessionSurfaceProvider(
  sessions: BrowserSessionSurfaceSource
): VisualStepSurfaceProvider {
  return async (request) => {
    const candidate = (await sessions.list()).find(
      (entry) => entry.clientId === request.run.workspaceId && entry.sessionStatus === "connected"
    );
    // A connected session always carries the native binding (schema-level
    // invariant); anything without it cannot be an exact surface — fail closed.
    if (!candidate) return undefined;
    const { processId, windowId } = candidate;
    if (processId === undefined || windowId === undefined) return undefined;
    const session = candidate;
    const page = session.pageIdentity?.status === "available" ? session.pageIdentity : undefined;
    const domain = page ? new URL(page.origin).hostname : undefined;
    return {
      surface: {
        app: session.browserApp,
        applicationId: session.browserApplicationId,
        processId,
        windowId,
        ...(domain ? { domain } : {}),
        ...(page ? { url: page.url, origin: page.origin, pageTitle: page.title } : {}),
        browserProfile: session.browserProfile,
        nativeProfileFingerprint: session.nativeProfileFingerprint,
        allowedApps: [session.browserApp, session.browserApplicationId],
        allowedDomains: domain ? [domain] : []
      },
      // Give every workflow run its own Computer Use control identity while
      // retaining the exact durable browser Session. Cancelling one workflow
      // can then abort its native action without poisoning another run that
      // happens to use the same browser window later.
      binding: {
        adPilotSessionId: request.run.id,
        browserSessionId: session.sessionId
      },
      clientId: session.clientId,
      platform: session.platform
    };
  };
}

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
    const signal = request.signal ?? NEVER_ABORTED_SIGNAL;
    signal.throwIfAborted();
    if (renderedAction.kind === "wait") {
      await delay(renderedAction.milliseconds, signal);
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
    signal.throwIfAborted();
    if (!context) {
      return { status: "failed", error: "no live execution surface is bound to this workflow run" };
    }
    const task = this.buildTask(request, context);
    const cancelRuntime = () => {
      try {
        // runMicroTask owns its own abort controller. Cancelling the exact
        // binding bridges the WorkflowRunner signal into that controller and
        // also clears any native input still queued for this surface.
        this.runtime.cancel(visualComputerBindingFromTask(task));
      } catch {
        // The durable workflow cancellation still wins. A runtime that already
        // lost/closed its surface has nothing left for this callback to stop.
      }
    };
    if (signal.aborted) cancelRuntime();
    else signal.addEventListener("abort", cancelRuntime, { once: true });
    try {
      signal.throwIfAborted();
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
      if (signal.aborted) {
        return {
          status: "failed",
          error: signal.reason instanceof Error
            ? signal.reason.message
            : "workflow run cancelled"
        };
      }
      if (error instanceof VisualRuntimeBlocker && PAUSE_BLOCKER_CODES.has(error.code)) {
        return { status: "failed", error: error.message, pauseRequested: true };
      }
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    } finally {
      signal.removeEventListener("abort", cancelRuntime);
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

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      rejectPromise(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("workflow run cancelled");
}

const NEVER_ABORTED_SIGNAL = new AbortController().signal;
