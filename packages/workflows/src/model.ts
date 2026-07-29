import { z } from "zod";

/**
 * Record & Replay workflows (Phase 5).
 *
 * A Workflow is the editable, reusable product of one recorded Computer Use
 * demonstration: an ordered list of steps with visual anchors, typed input
 * parameters (`{{name}}` templates), and an explicit failure policy. A
 * WorkflowRun is one execution of a published workflow, persisting per-step
 * outcomes and evidence ids so runs are idempotent and resumable.
 */

const IsoTimestamp = z.string().datetime();
const Uuid = z.string().uuid();

const EntityBase = {
  id: Uuid,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  revision: z.number().int().min(1)
} as const;

/** `{{name}}` template reference inside step text fields. */
export const PARAMETER_REFERENCE = /\{\{([a-z][a-z0-9_]*)\}\}/g;

export const WorkflowParameterName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "parameter names are lowercase snake_case")
  .max(64);

export const WorkflowParameter = z
  .object({
    name: WorkflowParameterName,
    label: z.string().min(1).max(256),
    required: z.boolean(),
    defaultValue: z.string().max(4_000).optional(),
    example: z.string().max(4_000).optional()
  })
  .strict();
export type WorkflowParameter = z.infer<typeof WorkflowParameter>;

export const WorkflowRegionHint = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive()
  })
  .strict();
export type WorkflowRegionHint = z.infer<typeof WorkflowRegionHint>;

/**
 * Visual anchor used to re-ground a step on a live screen. Every field is
 * optional; the recorder never invents anchor data that the underlying
 * Computer Action record does not contain.
 */
export const WorkflowAnchor = z
  .object({
    text: z.string().min(1).max(1_000).optional(),
    regionHint: WorkflowRegionHint.optional(),
    ocrText: z.string().min(1).max(1_000).optional(),
    accessibilityRole: z.string().min(1).max(128).optional()
  })
  .strict();
export type WorkflowAnchor = z.infer<typeof WorkflowAnchor>;

export const WorkflowStepAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    x: z.number().finite().nonnegative().optional(),
    y: z.number().finite().nonnegative().optional()
  }).strict(),
  z.object({ kind: z.literal("type"), text: z.string().min(1).max(16_384) }).strict(),
  z.object({ kind: z.literal("keypress"), keys: z.array(z.string().min(1)).min(1).max(8) }).strict(),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    x: z.number().finite().nonnegative().optional(),
    y: z.number().finite().nonnegative().optional()
  }).strict(),
  z.object({ kind: z.literal("wait"), milliseconds: z.number().int().min(50).max(10_000) }).strict(),
  z.object({ kind: z.literal("assert") }).strict(),
  z.object({ kind: z.literal("navigate"), url: z.string().min(1).max(4_000) }).strict()
]);
export type WorkflowStepAction = z.infer<typeof WorkflowStepAction>;
export type WorkflowStepActionKind = WorkflowStepAction["kind"];

export const WorkflowFailurePolicy = z.enum(["stop", "pause-for-user"]);
export type WorkflowFailurePolicy = z.infer<typeof WorkflowFailurePolicy>;

export const WorkflowStep = z
  .object({
    id: Uuid,
    order: z.number().int().min(1),
    title: z.string().min(1).max(512),
    action: WorkflowStepAction,
    anchor: WorkflowAnchor.default({}),
    /** Names of workflow parameters this step references via `{{name}}`. */
    parameters: z.array(WorkflowParameterName).default([]),
    expectedResult: z.string().min(1).max(2_000),
    /** Step-level override; when absent the workflow's failurePolicy applies. */
    onFailure: WorkflowFailurePolicy.optional(),
    mutation: z.boolean().default(false)
  })
  .strict();
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("recorded"),
    sessionId: Uuid,
    runId: z.string().min(1).max(256),
    recordedAt: IsoTimestamp
  }).strict(),
  z.object({ kind: z.literal("manual") }).strict()
]);
export type WorkflowSource = z.infer<typeof WorkflowSource>;

export const WorkflowPermissions = z
  .object({
    requiresMutation: z.boolean(),
    requiresApproval: z.boolean(),
    requiredPermissions: z.array(z.string().min(1)).default([])
  })
  .strict();
export type WorkflowPermissions = z.infer<typeof WorkflowPermissions>;

export const WorkflowStatus = z.enum(["draft", "published", "archived"]);
export type WorkflowStatus = z.infer<typeof WorkflowStatus>;

export const Workflow = z
  .object({
    ...EntityBase,
    workspaceId: z.string().min(1).max(256),
    projectId: Uuid.optional(),
    title: z.string().min(1).max(512),
    description: z.string().max(4_000).default(""),
    source: WorkflowSource,
    parameters: z.array(WorkflowParameter).default([]),
    steps: z.array(WorkflowStep).default([]),
    permissions: WorkflowPermissions,
    successCriteria: z.array(z.string().min(1).max(1_000)).default([]),
    failurePolicy: WorkflowFailurePolicy.default("pause-for-user"),
    status: WorkflowStatus.default("draft")
  })
  .strict();
