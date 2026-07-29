import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const REPO_SCRIPT_PATH = fileURLToPath(
  new URL("../../../packages/advertising-core/python/scripts/uac_experiment.py", import.meta.url)
);
const REPO_PYTHON_ROOT = fileURLToPath(
  new URL("../../../packages/advertising-core/python", import.meta.url)
);

/**
 * Third-party modules the engine needs beyond the Python standard library.
 * `decide` loads the bundled YAML heuristic policies (policy_loader.py →
 * io._load), so PyYAML is mandatory for the engine as a whole; `jsonschema`
 * is only used by the optional `doctor` command and is not required here.
 */
const REQUIRED_PYTHON_MODULES = ["yaml"] as const;

/** Engine identity stamped onto every successful analyze/decide result. */
const UAC_ENGINE_NAME = "uac-experiment";
/**
 * Last-resort engine version when no VERSION marker ships next to the script
 * (packages/advertising-core/python/VERSION is the canonical marker).
 */
const UAC_ENGINE_FALLBACK_VERSION = "0.1.0";

type EngineScriptResolution = {
  scriptPath: string;
  cwd: string;
  /** Directory holding the VERSION marker (parent of the scripts/ dir). */
  engineRoot: string;
};

/**
 * Script resolution chain: `ADPILOT_UAC_SCRIPT` explicit override (full path
 * to uac_experiment.py) > `ADPILOT_RESOURCES_PATH`/advertising-core/python
 * (production; the packaged Electron shell sets ADPILOT_RESOURCES_PATH to
 * process.resourcesPath, mirroring ADPILOT_NATIVE_HELPER_PATH) > the
 * repository-relative path (development).
 */
function resolveEngineScript(): EngineScriptResolution {
  const explicit = process.env.ADPILOT_UAC_SCRIPT;
  if (explicit) {
    const scriptPath = resolve(explicit);
    return { scriptPath, cwd: dirname(scriptPath), engineRoot: dirname(dirname(scriptPath)) };
  }
  const resourcesPath = process.env.ADPILOT_RESOURCES_PATH;
  if (resourcesPath) {
    const pythonRoot = join(resourcesPath, "advertising-core", "python");
    return {
      scriptPath: join(pythonRoot, "scripts", "uac_experiment.py"),
      cwd: pythonRoot,
      engineRoot: pythonRoot
    };
  }
  return { scriptPath: REPO_SCRIPT_PATH, cwd: REPO_PYTHON_ROOT, engineRoot: REPO_PYTHON_ROOT };
}

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
 * Provenance stamped by this bridge onto every successful engine result:
 * which engine produced it and its version (read from the VERSION marker
 * next to the script, falling back to UAC_ENGINE_FALLBACK_VERSION).
 */
export const UacEngineInfo = z.object({
  name: z.literal(UAC_ENGINE_NAME),
  version: z.string().min(1)
}).strict();
export type UacEngineInfo = z.infer<typeof UacEngineInfo>;

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
  recommendations: z.array(z.record(z.unknown())).optional(),
  engine: UacEngineInfo.optional()
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
  }).passthrough(),
  engine: UacEngineInfo.optional()
}).passthrough();
export type UacQuickDecisionResult = z.infer<typeof UacQuickDecisionResult>;

export type UacAnalyzeResult =
  | { kind: "analyze"; result: UacAnalysisResult }
  | { kind: "decide"; result: UacQuickDecisionResult };

