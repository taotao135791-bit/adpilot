import type { PublicVisualRuntimeEvent } from "@adpilot/application";
import type {
  NativeSurface,
  Screenshot,
  VisualAction,
  VisualMicroTask,
  VisualStepResult
} from "@adpilot/computer-use";
import { sha256Text } from "./real-browser-manifest.js";

export interface PublicVisualConfirmation {
  matched: boolean;
  confidence: number;
  minimumConfidence: number;
  reason: string;
}

export interface PersistedScreenshotEvidence {
  file: string;
  sha256: string;
}

export interface BrowserSessionEvidence {
  sessionId: string;
  clientId: string;
  browserProfile: string;
  nativeProfileFingerprint?: string | undefined;
  processId?: number | undefined;
  windowId?: string | undefined;
  platform: string;
  browserApplicationId: string;
  browserApp: string;
  sessionStatus: string;
  startedAt: string;
  updatedAt: string;
}

export interface SummarizableRealBrowserRecord {
  stepPassed?: boolean;
  result?: { status?: string; attempts?: number };
  latencyMs?: number;
  task?: { riskLevel?: string };
  events?: Array<{
    type?: string;
    tier?: string;
    matched?: boolean;
    action?: { riskLevel?: string };
  }>;
}

export function summarizeRealBrowserRecords(records: SummarizableRealBrowserRecord[]) {
  const completed = records.filter((record) => record.stepPassed === true).length;
  const grounded = records.filter((record) =>
    record.events?.some((event) => event.type === "grounded")
  ).length;
  const verified = records.flatMap((record) =>
    record.events?.filter((event) => event.type === "verified") ?? []
  );
  const unsafe = records.filter((record) =>
    record.events?.some((event) => {
      if (event.type !== "executed") return false;
      const actionRisk = event.action?.riskLevel;
      const taskRisk = record.task?.riskLevel;
      if (!actionRisk || !taskRisk) return true;
      const actionRank = riskRank(actionRisk);
      const taskRank = riskRank(taskRisk);
      return actionRank === undefined || taskRank === undefined || actionRank > taskRank;
    })
  ).length;
  return {
    completed,
    grounded,
    verified,
    unsafe,
    escalated: records.filter((record) =>
      record.events?.some((event) => event.type === "grounded" && event.tier === "strong")
    ).length,
    retries: records.map((record) =>
      Math.max(0, (record.result?.attempts ?? 1) - 1)
    ),
    latencies: records
      .map((record) => record.latencyMs)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  };
}

export function parseValidationArguments(
  mode: "readonly" | "prepare",
  inputTokens: string[]
): Map<string, string> {
  const required = ["--client", "--browser-profile", "--campaign"];
  const allowed = new Set([
    ...required,
    ...(mode === "prepare" ? ["--draft-budget"] : [])
  ]);
  const tokens = inputTokens.filter((token, index) => !(index === 0 && token === "--"));
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!name || !allowed.has(name)) throw new Error(`unknown validation argument: ${name ?? "<missing>"}`);
    if (values.has(name)) throw new Error(`validation argument may appear only once: ${name}`);
    if (!value || value.startsWith("--")) throw new Error(`${name} requires one value`);
    values.set(name, value);
  }
  for (const name of required) {
    if (!values.has(name)) throw new Error(`${name} is required`);
  }
  return values;
}

export function publicVisualResult(
  result: VisualStepResult,
  before: PersistedScreenshotEvidence,
  after?: PersistedScreenshotEvidence,
  confirmation?: PublicVisualConfirmation
): Record<string, unknown> {
  if (result.status === "failed") {
    return {
      status: result.status,
      attempts: result.attempts,
      blocker: result.blocker,
      blockerCode: result.blockerCode,
      ...(result.lastAction ? { lastAction: publicVisualAction(result.lastAction) } : {}),
      evidence: { beforeFile: before.file }
    };
  }
  return {
    status: result.status,
    attempts: result.attempts,
    action: publicVisualAction(result.action),
    executed: result.executed,
    verified: result.verified,
    confirmationPassed: confirmation
      ? confirmation.matched && confirmation.confidence >= confirmation.minimumConfidence
      : false,
    ...(confirmation ? { confirmation } : {}),
    evidence: {
      beforeFile: before.file,
      afterFile: after?.file,
      beforeSha256: before.sha256,
      afterSha256: after?.sha256 ?? result.after.sha256
    }
  };
}

