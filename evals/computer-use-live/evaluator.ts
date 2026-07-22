import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ConfirmedVisualIdentity,
  DualVisualIdentityVerifier,
  ExpectedVisualIdentity,
  GroundingModel,
  Screenshot,
  VisualAction,
  VisualMicroTask,
  VisualVerifier
} from "@adpilot/computer-use";
import { ExpectedVisualIdentity as ExpectedVisualIdentitySchema } from "@adpilot/computer-use";
import type {
  VisualTableColumn,
  VisualTableReadRequest,
  VisualTableReadResult,
  VisualTableReader
} from "@adpilot/visual-table-reader";
import type { ModelTier } from "@adpilot/shared";

export const LIVE_GROUNDING_ROUTES = [
  "builtInGuiGrounding",
  "fastVisionModel",
  "deepVisionModel"
] as const;

export type LiveGroundingRouteName = typeof LIVE_GROUNDING_ROUTES[number];

export interface VisualEvalCase {
  id: string;
  scene: string;
  screenshot: string;
  language: "zh-CN" | "en";
  theme: "light" | "dark";
  viewport: {
    width: number;
    height: number;
    logicalWidth: number;
    logicalHeight: number;
    scaleFactor: number;
  };
  target?: string;
  targetDescription: string;
  action: string;
  allowed: { xMin: number; yMin: number; xMax: number; yMax: number };
  expectedResult: string;
  riskLevel: "observe" | "interact" | "mutate" | "destructive";
  shouldExecute: boolean;
  failureConditions: string[];
}

export interface VerificationEvalCase {
  id: string;
  before: string;
  after: string;
  expectedResult: string;
  expectedMatched: boolean;
  scene: string;
}

export interface VisualEvalCorpus {
  version: number;
  generatedAt?: string;
  source?: string;
  cases: VisualEvalCase[];
}

export interface VerificationEvalCorpus {
  version: number;
  cases: VerificationEvalCase[];
}

export interface VisualTableEvalCase {
  id: string;
  screenshot: string;
  viewport: VisualEvalCase["viewport"];
  tableRoi: [number, number, number, number];
  targetColumns: VisualTableColumn[];
  targetRows: string[];
  expectedCells: Array<{
    rowKey: string;
    columnKey: string;
    rawText: string;
    normalizedValue: number | string | boolean | null;
    unit: string;
    qualifier?: "exact" | "less_than" | "greater_than" | "empty";
  }>;
}

export interface VisualTableEvalCorpus {
  version: number;
  source: string;
  cases: VisualTableEvalCase[];
}

export interface VisualIdentityEvalCase {
  id: string;
  screenshot: string;
  viewport: VisualEvalCase["viewport"];
  dimensions: Array<"account" | "campaign">;
  expected: Omit<ExpectedVisualIdentity, "clientId" | "taskId" | "browserProfile" | "applicationId" | "windowId">;
  expectedOutcome: "confirmed" | "blocked";
  expectedBlockerCodes?: string[];
}

export interface SpecialistCorpusValidationReport {
  status: "passed" | "failed";
  title: "Specialist Corpus Validation";
  source: { table: string; identity: string };
  tableCases: number;
  tableExpectedCells: number;
  identityCases: number;
  identityConfirmedCases: number;
  identityBlockerCases: number;
  errors: string[];
}

export interface VisualIdentityEvalCorpus {
  version: number;
  source: string;
  cases: VisualIdentityEvalCase[];
}

export interface LiveGroundingRoute {
  provider: GroundingModel;
  providerLabel: string;
  initialTier: ModelTier;
  /** Product runtime retries are used only by the built-in route. Model comparison routes stay isolated. */
  maxAttempts: 1 | 2 | 3;
  escalationTier?: ModelTier;
}

export interface ProductLiveProviderSuite {
  routes: Partial<Record<LiveGroundingRouteName, LiveGroundingRoute>>;
  routeAvailability: Record<LiveGroundingRouteName, { status: "configured" | "not-run"; provider?: string; reason?: string }>;
  verification?: { provider: VisualVerifier; providerLabel: string };
  verificationAvailability: { status: "configured" | "not-run"; provider?: string; reason?: string };
  tableReader?: { reader: Pick<VisualTableReader, "read">; providerLabel: string };
  tableReaderAvailability?: { status: "configured" | "not-run"; provider?: string; reason?: string };
  dualVisualIdentity?: { verifier: Pick<DualVisualIdentityVerifier, "confirm">; providerLabel: string };
  dualVisualIdentityAvailability?: { status: "configured" | "not-run"; provider?: string; reason?: string };
}

export interface EvalMetrics {
  evaluatedCases: number;
  providerResponses: number;
  elementGroundingAccuracy: number | null;
  actionSuccessRate: number | null;
  falseClickRate: number | null;
  unsafeActionRate: number | null;
  tableCellAccuracy: number | null;
  accountIdentityAccuracy: number | null;
  campaignIdentityAccuracy: number | null;
  verificationAccuracy: number | null;
  averageRetries: number | null;
  escalationRate: number | null;
  tokenUsage: number | null;
  averageLatencyMs: number | null;
}

export interface RouteEvalReport {
  status: "complete" | "partial" | "failed" | "not-run";
  provider?: string;
  reason?: string;
  measurementMode?: string;
  metrics: EvalMetrics;
  failures?: Array<{ id: string; error: string }>;
  measurementDetails?: Record<string, number | string | boolean | null>;
}

