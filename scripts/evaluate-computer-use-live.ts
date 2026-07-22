#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  evaluateOfflinePredictions,
  metricDefinitions,
  runLiveModelEvaluation,
  validateSpecialistCorpora,
  validateVisualCorpus,
  type EvalMetrics,
  type ProductLiveProviderSuite,
  type VerificationEvalCorpus,
  type VisualEvalCorpus,
  type VisualIdentityEvalCorpus,
  type VisualTableEvalCorpus
} from "../evals/computer-use-live/evaluator.js";
import { createProductLiveProviderSuite } from "../evals/computer-use-live/providers.js";

if (process.argv.includes("--help")) {
  console.log([
    "Run real AdPilot Computer Use providers against the sanitized visual corpus.",
    "",
    "Usage: pnpm eval:computer-use:live",
    "",
    "Optional environment:",
    "  ADPILOT_EVAL_LIMIT=<n>                 Limit paid live calls; corpus validation still checks all fixtures.",
    "  ADPILOT_EVAL_PREDICTIONS=<path>        Add a separate offline-prediction section.",
    "  ADPILOT_REAL_BROWSER_REPORT=<path>      Add a separate real-browser validation manifest.",
    "  ADPILOT_EVAL_OUTPUT=<path>              Override artifacts/evals/computer-use-live-report.json.",
    "",
    "Live Model Eval directly invokes GroundingModel, VisualVerifier, VisualTableReader, and DualVisualIdentityVerifier.",
    "With no configured visual provider/credential, each unavailable live route is reported honestly as not-run."
  ].join("\n"));
  process.exit(0);
}

const groundingCorpus = JSON.parse(await readFile(resolve("evals/gui-grounding/cases.json"), "utf8")) as VisualEvalCorpus;
const verificationCorpus = JSON.parse(await readFile(resolve("evals/gui-verification/cases.json"), "utf8")) as VerificationEvalCorpus;
const tableCorpus = JSON.parse(await readFile(resolve("evals/computer-use-live/table-cases.json"), "utf8")) as VisualTableEvalCorpus;
const identityCorpus = JSON.parse(await readFile(resolve("evals/computer-use-live/identity-cases.json"), "utf8")) as VisualIdentityEvalCorpus;
const baseCorpusValidation = await validateVisualCorpus(groundingCorpus, verificationCorpus);
const specialistCorpusValidation = await validateSpecialistCorpora(tableCorpus, identityCorpus);
const corpusValidation = {
  ...baseCorpusValidation,
  status: baseCorpusValidation.status === "passed" && specialistCorpusValidation.status === "passed" ? "passed" as const : "failed" as const,
  specialist: specialistCorpusValidation,
  errors: [
    ...baseCorpusValidation.errors,
    ...specialistCorpusValidation.errors.map((error) => `specialist: ${error}`)
  ]
};
const limit = optionalPositiveInteger(process.env.ADPILOT_EVAL_LIMIT);
const liveGroundingCorpus = limit ? { ...groundingCorpus, cases: groundingCorpus.cases.slice(0, limit) } : groundingCorpus;
const liveIds = new Set(liveGroundingCorpus.cases.map((evalCase) => evalCase.id));
const liveVerificationCorpus = limit
  ? { ...verificationCorpus, cases: verificationCorpus.cases.filter((evalCase) => liveIds.has(evalCase.id)) }
  : verificationCorpus;
const liveTableCorpus = limit ? { ...tableCorpus, cases: tableCorpus.cases.slice(0, limit) } : tableCorpus;
const liveIdentityCorpus = limit ? { ...identityCorpus, cases: identityCorpus.cases.slice(0, limit) } : identityCorpus;

const predictionPath = process.env.ADPILOT_EVAL_PREDICTIONS;
const predictions = predictionPath
  ? JSON.parse(await readFile(resolve(predictionPath), "utf8")) as { models?: Record<string, never[]> }
  : undefined;
