import { randomUUID } from "node:crypto";
import {
  WorkflowError,
  WorkflowRun,
  renderTemplate,
  type Workflow as WorkflowValue,
  type WorkflowRun as WorkflowRunValue,
  type WorkflowStepAction,
  type WorkflowStepResult
} from "./model.js";
import {
  WorkflowRunRevisionConflictError,
  WorkflowRunTerminalStateError,
  type WorkflowRunStore,
  type WorkflowStore
} from "./store.js";
import type { StepExecutionOutcome, StepExecutor } from "./executor.js";

/**
 * Minimum verification confidence for a step to count as succeeded. Below
 * this the step is treated as failed and the failure policy applies.
 */
export const MIN_STEP_VERIFICATION_CONFIDENCE = 0.6;

export interface CreateWorkflowRunInput {
  workflowId: string;
  workspaceId: string;
  parameters: Record<string, string>;
  approvalId?: string;
}

export interface WorkflowRunnerOptions {
  workflows: WorkflowStore;
  runs: WorkflowRunStore;
  executor: StepExecutor;
  now?: () => Date;
  id?: () => string;
  minVerificationConfidence?: number;
}

/**
 * Executes published workflows step by step through an injected StepExecutor.
 *
 * Semantics:
 * - Every run is persisted after each transition, so a process crash leaves a
 *   truthful record and `resume(runId)` continues from the first
 *   non-succeeded step.
 * - Idempotency: a step that already succeeded inside this run
 *   (workflowId + runId + stepId) is never executed again.
 * - Mutation steps require the run's approvalId and are additionally
 *   protected by the executor's own replay protection.
 * - Any step failure, insufficient verification confidence, or lost window
 *   identity applies the step's onFailure policy (defaulting to the
 *   workflow's failurePolicy): `stop` fails the run, `pause-for-user`
 *   pauses it for a human.
 */
export class WorkflowRunner {
  private readonly workflows: WorkflowStore;
  private readonly runs: WorkflowRunStore;
  private readonly executor: StepExecutor;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly minConfidence: number;
  private readonly active = new Map<string, AbortController>();

  constructor(options: WorkflowRunnerOptions) {
    this.workflows = options.workflows;
    this.runs = options.runs;
    this.executor = options.executor;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.minConfidence = options.minVerificationConfidence ?? MIN_STEP_VERIFICATION_CONFIDENCE;
  }

  async createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunValue> {
    const workflow = await this.requireWorkflow(input.workflowId);
    if (workflow.workspaceId !== input.workspaceId) {
      throw new WorkflowError(`workflow not found in this workspace: ${input.workflowId}`, "WORKFLOW_NOT_FOUND");
    }
    if (workflow.status !== "published") {
      throw new WorkflowError(`workflow is not published: ${input.workflowId}`, "WORKFLOW_NOT_PUBLISHED");
    }
    const values = resolveParameters(workflow, input.parameters);
    if (workflow.permissions.requiresApproval && !input.approvalId) {
      throw new WorkflowError("this workflow has mutation steps and requires an approvalId", "APPROVAL_REQUIRED");
    }
    const nowIso = this.now().toISOString();
    const run = WorkflowRun.parse({
      id: this.id(),
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      workspaceId: workflow.workspaceId,
      parameters: values,
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      status: "running",
      steps: workflow.steps.map((step) => ({ stepId: step.id, status: "pending", attempts: 0, evidenceIds: [] })),
      evidenceIds: [],
      startedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
      revision: 1
    });
    await this.runs.create(run);
    return run;
  }

  /** Execute (or continue) a run. Never throws for step failures; the run record carries them. */
  async execute(runId: string): Promise<WorkflowRunValue> {
    if (this.active.has(runId)) {
      throw new WorkflowError(`workflow run is already executing: ${runId}`, "RUN_ACTIVE");
    }
    const controller = new AbortController();
    this.active.set(runId, controller);
    try {
      return await this.executeLoop(runId, controller.signal);
    } finally {
      this.active.delete(runId);
    }
  }

  async resume(runId: string): Promise<WorkflowRunValue> {
    const run = await this.requireRun(runId);
    if (run.status !== "paused") {
      throw new WorkflowError(`workflow run is not paused: ${runId}`, "RUN_NOT_PAUSED");
    }
    return this.execute(runId);
  }

