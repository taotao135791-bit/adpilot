#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const releaseRoot = resolve(process.env.ADPILOT_RELEASE_ROOT ?? "release");
const required = process.argv.includes("--require");
const artifacts = await walk(releaseRoot, 4).catch(() => []);
const packageVersion = JSON.parse(await readFile(resolve("package.json"), "utf8")).version;
const dmgs = artifacts.filter((path) =>
  path.endsWith(".dmg") && basename(path).startsWith(`AdPilot-${packageVersion}-`)
);
const apps = artifacts.filter((path) => path.endsWith(".app"));
const checks = [];

/**
 * Third-party Python modules the bundled UAC engine needs at runtime (kept in
 * sync with REQUIRED_PYTHON_MODULES in packages/ads-intelligence/src/uac-engine.ts).
 * PyYAML: `decide` loads the bundled YAML heuristic policies. jsonschema is
 * only used by the engine's optional `doctor` command, so it is not gated here.
 */
const UAC_ENGINE_PYTHON_DEPS = ["yaml"];

/** Minimal valid UAC input contract object for a real `analyze` smoke call. */
const UAC_SMOKE_CASE = {
  scope: {
    platform: "google_ads",
    campaign_type: "app_campaign",
    campaign: "smoke",
    os: "android",
    country: "us",
    start_date: "2026-07-01",
    end_date: "2026-07-14",
    timezone: "UTC"
  },
  goal: { business_goal: "payment", optimization_event: "registration", bidding_strategy: "tcpa" },
  facts: {
    segmentation_complete: true,
    metrics: { spend: 100, installs: 50, registrations: 10, payments: 2 }
  },
  measurement: {
    google_ads_vs_firebase: "consistent",
    google_ads_vs_mmp: "consistent",
    mmp_vs_backend: "consistent",
    duplicate_events: false,
    value_currency_valid: true,
    delay_known: true,
    os_discrepancy: false,
    first_repeat_definition_clear: true,
    payment_trial_refund_distinguished: true,
    attribution_window_reviewed: true
  },
  learning: {
    event_volume_assessment: "sufficient",
    budget_assessment: "sufficient",
    target_assessment: "reasonable"
  },
  maturity: {
    days_elapsed: 14,
    minimum_days: 7,
    conversions_observed: 18,
    minimum_conversions: 10,
    conversion_delay_elapsed_days: 5,
    conversion_delay_days: 3
  },
  permissions: { optimizer_can: ["budget"], client_approval_required: [], unavailable: [] },
  signals: {},
  evidence: []
};

for (const dmg of dmgs) {
  checks.push(await commandCheck("dmg-integrity", dmg, "hdiutil", ["verify", dmg]));
}
for (const app of apps) {
  checks.push(await commandCheck("app-signature", app, "codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    app
  ]));
  checks.push(await bundleVersionCheck("app-version", app, packageVersion));
  const helper = join(
    app,
    "Contents",
    "Resources",
    "native",
    "AdPilot Computer Helper.app"
  );
  const helperExists = await stat(helper).then((item) => item.isDirectory()).catch(() => false);
  checks.push({
    check: "nested-helper-present",
    artifact: helper,
    status: helperExists ? "passed" : "failed"
  });
  if (helperExists) {
    checks.push(await commandCheck("nested-helper-signature", helper, "codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      helper
    ]));
    checks.push(await bundleVersionCheck("nested-helper-version", helper, packageVersion));
  }
  checks.push(...await uacEngineChecks(app));
}

let status;
if (dmgs.length === 0 && apps.length === 0) {
  status = required ? "failed" : "not-run";
} else {
  // The UAC engine is an optional capability (the native helper is the
  // required one), so "blocked" checks never fail the smoke run.
  status = checks.some((check) => check.status === "failed") ? "failed" : "passed";
}
const report = {
  status,
  packageVersion,
  releaseRoot,
  artifacts: [...dmgs, ...apps].map((path) => basename(path)),
  checks,
  reason: status === "not-run"
    ? "No macOS package exists yet. Run pnpm package:mac first."
    : status === "failed" && checks.length === 0
      ? "Packaging completed without a discoverable .dmg or .app artifact."
      : undefined
};
console.log(JSON.stringify(report, null, 2));
if (status === "failed") process.exitCode = 1;

/**
 * Bundled Python UAC engine checks for one packaged .app: the engine script
 * must ship under Contents/Resources (a packaging failure if missing), then a
 * real `analyze` call through the system python3 — gracefully "blocked" when
 * python3 or a required third-party module is absent, since the engine is an
 * optional capability.
 */