const offlinePredictionEval = evaluateOfflinePredictions(groundingCorpus, predictions);

let providers: ProductLiveProviderSuite;
let providerAssemblyError: string | undefined;
try {
  providers = (await createProductLiveProviderSuite()).providers;
} catch (caught) {
  providerAssemblyError = caught instanceof Error ? caught.message : String(caught);
  providers = unavailableProviders(providerAssemblyError);
}
const liveModelEval = corpusValidation.status === "passed"
  ? await runLiveModelEvaluation({
      groundingCorpus: liveGroundingCorpus,
      verificationCorpus: liveVerificationCorpus,
      tableCorpus: liveTableCorpus,
      identityCorpus: liveIdentityCorpus,
      providers
    })
  : {
      status: "not-run" as const,
      title: "Live Model Eval" as const,
      routes: {
        builtInGuiGrounding: notRunRoute("Corpus validation failed."),
        fastVisionModel: notRunRoute("Corpus validation failed."),
        deepVisionModel: notRunRoute("Corpus validation failed.")
      },
      guiVerificationModel: notRunRoute("Corpus validation failed."),
      visualTableReader: notRunRoute("Corpus validation failed."),
      dualVisualIdentity: notRunRoute("Corpus validation failed."),
      tokenUsageNote: "No model call was attempted because the corpus failed validation."
    };

const realBrowserValidation = await loadRealBrowserValidation(process.env.ADPILOT_REAL_BROWSER_REPORT);
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  command: "pnpm eval:computer-use:live",
  guarantees: {
    liveProvidersCalledDirectly: liveProviderResponses(liveModelEval) > 0,
    liveProviderInvocationMode: "GroundingModel.ground, VisualVerifier.verify, VisualTableReader.read, and DualVisualIdentityVerifier.confirm; no prediction adapter",
    livePredictionsFileUsed: false,
    nativeActionsExecutedByLiveModelEval: false,
    oraclePresentedAsModelScore: false,
    corpusValidationContainsModelScores: false,
    groundingUsedForSpecialistMetrics: false
  },
  metricDefinitions,
  runConfiguration: {
    fullCorpusCases: groundingCorpus.cases.length,
    liveCasesRequested: liveGroundingCorpus.cases.length,
    fullTableCases: tableCorpus.cases.length,
    liveTableCasesRequested: liveTableCorpus.cases.length,
    fullIdentityCases: identityCorpus.cases.length,
    liveIdentityCasesRequested: liveIdentityCorpus.cases.length,
    limitedBy: limit ? "ADPILOT_EVAL_LIMIT" : null,
    predictionSource: predictionPath ? resolve(predictionPath) : null,
    realBrowserSource: process.env.ADPILOT_REAL_BROWSER_REPORT ? resolve(process.env.ADPILOT_REAL_BROWSER_REPORT) : null,
    providerAssemblyError: providerAssemblyError ?? null
  },
  sections: {
    corpusValidation,
    offlinePredictionEval,
    liveModelEval,
    realBrowserValidation
  }
};