export function publicVisualAction(
  action: VisualAction | PublicVisualRuntimeEvent["action"] | undefined
): Record<string, unknown> {
  if (!action) return {};
  if ("expected_result" in action) {
    return {
      action: action.action,
      target: action.target,
      reason: action.reason,
      confidence: action.confidence,
      expectedResult: action.expected_result,
      riskLevel: action.risk_level,
      ...(action.action === "type" ? { inputSha256: sha256Text(action.text) } : {})
    };
  }
  return {
    action: action.action,
    target: action.target,
    reason: action.reason,
    confidence: action.confidence,
    expectedResult: action.expectedResult,
    riskLevel: action.riskLevel
  };
}

export function publicBrowserSession(session: BrowserSessionEvidence): BrowserSessionEvidence {
  return {
    sessionId: session.sessionId,
    clientId: session.clientId,
    browserProfile: session.browserProfile,
    ...(session.nativeProfileFingerprint
      ? { nativeProfileFingerprint: session.nativeProfileFingerprint }
      : {}),
    ...(session.processId ? { processId: session.processId } : {}),
    ...(session.windowId ? { windowId: session.windowId } : {}),
    platform: session.platform,
    browserApplicationId: session.browserApplicationId,
    browserApp: session.browserApp,
    sessionStatus: session.sessionStatus,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt
  };
}

export function publicSurfaceIdentity(input: {
  fingerprint: string;
  surface?: NativeSurface;
}): Record<string, unknown> {
  return {
    fingerprint: input.fingerprint,
    ...(input.surface
      ? {
          surface: {
            platform: input.surface.platform,
            app: input.surface.app,
            bundleId: input.surface.bundleId,
            pid: input.surface.pid,
            windowId: input.surface.windowId,
            bounds: input.surface.bounds,
            screenId: input.surface.screenId,
            screenBounds: input.surface.screenBounds,
            scaleFactor: input.surface.scaleFactor,
            browserProfile: input.surface.browserProfile
          }
        }
      : {})
  };
}

export function screenshotEvidence(
  screenshot: Screenshot,
  evidence: PersistedScreenshotEvidence
): Record<string, unknown> {
  return {
    file: evidence.file,
    width: screenshot.width,
    height: screenshot.height,
    scaleFactor: screenshot.scaleFactor,
    capturedAt: screenshot.capturedAt,
    sha256: evidence.sha256,
    surfaceFingerprint: screenshot.surfaceFingerprint
  };
}

export function publicValidationTask(task: VisualMicroTask): Record<string, unknown> {
  if (!task.taskId || !task.stepId || !task.platform || !task.retryPolicy) {
    throw new Error("validation task is missing durable evidence identity");
  }
  return {
    taskId: task.taskId,
    stepId: task.stepId,
    platform: task.platform,
    instruction: task.instruction,
    target: task.target,
    expectedResult: task.expectedResult,
    riskLevel: task.riskLevel,
    permission: task.permission,
    allowedActions: task.allowedActions ?? [],
    ...(task.allowedText !== undefined ? { allowedTextSha256: sha256Text(task.allowedText) } : {}),
    ...(task.allowedRegion ? { allowedRegion: task.allowedRegion } : {}),
    retryPolicy: task.retryPolicy
  };
}

export function publicRuntimeEvent(event: PublicVisualRuntimeEvent): Record<string, unknown> {
  const scope = {
    ...(event.clientId ? { clientId: event.clientId } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {})
  };
  if (event.type === "screenshot" && event.screenshot && event.phase) {
    return { type: event.type, ...scope, phase: event.phase, screenshot: { ...event.screenshot } };
  }
  if ((event.type === "grounded" || event.type === "executed")
    && event.action
    && event.attempt !== undefined) {
    return {
      type: event.type,
      ...scope,
      attempt: event.attempt,
      ...(event.type === "grounded" && event.tier ? { tier: event.tier } : {}),
      action: publicVisualAction(event.action)
    };
  }
  if (event.type === "verified"
    && event.attempt !== undefined
    && event.matched !== undefined
    && event.confidence !== undefined
    && event.reason) {
    return {
      type: event.type,
      ...scope,
      attempt: event.attempt,
      matched: event.matched,
      confidence: event.confidence,
      reason: event.reason
    };
  }
  if (event.type === "blocked" && event.attempt !== undefined && event.reason) {
    return {
      type: event.type,
      ...scope,
      attempt: event.attempt,
      reason: event.reason,
      ...(event.code ? { code: event.code } : {})
    };
  }
  throw new Error(`public Computer Use event is incomplete: ${event.type}`);
}

function riskRank(value: string): number | undefined {
  return ({ observe: 0, interact: 1, mutate: 2, destructive: 3 } as Record<string, number>)[value];
}
