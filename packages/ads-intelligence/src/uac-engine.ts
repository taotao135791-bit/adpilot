import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AdsIntelligenceError } from "./errors.js";

export const UAC_ENGINE_UNAVAILABLE = "UAC_ENGINE_UNAVAILABLE";
export const UAC_ENGINE_FAILED = "UAC_ENGINE_FAILED";
export const UAC_OUTPUT_INVALID = "UAC_OUTPUT_INVALID";

/**
 * Real entry point of the deterministic UAC helper in
 * packages/advertising-core/python (see its tests/uac/test_uac_quick_cli.py).
 * The script exposes `analyze` (full UAC analysis JSON on stdout) and
 * `decide --json` (Quick Decision card JSON on stdout); both accept a JSON
 * input file holding the UAC input contract object.
 */
const DEFAULT_SCRIPT_PATH = fileURLToPath(
  new URL("../../../packages/advertising-core/python/scripts/uac_experiment.py", import.meta.url)
);
const DEFAULT_SCRIPT_CWD = fileURLToPath(
  new URL("../../../packages/advertising-core/python", import.meta.url)
);

/**
 * Analysis request: `kind` selects the engine entry (`analyze` for a full
 * diagnosis, `decide` for the read-only Campaign Level Quick Decision card),
 * `case` is the UAC input contract object (scope/goal/facts/measurement/
 * learning/maturity/permissions/signals/...), `question` is forwarded to
 * `decide --question`.
 */
export const UacAnalyzeRequest = z.object({
  kind: z.enum(["analyze", "decide"]),
  case: z.record(z.unknown()),
  question: z.string().min(1).max(4_000).optional()
}).strict();
export type UacAnalyzeRequest = z.infer<typeof UacAnalyzeRequest>;

/**
 * Validated view of the engine's full-analysis output. Fields AdPilot depends
 * on are checked strictly; the rest of the contract is passed through so the
 * caller keeps the complete engine result.
 */
export const UacAnalysisResult = z.object({
  schema_version: z.string().min(1),
  account_state: z.record(z.unknown()),
  measurement_state: z.object({ status: z.string().min(1) }).passthrough(),
  learning_eligibility: z.object({ status: z.string().min(1) }).passthrough(),
  optimization_feasibility: z.object({ status: z.string().min(1) }).passthrough(),
  diagnoses: z.array(z.record(z.unknown())).optional(),
  recommendations: z.array(z.record(z.unknown())).optional()
}).passthrough();
export type UacAnalysisResult = z.infer<typeof UacAnalysisResult>;

/** Validated view of the engine's Quick Decision output (schema_version 1.0). */
export const UacQuickDecisionResult = z.object({
  schema_version: z.string().min(1),
  mode: z.literal("quick_decision"),
  question_type: z.string().min(1),
  terminology: z.object({
    resolved_level: z.enum(["AC2.0", "AC2.5", "AC3.0"]).nullable(),
    resolution_source: z.string().min(1),
    confidence: z.string().min(1)
  }).passthrough(),
  decision: z.object({
    verdict: z.string().min(1),
    confidence: z.string().min(1),
    summary: z.string()
  }).passthrough()
}).passthrough();
export type UacQuickDecisionResult = z.infer<typeof UacQuickDecisionResult>;

export type UacAnalyzeResult =
  | { kind: "analyze"; result: UacAnalysisResult }
  | { kind: "decide"; result: UacQuickDecisionResult };

export type PythonUacEngineOptions = {
  /** Python interpreter to spawn; default "python3". */
  pythonPath?: string;
  /** Engine CLI entry; default the advertising-core uac_experiment.py script. */
  scriptPath?: string;
  /** Working directory for the engine process; default the python package dir. */
  cwd?: string;
  /** Hard wall-clock limit per engine call; default 30s. */
  timeoutMs?: number;
};

/**
 * Productized bridge to the deterministic Python UAC engine. It never fakes a
 * result: when python3 (or the engine) cannot run, every call fails with a
 * coded AdsIntelligenceError instead of returning fabricated analysis.
 */
export class PythonUacEngine {
  private readonly pythonPath: string;
  private readonly scriptPath: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;

  constructor(options: PythonUacEngineOptions = {}) {
    this.pythonPath = options.pythonPath ?? "python3";
    this.scriptPath = options.scriptPath ?? DEFAULT_SCRIPT_PATH;
    this.cwd = options.cwd ?? DEFAULT_SCRIPT_CWD;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** True when the configured interpreter answers `python3 --version`. */
  async isAvailable(): Promise<boolean> {
    try {
      const { status } = await this.run([this.pythonPath, ["--version"]]);
      return status === 0;
    } catch {
      return false;
    }
  }

  async analyze(request: UacAnalyzeRequest): Promise<UacAnalyzeResult> {
    const parsed = UacAnalyzeRequest.parse(request);
    if (!(await this.isAvailable())) {
      throw new AdsIntelligenceError(
        `python interpreter is not available: ${this.pythonPath}`,
        UAC_ENGINE_UNAVAILABLE
      );
    }
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "adpilot-uac-"));
    try {
      const inputPath = join(temporaryDirectory, "uac-input.json");
      await writeFile(inputPath, `${JSON.stringify(parsed.case)}\n`, { encoding: "utf8", mode: 0o600 });
      const args = parsed.kind === "decide"
        ? [
            this.scriptPath,
            "decide",
            inputPath,
            "--json",
            ...(parsed.question !== undefined ? ["--question", parsed.question] : [])
          ]
        : [this.scriptPath, "analyze", inputPath];
      const { status, stdout, stderr, error } = await this.run([this.pythonPath, args]);
      if (error !== undefined || status !== 0) {
        throw new AdsIntelligenceError(
          `UAC engine ${parsed.kind} failed: ${describeFailure(status, stderr, error)}`,
          UAC_ENGINE_FAILED
        );
      }
      let output: unknown;
      try {
        output = JSON.parse(stdout);
      } catch {
        throw new AdsIntelligenceError(
          `UAC engine ${parsed.kind} produced non-JSON stdout`,
          UAC_OUTPUT_INVALID
        );
      }
      if (parsed.kind === "decide") {
        const result = UacQuickDecisionResult.safeParse(output);
        if (!result.success) {
          throw new AdsIntelligenceError(
            `UAC engine decide output failed schema validation: ${result.error.issues[0]?.message ?? "invalid shape"}`,
            UAC_OUTPUT_INVALID
          );
        }
        return { kind: "decide", result: result.data };
      }
      const result = UacAnalysisResult.safeParse(output);
      if (!result.success) {
        throw new AdsIntelligenceError(
          `UAC engine analyze output failed schema validation: ${result.error.issues[0]?.message ?? "invalid shape"}`,
          UAC_OUTPUT_INVALID
        );
      }
      return { kind: "analyze", result: result.data };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private run([command, args]: [string, string[]]): Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }> {
    return new Promise((resolvePromise) => {
      execFile(
        command,
        args,
        { cwd: this.cwd, timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGTERM" },
        (error, stdout, stderr) => {
          if (error) {
            const status = typeof error.code === "number" ? error.code : null;
            resolvePromise({ status, stdout, stderr, error });
            return;
          }
          resolvePromise({ status: 0, stdout, stderr });
        }
      );
    });
  }
}

function describeFailure(status: number | null, stderr: string, error: Error | undefined): string {
  const timedOut = error && "killed" in error && (error as { killed?: boolean }).killed;
  if (timedOut) return `timed out after the configured limit`;
  const detail = stderr.trim().split("\n").at(-1) ?? error?.message ?? "unknown error";
  return `exit ${status ?? "signal"}: ${detail}`;
}
