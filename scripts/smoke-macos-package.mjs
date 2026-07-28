#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
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
  }
}

let status;
if (dmgs.length === 0 && apps.length === 0) {
  status = required ? "failed" : "not-run";
} else {
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