  async cancel(runId: string): Promise<WorkflowRunValue> {
    // A run may transition while cancel is reading it. Retry optimistic
    // conflicts until cancellation linearizes or another terminal state wins.
    for (;;) {
      const run = await this.requireRun(runId);
      if (run.status === "completed" || run.status === "failed") return run;
      if (run.status === "cancelled") {
        this.abortActiveRun(runId);
        return run;
      }
      const cancelled = WorkflowRun.parse({
        ...run,
        status: "cancelled",
        completedAt: this.now().toISOString(),
        failureReason: "cancelled by user",
        updatedAt: this.now().toISOString(),
        revision: run.revision + 1
      });
      try {
        await this.runs.compareAndSwap(cancelled, run.revision);
        this.abortActiveRun(runId);
        return cancelled;
      } catch (error) {
        if (error instanceof WorkflowRunRevisionConflictError) continue;
        if (error instanceof WorkflowRunTerminalStateError) {
          const current = await this.requireRun(runId);
          if (current.status === "cancelled") {
            this.abortActiveRun(runId);
            return current;
          }
        }
        throw error;
      }
    }
  }

  private async executeLoop(runId: string, signal: AbortSignal): Promise<WorkflowRunValue> {
    let run = await this.requireRun(runId);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;
    const workflow = await this.requireWorkflow(run.workflowId);
    // Fresh runs are already running. Resume is the only path that needs this
    // transition; its CAS cannot overwrite a cancellation that landed after
    // resume() read the paused record.
    if (run.status === "paused") {
      run = await this.persist(run, { status: "running" });
      if (run.status === "cancelled") return run;
    }
    const orderedSteps = [...workflow.steps].sort((left, right) => left.order - right.order);
    for (const step of orderedSteps) {
      // Honor an external cancel between steps.
      run = await this.requireRun(runId);
      if (run.status === "cancelled") return run;
      const result = stepResultFor(run, step.id);
      if (!result) {
        return this.fail(run, `run is missing a result slot for step ${step.id}`);
      }
      if (result.status === "succeeded") continue; // idempotent resume
      if (step.mutation && !run.approvalId) {
        return this.applyFailurePolicy(run, workflow.failurePolicy, step.id, "mutation step requires an approvalId");
      }
      let renderedAction: WorkflowStepAction;
      let expectedResult: string;
      try {
        renderedAction = renderAction(step.action, run.parameters);
        expectedResult = renderTemplate(step.expectedResult, run.parameters);
      } catch (error) {
        return this.fail(run, error instanceof Error ? error.message : String(error));
      }
      run = await this.updateStep(run, step.id, {
        status: "running",
        startedAt: this.now().toISOString()
      });
      if (run.status === "cancelled") return run;
      if (signal.aborted) {
        run = await this.requireRun(runId);
        if (run.status === "cancelled") return run;
        throw signal.reason instanceof Error ? signal.reason : new Error("workflow execution aborted");
      }
      let outcome: StepExecutionOutcome;
      try {
        outcome = await this.executor.executeStep({
          workflow,
          run,
          step,
          renderedAction,
          expectedResult,
          signal,
          ...(run.approvalId ? { approvalId: run.approvalId } : {})
        });
      } catch (executorError) {
        outcome = {
          status: "failed",
          error: executorError instanceof Error ? executorError.message : String(executorError)
        };
      }
      // A cancel (or external pause) landing while the executor ran wins over
      // the step outcome: reload before writing anything further.
      run = await this.requireRun(runId);
      if (run.status === "cancelled") return run;
      const current = stepResultFor(run, step.id) ?? result;
      const succeeded = outcome.status === "succeeded"
        && outcome.verification !== undefined
        && outcome.verification.matched
        && outcome.verification.confidence >= this.minConfidence;
      if (succeeded) {
        run = await this.updateStep(run, step.id, {
          status: "succeeded",
          attempts: current.attempts + 1,
          verification: outcome.verification!,
          ...(outcome.recordId ? { recordId: outcome.recordId } : {}),
          evidenceIds: outcome.evidenceIds ?? [],
          completedAt: this.now().toISOString()
        });
        if (run.status === "cancelled") return run;
        const evidence = new Set(run.evidenceIds);
        if (outcome.recordId) evidence.add(`action:${outcome.recordId}`);
        for (const id of outcome.evidenceIds ?? []) evidence.add(id);
        run = await this.persist(run, { evidenceIds: [...evidence] });
        if (run.status === "cancelled") return run;
        continue;
      }
      const error = outcome.error
        ?? (outcome.status === "succeeded" && !outcome.verification
          ? "executor reported success without verification evidence"
          : outcome.verification && !outcome.verification.matched
            ? `expected result did not match: ${outcome.verification.reason}`
            : outcome.verification
              ? `verification confidence ${outcome.verification.confidence} is below ${this.minConfidence}`
              : "step failed");
      run = await this.updateStep(run, step.id, {
        status: "failed",
        attempts: current.attempts + 1,
        ...(outcome.verification ? { verification: outcome.verification } : {}),
        ...(outcome.recordId ? { recordId: outcome.recordId } : {}),
        error,
        completedAt: this.now().toISOString()
      });
      if (run.status === "cancelled") return run;
      return this.applyFailurePolicy(run, step.onFailure ?? workflow.failurePolicy, step.id, error);
    }
    run = await this.requireRun(runId);
    if (run.status === "cancelled") return run;
    return this.persist(run, { status: "completed", completedAt: this.now().toISOString() });
  }