export type PythonUacEngineOptions = {
  /** Python interpreter to spawn; default "python3". */
  pythonPath?: string;
  /** Engine CLI entry; default resolved via the ADPILOT_UAC_SCRIPT >
   * ADPILOT_RESOURCES_PATH > repository chain (see resolveEngineScript). */
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
  private readonly engineRoot: string;
  private readonly timeoutMs: number;
  private engineInfoCache: UacEngineInfo | undefined;

  constructor(options: PythonUacEngineOptions = {}) {
    const resolution = options.scriptPath !== undefined
      ? {
          scriptPath: options.scriptPath,
          cwd: dirname(options.scriptPath),
          engineRoot: dirname(dirname(options.scriptPath))
        }
      : resolveEngineScript();
    this.pythonPath = options.pythonPath ?? "python3";
    this.scriptPath = resolution.scriptPath;
    this.cwd = options.cwd ?? resolution.cwd;
    this.engineRoot = resolution.engineRoot;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * True when the configured interpreter answers `python3 --version` and can
   * import every third-party module the engine needs (REQUIRED_PYTHON_MODULES).
   */
  async isAvailable(): Promise<boolean> {
    return (await this.interpreterAvailable()) && (await this.missingPythonModules()).length === 0;
  }

  async analyze(request: UacAnalyzeRequest): Promise<UacAnalyzeResult> {
    const parsed = UacAnalyzeRequest.parse(request);
    if (!(await this.interpreterAvailable())) {
      throw new AdsIntelligenceError(
        `python interpreter is not available: ${this.pythonPath}`,
        UAC_ENGINE_UNAVAILABLE
      );
    }
    const missingModules = await this.missingPythonModules();
    if (missingModules.length > 0) {
      throw new AdsIntelligenceError(
        `python module(s) not available for ${this.pythonPath}: ${missingModules.join(", ")} ` +
          "(the UAC engine requires PyYAML; install it for the system python3 to enable UAC analysis)",
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
      // -B: never write bytecode. The packaged engine lives inside a signed
      // app bundle; a __pycache__ directory created at call time breaks the
      // code signature seal.
      const { status, stdout, stderr, error } = await this.run([this.pythonPath, ["-B", ...args]]);
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
      const engine = await this.engineInfo();
      if (parsed.kind === "decide") {
        const result = UacQuickDecisionResult.safeParse(output);
        if (!result.success) {
          throw new AdsIntelligenceError(
            `UAC engine decide output failed schema validation: ${result.error.issues[0]?.message ?? "invalid shape"}`,
            UAC_OUTPUT_INVALID
          );
        }
        return { kind: "decide", result: { ...result.data, engine } };
      }
      const result = UacAnalysisResult.safeParse(output);
      if (!result.success) {
        throw new AdsIntelligenceError(
          `UAC engine analyze output failed schema validation: ${result.error.issues[0]?.message ?? "invalid shape"}`,
          UAC_OUTPUT_INVALID
        );
      }
      return { kind: "analyze", result: { ...result.data, engine } };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** True when the configured interpreter answers `python3 --version`. */
  private async interpreterAvailable(): Promise<boolean> {
    try {
      const { status } = await this.run([this.pythonPath, ["--version"]]);
      return status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Required third-party modules the interpreter cannot import, verified one
   * by one (`python3 -c "import <module>"`). A module that fails to import is
   * reported by name so callers degrade to UAC_ENGINE_UNAVAILABLE instead of
   * surfacing a raw engine crash.
   */
  private async missingPythonModules(): Promise<string[]> {
    const missing: string[] = [];
    for (const moduleName of REQUIRED_PYTHON_MODULES) {
      try {
        const { status, error } = await this.run([this.pythonPath, ["-c", `import ${moduleName}`]]);
        if (error !== undefined || status !== 0) missing.push(moduleName);
      } catch {
        missing.push(moduleName);
      }
    }
    return missing;
  }

  /**
   * Engine identity stamped onto results. The version is read once from the
   * VERSION marker at the engine root (packages/advertising-core/python/VERSION);
   * when the marker is absent or malformed the documented fallback is used.
   */
  private async engineInfo(): Promise<UacEngineInfo> {
    if (this.engineInfoCache !== undefined) return this.engineInfoCache;
    let version = UAC_ENGINE_FALLBACK_VERSION;
    try {
      const marker = (await readFile(join(this.engineRoot, "VERSION"), "utf8")).trim();
      if (/^\d+\.\d+\.\d+$/.test(marker)) version = marker;
    } catch {
      // No VERSION marker shipped next to the script; keep the fallback.
    }
    this.engineInfoCache = { name: UAC_ENGINE_NAME, version };
    return this.engineInfoCache;
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
