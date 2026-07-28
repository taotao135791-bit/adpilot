#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  ComputerUseEvaluation,
  type ComputerUseEvaluationStatus,
  createComputerUseMetrics,
  currentComputerUseEnvironment,
  emptyComputerUseTarget
} from "./computer-use-evaluation.js";

export type GoogleAdsEvalMode = "readonly" | "prepare" | "mutation";

export interface HarnessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GoogleAdsEvalOptions {
  mode: GoogleAdsEvalMode;
  values: Map<string, string>;
  mutationOptIn: boolean;
}

export interface MutationExecutionResult {
  status: "passed" | "failed";
  nativeInputExecuted: boolean;
  mutationExecuted: boolean;
  persistenceVerified: boolean;
  actionAttempts: number;
  successfulActions: number;
  verificationAttempts: number;
  successfulVerifications: number;
  reason?: string;
}

const valuedFlags = new Set([
  "--product-session-id",
  "--approval-id",
  "--client",
  "--test-account",
  "--browser-profile",
  "--campaign",
  "--campaign-id",
  "--draft-budget",
  "--field",
  "--old-value",
  "--new-value",
  "--approval-file",
  "--output"
]);
const nativeActionKinds = new Set([
  "click",
  "double_click",
  "right_click",
  "move",
  "drag",
  "type",
  "hotkey",
  "scroll"
]);

const MutationApproval = z.object({
  schema: z.literal("AdPilotGoogleAdsTestMutationApproval"),
  schemaVersion: z.literal(1),
  approvalId: z.string().uuid(),
  approvedBy: z.string().min(1),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  singleUse: z.literal(true),
  productSessionId: z.string().uuid(),
  clientId: z.string().min(1),
  testAccount: z.string().min(1),
  browserProfile: z.string().min(1),
  campaign: z.string().min(1),
  campaignId: z.string().min(1),
  field: z.string().min(1),
  oldValue: z.string().min(1),
  newValue: z.string().min(1)
}).strict();

type MutationApproval = z.infer<typeof MutationApproval>;

const MutationPersistenceVerification = z.object({
  verified: z.literal(true),
  refreshedFrameSha256: z.string().regex(/^[a-f0-9]{64}$/),
  exactValue: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  identityMatch: z.literal(true),
  accountId: z.string().min(1),
  campaignId: z.string().min(1),
  verifiedAt: z.string().datetime(),
  evidenceIds: z.array(z.string().min(1)).min(1)
}).strict();

const usage = [
  "Google Ads real-browser evaluation wrapper.",
  "",
  "Readonly:",
  "  pnpm test:computer:google-ads-readonly -- --client <id> --test-account <account-ref> --browser-profile <name> --campaign <name>",
  "",
  "Prepare, never submit:",
  "  pnpm test:computer:google-ads-prepare -- --client <id> --test-account <account-ref> --browser-profile <name> --campaign <name> --draft-budget <value>",
  "",
  "One-shot mutation evaluation (only an exact pending_user test approval; never retried):",
  "  pnpm test:computer:google-ads-mutation -- --product-session-id <uuid> --approval-id <uuid> --client <id> --test-account <account-ref> --browser-profile <name> --campaign <name> --campaign-id <id> --field <field> --old-value <value> --new-value <value> --approval-file <file> --allow-test-mutation",
  "",
  "All commands emit a ComputerUseEvaluation JSON report. Missing external prerequisites are blocked/not-run, never reported as a pass."
].join("\n");

