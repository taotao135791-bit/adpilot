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
    "  pnpm validate:google-ads:readonly -- --client <id> --browser-profile <name> --campaign <name>",
    "  pnpm validate:google-ads:prepare -- --client <id> --browser-profile <name> --campaign <name> --draft-budget <value>",
    "",
    "Open the authorized Google Ads account in the foreground before starting.",
    "prepare fills a draft budget field and stops before Save/Apply; it never submits."
  ].join("\n"));
  process.exit(mode ? 0 : 1);
}

const clientId = requiredFlag("--client");
const browserProfile = requiredFlag("--browser-profile");
const campaign = requiredFlag("--campaign");
const draftBudget = flag("--draft-budget");
if (mode === "prepare" && !draftBudget) throw new Error("prepare requires --draft-budget");

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
const artifactRoot = resolve(process.cwd(), "artifacts", "validation", runId);
await mkdir(artifactRoot, { recursive: true });
const records: Array<Record<string, unknown>> = [];
let screenshotIndex = 0;

const readonlySteps = [
  ["Confirm from the visible logo and navigation that the foreground page is Google Ads; do not click if uncertain", "Google Ads visual identity", "Google Ads logo and navigation are visibly confirmed"],
  ["Read and confirm the visible Google Ads customer account name and customer ID", "account identity", "the authorized account name and customer ID are visibly confirmed"],
  ["Open the Campaigns page using the visible Google Ads navigation", "Campaigns navigation", "the Campaigns page is visibly open"],
  ["Open the visible date-range selector without changing campaign settings", "date range selector", "the date range menu is visibly open"],
  ["Choose Last 7 days in the open date-range selector", "Last 7 days", "the visible date range is Last 7 days"],
  [`Find the visible campaign named ${campaign} without opening an edit control`, campaign, `campaign ${campaign} is visibly identified`],
  [`Read the visible status for campaign ${campaign} without changing it`, `${campaign} status`, `the campaign status is visibly readable`],
  [`Read the visible daily budget for campaign ${campaign} without editing it`, `${campaign} budget`, `the campaign budget is visibly readable`],
  [`Read the visible bid strategy or bid target for campaign ${campaign} without editing it`, `${campaign} bid target`, `the bid strategy or target is visibly readable`],
  ["Open the visible Goals or Conversions page using navigation; do not edit a goal", "Goals and conversions navigation", "conversion goals are visibly listed"],
  ["Take final evidence and stop. Do not click Save, Apply, Publish, Remove, or Delete", "read-only completion", "Google Ads remains visible with no mutation confirmation"]
] as const;

const prepareSteps = [
  [`Open the visible campaign row named ${campaign}; do not edit yet`, campaign, `campaign ${campaign} details are visibly open`],
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
