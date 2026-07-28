import { release } from "node:os";
import { z } from "zod";

export const ComputerUseEvaluationStatus = z.enum([
  "passed",
  "failed",
  "skipped",
  "not-run",
  "blocked-by-permission",
  "blocked-by-missing-credentials",
  "blocked-by-no-test-account"
]);

export type ComputerUseEvaluationStatus = z.infer<typeof ComputerUseEvaluationStatus>;

export const ComputerUseEvidenceClass = z.enum([
  "fixture-replay",
  "live-model-fixture",
  "real-browser-readonly",
  "real-browser-prepare",
  "real-browser-mutation"
]);

export type ComputerUseEvidenceClass = z.infer<typeof ComputerUseEvidenceClass>;

export const ComputerUseEvaluationMetrics = z.object({
  runs: z.number().int().nonnegative(),
  totalRuns: z.number().int().nonnegative(),
  completedRuns: z.number().int().nonnegative(),
  passedRuns: z.number().int().nonnegative(),
  failedRuns: z.number().int().nonnegative(),
  blockedRuns: z.number().int().nonnegative(),
  actionAttempts: z.number().int().nonnegative(),
  successfulActions: z.number().int().nonnegative(),
  verificationAttempts: z.number().int().nonnegative(),
  successfulVerifications: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1).nullable(),
  permissionSuccessRate: z.number().min(0).max(1).nullable(),
  captureSuccessRate: z.number().min(0).max(1).nullable(),
  groundingSuccessRate: z.number().min(0).max(1).nullable(),
  actionSuccessRate: z.number().min(0).max(1).nullable(),
  identityValidationRate: z.number().min(0).max(1).nullable(),
  valueReadAccuracy: z.number().min(0).max(1).nullable(),
  verificationSuccessRate: z.number().min(0).max(1).nullable(),
  userTakeoverRate: z.number().min(0).max(1).nullable(),
  wrongWindowActions: z.number().int().nonnegative(),
  wrongAccountActions: z.number().int().nonnegative(),
  wrongCampaignActions: z.number().int().nonnegative(),
  unapprovedMutations: z.number().int().nonnegative(),
  duplicateMutations: z.number().int().nonnegative()
}).strict().superRefine((metrics, context) => {
  if (metrics.totalRuns !== metrics.runs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "totalRuns and runs must describe the same observed run count"
    });
  }
  if (metrics.completedRuns !== metrics.passedRuns + metrics.failedRuns) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "completedRuns must equal passedRuns plus failedRuns"
    });
  }
  if (metrics.passedRuns + metrics.failedRuns + metrics.blockedRuns > metrics.runs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "run outcome counts cannot exceed runs"
    });
  }
  requireNullWithoutDenominator(context, "successRate", metrics.runs, metrics.successRate);
  requireNullWithoutDenominator(
    context,
    "actionSuccessRate",
    metrics.actionAttempts,
    metrics.actionSuccessRate
  );
  requireNullWithoutDenominator(
    context,
    "verificationSuccessRate",
    metrics.verificationAttempts,
    metrics.verificationSuccessRate
  );
});

export type ComputerUseEvaluationMetrics = z.infer<typeof ComputerUseEvaluationMetrics>;

export const ComputerUseEvaluation = z.object({
  schema: z.literal("ComputerUseEvaluation"),
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  command: z.string().min(1),
  mode: z.enum(["fixture", "live-model", "readonly", "prepare", "mutation"]),
  evidenceClass: ComputerUseEvidenceClass,
  status: ComputerUseEvaluationStatus,
  environment: z.string().min(1),
  appVersion: z.string().min(1),
  macOSVersion: z.string().min(1),
  browserVersion: z.string().min(1),
  displayConfiguration: z.string().min(1),
  model: z.string().min(1),
  execution: z.object({
    fixtureUsed: z.boolean(),
    liveModelCalled: z.boolean(),
    realBrowserUsed: z.boolean(),
    nativeInputExecuted: z.boolean(),
    mutationExecuted: z.boolean()
  }).strict(),
  target: z.object({
    productSessionId: z.string().uuid().nullable(),
    approvalId: z.string().uuid().nullable(),
    clientId: z.string().min(1).nullable(),
    testAccount: z.string().min(1).nullable(),
    browserProfile: z.string().min(1).nullable(),
    campaign: z.string().min(1).nullable(),
    campaignId: z.string().min(1).nullable()
  }).strict(),
  metrics: ComputerUseEvaluationMetrics,
  blockers: z.array(z.object({
    code: z.string().min(1),
    message: z.string().min(1)
  }).strict()),
  artifacts: z.array(z.object({
    kind: z.string().min(1),
    path: z.string().min(1)
  }).strict()),
  notes: z.array(z.string().min(1))
}).strict().superRefine((report, context) => {
  if (report.metrics.runs === 0) {
    for (const field of [
      "successRate",
      "permissionSuccessRate",
      "captureSuccessRate",
      "groundingSuccessRate",
      "actionSuccessRate",
      "identityValidationRate",
      "valueReadAccuracy",
      "verificationSuccessRate",
      "userTakeoverRate"
    ] as const) {
      if (report.metrics[field] !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["metrics", field],
          message: `${field} must be null when no run occurred`
        });
      }
    }
  }
  if (report.evidenceClass !== "real-browser-mutation" && report.execution.mutationExecuted) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["execution", "mutationExecuted"],
      message: "only a real-browser-mutation report may claim a mutation"
    });
  }
  if (report.status === "passed" && report.metrics.passedRuns < 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metrics", "passedRuns"],
      message: "a passed evaluation must contain a passed run"
    });
  }
});