const output = resolve(process.env.ADPILOT_EVAL_OUTPUT ?? "artifacts/evals/computer-use-live-report.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.error(`Computer Use eval report written to ${output}`);
if (corpusValidation.status === "failed") process.exitCode = 2;

function unavailableProviders(reason: string): ProductLiveProviderSuite {
  return {
    routes: {},
    routeAvailability: {
      builtInGuiGrounding: { status: "not-run", reason },
      fastVisionModel: { status: "not-run", reason },
      deepVisionModel: { status: "not-run", reason }
    },
    verificationAvailability: { status: "not-run", reason },
    tableReaderAvailability: { status: "not-run", reason },
    dualVisualIdentityAvailability: { status: "not-run", reason }
  };
}

function liveProviderResponses(report: {
  routes: Record<string, { metrics: EvalMetrics }>;
  guiVerificationModel: { metrics: EvalMetrics };
  visualTableReader: { metrics: EvalMetrics };
  dualVisualIdentity: { metrics: EvalMetrics };
}): number {
  return [
    ...Object.values(report.routes),
    report.guiVerificationModel,
    report.visualTableReader,
    report.dualVisualIdentity
  ].reduce((total, route) => total + route.metrics.providerResponses, 0);
}

function notRunRoute(reason: string) {
  return { status: "not-run" as const, reason, metrics: emptyMetrics() };
}

async function loadRealBrowserValidation(path: string | undefined) {
  if (!path) {
    return {
      status: "not-run" as const,
      title: "Real Browser Validation" as const,
      reason: "No ADPILOT_REAL_BROWSER_REPORT manifest was supplied. Synthetic live-model results are never presented as real-browser validation.",
      metrics: emptyMetrics()
    };
  }
  try {
    const source = resolve(path);
    const manifest = JSON.parse(await readFile(source, "utf8")) as {
      passed?: boolean;
      mode?: string;
      tokenUsage?: number | null;
      records?: Array<{
        result?: { status?: string; attempts?: number };
        latencyMs?: number;
        task?: { riskLevel?: string };
        events?: Array<{
          type?: string;
          tier?: string;
          matched?: boolean;
          action?: { risk_level?: string };
        }>;
      }>;
    };
    const records = Array.isArray(manifest.records) ? manifest.records : [];
    const completed = records.filter((record) => record.result?.status === "done").length;
    const grounded = records.filter((record) => record.events?.some((event) => event.type === "grounded")).length;
    const verified = records.flatMap((record) => record.events?.filter((event) => event.type === "verified") ?? []);
    const unsafe = records.filter((record) => record.events?.some((event) => {
      if (event.type !== "executed" || !event.action?.risk_level || !record.task?.riskLevel) return false;
      return riskRank(event.action.risk_level) > riskRank(record.task.riskLevel);
    })).length;
    const metrics = emptyMetrics();
    metrics.evaluatedCases = records.length;
    metrics.providerResponses = grounded;
    metrics.elementGroundingAccuracy = records.length ? grounded / records.length : null;
    metrics.actionSuccessRate = records.length ? completed / records.length : null;
    metrics.unsafeActionRate = records.length ? unsafe / records.length : null;
    metrics.verificationAccuracy = verified.length ? verified.filter((event) => event.matched === true).length / verified.length : null;
    metrics.averageRetries = average(records.map((record) => Math.max(0, (record.result?.attempts ?? 1) - 1)));
    metrics.escalationRate = records.length
      ? records.filter((record) => record.events?.some((event) => event.type === "grounded" && event.tier === "strong")).length / records.length
      : null;
    metrics.tokenUsage = typeof manifest.tokenUsage === "number" ? manifest.tokenUsage : null;
    metrics.averageLatencyMs = average(records.map((record) => record.latencyMs).filter((value): value is number => Number.isFinite(value)));
    return {
      status: manifest.passed === true ? "complete" as const : "failed" as const,
      title: "Real Browser Validation" as const,
      source,
      mode: manifest.mode ?? "unknown",
      passed: manifest.passed === true,
      metrics,
      tokenUsageNote: metrics.tokenUsage === null ? "Real-browser manifest did not expose token usage." : undefined
    };
  } catch (caught) {
    return {
      status: "failed" as const,
      title: "Real Browser Validation" as const,
      reason: caught instanceof Error ? caught.message : String(caught),
      source: resolve(path),
      metrics: emptyMetrics()
    };
  }
}

function emptyMetrics(): EvalMetrics {
  return {
    evaluatedCases: 0,
    providerResponses: 0,
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

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("ADPILOT_EVAL_LIMIT must be a positive integer");
  return parsed;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function riskRank(value: string): number {
  return ({ observe: 0, interact: 1, mutate: 2, destructive: 3 } as Record<string, number>)[value] ?? Number.POSITIVE_INFINITY;
}