  private async applyFailurePolicy(
    run: WorkflowRunValue,
    policy: "stop" | "pause-for-user",
    stepId: string,
    reason: string
  ): Promise<WorkflowRunValue> {
    if (policy === "pause-for-user") {
      return this.persist(run, { status: "paused", failureReason: `step ${stepId}: ${reason}` });
    }
    return this.fail(run, `step ${stepId}: ${reason}`);
  }

  private async fail(run: WorkflowRunValue, reason: string): Promise<WorkflowRunValue> {
    return this.persist(run, {
      status: "failed",
      failureReason: reason,
      completedAt: this.now().toISOString()
    });
  }

  private async updateStep(
    run: WorkflowRunValue,
    stepId: string,
    patch: Partial<WorkflowStepResult>
  ): Promise<WorkflowRunValue> {
    const steps = run.steps.map((result) => (result.stepId === stepId ? { ...result, ...patch } : result));
    return this.persist(run, { steps });
  }

  private async persist(run: WorkflowRunValue, patch: Partial<WorkflowRunValue>): Promise<WorkflowRunValue> {
    const next = WorkflowRun.parse({
      ...run,
      ...patch,
      updatedAt: this.now().toISOString(),
      revision: run.revision + 1
    });
    try {
      await this.runs.compareAndSwap(next, run.revision);
      return next;
    } catch (error) {
      if (
        error instanceof WorkflowRunRevisionConflictError
        || error instanceof WorkflowRunTerminalStateError
      ) {
        const current = await this.requireRun(run.id);
        // Cancellation is an authority boundary, not an ordinary optimistic
        // conflict. Return the winning terminal record so every caller exits
        // without executing or persisting another step.
        if (current.status === "cancelled") return current;
      }
      throw error;
    }
  }

  private abortActiveRun(runId: string): void {
    const controller = this.active.get(runId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(`workflow run cancelled by user: ${runId}`));
    }
  }

  private async requireWorkflow(workflowId: string): Promise<WorkflowValue> {
    const workflow = await this.workflows.get(workflowId);
    if (!workflow) throw new WorkflowError(`workflow not found: ${workflowId}`, "WORKFLOW_NOT_FOUND");
    return workflow;
  }

  private async requireRun(runId: string): Promise<WorkflowRunValue> {
    const run = await this.runs.get(runId);
    if (!run) throw new WorkflowError(`workflow run not found: ${runId}`, "WORKFLOW_RUN_NOT_FOUND");
    return run;
  }
}

function stepResultFor(run: WorkflowRunValue, stepId: string): WorkflowStepResult | undefined {
  return run.steps.find((result) => result.stepId === stepId);
}

/** Resolve declared parameters against provided values; unknown or missing-required values fail closed. */
function resolveParameters(workflow: WorkflowValue, provided: Record<string, string>): Record<string, string> {
  const declared = new Map(workflow.parameters.map((parameter) => [parameter.name, parameter]));
  for (const name of Object.keys(provided)) {
    if (!declared.has(name)) {
      throw new WorkflowError(`unknown workflow parameter: ${name}`, "UNKNOWN_PARAMETER");
    }
  }
  const values: Record<string, string> = {};
  for (const parameter of workflow.parameters) {
    const value = provided[parameter.name] ?? parameter.defaultValue;
    if (value === undefined) {
      if (parameter.required) {
        throw new WorkflowError(`missing required workflow parameter: ${parameter.name}`, "MISSING_PARAMETER");
      }
      continue;
    }
    values[parameter.name] = value;
  }
  return values;
}

function renderAction(action: WorkflowStepAction, values: Record<string, string>): WorkflowStepAction {
  switch (action.kind) {
    case "type":
      return { ...action, text: renderTemplate(action.text, values) };
    case "navigate":
      return { ...action, url: renderTemplate(action.url, values) };
    default:
      return action;
  }
}