export type ComputerUseEvaluation = z.infer<typeof ComputerUseEvaluation>;

export function createComputerUseMetrics(input: Partial<{
  runs: number;
  passedRuns: number;
  failedRuns: number;
  blockedRuns: number;
  actionAttempts: number;
  successfulActions: number;
  verificationAttempts: number;
  successfulVerifications: number;
  permissionAttempts: number;
  successfulPermissions: number;
  captureAttempts: number;
  successfulCaptures: number;
  groundingAttempts: number;
  successfulGroundings: number;
  identityValidationAttempts: number;
  successfulIdentityValidations: number;
  valueReadAttempts: number;
  accurateValueReads: number;
  takeoverOpportunities: number;
  userTakeovers: number;
  wrongWindowActions: number;
  wrongAccountActions: number;
  wrongCampaignActions: number;
  unapprovedMutations: number;
  duplicateMutations: number;
}> = {}): ComputerUseEvaluationMetrics {
  const counts = {
    runs: input.runs ?? 0,
    passedRuns: input.passedRuns ?? 0,
    failedRuns: input.failedRuns ?? 0,
    blockedRuns: input.blockedRuns ?? 0,
    actionAttempts: input.actionAttempts ?? 0,
    successfulActions: input.successfulActions ?? 0,
    verificationAttempts: input.verificationAttempts ?? 0,
    successfulVerifications: input.successfulVerifications ?? 0,
    permissionAttempts: input.permissionAttempts ?? 0,
    successfulPermissions: input.successfulPermissions ?? 0,
    captureAttempts: input.captureAttempts ?? 0,
    successfulCaptures: input.successfulCaptures ?? 0,
    groundingAttempts: input.groundingAttempts ?? 0,
    successfulGroundings: input.successfulGroundings ?? 0,
    identityValidationAttempts: input.identityValidationAttempts ?? 0,
    successfulIdentityValidations: input.successfulIdentityValidations ?? 0,
    valueReadAttempts: input.valueReadAttempts ?? 0,
    accurateValueReads: input.accurateValueReads ?? 0,
    takeoverOpportunities: input.takeoverOpportunities ?? 0,
    userTakeovers: input.userTakeovers ?? 0,
    wrongWindowActions: input.wrongWindowActions ?? 0,
    wrongAccountActions: input.wrongAccountActions ?? 0,
    wrongCampaignActions: input.wrongCampaignActions ?? 0,
    unapprovedMutations: input.unapprovedMutations ?? 0,
    duplicateMutations: input.duplicateMutations ?? 0
  };
  return ComputerUseEvaluationMetrics.parse({
    runs: counts.runs,
    totalRuns: counts.runs,
    completedRuns: counts.passedRuns + counts.failedRuns,
    passedRuns: counts.passedRuns,
    failedRuns: counts.failedRuns,
    blockedRuns: counts.blockedRuns,
    actionAttempts: counts.actionAttempts,
    successfulActions: counts.successfulActions,
    verificationAttempts: counts.verificationAttempts,
    successfulVerifications: counts.successfulVerifications,
    successRate: rate(counts.passedRuns, counts.runs),
    permissionSuccessRate: rate(
      counts.successfulPermissions,
      counts.permissionAttempts
    ),
    captureSuccessRate: rate(counts.successfulCaptures, counts.captureAttempts),
    groundingSuccessRate: rate(
      counts.successfulGroundings,
      counts.groundingAttempts
    ),
    actionSuccessRate: rate(counts.successfulActions, counts.actionAttempts),
    identityValidationRate: rate(
      counts.successfulIdentityValidations,
      counts.identityValidationAttempts
    ),
    valueReadAccuracy: rate(counts.accurateValueReads, counts.valueReadAttempts),
    verificationSuccessRate: rate(
      counts.successfulVerifications,
      counts.verificationAttempts
    ),
    userTakeoverRate: rate(counts.userTakeovers, counts.takeoverOpportunities),
    wrongWindowActions: counts.wrongWindowActions,
    wrongAccountActions: counts.wrongAccountActions,
    wrongCampaignActions: counts.wrongCampaignActions,
    unapprovedMutations: counts.unapprovedMutations,
    duplicateMutations: counts.duplicateMutations
  });
}

export function currentComputerUseEnvironment(
  env: NodeJS.ProcessEnv = process.env
): Pick<
  ComputerUseEvaluation,
  | "environment"
  | "appVersion"
  | "macOSVersion"
  | "browserVersion"
  | "displayConfiguration"
  | "model"
> {
  return {
    environment: `${process.platform}-${process.arch}`,
    appVersion: env.npm_package_version ?? "unknown",
    macOSVersion: process.platform === "darwin"
      ? `macOS/Darwin ${release()}`
      : `not-macOS (${process.platform} ${release()})`,
    browserVersion: env.ADPILOT_BROWSER_VERSION ?? "not-observed",
    displayConfiguration: env.ADPILOT_DISPLAY_CONFIGURATION ?? "not-observed",
    model: env.ADPILOT_GUI_MODEL
      ?? env.ADPILOT_VERIFY_MODEL
      ?? env.ADPILOT_FAST_MODEL
      ?? "not-configured"
  };
}

export function emptyComputerUseTarget(): ComputerUseEvaluation["target"] {
  return {
    productSessionId: null,
    approvalId: null,
    clientId: null,
    testAccount: null,
    browserProfile: null,
    campaign: null,
    campaignId: null
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function requireNullWithoutDenominator(
  context: z.RefinementCtx,
  field: "successRate" | "actionSuccessRate" | "verificationSuccessRate",
  denominator: number,
  value: number | null
): void {
  if (denominator === 0 && value !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `${field} is not computable without observations`
    });
  }
}