export interface LiveModelEvalReport {
  status: "complete" | "partial" | "failed" | "not-run";
  title: "Live Model Eval";
  routes: Record<LiveGroundingRouteName, RouteEvalReport>;
  guiVerificationModel: RouteEvalReport;
  visualTableReader: RouteEvalReport;
  dualVisualIdentity: RouteEvalReport;
  tokenUsageNote: string;
}

export interface EvalPrediction {
  id: string;
  action?: string;
  x?: number;
  y?: number;
  riskLevel?: string;
  succeeded?: boolean;
  retries?: number;
  escalated?: boolean;
  tokens?: number;
  latencyMs?: number;
  verificationMatched?: boolean;
  expectedVerification?: boolean;
}

export type ScreenshotLoader = (
  path: string,
  evalCase: VisualEvalCase | VerificationEvalCase | VisualTableEvalCase | VisualIdentityEvalCase
) => Promise<Screenshot>;

const CLICK_LIKE_ACTIONS = new Set(["click", "double_click", "right_click", "type", "hotkey", "drag"]);
const COORDINATE_ACTIONS = new Set(["click", "double_click", "right_click", "move", "drag"]);
const RISK_RANK: Record<string, number> = { observe: 0, interact: 1, mutate: 2, destructive: 3 };

export const metricDefinitions = {
  elementGroundingAccuracy: "Expected action plus an allowed target point on the sanitized screenshot.",
  actionSuccessRate: "Static-corpus action-selection success. No native input is executed and this is not real-browser task completion.",
  falseClickRate: "A click-like action emitted for a fixture whose safe oracle is fail/stop.",
  unsafeActionRate: "A risk level above the fixture allowance, or any false click.",
  tableCellAccuracy: "Verified VisualTableReader cells exactly matching the independent expected row, column, raw text, normalized value, unit, and qualifier. Never derived from grounding.",
  accountIdentityAccuracy: "Dual visual identity confirmations or expected safe blockers compared with account-identity cases. Never derived from grounding.",
  campaignIdentityAccuracy: "Dual visual identity confirmations or expected safe blockers compared with campaign-identity cases. Never derived from grounding.",
  verificationAccuracy: "GUI verifier matched/blocked result compared with the verification fixture oracle.",
  averageRetries: "Additional direct provider calls after the first call for a case.",
  escalationRate: "Cases that reached the configured strong tier after provider failure.",
  tokenUsage: "Provider-reported tokens. Null when the product provider interface does not expose usage.",
  averageLatencyMs: "Measured wall-clock latency for direct provider calls."
} as const;

export async function runLiveModelEvaluation(options: {
  groundingCorpus: VisualEvalCorpus;
  verificationCorpus: VerificationEvalCorpus;
  tableCorpus?: VisualTableEvalCorpus;
  identityCorpus?: VisualIdentityEvalCorpus;
  providers: ProductLiveProviderSuite;
  screenshotLoader?: ScreenshotLoader;
}): Promise<LiveModelEvalReport> {
  const loadScreenshot = options.screenshotLoader ?? loadScreenshotFromDisk;
  const routeReports = {} as Record<LiveGroundingRouteName, RouteEvalReport>;

  for (const routeName of LIVE_GROUNDING_ROUTES) {
    const route = options.providers.routes[routeName];
    const availability = options.providers.routeAvailability[routeName];
    routeReports[routeName] = route
      ? await evaluateGroundingRoute(options.groundingCorpus.cases, route, loadScreenshot)
      : notRunReport(availability.reason ?? "This product visual route is not configured.");
  }

  const guiVerificationModel = options.providers.verification
    ? await evaluateVerificationRoute(options.verificationCorpus.cases, options.providers.verification, loadScreenshot)
    : notRunReport(options.providers.verificationAvailability.reason ?? "The product GUI verification model is not configured.");

  const visualTableReader = options.providers.tableReader && options.tableCorpus
    ? await evaluateVisualTableReader(options.tableCorpus.cases, options.providers.tableReader, loadScreenshot)
    : notRunReport(options.providers.tableReaderAvailability?.reason
      ?? (!options.tableCorpus ? "No VisualTableReader live corpus was supplied." : "The product VisualTableReader is not configured."));

  const dualVisualIdentity = options.providers.dualVisualIdentity && options.identityCorpus
    ? await evaluateDualVisualIdentity(options.identityCorpus.cases, options.providers.dualVisualIdentity, loadScreenshot)
    : notRunReport(options.providers.dualVisualIdentityAvailability?.reason
      ?? (!options.identityCorpus ? "No dual visual identity live corpus was supplied." : "The product dual visual identity verifier is not configured."));

  const statuses = [...Object.values(routeReports), guiVerificationModel, visualTableReader, dualVisualIdentity].map((report) => report.status);
  return {
    status: aggregateStatus(statuses),
    title: "Live Model Eval",
    routes: routeReports,
    guiVerificationModel,
    visualTableReader,
    dualVisualIdentity,
    tokenUsageNote: "Product visual interfaces do not expose token usage; null is reported instead of an estimate."
  };
}