async function uacEngineChecks(app) {
  const pythonRoot = join(app, "Contents", "Resources", "advertising-core", "python");
  const script = join(pythonRoot, "scripts", "uac_experiment.py");
  const scriptExists = await stat(script).then((item) => item.isFile()).catch(() => false);
  const results = [{
    check: "uac-engine-script-present",
    artifact: script,
    status: scriptExists ? "passed" : "failed"
  }];
  if (!scriptExists) return results;

  try {
    await run("python3", ["--version"], { timeout: 30_000 });
  } catch {
    results.push({
      check: "uac-engine-python3",
      artifact: script,
      status: "blocked",
      reason: "blocked:no-python3"
    });
    return results;
  }
  results.push({ check: "uac-engine-python3", artifact: script, status: "passed" });

  const missingDeps = [];
  for (const dep of UAC_ENGINE_PYTHON_DEPS) {
    try {
      await run("python3", ["-c", `import ${dep}`], { timeout: 30_000 });
    } catch {
      missingDeps.push(dep);
    }
  }
  if (missingDeps.length > 0) {
    results.push({
      check: "uac-engine-python-deps",
      artifact: script,
      status: "blocked",
      reason: `blocked:missing-python-dep:${missingDeps.join(",")}`
    });
    return results;
  }
  results.push({ check: "uac-engine-python-deps", artifact: script, status: "passed" });

  results.push(await uacEngineAnalyzeCheck(script, pythonRoot));
  return results;
}

/**
 * Minimal real engine invocation: write the smoke case to a private temp JSON
 * file and run `python3 <bundled script> analyze <file>` (the engine's actual
 * file-in/stdout-JSON protocol), then validate the JSON result shape.
 */
async function uacEngineAnalyzeCheck(script, pythonRoot) {
  const check = "uac-engine-analyze";
  const tempDir = await mkdtemp(join(tmpdir(), "adpilot-uac-smoke-"));
  try {
    const inputPath = join(tempDir, "uac-input.json");
    await writeFile(inputPath, `${JSON.stringify(UAC_SMOKE_CASE)}\n`, { encoding: "utf8", mode: 0o600 });
    // -B keeps python from writing __pycache__ into the signed bundle.
    const { stdout } = await run("python3", ["-B", script, "analyze", inputPath], {
      cwd: pythonRoot,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024
    });
    let output;
    try {
      output = JSON.parse(stdout);
    } catch {
      return { check, artifact: script, status: "failed", reason: "engine produced non-JSON stdout" };
    }
    const valid = output !== null
      && typeof output === "object"
      && output.schema_version === "1.0"
      && typeof output.measurement_state?.status === "string"
      && typeof output.learning_eligibility?.status === "string"
      && typeof output.optimization_feasibility?.status === "string";
    const pycachePollution = (await walk(pythonRoot, 8)).some((path) => path.includes("__pycache__") || path.endsWith(".pyc"));
    if (pycachePollution) {
      return { check, artifact: script, status: "failed", reason: "analyze wrote bytecode into the signed bundle" };
    }
    return valid
      ? { check, artifact: script, status: "passed" }
      : { check, artifact: script, status: "failed", reason: "engine output failed smoke validation" };
  } catch (caught) {
    return {
      check,
      artifact: script,
      status: "failed",
      reason: caught instanceof Error ? caught.message.split("\n")[0] : String(caught)
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function walk(root, depth) {
  if (depth < 0) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".app")) {
        found.push(path);
      } else {
        found.push(...await walk(path, depth - 1));
      }
    } else if (entry.isFile() && entry.name.endsWith(".dmg")) {
      found.push(path);
    }
  }
  return found;
}

async function commandCheck(check, artifact, command, args) {
  try {
    await run(command, args, {
      timeout: 120_000,
      maxBuffer: 1024 * 1024
    });
    return { check, artifact, status: "passed" };
  } catch (caught) {
    return {
      check,
      artifact,
      status: "failed",
      reason: caught instanceof Error ? caught.message.split("\n")[0] : String(caught)
    };
  }
}

async function bundleVersionCheck(check, app, expectedVersion) {
  const plist = join(app, "Contents", "Info.plist");
  try {
    const [shortVersion, buildVersion] = await Promise.all([
      run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], { timeout: 30_000 }),
      run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", plist], { timeout: 30_000 })
    ]);
    const actualShortVersion = shortVersion.stdout.trim();
    const actualBuildVersion = buildVersion.stdout.trim();
    if (actualShortVersion !== expectedVersion || actualBuildVersion !== expectedVersion) {
      return {
        check,
        artifact: app,
        status: "failed",
        reason: `expected ${expectedVersion}; found short=${actualShortVersion || "missing"}, build=${actualBuildVersion || "missing"}`
      };
    }
    return { check, artifact: app, status: "passed", version: expectedVersion };
  } catch (caught) {
    return {
      check,
      artifact: app,
      status: "failed",
      reason: caught instanceof Error ? caught.message.split("\n")[0] : String(caught)
    };
  }
}