export type Workflow = z.infer<typeof Workflow>;

/* ------------------------------------------------------------------------ */
/* Runs                                                                      */
/* ------------------------------------------------------------------------ */

export const WorkflowRunStatus = z.enum(["running", "paused", "completed", "failed", "cancelled"]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;

export const WorkflowStepVerification = z
  .object({
    matched: z.boolean(),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(2_000)
  })
  .strict();
export type WorkflowStepVerification = z.infer<typeof WorkflowStepVerification>;

export const WorkflowStepResultStatus = z.enum(["pending", "running", "succeeded", "failed", "skipped"]);
export type WorkflowStepResultStatus = z.infer<typeof WorkflowStepResultStatus>;

export const WorkflowStepResult = z
  .object({
    stepId: Uuid,
    status: WorkflowStepResultStatus,
    attempts: z.number().int().nonnegative().default(0),
    verification: WorkflowStepVerification.optional(),
    /** Executor-owned record id (e.g. a Computer Action record) for this step. */
    recordId: z.string().min(1).optional(),
    evidenceIds: z.array(z.string().min(1)).default([]),
    error: z.string().min(1).optional(),
    startedAt: IsoTimestamp.optional(),
    completedAt: IsoTimestamp.optional()
  })
  .strict();
export type WorkflowStepResult = z.infer<typeof WorkflowStepResult>;

export const WorkflowRun = z
  .object({
    ...EntityBase,
    workflowId: Uuid,
    /** Workflow revision pinned at run creation; resume keeps executing this revision's steps. */
    workflowRevision: z.number().int().min(1),
    workspaceId: z.string().min(1).max(256),
    parameters: z.record(z.string().max(16_384)).default({}),
    /** Approval consumed by mutation steps; required before any mutation step runs. */
    approvalId: Uuid.optional(),
    status: WorkflowRunStatus,
    steps: z.array(WorkflowStepResult).default([]),
    evidenceIds: z.array(z.string().min(1)).default([]),
    failureReason: z.string().min(1).optional(),
    startedAt: IsoTimestamp,
    completedAt: IsoTimestamp.optional()
  })
  .strict();
export type WorkflowRun = z.infer<typeof WorkflowRun>;

/** Derive the least-privilege permission summary from a step list. */
export function deriveWorkflowPermissions(steps: readonly WorkflowStep[]): WorkflowPermissions {
  const requiresMutation = steps.some((step) => step.mutation);
  const required = new Set<string>();
  if (steps.length > 0) required.add("INTERACT");
  if (steps.some((step) => step.action.kind === "assert")) required.add("OBSERVE");
  if (requiresMutation) required.add("MUTATE");
  return WorkflowPermissions.parse({
    requiresMutation,
    requiresApproval: requiresMutation,
    requiredPermissions: [...required].sort()
  });
}

/** Render `{{name}}` references in one text value. Unknown names fail closed. */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PARAMETER_REFERENCE, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new WorkflowError(`workflow parameter has no value: ${name}`, "MISSING_PARAMETER");
    }
    return value;
  });
}

/** Names referenced by `{{name}}` templates in one text value. */
export function templateReferences(text: string): string[] {
  return [...text.matchAll(PARAMETER_REFERENCE)].map((match) => match[1]!);
}

export class WorkflowError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

/**
 * Cross-field consistency for a workflow draft: step parameter references
 * must resolve against declared parameters, declared parameters must be
 * unique, and step orders must be a dense 1..N sequence.
 */
export function assertWorkflowConsistent(workflow: {
  parameters: readonly WorkflowParameter[];
  steps: readonly WorkflowStep[];
}): void {
  const declared = new Set<string>();
  for (const parameter of workflow.parameters) {
    if (declared.has(parameter.name)) {
      throw new WorkflowError(`duplicate workflow parameter: ${parameter.name}`, "DUPLICATE_PARAMETER");
    }
    declared.add(parameter.name);
  }
  const orders = workflow.steps.map((step) => step.order).sort((left, right) => left - right);
  orders.forEach((order, index) => {
    if (order !== index + 1) {
      throw new WorkflowError("workflow step orders must be a dense 1..N sequence", "INVALID_STEP_ORDER");
    }
  });
  const ids = new Set(workflow.steps.map((step) => step.id));
  if (ids.size !== workflow.steps.length) {
    throw new WorkflowError("workflow step ids must be unique", "INVALID_STEP_ORDER");
  }
  for (const step of workflow.steps) {
    const referenced = new Set(step.parameters);
    const texts: string[] = [step.expectedResult, step.title];
    if (step.action.kind === "type") texts.push(step.action.text);
    if (step.action.kind === "navigate") texts.push(step.action.url);
    if (step.anchor.text) texts.push(step.anchor.text);
    for (const text of texts) {
      for (const name of templateReferences(text)) referenced.add(name);
    }
    for (const name of referenced) {
      if (!declared.has(name)) {
        throw new WorkflowError(
          `step "${step.title}" references undeclared parameter: ${name}`,
          "UNDECLARED_PARAMETER"
        );
      }
    }
  }
}