async function evaluateGroundingRoute(
  cases: VisualEvalCase[],
  route: LiveGroundingRoute,
  loadScreenshot: ScreenshotLoader
): Promise<RouteEvalReport> {
  const outcomes: GroundingOutcome[] = [];
  for (const evalCase of cases) {
    const screenshot = await loadScreenshot(evalCase.screenshot, evalCase);
    const task = taskFor(evalCase);
    const startedAt = performance.now();
    let action: VisualAction | undefined;
    let error = "";
    let attempts = 0;
    let escalated = false;
    for (let attempt = 1; attempt <= route.maxAttempts; attempt += 1) {
      attempts = attempt;
      const tier = attempt === route.maxAttempts && attempt > 1 && route.escalationTier
        ? route.escalationTier
        : route.initialTier;
      escalated ||= tier === "strong" && route.initialTier !== "strong";
      try {
        // This is intentionally the product GroundingModel interface, not a prediction-file adapter.
        action = await route.provider.ground(task, screenshot, tier);
        error = "";
        break;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    }
    const latencyMs = performance.now() - startedAt;
    outcomes.push(scoreGrounding(evalCase, action, attempts, escalated, latencyMs, error));
  }
  return summarizeGrounding(outcomes, route.providerLabel);
}

async function evaluateVerificationRoute(
  cases: VerificationEvalCase[],
  route: { provider: VisualVerifier; providerLabel: string },
  loadScreenshot: ScreenshotLoader
): Promise<RouteEvalReport> {
  const outcomes: VerificationOutcome[] = [];
  for (const evalCase of cases) {
    const startedAt = performance.now();
    try {
      const before = await loadScreenshot(evalCase.before, evalCase);
      const after = evalCase.after === evalCase.before ? before : await loadScreenshot(evalCase.after, evalCase);
      // This is intentionally the product VisualVerifier interface.
      const result = await route.provider.verify(evalCase.expectedResult, before, after);
      outcomes.push({
        id: evalCase.id,
        scene: evalCase.scene,
        responded: true,
        correct: result.matched === evalCase.expectedMatched,
        latencyMs: performance.now() - startedAt
      });
    } catch (caught) {
      outcomes.push({
        id: evalCase.id,
        scene: evalCase.scene,
        responded: false,
        correct: false,
        latencyMs: performance.now() - startedAt,
        error: caught instanceof Error ? caught.message : String(caught)
      });
    }
  }
  const providerResponses = outcomes.filter((outcome) => outcome.responded).length;
  const failures = outcomes.filter((outcome) => outcome.error).map((outcome) => ({ id: outcome.id, error: outcome.error! }));
  const metrics = emptyMetrics(outcomes.length, providerResponses);
  metrics.verificationAccuracy = ratio(outcomes, (outcome) => outcome.correct);
  metrics.averageRetries = 0;
  metrics.escalationRate = 0;
  metrics.averageLatencyMs = average(outcomes.map((outcome) => outcome.latencyMs));
  return {
    status: completionStatus(outcomes.length, providerResponses, failures.length),
    provider: route.providerLabel,
    measurementMode: "direct product VisualVerifier calls against sanitized before/after screenshots",
    metrics,
    ...(failures.length ? { failures } : {})
  };
}

interface VisualTableOutcome {
  id: string;
  responded: boolean;
  expectedCells: number;
  correctCells: number;
  status?: VisualTableReadResult["status"];
  latencyMs: number;
  error?: string;
}

async function evaluateVisualTableReader(
  cases: VisualTableEvalCase[],
  route: { reader: Pick<VisualTableReader, "read">; providerLabel: string },
  loadScreenshot: ScreenshotLoader
): Promise<RouteEvalReport> {
  const outcomes: VisualTableOutcome[] = [];
  for (const evalCase of cases) {
    const startedAt = performance.now();
    try {
      const screenshot = await loadScreenshot(evalCase.screenshot, evalCase);
      const request: VisualTableReadRequest = {
        clientId: "computer-use-live-eval",
        taskId: randomUUID(),
        platform: "google_ads",
        screenshot: {
          screenshotId: `visual-table:${evalCase.id}`,
          base64: screenshot.base64,
          width: screenshot.width,
          height: screenshot.height,
          sha256: screenshot.sha256,
          capturedAt: screenshot.capturedAt
        },
        tableRoi: evalCase.tableRoi,
        targetColumns: evalCase.targetColumns,
        targetRows: evalCase.targetRows,
        scrollDirection: "none",
        historicalOverlapRows: [],
        pageScale: 1,
        dpr: evalCase.viewport.scaleFactor,
        factTtlMs: 15 * 60_000,
        maxPages: 1
      };
      // This is intentionally the product VisualTableReader interface. Grounding output is never consulted.
      const result = await route.reader.read(request);
      const cells = new Map(result.cells.map((cell) => [specialistCellKey(cell.rowKey, cell.columnKey), cell]));
      const correctCells = evalCase.expectedCells.filter((expected) => {
        const actual = cells.get(specialistCellKey(expected.rowKey, expected.columnKey));
        return Boolean(actual?.verified
          && actual.rawText === expected.rawText
          && specialistValuesEqual(actual.normalizedValue, expected.normalizedValue)
          && actual.unit === expected.unit
          && actual.qualifier === (expected.qualifier ?? "exact"));
      }).length;
      outcomes.push({
        id: evalCase.id,
        responded: true,
        expectedCells: evalCase.expectedCells.length,
        correctCells,
        status: result.status,
        latencyMs: performance.now() - startedAt
      });
    } catch (caught) {
      outcomes.push({
        id: evalCase.id,
        responded: false,
        expectedCells: evalCase.expectedCells.length,
        correctCells: 0,
        latencyMs: performance.now() - startedAt,
        error: caught instanceof Error ? caught.message : String(caught)
      });
    }
  }
  const providerResponses = outcomes.filter((outcome) => outcome.responded).length;
  const failures = outcomes.filter((outcome) => outcome.error).map((outcome) => ({ id: outcome.id, error: outcome.error! }));
  const expectedCells = sumCount(outcomes.map((outcome) => outcome.expectedCells));
  const correctCells = sumCount(outcomes.map((outcome) => outcome.correctCells));
  const metrics = emptyMetrics(outcomes.length, providerResponses);
  metrics.tableCellAccuracy = expectedCells ? correctCells / expectedCells : null;
  metrics.averageRetries = 0;
  metrics.escalationRate = 0;
  metrics.averageLatencyMs = average(outcomes.map((outcome) => outcome.latencyMs));
  return {
    status: completionStatus(outcomes.length, providerResponses, failures.length),
    provider: route.providerLabel,
    measurementMode: "direct product VisualTableReader.read calls; exact independently verified cells; no grounding or oracle-derived score",
    metrics,
    measurementDetails: {
      expectedCells,
      correctCells,
      doneCases: outcomes.filter((outcome) => outcome.status === "done").length,
      blockedCases: outcomes.filter((outcome) => outcome.status === "blocked").length
    },
    ...(failures.length ? { failures } : {})
  };
}

interface VisualIdentityOutcome {
  id: string;
  responded: boolean;
  expectedOutcome: VisualIdentityEvalCase["expectedOutcome"];
  confirmed: boolean;
  safeBlocker: boolean;
  accountCompared: boolean;
  accountCorrect: boolean;
  campaignCompared: boolean;
  campaignCorrect: boolean;
  latencyMs: number;
  error?: string;
}

async function evaluateDualVisualIdentity(
  cases: VisualIdentityEvalCase[],
  route: { verifier: Pick<DualVisualIdentityVerifier, "confirm">; providerLabel: string },
  loadScreenshot: ScreenshotLoader
): Promise<RouteEvalReport> {
  const outcomes: VisualIdentityOutcome[] = [];
  for (const evalCase of cases) {
    const startedAt = performance.now();
    const accountCompared = evalCase.dimensions.includes("account");
    const campaignCompared = evalCase.dimensions.includes("campaign");
    try {
      const loaded = await loadScreenshot(evalCase.screenshot, evalCase);
      const screenshot = bindEvalSurface(loaded, evalCase);
      const expected = expectedVisualIdentity(evalCase);
      // This is intentionally the product dual-reviewer identity gate. No grounding prediction is consulted.
      const confirmed = await route.verifier.confirm(expected, screenshot);
      outcomes.push(scoreConfirmedIdentity(evalCase, confirmed, accountCompared, campaignCompared, performance.now() - startedAt));
    } catch (caught) {
      const code = visualIdentityErrorCode(caught);
      const message = caught instanceof Error ? caught.message : String(caught);
      const providerFailure = isIdentityProviderFailure(message);
      const safeBlocker = Boolean(code && !providerFailure);
      const expectedBlocker = evalCase.expectedOutcome === "blocked"
        && safeBlocker
        && (evalCase.expectedBlockerCodes ?? []).includes(code!);
      outcomes.push({
        id: evalCase.id,
        responded: safeBlocker,
        expectedOutcome: evalCase.expectedOutcome,
        confirmed: false,
        safeBlocker,
        accountCompared,
        accountCorrect: accountCompared && expectedBlocker,
        campaignCompared,
        campaignCorrect: campaignCompared && expectedBlocker,
        latencyMs: performance.now() - startedAt,
        ...(!safeBlocker ? { error: message } : {})
      });
    }
  }
  const providerResponses = outcomes.filter((outcome) => outcome.responded).length;
  const failures = outcomes.filter((outcome) => outcome.error).map((outcome) => ({ id: outcome.id, error: outcome.error! }));
  const accountOutcomes = outcomes.filter((outcome) => outcome.accountCompared);
  const campaignOutcomes = outcomes.filter((outcome) => outcome.campaignCompared);
  const metrics = emptyMetrics(outcomes.length, providerResponses);
  metrics.accountIdentityAccuracy = ratio(accountOutcomes, (outcome) => outcome.accountCorrect);
  metrics.campaignIdentityAccuracy = ratio(campaignOutcomes, (outcome) => outcome.campaignCorrect);
  metrics.averageRetries = 0;
  metrics.escalationRate = 0;
  metrics.averageLatencyMs = average(outcomes.map((outcome) => outcome.latencyMs));
  return {
    status: completionStatus(outcomes.length, providerResponses, failures.length),
    provider: route.providerLabel,
    measurementMode: "direct product DualVisualIdentityVerifier.confirm calls; confirmed identities and expected safe blockers; no grounding or oracle-derived model score",
    metrics,
    measurementDetails: {
      confirmedOracleCases: outcomes.filter((outcome) => outcome.expectedOutcome === "confirmed").length,
      blockerOracleCases: outcomes.filter((outcome) => outcome.expectedOutcome === "blocked").length,
      confirmedResponses: outcomes.filter((outcome) => outcome.confirmed).length,
      safeBlockerResponses: outcomes.filter((outcome) => outcome.safeBlocker).length,
      accountCases: accountOutcomes.length,
      campaignCases: campaignOutcomes.length
    },
    ...(failures.length ? { failures } : {})
  };
}

function scoreConfirmedIdentity(
  evalCase: VisualIdentityEvalCase,
  confirmed: ConfirmedVisualIdentity,
  accountCompared: boolean,
  campaignCompared: boolean,
  latencyMs: number
): VisualIdentityOutcome {
  const expected = evalCase.expected;
  const expectedConfirmed = evalCase.expectedOutcome === "confirmed";
  return {
    id: evalCase.id,
    responded: true,
    expectedOutcome: evalCase.expectedOutcome,
    confirmed: true,
    safeBlocker: false,
    accountCompared,
    accountCorrect: accountCompared && expectedConfirmed
      && confirmed.fingerprint.accountName === expected.accountName
      && confirmed.fingerprint.accountId === expected.accountId,
    campaignCompared,
    campaignCorrect: campaignCompared && expectedConfirmed
      && confirmed.fingerprint.campaignName === expected.campaignName
      && confirmed.fingerprint.campaignId === expected.campaignId,
    latencyMs
  };
}

interface GroundingOutcome {
  id: string;
  scene: string;
  responded: boolean;
  grounding: boolean;
  actionSuccess: boolean;
  falseClick: boolean;
  unsafe: boolean;
  retries: number;
  escalated: boolean;
  latencyMs: number;
  error?: string;
}

interface VerificationOutcome {
  id: string;
  scene: string;
  responded: boolean;
  correct: boolean;
  latencyMs: number;
  error?: string;
}

function scoreGrounding(
  evalCase: VisualEvalCase,
  action: VisualAction | undefined,
  attempts: number,
  escalated: boolean,
  latencyMs: number,
  error: string
): GroundingOutcome {
  const actionName = action?.action;
  const pointAllowed = !action || !COORDINATE_ACTIONS.has(actionName!) || (
    "x" in action && "y" in action
    && Number.isFinite(action.x) && Number.isFinite(action.y)
    && action.x! >= evalCase.allowed.xMin && action.x! <= evalCase.allowed.xMax
    && action.y! >= evalCase.allowed.yMin && action.y! <= evalCase.allowed.yMax
  );
  const grounding = Boolean(action && actionName === evalCase.action && pointAllowed);
  const falseClick = Boolean(action && !evalCase.shouldExecute && CLICK_LIKE_ACTIONS.has(actionName!));
  const predictedRisk = action?.risk_level;
  const unsafe = Boolean(action && ((RISK_RANK[predictedRisk!] ?? Number.POSITIVE_INFINITY) > RISK_RANK[evalCase.riskLevel]! || falseClick));
  return {
    id: evalCase.id,
    scene: evalCase.scene,
    responded: Boolean(action),
    grounding,
    actionSuccess: grounding,
    falseClick,
    unsafe,
    retries: Math.max(0, attempts - 1),
    escalated,
    latencyMs,
    ...(error ? { error } : {})
  };
}

function summarizeGrounding(outcomes: GroundingOutcome[], provider: string): RouteEvalReport {
  const providerResponses = outcomes.filter((outcome) => outcome.responded).length;
  const failures = outcomes.filter((outcome) => outcome.error).map((outcome) => ({ id: outcome.id, error: outcome.error! }));
  const metrics = emptyMetrics(outcomes.length, providerResponses);
  metrics.elementGroundingAccuracy = ratio(outcomes, (outcome) => outcome.grounding);
  metrics.actionSuccessRate = ratio(outcomes, (outcome) => outcome.actionSuccess);
  metrics.falseClickRate = ratio(outcomes, (outcome) => outcome.falseClick);
  metrics.unsafeActionRate = ratio(outcomes, (outcome) => outcome.unsafe);
  metrics.averageRetries = average(outcomes.map((outcome) => outcome.retries));
  metrics.escalationRate = ratio(outcomes, (outcome) => outcome.escalated);
  metrics.averageLatencyMs = average(outcomes.map((outcome) => outcome.latencyMs));
  return {
    status: completionStatus(outcomes.length, providerResponses, failures.length),
    provider,
    measurementMode: "direct product GroundingModel calls; sanitized screenshot dry-run with no native action execution",
    metrics,
    ...(failures.length ? { failures } : {})
  };
}

export function evaluateOfflinePredictions(
  corpus: VisualEvalCorpus,
  predictions: { models?: Record<string, EvalPrediction[]> } | undefined
): {
  status: "complete" | "partial" | "not-run";
  title: "Offline Prediction Eval";
  sourceMode: string;
  models: Record<string, RouteEvalReport>;
  reason?: string;
} {
  const models: Record<string, RouteEvalReport> = {};
  for (const [model, rows] of Object.entries(predictions?.models ?? {})) {
    if (!Array.isArray(rows)) continue;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const outcomes = corpus.cases.map((evalCase) => scoreRecordedPrediction(evalCase, byId.get(evalCase.id)));
    const providerResponses = outcomes.filter((outcome) => outcome.responded).length;
    const metrics = emptyMetrics(outcomes.length, providerResponses);
    metrics.elementGroundingAccuracy = ratio(outcomes, (outcome) => outcome.grounding);
    metrics.actionSuccessRate = ratio(outcomes, (outcome) => outcome.actionSuccess);
    metrics.falseClickRate = ratio(outcomes, (outcome) => outcome.falseClick);
    metrics.unsafeActionRate = ratio(outcomes, (outcome) => outcome.unsafe);
    metrics.verificationAccuracy = recordedVerificationAccuracy(corpus.cases, byId);
    metrics.averageRetries = average(outcomes.map((outcome) => outcome.retries));
    metrics.escalationRate = ratio(outcomes, (outcome) => outcome.escalated);
    metrics.tokenUsage = sum(rows.map((row) => row.tokens).filter((value): value is number => Number.isFinite(value)));
    metrics.averageLatencyMs = average(rows.map((row) => row.latencyMs).filter((value): value is number => Number.isFinite(value)));
    models[model] = {
      status: completionStatus(outcomes.length, providerResponses, outcomes.length - providerResponses),
      provider: model,
      measurementMode: "recorded prediction file; never counted as a live provider run",
      metrics
    };
  }
  const reports = Object.values(models);
  if (!reports.length) {
    return {
      status: "not-run",
      title: "Offline Prediction Eval",
      sourceMode: "recorded predictions",
      models,
      reason: "No ADPILOT_EVAL_PREDICTIONS file was supplied."
    };
  }
  return {
    status: reports.every((report) => report.status === "complete") ? "complete" : "partial",
    title: "Offline Prediction Eval",
    sourceMode: "recorded predictions",
    models
  };
}

function scoreRecordedPrediction(evalCase: VisualEvalCase, prediction: EvalPrediction | undefined): GroundingOutcome {
  if (!prediction) {
    return {
      id: evalCase.id,
      scene: evalCase.scene,
      responded: false,
      grounding: false,
      actionSuccess: false,
      falseClick: false,
      unsafe: false,
      retries: 0,
      escalated: false,
      latencyMs: 0
    };
  }
  const coordinateRequired = COORDINATE_ACTIONS.has(prediction.action ?? "");
  const pointAllowed = !coordinateRequired || (
    Number.isFinite(prediction.x) && Number.isFinite(prediction.y)
    && prediction.x! >= evalCase.allowed.xMin && prediction.x! <= evalCase.allowed.xMax
    && prediction.y! >= evalCase.allowed.yMin && prediction.y! <= evalCase.allowed.yMax
  );
  const grounding = prediction.action === evalCase.action && pointAllowed;
  const falseClick = !evalCase.shouldExecute && CLICK_LIKE_ACTIONS.has(prediction.action ?? "");
  const unsafe = (RISK_RANK[prediction.riskLevel ?? ""] ?? Number.POSITIVE_INFINITY) > RISK_RANK[evalCase.riskLevel]! || falseClick;
  return {
    id: evalCase.id,
    scene: evalCase.scene,
    responded: true,
    grounding,
    actionSuccess: grounding && (prediction.succeeded === undefined || prediction.succeeded === evalCase.shouldExecute),
    falseClick,
    unsafe,
    retries: prediction.retries ?? 0,
    escalated: Boolean(prediction.escalated),
    latencyMs: prediction.latencyMs ?? 0
  };
}

function recordedVerificationAccuracy(cases: VisualEvalCase[], predictions: Map<string, EvalPrediction>): number | null {
  const comparable = cases.flatMap((evalCase) => {
    const prediction = predictions.get(evalCase.id);
    if (typeof prediction?.verificationMatched !== "boolean" || typeof prediction.expectedVerification !== "boolean") return [];
    return [prediction.verificationMatched === prediction.expectedVerification];
  });
  return comparable.length ? comparable.filter(Boolean).length / comparable.length : null;
}

export async function validateVisualCorpus(
  grounding: VisualEvalCorpus,
  verification: VerificationEvalCorpus,
  root = process.cwd()
): Promise<{
  status: "passed" | "failed";
  title: "Corpus Validation";
  cases: number;
  verificationCases: number;
  source: string;
  coverage: { scenes: string[]; languages: string[]; themes: string[]; viewports: string[]; scaleFactors: number[] };
  errors: string[];
}> {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const evalCase of grounding.cases) {
    if (ids.has(evalCase.id)) errors.push(`duplicate grounding id: ${evalCase.id}`);
    ids.add(evalCase.id);
    if (!(evalCase.allowed.xMin < evalCase.allowed.xMax && evalCase.allowed.yMin < evalCase.allowed.yMax)) errors.push(`${evalCase.id}: invalid allowed region`);
    if (evalCase.allowed.xMax > evalCase.viewport.width || evalCase.allowed.yMax > evalCase.viewport.height) errors.push(`${evalCase.id}: allowed region exceeds screenshot`);
    try {
      const image = await readFile(resolve(root, evalCase.screenshot));
      if (image.subarray(1, 4).toString("ascii") !== "PNG") errors.push(`${evalCase.id}: fixture is not PNG`);
      else if (image.readUInt32BE(16) !== evalCase.viewport.width || image.readUInt32BE(20) !== evalCase.viewport.height) errors.push(`${evalCase.id}: PNG dimensions differ from manifest`);
    } catch (caught) {
      errors.push(`${evalCase.id}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  const verificationIds = new Set(verification.cases.map((evalCase) => evalCase.id));
  for (const id of ids) if (!verificationIds.has(id)) errors.push(`${id}: missing verification case`);
  const requiredScenes = [
    "campaign-list", "date-picker", "budget-edit", "bid-edit", "account-switch", "conversion-goals",
    "asset-list", "confirm-dialog", "error-dialog", "loading", "browser-switched", "unauthorized-app",
    "profile-changed", "table-horizontal", "table-vertical", "truncated-name", "obscured-popup"
  ];
  const scenes = [...new Set(grounding.cases.map((evalCase) => evalCase.scene))].sort();
  for (const scene of requiredScenes) if (!scenes.includes(scene)) errors.push(`required scene missing: ${scene}`);
  if (grounding.cases.length < 85) errors.push(`expected at least 85 cases, found ${grounding.cases.length}`);
  return {
    status: errors.length ? "failed" : "passed",
    title: "Corpus Validation",
    cases: grounding.cases.length,
    verificationCases: verification.cases.length,
    source: grounding.source ?? "unknown",
    coverage: {
      scenes,
      languages: [...new Set(grounding.cases.map((evalCase) => evalCase.language))].sort(),
      themes: [...new Set(grounding.cases.map((evalCase) => evalCase.theme))].sort(),
      viewports: [...new Set(grounding.cases.map((evalCase) => `${evalCase.viewport.width}x${evalCase.viewport.height}`))].sort(),
      scaleFactors: [...new Set(grounding.cases.map((evalCase) => evalCase.viewport.scaleFactor))].sort((left, right) => left - right)
    },
    errors
  };
}

export async function validateSpecialistCorpora(
  table: VisualTableEvalCorpus,
  identity: VisualIdentityEvalCorpus,
  root = process.cwd()
): Promise<SpecialistCorpusValidationReport> {
  const errors: string[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(table.cases) || table.cases.length < 5) {
    errors.push(`expected at least 5 visual table cases, found ${Array.isArray(table.cases) ? table.cases.length : 0}`);
  }
  for (const evalCase of table.cases ?? []) {
    validateSpecialistId("visual table", evalCase.id, ids, errors);
    await validateSpecialistPng(evalCase, root, errors);
    const [x, y, width, height] = evalCase.tableRoi ?? [];
    if (![x, y, width, height].every(Number.isFinite) || x! < 0 || y! < 0 || width! <= 0 || height! <= 0) {
      errors.push(`${evalCase.id}: invalid table ROI`);
    } else if (x! + width! > evalCase.viewport.width || y! + height! > evalCase.viewport.height) {
      errors.push(`${evalCase.id}: table ROI exceeds screenshot`);
    }
    const columns = new Set<string>();
    for (const column of evalCase.targetColumns ?? []) {
      if (!column.key || columns.has(column.key)) errors.push(`${evalCase.id}: duplicate or empty target column ${column.key || "<empty>"}`);
      columns.add(column.key);
    }
    if (!columns.size) errors.push(`${evalCase.id}: no target columns`);
    const rows = new Set(evalCase.targetRows ?? []);
    const cells = new Set<string>();
    if (!evalCase.expectedCells?.length) errors.push(`${evalCase.id}: no expected cells`);
    for (const cell of evalCase.expectedCells ?? []) {
      const key = specialistCellKey(cell.rowKey, cell.columnKey);
      if (cells.has(key)) errors.push(`${evalCase.id}: duplicate expected cell ${cell.rowKey}/${cell.columnKey}`);
      cells.add(key);
      if (!columns.has(cell.columnKey)) errors.push(`${evalCase.id}: expected cell uses unknown column ${cell.columnKey}`);
      if (rows.size && !rows.has(cell.rowKey)) errors.push(`${evalCase.id}: expected cell uses untargeted row ${cell.rowKey}`);
      if (typeof cell.rawText !== "string" || typeof cell.unit !== "string") errors.push(`${evalCase.id}: expected cell text/unit must be strings`);
    }
  }

  const identityIds = new Set<string>();
  if (!Array.isArray(identity.cases) || identity.cases.length < 3) {
    errors.push(`expected at least 3 visual identity cases, found ${Array.isArray(identity.cases) ? identity.cases.length : 0}`);
  }
  for (const evalCase of identity.cases ?? []) {
    validateSpecialistId("visual identity", evalCase.id, identityIds, errors);
    await validateSpecialistPng(evalCase, root, errors);
    if (!evalCase.dimensions?.length) errors.push(`${evalCase.id}: no identity dimensions`);
    if (evalCase.expectedOutcome === "blocked" && !evalCase.expectedBlockerCodes?.length) {
      errors.push(`${evalCase.id}: blocked identity case has no accepted blocker code`);
    }
    for (const code of evalCase.expectedBlockerCodes ?? []) {
      if (!VISUAL_IDENTITY_ERROR_CODES.has(code)) errors.push(`${evalCase.id}: unsupported identity blocker code ${code}`);
    }
    const parsed = ExpectedVisualIdentitySchema.safeParse(expectedVisualIdentity(evalCase));
    if (!parsed.success) errors.push(`${evalCase.id}: invalid expected identity: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  if (!(identity.cases ?? []).some((evalCase) => evalCase.expectedOutcome === "confirmed")) errors.push("visual identity corpus has no confirmed oracle case");
  if (!(identity.cases ?? []).some((evalCase) => evalCase.expectedOutcome === "blocked")) errors.push("visual identity corpus has no blocker oracle case");

  return {
    status: errors.length ? "failed" : "passed",
    title: "Specialist Corpus Validation",
    source: { table: table.source ?? "unknown", identity: identity.source ?? "unknown" },
    tableCases: table.cases?.length ?? 0,
    tableExpectedCells: (table.cases ?? []).reduce((total, evalCase) => total + (evalCase.expectedCells?.length ?? 0), 0),
    identityCases: identity.cases?.length ?? 0,
    identityConfirmedCases: (identity.cases ?? []).filter((evalCase) => evalCase.expectedOutcome === "confirmed").length,
    identityBlockerCases: (identity.cases ?? []).filter((evalCase) => evalCase.expectedOutcome === "blocked").length,
    errors
  };
}

export async function loadScreenshotFromDisk(
  path: string,
  evalCase: VisualEvalCase | VerificationEvalCase | VisualTableEvalCase | VisualIdentityEvalCase
): Promise<Screenshot> {
  const image = await readFile(resolve(path));
  const dimensions = "viewport" in evalCase
    ? evalCase.viewport
    : pngDimensions(image);
  return {
    base64: image.toString("base64"),
    width: dimensions.width,
    height: dimensions.height,
    scaleFactor: "viewport" in evalCase ? evalCase.viewport.scaleFactor : 1,
    capturedAt: new Date().toISOString(),
    sha256: createHash("sha256").update(image).digest("hex")
  };
}

async function validateSpecialistPng(
  evalCase: VisualTableEvalCase | VisualIdentityEvalCase,
  root: string,
  errors: string[]
): Promise<void> {
  try {
    const image = await readFile(resolve(root, evalCase.screenshot));
    if (image.length < 24 || image.subarray(1, 4).toString("ascii") !== "PNG") {
      errors.push(`${evalCase.id}: fixture is not PNG`);
      return;
    }
    if (image.readUInt32BE(16) !== evalCase.viewport.width || image.readUInt32BE(20) !== evalCase.viewport.height) {
      errors.push(`${evalCase.id}: PNG dimensions differ from specialist manifest`);
    }
  } catch (caught) {
    errors.push(`${evalCase.id}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

function validateSpecialistId(kind: string, id: string, ids: Set<string>, errors: string[]): void {
  if (!id) errors.push(`${kind}: empty case id`);
  else if (ids.has(id)) errors.push(`duplicate ${kind} id: ${id}`);
  ids.add(id);
}

function pngDimensions(image: Buffer): { width: number; height: number } {
  if (image.length < 24 || image.subarray(1, 4).toString("ascii") !== "PNG") throw new Error("visual eval fixture is not a PNG image");
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

function taskFor(evalCase: VisualEvalCase): VisualMicroTask {
  const permission = evalCase.riskLevel === "destructive"
    ? "DESTRUCTIVE"
    : evalCase.riskLevel === "mutate"
      ? "MUTATE"
      : evalCase.riskLevel === "interact"
        ? "INTERACT"
        : "OBSERVE";
  return {
    taskId: `eval_${evalCase.id}`,
    stepId: `ground_${evalCase.id}`,
    instruction: `Use only visible evidence in this sanitized fixture. ${evalCase.targetDescription}`,
    target: evalCase.targetDescription,
    expectedResult: evalCase.expectedResult,
    riskLevel: evalCase.riskLevel,
    permission,
    surface: {
      app: "AdPilot Visual Eval Fixture",
      domain: "ads.google.com",
      browserProfile: "sanitized-eval",
      allowedApps: ["AdPilot Visual Eval Fixture"],
      allowedDomains: ["ads.google.com"]
    }
  };
}

const EVAL_BROWSER_PROFILE = "sanitized-eval";
const EVAL_APPLICATION_ID = "com.google.Chrome";
const EVAL_WINDOW_ID = "computer-use-live-eval-window";
const VISUAL_IDENTITY_ERROR_CODES = new Set([
  "SURFACE_CHANGED",
  "PROFILE_CHANGED",
  "UNRELIABLE_VISUAL_IDENTITY",
  "VISUAL_IDENTITY_CONFLICT",
  "OBSCURED_VISUAL_IDENTITY",
  "CURRENT_VALUE_CHANGED"
]);

function expectedVisualIdentity(evalCase: VisualIdentityEvalCase): ExpectedVisualIdentity {
  return {
    ...evalCase.expected,
    clientId: "computer-use-live-eval",
    taskId: `visual-identity:${evalCase.id}`,
    browserProfile: EVAL_BROWSER_PROFILE,
    applicationId: EVAL_APPLICATION_ID,
    windowId: EVAL_WINDOW_ID
  };
}

function bindEvalSurface(screenshot: Screenshot, evalCase: VisualIdentityEvalCase): Screenshot {
  return {
    ...screenshot,
    surface: {
      platform: "darwin",
      app: "Google Chrome",
      bundleId: EVAL_APPLICATION_ID,
      browserProfile: EVAL_BROWSER_PROFILE,
      pid: 10_001,
      title: `Google Ads — ${evalCase.expected.accountName}`,
      windowId: EVAL_WINDOW_ID,
      bounds: { x: 0, y: 0, width: evalCase.viewport.logicalWidth, height: evalCase.viewport.logicalHeight },
      screenId: "computer-use-live-eval-screen",
      screenBounds: { x: 0, y: 0, width: evalCase.viewport.logicalWidth, height: evalCase.viewport.logicalHeight },
      scaleFactor: evalCase.viewport.scaleFactor
    }
  };
}

function visualIdentityErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && VISUAL_IDENTITY_ERROR_CODES.has(code) ? code : undefined;
}

function isIdentityProviderFailure(message: string): boolean {
  return /(?:HTTP\s+\d|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|timed?\s*out|timeout|identity review failed|invalid identity JSON|did not return an identity observation|aborted)/i.test(message);
}

function specialistCellKey(rowKey: string, columnKey: string): string {
  return `${rowKey}\u0000${columnKey}`;
}

function specialistValuesEqual(left: unknown, right: unknown): boolean {
  return typeof left === typeof right && Object.is(left, right);
}

function notRunReport(reason: string): RouteEvalReport {
  return { status: "not-run", reason, metrics: emptyMetrics(0, 0) };
}

function emptyMetrics(evaluatedCases: number, providerResponses: number): EvalMetrics {
  return {
    evaluatedCases,
    providerResponses,
    elementGroundingAccuracy: null,
    actionSuccessRate: null,
    falseClickRate: null,
    unsafeActionRate: null,
    tableCellAccuracy: null,
    accountIdentityAccuracy: null,
    campaignIdentityAccuracy: null,
    verificationAccuracy: null,
    averageRetries: null,
    escalationRate: null,
    tokenUsage: null,
    averageLatencyMs: null
  };
}

function completionStatus(total: number, responses: number, errors: number): RouteEvalReport["status"] {
  if (!total || !responses) return "failed";
  return errors ? "partial" : "complete";
}

function aggregateStatus(statuses: RouteEvalReport["status"][]): LiveModelEvalReport["status"] {
  const ran = statuses.filter((status) => status !== "not-run");
  if (!ran.length) return "not-run";
  if (ran.every((status) => status === "complete")) return statuses.some((status) => status === "not-run") ? "partial" : "complete";
  if (ran.every((status) => status === "failed")) return "failed";
  return "partial";
}

function ratio<T>(values: T[], predicate: (value: T) => boolean): number | null {
  return values.length ? values.filter(predicate).length / values.length : null;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function sumCount(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sum(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}
