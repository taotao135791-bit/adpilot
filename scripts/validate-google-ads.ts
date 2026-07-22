#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAdPilotSystem } from "@adpilot/application";
import type { VisualMicroTask, VisualRuntimeEvent } from "@adpilot/computer-use";

type Mode = "readonly" | "prepare";

const mode = (process.argv[2] ?? "") as Mode;
if (!(["readonly", "prepare"] as string[]).includes(mode) || process.argv.includes("--help")) {
  console.log([
    "Google Ads native visual validation (never uses DOM/Playwright).",
    "",
    "Usage:",
    "  pnpm validate:google-ads:readonly -- --client <id> --browser-profile <name>",
    "  pnpm validate:google-ads:prepare -- --client <id> --browser-profile <name> --campaign <name> --draft-budget <value>",
    "",
    "Open the authorized Google Ads account in the foreground before starting.",
    "prepare fills a draft budget field and stops before Save/Apply; it never submits."
  ].join("\n"));
  process.exit(mode ? 0 : 1);
}

const clientId = requiredFlag("--client");
const browserProfile = requiredFlag("--browser-profile");
const campaign = flag("--campaign");
const draftBudget = flag("--draft-budget");
if (mode === "prepare" && (!campaign || !draftBudget)) throw new Error("prepare requires --campaign and --draft-budget");

const system = await createAdPilotSystem();
if (!system.computer) throw new Error("computer use is not configured; configure GUI grounding plus verification in Settings");
const client = await system.workspace.readClient(clientId);
const account = client.accounts?.accounts.find((item) => item.platform === "google_ads" && item.browserProfile === browserProfile);
if (!account || !account.allowedDomains.includes("ads.google.com")) {
  throw new Error(`client ${clientId} has no google_ads account bound to browser profile ${browserProfile} and ads.google.com`);
}
const live = await system.computer.identifySurface();
if (!live.surface) throw new Error("native active-window identity is unavailable");
if (!/chrome|safari|edge|arc|brave|firefox/i.test(`${live.surface.app} ${live.surface.bundleId ?? ""}`)) {
  throw new Error(`foreground app is not a supported browser: ${live.surface.app}`);
}

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${mode}`;
const artifactRoot = resolve(process.cwd(), "artifacts", "google-ads-validation", runId);
await mkdir(artifactRoot, { recursive: true });
const records: Array<Record<string, unknown>> = [];
let screenshotIndex = 0;

const readonlySteps = [
  ["Confirm the visible Google Ads customer account name and customer ID; do not click if they are not visible", "account identity", "the authorized Google Ads account identity is visibly confirmed"],
  ["Open the visible date-range selector without changing campaign settings", "date range selector", "the date range menu is visibly open"],
  ["Choose Last 30 days in the open date-range selector", "Last 30 days", "the visible date range is Last 30 days"],
  ["Inspect the visible campaign table without editing anything", "campaign table", "campaign names and status columns are visible"],
  ["Open the visible Columns menu without applying changes", "Columns menu", "the columns menu is visibly open"],
  ["Close the columns menu without applying changes", "Close columns menu", "the columns menu is visibly closed"],
  ["Open the visible Filters control without applying a filter", "Filters control", "the filter panel is visibly open"],
  ["Close the filter panel without applying changes", "Close filters", "the campaign table is visible again"],
  ["Scroll the campaign table enough to inspect more visible rows; do not open an edit control", "campaign table rows", "additional campaign rows are visible"],
  ["Finish after confirming no Save, Apply, Publish, Remove, or destructive control was used", "read-only completion", "the campaign table remains visible and unchanged"]
] as const;

const prepareSteps = [
  [`Open the visible campaign row named ${campaign}; do not edit yet`, campaign!, `campaign ${campaign} details are visibly open`],
  ["Open the campaign budget edit control, but do not save or apply", "budget edit control", "the budget edit field is visibly available"],
  ["Focus the daily budget input without submitting", "daily budget input", "the budget input is visibly focused"],
  [`Replace the draft value in the focused daily budget input with ${draftBudget}; do not click Save, Apply, Publish, or press Enter`, "daily budget input", `the unsaved draft budget visibly shows ${draftBudget}`],
  ["Stop now. Do not click Save, Apply, Publish, Done, or press Enter. Confirm the draft remains unsubmitted", "unsubmitted budget draft", `the draft budget ${draftBudget} is visible and no success confirmation is present`]
] as const;

const steps = mode === "readonly" ? readonlySteps : prepareSteps;
for (let index = 0; index < steps.length; index += 1) {
  const [instruction, target, expectedResult] = steps[index]!;
  const taskId = crypto.randomUUID();
  const task: VisualMicroTask = {
    taskId,
    stepId: `${mode}-${String(index + 1).padStart(2, "0")}`,
    instruction,
    target,
    expectedResult,
    riskLevel: index === steps.length - 1 ? "observe" : "interact",
    permission: index === steps.length - 1 ? "OBSERVE" : "INTERACT",
    surface: {
      app: live.surface.app,
      domain: "ads.google.com",
      browserProfile,
      allowedApps: [live.surface.app],
      allowedDomains: ["ads.google.com"]
    }
  };
  const eventStart = system.events.history().length;
  const startedAt = Date.now();
  const result = await system.tools.executeVisualTask({ clientId, taskId, actor: "google_ads_validation", permission: task.permission }, task);
  const events = system.events.history().slice(eventStart).filter((event): event is { type: "computer"; event: VisualRuntimeEvent } => event.type === "computer");
  const safeEvents = [];
  for (const wrapped of events) {
    const event = wrapped.event;
    if (event.type === "screenshot") {
      const filename = `${String(++screenshotIndex).padStart(3, "0")}-${task.stepId}-${event.phase}.png`;
      await writeFile(resolve(artifactRoot, filename), Buffer.from(event.screenshot.base64, "base64"));
      safeEvents.push({ type: event.type, phase: event.phase, file: filename, sha256: event.screenshot.sha256, surfaceFingerprint: event.screenshot.surfaceFingerprint });
    } else safeEvents.push(event);
  }
  const executedTargets = events.flatMap(({ event }) => event.type === "executed" ? [event.action.target] : []);
  if (executedTargets.some((target) => /save|apply|publish|remove|delete|提交|保存|应用|发布|删除/i.test(target))) {
    throw new Error(`submission guard tripped on forbidden target: ${executedTargets.join(", ")}`);
  }
  records.push({ index: index + 1, task, result, latencyMs: Date.now() - startedAt, events: safeEvents });
  if (result.status !== "done") break;
}

const passed = records.length === steps.length && records.every((record) => (record.result as { status: string }).status === "done");
const manifest = {
  schemaVersion: 1,
  runId,
  mode,
  passed,
  safety: { domAutomation: false, submitAllowed: false, mutationsAllowed: false },
  clientId,
  accountRef: account.accountRef,
  browserProfile,
  initialSurface: live,
  models: system.modelStatus,
  tokenUsage: null,
  tokenUsageNote: "The configured provider did not expose per-request usage through the visual runtime interface.",
  startedAt: runId.slice(0, 24),
  completedAt: new Date().toISOString(),
  records
};
await writeFile(resolve(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ passed, mode, stepsCompleted: records.length, artifactRoot }, null, 2));
if (!passed) process.exitCode = 2;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredFlag(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