export function parseGoogleAdsEvalArguments(
  mode: GoogleAdsEvalMode,
  tokens: string[]
): GoogleAdsEvalOptions {
  const values = new Map<string, string>();
  let mutationOptIn = false;
  const input = tokens.filter((token, index) => !(index === 0 && token === "--"));
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index]!;
    if (token === "--allow-test-mutation") {
      if (mode !== "mutation") throw new Error(`${token} is valid only for mutation preflight`);
      if (mutationOptIn) throw new Error(`${token} may appear only once`);
      mutationOptIn = true;
      continue;
    }
    if (!valuedFlags.has(token)) throw new Error(`unknown Google Ads eval argument: ${token}`);
    if (values.has(token)) throw new Error(`${token} may appear only once`);
    const value = input[++index];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires one value`);
    values.set(token, value);
  }
  for (const name of ["--product-session-id", "--approval-id"]) {
    const value = values.get(name);
    if (value && !z.string().uuid().safeParse(value).success) {
      throw new Error(`${name} must be a UUID`);
    }
  }
  return { mode, values, mutationOptIn };
}

export async function evaluateGoogleAds(
  options: GoogleAdsEvalOptions,
  dependencies: {
    now?: Date;
    runHarness?: (mode: "readonly" | "prepare", args: string[]) => Promise<HarnessResult>;
    executeMutation?: (
      options: GoogleAdsEvalOptions,
      approval: MutationApproval
    ) => Promise<MutationExecutionResult>;
  } = {}
): Promise<ComputerUseEvaluation> {
  const now = dependencies.now ?? new Date();
  const target = {
    ...emptyComputerUseTarget(),
    productSessionId: uuidOrNull(options.values, "--product-session-id"),
    approvalId: uuidOrNull(options.values, "--approval-id"),
    clientId: valueOrNull(options.values, "--client"),
    testAccount: valueOrNull(options.values, "--test-account"),
    browserProfile: valueOrNull(options.values, "--browser-profile"),
    campaign: valueOrNull(options.values, "--campaign"),
    campaignId: valueOrNull(options.values, "--campaign-id")
  };
  const command = `pnpm test:computer:google-ads-${options.mode}`;
  const evidenceClass = `real-browser-${options.mode}` as const;
  const missingNamedTarget = [
    ["--client", target.clientId],
    ["--test-account", target.testAccount],
    ["--browser-profile", target.browserProfile],
    ["--campaign", target.campaign]
  ].filter((entry): entry is [string, null] => entry[1] === null).map(([name]) => name);

  if (missingNamedTarget.length > 0) {
    return ComputerUseEvaluation.parse({
      schema: "ComputerUseEvaluation",
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      command,
      mode: options.mode,
      evidenceClass,
      status: "blocked-by-no-test-account",
      ...currentComputerUseEnvironment(),
      execution: noExecution(),
      target,
      metrics: createComputerUseMetrics(),
      blockers: [{
        code: "NAMED_TEST_TARGET_REQUIRED",
        message: `A named test target is required; missing ${missingNamedTarget.join(", ")}. AdPilot never chooses a production account or campaign.`
      }],
      artifacts: [],
      notes: ["No browser or model call was attempted."]
    });
  }

  if (options.mode === "mutation") {
    return evaluateMutation(options, target, now, command, dependencies.executeMutation);
  }

  if (options.mode === "prepare" && !options.values.has("--draft-budget")) {
    return notRunReport({
      now,
      command,
      mode: options.mode,
      evidenceClass,
      target,
      code: "DRAFT_VALUE_REQUIRED",
      message: "Prepare requires an exact --draft-budget value; no input was attempted."
    });
  }

  const harnessArgs = [
    "--client", target.clientId!,
    "--browser-profile", target.browserProfile!,
    "--campaign", target.campaign!,
    "--test-account", target.testAccount!,
    ...(options.mode === "prepare"
      ? ["--draft-budget", options.values.get("--draft-budget")!]
      : [])
  ];
  const harness = await (dependencies.runHarness ?? runValidationHarness)(
    options.mode,
    harnessArgs
  );
  const summary = parseHarnessSummary(harness.stdout);
  const manifest = summary?.artifactRoot
    ? await readHarnessManifest(summary.artifactRoot)
    : undefined;
  const diagnostic = [
    harness.stderr,
    ...(manifest?.failures.map((failure) => failure.reason) ?? [])
  ].join("\n");
  const status = summary?.passed === true && harness.exitCode === 0
    ? "passed"
    : classifyHarnessBlocker(diagnostic);
  const records = manifest?.records ?? [];
  const actionAttempts = records.reduce((total, record) =>
    total + record.events.filter((event) =>
      event.type === "grounded"
      && event.action !== undefined
      && nativeActionKinds.has(event.action)
    ).length, 0);
  const successfulActions = records.reduce((total, record) =>
    total + record.events.filter((event) =>
      event.type === "executed"
      && event.action !== undefined
      && nativeActionKinds.has(event.action)
    ).length, 0);
  const verificationAttempts = records.reduce((total, record) =>
    total + record.events.filter((event) => event.type === "verified").length, 0);
  const successfulVerifications = records.reduce((total, record) =>
    total + record.events.filter(
      (event) => event.type === "verified" && event.matched === true
    ).length, 0);
  const successfulCaptures = records.reduce((total, record) =>
    total + record.events.filter((event) => event.type === "screenshot").length, 0);
  const runOccurred = Boolean(
    manifest && (manifest.records.length > 0 || manifest.failures.length > 0)
  );
  const passed = status === "passed";
  const blocked = status.startsWith("blocked-");
  const blockerMessage = publicDiagnostic(diagnostic, status);

  return ComputerUseEvaluation.parse({
    schema: "ComputerUseEvaluation",
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    command,
    mode: options.mode,
    evidenceClass,
    status,
    ...currentComputerUseEnvironment(),
    execution: {
      fixtureUsed: false,
      liveModelCalled: records.some((record) =>
        record.events.some((event) => event.type === "grounded")
      ),
      realBrowserUsed: runOccurred,
      nativeInputExecuted: successfulActions > 0,
      mutationExecuted: false
    },
    target,
    metrics: createComputerUseMetrics({
      runs: runOccurred ? 1 : 0,
      passedRuns: passed ? 1 : 0,
      failedRuns: runOccurred && !passed && !blocked ? 1 : 0,
      blockedRuns: blocked && runOccurred ? 1 : 0,
      actionAttempts,
      successfulActions,
      verificationAttempts,
      successfulVerifications,
      permissionAttempts: runOccurred ? 1 : 0,
      successfulPermissions: runOccurred && status !== "blocked-by-permission" ? 1 : 0,
      captureAttempts: successfulCaptures,
      successfulCaptures,
      groundingAttempts: actionAttempts,
      successfulGroundings: actionAttempts,
      identityValidationAttempts: runOccurred ? 1 : 0,
      successfulIdentityValidations: passed ? 1 : 0
    }),
    blockers: passed ? [] : [{
      code: blockerCode(status),
      message: blockerMessage
    }],
    artifacts: summary?.artifactRoot
      ? [{ kind: "real-browser-manifest", path: resolve(summary.artifactRoot, "manifest.json") }]
      : [],
    notes: [
      options.mode === "readonly"
        ? "Read-only permits bounded navigation and scrolling, but never typing or mutation."
        : "Prepare permits only an exact draft input and never Save, Apply, Publish, Enter or submission.",
      "Fixture results and live-model fixture scores are not included in this real-browser report."
    ]
  });
}

export async function writeEvaluationReport(
  report: ComputerUseEvaluation,
  output?: string
): Promise<string> {
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const path = resolve(
    output ?? `artifacts/evals/google-ads/${stamp}-${report.mode}.json`
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function classifyHarnessBlocker(message: string): ComputerUseEvaluationStatus {
  if (/screen recording|screen capture|accessibility|permission|not authorized|tcc/i.test(message)) {
    return "blocked-by-permission";
  }
  if (/image-capable model|credential|api key|oauth|provider.+not configured|computer use is not ready/i.test(message)) {
    return "blocked-by-missing-credentials";
  }
  if (/has no google_ads account|account.+not bound|test account|campaign.+not found/i.test(message)) {
    return "blocked-by-no-test-account";
  }
  if (/managed browser is not connected|browser session|run adpilot browser start/i.test(message)) {
    return "not-run";
  }
  return "failed";
}

async function evaluateMutation(
  options: GoogleAdsEvalOptions,
  target: ComputerUseEvaluation["target"],
  now: Date,
  command: string,
  executeMutation: ((
    options: GoogleAdsEvalOptions,
    approval: MutationApproval
  ) => Promise<MutationExecutionResult>) | undefined
): Promise<ComputerUseEvaluation> {
  const mutationFields = [
    "--product-session-id",
    "--approval-id",
    "--campaign-id",
    "--field",
    "--old-value",
    "--new-value"
  ];
  const missingFields = mutationFields.filter((name) => !options.values.has(name));
  if (missingFields.length > 0) {
    return notRunReport({
      now,
      command,
      mode: "mutation",
      evidenceClass: "real-browser-mutation",
      target,
      code: "EXACT_MUTATION_TARGET_REQUIRED",
      message: `Mutation preflight is missing ${missingFields.join(", ")}. No production target is inferred.`
    });
  }
  if (!options.mutationOptIn) {
    return blockedPermissionReport(
      now,
      command,
      target,
      "EXPLICIT_MUTATION_OPT_IN_REQUIRED",
      "Mutation preflight requires the explicit --allow-test-mutation flag."
    );
  }
  const approvalPath = options.values.get("--approval-file");
  if (!approvalPath) {
    return blockedPermissionReport(
      now,
      command,
      target,
      "FRESH_APPROVAL_REQUIRED",
      "Mutation preflight requires a fresh, single-use --approval-file."
    );
  }

  let approval: MutationApproval;
  try {
    approval = await readFreshApproval(approvalPath, now);
  } catch (caught) {
    return blockedPermissionReport(
      now,
      command,
      target,
      "FRESH_APPROVAL_INVALID",
      caught instanceof Error ? caught.message : String(caught)
    );
  }
  const expectedBinding = {
    productSessionId: target.productSessionId!,
    approvalId: target.approvalId!,
    clientId: target.clientId!,
    testAccount: target.testAccount!,
    browserProfile: target.browserProfile!,
    campaign: target.campaign!,
    campaignId: options.values.get("--campaign-id")!,
    field: options.values.get("--field")!,
    oldValue: options.values.get("--old-value")!,
    newValue: options.values.get("--new-value")!
  };
  const mismatches = Object.entries(expectedBinding)
    .filter(([key, value]) => approval[key as keyof typeof expectedBinding] !== value)
    .map(([key]) => key);
  if (mismatches.length > 0) {
    return blockedPermissionReport(
      now,
      command,
      target,
      "APPROVAL_BINDING_MISMATCH",
      `Approval does not match the requested ${mismatches.join(", ")}.`
    );
  }

  let execution: MutationExecutionResult;
  try {
    execution = await (executeMutation ?? executeApprovedMutation)(options, approval);
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    const status = classifyHarnessBlocker(reason);
    return ComputerUseEvaluation.parse({
      schema: "ComputerUseEvaluation",
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      command,
      mode: "mutation",
      evidenceClass: "real-browser-mutation",
      status,
      ...currentComputerUseEnvironment(),
      execution: noExecution(),
      target,
      metrics: createComputerUseMetrics(),
      blockers: [{
        code: blockerCode(status),
        message: publicDiagnostic(reason, status)
      }],
      artifacts: [],
      notes: [
        `Product approval ${approval.approvalId} was not reported as consumed.`,
        "No mutation retry was attempted."
      ]
    });
  }
  const passed = execution.status === "passed"
    && execution.mutationExecuted
    && execution.persistenceVerified;
  return ComputerUseEvaluation.parse({
    schema: "ComputerUseEvaluation",
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    command,
    mode: "mutation",
    evidenceClass: "real-browser-mutation",
    status: passed ? "passed" : "failed",
    ...currentComputerUseEnvironment(),
    execution: {
      fixtureUsed: false,
      liveModelCalled: execution.actionAttempts > 0 || execution.verificationAttempts > 0,
      realBrowserUsed: execution.actionAttempts > 0 || execution.verificationAttempts > 0,
      nativeInputExecuted: execution.nativeInputExecuted,
      mutationExecuted: execution.mutationExecuted
    },
    target,
    metrics: createComputerUseMetrics({
      runs: 1,
      passedRuns: passed ? 1 : 0,
      failedRuns: passed ? 0 : 1,
      actionAttempts: execution.actionAttempts,
      successfulActions: execution.successfulActions,
      verificationAttempts: execution.verificationAttempts,
      successfulVerifications: execution.successfulVerifications
    }),
    blockers: passed ? [] : [{
      code: execution.mutationExecuted
        ? "MUTATION_OUTCOME_UNKNOWN"
        : "MUTATION_EXECUTION_FAILED",
      message: execution.reason
        ?? "The exact refreshed persistence proof was absent; the mutation outcome is unknown."
    }],
    artifacts: [],
    notes: [
      `Product approval ${approval.approvalId} was the only approval presented for execution.`,
      execution.persistenceVerified
        ? "Exact account, campaign and value persistence was verified after refresh/re-entry."
        : "Persistence was not proven; this report does not claim success.",
      "The mutation commit path was invoked at most once and no retry was attempted."
    ]
  });
}

async function readFreshApproval(path: string, now: Date): Promise<MutationApproval> {
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Approval must be a regular file.");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Approval file must be owned by the current user.");
    }
    if (stat.size < 2 || stat.size > 64 * 1024) {
      throw new Error("Approval file size is outside the 2–65536 byte limit.");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("Approval file must not be readable or writable by group/others (use mode 0600).");
    }
    const approval = MutationApproval.parse(JSON.parse(await handle.readFile("utf8")));
    const issuedAt = new Date(approval.issuedAt).getTime();
    const expiresAt = new Date(approval.expiresAt).getTime();
    const nowMs = now.getTime();
    if (issuedAt > nowMs + 5_000) throw new Error("Approval issuedAt is in the future.");
    if (nowMs - issuedAt > 5 * 60_000) throw new Error("Approval is older than five minutes.");
    if (expiresAt <= nowMs) throw new Error("Approval has expired.");
    if (expiresAt - issuedAt > 10 * 60_000) {
      throw new Error("Approval lifetime exceeds ten minutes.");
    }
    return approval;
  } finally {
    await handle.close();
  }
}

async function executeApprovedMutation(
  options: GoogleAdsEvalOptions,
  material: MutationApproval
): Promise<MutationExecutionResult> {
  const [{ createAdPilotSystem }, { visualTaskFromExecutionPlan }] = await Promise.all([
    import("@adpilot/application"),
    import("@adpilot/tools")
  ]);
  const system = await createAdPilotSystem();
  const clientId = options.values.get("--client")!;
  const approvalId = options.values.get("--approval-id")!;
  const productSessionId = options.values.get("--product-session-id")!;
  try {
    const [session, productApproval, client] = await Promise.all([
      system.sessions.require(productSessionId),
      system.approvals.get(clientId, approvalId),
      system.workspace.readClient(clientId)
    ]);
    if (session.clientId !== clientId) {
      throw new Error("product session belongs to a different client");
    }
    if (session.status !== "waiting_for_approval") {
      throw new Error(`product session status is ${session.status}, not waiting_for_approval`);
    }
    if (!session.platforms.includes("google_ads")) {
      throw new Error("product session is not bound to google_ads");
    }
    if (
      session.permissionProfile.level !== "EXECUTE"
      || session.permissionProfile.computerUse !== "execute"
      || session.permissionProfile.approvalRequired !== true
    ) {
      throw new Error("product session lacks approval-gated Computer Use execute permission");
    }
    if (
      session.permissionProfile.browserProfile !== material.browserProfile
      || !session.permissionProfile.accountRefs.includes(material.testAccount)
    ) {
      throw new Error("product session permission profile does not match the named test account and browser profile");
    }
    if (
      productApproval.status !== "pending_user"
      || productApproval.riskReview?.approved !== true
    ) {
      throw new Error("product approval is not an exact risk-reviewed pending_user approval");
    }
    if (!productApproval.executionPlan) {
      throw new Error("product approval has no complete visual execution plan");
    }
    if (
      productApproval.id !== material.approvalId
      || productApproval.clientId !== material.clientId
      || productApproval.operation.riskLevel !== "mutate"
      || productApproval.executionPlan.platform !== "google_ads"
      || productApproval.executionPlan.browserProfile !== material.browserProfile
      || productApproval.executionPlan.accountId !== material.testAccount
      || productApproval.executionPlan.campaignName !== material.campaign
      || productApproval.executionPlan.campaignId !== material.campaignId
      || productApproval.executionPlan.operation !== material.field
      || String(productApproval.executionPlan.currentValue) !== material.oldValue
      || String(productApproval.executionPlan.proposedValue) !== material.newValue
    ) {
      throw new Error("stored product approval does not exactly match the fresh mutation authorization");
    }
    const configuredAccount = client.accounts?.accounts.find((account) =>
      account.platform === "google_ads"
      && account.accountRef === material.testAccount
      && account.browserProfile === material.browserProfile
      && account.allowedDomains.includes("ads.google.com")
    );
    if (!configuredAccount) {
      throw new Error("named test account is not an allowlisted google_ads workspace account");
    }

    await system.tools.validateApprovalGuardrail(clientId, approvalId, true);
    const issued = await system.approvals.approveByUser(
      clientId,
      approvalId,
      material.approvedBy
    );
    const visualTask = visualTaskFromExecutionPlan(
      issued.approval.executionPlan!,
      client.kpi.currency,
      "MUTATE"
    );
    const auditStart = new Date().toISOString();
    try {
      const result = await system.tools.commitApprovedVisualAction(
        {
          clientId,
          taskId: issued.approval.taskId,
          actor: "google_ads_live_eval",
          permission: "MUTATE"
        },
        approvalId,
        issued.token,
        issued.approval.operation,
        visualTask
      );
      const persistence = MutationPersistenceVerification.safeParse(
        (result as unknown as { persistenceVerification?: unknown })
          .persistenceVerification
      );
      const mutationExecuted = result.status === "done"
        ? result.executed
        : result.blockerCode === "MUTATION_RETRY_FORBIDDEN";
      const immediateVerified = result.status === "done" && result.verified;
      const persistenceVerified = persistence.success
        && String(persistence.data.exactValue) === material.newValue
        && persistence.data.accountId === material.testAccount
        && persistence.data.campaignId === material.campaignId;
      return {
        status: result.status === "done"
          && result.executed
          && immediateVerified
          && persistenceVerified
          ? "passed"
          : "failed",
        nativeInputExecuted: mutationExecuted,
        mutationExecuted,
        persistenceVerified,
        actionAttempts: result.status === "done" || result.lastAction ? 1 : 0,
        successfulActions: mutationExecuted ? 1 : 0,
        verificationAttempts: (immediateVerified ? 1 : 0) + (persistence.success ? 1 : 0),
        successfulVerifications: (immediateVerified ? 1 : 0) + (persistenceVerified ? 1 : 0),
        ...(persistenceVerified
          ? {}
          : {
              reason: result.status === "failed"
                ? result.blocker
                : "commit returned without the exact refreshed persistence proof"
            })
      };
    } catch (caught) {
      const events = (await system.audit.list(clientId)).filter((event) =>
        event.taskId === productApproval.taskId
        && event.at >= auditStart
      );
      const mutationExecuted = events.some((event) =>
        event.details.nativeActionExecuted === true
        || (
          event.action === "execute_visual_task"
          && event.status === "succeeded"
          && event.details.executed === true
        )
      );
      return {
        status: "failed",
        nativeInputExecuted: mutationExecuted,
        mutationExecuted,
        persistenceVerified: false,
        actionAttempts: events.some((event) =>
          event.action === "execute_visual_task"
        ) ? 1 : 0,
        successfulActions: mutationExecuted ? 1 : 0,
        verificationAttempts: events.filter((event) =>
          event.action === "verify_post_mutation_value"
          || event.action === "verify_post_mutation_persistence"
        ).length,
        successfulVerifications: events.filter((event) =>
          (
            event.action === "verify_post_mutation_value"
            || event.action === "verify_post_mutation_persistence"
          )
          && event.status === "succeeded"
        ).length,
        reason: mutationExecuted
          ? `Mutation may have executed, but persistence verification failed: ${errorMessage(caught)}`
          : errorMessage(caught)
      };
    }
  } finally {
    await system.shutdown().catch(() => undefined);
  }
}

async function runValidationHarness(
  mode: "readonly" | "prepare",
  args: string[]
): Promise<HarnessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "tsx", "scripts/validate-google-ads.ts", mode, ...args],
      {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolveResult({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function parseHarnessSummary(stdout: string): {
  passed: boolean;
  artifactRoot?: string;
} | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const result = z.object({
      passed: z.boolean(),
      artifactRoot: z.string().min(1).optional()
    }).passthrough().safeParse(parsed);
    if (!result.success) return undefined;
    return {
      passed: result.data.passed,
      ...(result.data.artifactRoot ? { artifactRoot: result.data.artifactRoot } : {})
    };
  } catch {
    return undefined;
  }
}

async function readHarnessManifest(artifactRoot: string): Promise<{
  failures: Array<{ reason: string }>;
  records: Array<{
    events: Array<{ type: string; matched?: boolean; action?: string }>;
  }>;
} | undefined> {
  try {
    const parsed = z.object({
      failures: z.array(z.object({ reason: z.string() }).passthrough()),
      records: z.array(z.object({
        events: z.array(z.object({
          type: z.string(),
          matched: z.boolean().optional(),
          action: z.object({ action: z.string() }).passthrough().optional()
        }).passthrough())
      }).passthrough())
    }).passthrough().parse(
      JSON.parse(await readFile(resolve(artifactRoot, "manifest.json"), "utf8"))
    );
    return {
      failures: parsed.failures.map((failure) => ({ reason: failure.reason })),
      records: parsed.records.map((record) => ({
        events: record.events.map((event) => ({
          type: event.type,
          ...(event.matched === undefined ? {} : { matched: event.matched }),
          ...(event.action === undefined ? {} : { action: event.action.action })
        }))
      }))
    };
  } catch {
    return undefined;
  }
}

function notRunReport(input: {
  now: Date;
  command: string;
  mode: GoogleAdsEvalMode;
  evidenceClass: `real-browser-${GoogleAdsEvalMode}`;
  target: ComputerUseEvaluation["target"];
  code: string;
  message: string;
}): ComputerUseEvaluation {
  return ComputerUseEvaluation.parse({
    schema: "ComputerUseEvaluation",
    schemaVersion: 1,
    generatedAt: input.now.toISOString(),
    command: input.command,
    mode: input.mode,
    evidenceClass: input.evidenceClass,
    status: "not-run",
    ...currentComputerUseEnvironment(),
    execution: noExecution(),
    target: input.target,
    metrics: createComputerUseMetrics(),
    blockers: [{ code: input.code, message: input.message }],
    artifacts: [],
    notes: ["No browser, model, native input or mutation was attempted."]
  });
}

function blockedPermissionReport(
  now: Date,
  command: string,
  target: ComputerUseEvaluation["target"],
  code: string,
  message: string
): ComputerUseEvaluation {
  return ComputerUseEvaluation.parse({
    schema: "ComputerUseEvaluation",
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    command,
    mode: "mutation",
    evidenceClass: "real-browser-mutation",
    status: "blocked-by-permission",
    ...currentComputerUseEnvironment(),
    execution: noExecution(),
    target,
    metrics: createComputerUseMetrics(),
    blockers: [{ code, message }],
    artifacts: [],
    notes: ["No browser, model, native input or mutation was attempted."]
  });
}

function noExecution() {
  return {
    fixtureUsed: false,
    liveModelCalled: false,
    realBrowserUsed: false,
    nativeInputExecuted: false,
    mutationExecuted: false
  };
}

function valueOrNull(values: Map<string, string>, name: string): string | null {
  return values.get(name) ?? null;
}

function uuidOrNull(values: Map<string, string>, name: string): string | null {
  return values.get(name) ?? null;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function blockerCode(status: ComputerUseEvaluationStatus): string {
  return ({
    passed: "NONE",
    failed: "LIVE_EVALUATION_FAILED",
    skipped: "LIVE_EVALUATION_SKIPPED",
    "not-run": "LIVE_EVALUATION_NOT_RUN",
    "blocked-by-permission": "NATIVE_PERMISSION_REQUIRED",
    "blocked-by-missing-credentials": "VISUAL_MODEL_CREDENTIALS_REQUIRED",
    "blocked-by-no-test-account": "TEST_ACCOUNT_REQUIRED"
  } satisfies Record<ComputerUseEvaluationStatus, string>)[status];
}

function publicDiagnostic(
  diagnostic: string,
  status: ComputerUseEvaluationStatus
): string {
  if (status === "blocked-by-permission") {
    return "Screen Recording or Accessibility permission blocked the real-browser run.";
  }
  if (status === "blocked-by-missing-credentials") {
    return "No configured image-capable model credential was available for the live run.";
  }
  if (status === "blocked-by-no-test-account") {
    return "The named Google Ads test account or campaign is not configured.";
  }
  if (status === "not-run") {
    return "The AdPilot-managed browser session is not connected.";
  }
  const firstLine = diagnostic.split(/\r?\n/).find((line) => line.trim());
  return firstLine?.slice(0, 500) ?? "The real-browser evaluation did not complete.";
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(usage);
    return;
  }
  const mode = process.argv[2] as GoogleAdsEvalMode | undefined;
  if (!mode || !["readonly", "prepare", "mutation"].includes(mode)) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  let options: GoogleAdsEvalOptions;
  try {
    options = parseGoogleAdsEvalArguments(mode, process.argv.slice(3));
  } catch (caught) {
    const now = new Date();
    const report = ComputerUseEvaluation.parse({
      schema: "ComputerUseEvaluation",
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      command: `pnpm test:computer:google-ads-${mode}`,
      mode,
      evidenceClass: `real-browser-${mode}`,
      status: "failed",
      ...currentComputerUseEnvironment(),
      execution: noExecution(),
      target: emptyComputerUseTarget(),
      metrics: createComputerUseMetrics(),
      blockers: [{
        code: "INVALID_ARGUMENTS",
        message: caught instanceof Error ? caught.message : String(caught)
      }],
      artifacts: [],
      notes: ["Argument validation failed before any external action."]
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  const report = await evaluateGoogleAds(options);
  const output = await writeEvaluationReport(report, options.values.get("--output"));
  console.log(JSON.stringify(report, null, 2));
  console.error(`Google Ads Computer Use evaluation written to ${output}`);
  if (report.status === "failed") process.exitCode = 2;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  await main();
}
