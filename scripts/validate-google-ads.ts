#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createAdPilotSystem,
  type ProductEvent
} from "@adpilot/application";
import type {
  Screenshot,
  VisualActionKind,
  VisualMicroTask
} from "@adpilot/computer-use";
import {
  publicBrowserSession,
  parseValidationArguments,
  publicRuntimeEvent,
  publicSurfaceIdentity,
  publicValidationTask,
  publicVisualResult,
  screenshotEvidence
} from "./visual-validation-helpers.js";
import {
  RealBrowserValidationManifest,
  RealBrowserValidationRecord
} from "./real-browser-manifest.js";

type Mode = "readonly" | "prepare";

const usage = [
  "Google Ads logged-in-browser pure-vision validation (never uses DOM/Playwright).",
  "",
  "Usage:",
  "  pnpm validate:visual:google-ads:observe -- --client <id> --test-account <account-ref> --browser-profile <name> --campaign <name>",
  "  pnpm validate:visual:google-ads:prepare -- --client <id> --test-account <account-ref> --browser-profile <name> --campaign <name> --draft-budget <value>",
  "",
  "Start the AdPilot-managed browser first, then log in manually and leave its bound window in the foreground.",
  "For prepare, manually open the budget editor and focus the budget input before running the command.",
  "prepare permits only one type action and a read-only confirmation; Save/Apply/Publish cannot execute."
].join("\n");

if (process.argv.includes("--help")) {
  console.log(usage);
  process.exit(0);
}
const mode = (process.argv[2] ?? "") as Mode;
if (!(["readonly", "prepare"] as string[]).includes(mode)) {
  console.log(usage);
  process.exit(1);
}

const cliArguments = parseValidationArguments(mode, process.argv.slice(3));
const clientId = cliArguments.get("--client")!;
const browserProfile = cliArguments.get("--browser-profile")!;
const campaign = cliArguments.get("--campaign")!;
const expectedAccountRef = cliArguments.get("--test-account");
const draftBudget = cliArguments.get("--draft-budget");
if (mode === "prepare" && !draftBudget) throw new Error("prepare requires --draft-budget");
if (draftBudget && (!/^\d+(?:\.\d{1,2})?$/.test(draftBudget) || Number(draftBudget) <= 0)) {
  throw new Error("--draft-budget must be a positive decimal without signs, separators, whitespace, or control characters");
}

const system = await createAdPilotSystem();
const client = await system.workspace.readClient(clientId);
const account = client.accounts?.accounts.find((item) => item.platform === "google_ads" && item.browserProfile === browserProfile);
if (!account || !account.allowedDomains.includes("ads.google.com")) {
  throw new Error(`client ${clientId} has no google_ads account bound to browser profile ${browserProfile} and ads.google.com`);
}
if (expectedAccountRef && account.accountRef !== expectedAccountRef) {
  throw new Error(
    `named test account does not match the google_ads account bound to browser profile ${browserProfile}`
  );
}
const session = await system.browserSessions.get(clientId, browserProfile);
if (!session || session.sessionStatus !== "connected") {
  throw new Error(`managed browser is not connected; run adpilot browser start --client ${clientId} --profile ${browserProfile}`);
}
if (!session.processId || !session.windowId || !session.nativeProfileFingerprint) {
  throw new Error("managed browser lacks the required native PID/window/profile identity");
}
if (!system.computer) throw new Error("Computer Use is not ready; connect an image-capable model in Settings");
await system.browserSessions.assertActive(clientId, browserProfile, "google_ads");
const taskSurface = {
  app: session.browserApp,
  applicationId: session.browserApplicationId,
  processId: session.processId,
  windowId: session.windowId,
  domain: "ads.google.com",
  browserProfile,
  allowedApps: [session.browserApplicationId, session.browserApp],
  allowedDomains: ["ads.google.com"]
};
const live = await system.computer.identifySurface({
  clientId,
  taskId: crypto.randomUUID(),
  platform: "google_ads",
  instruction: "Confirm the managed Google Ads browser window",
  target: "Google Ads browser window",
  expectedResult: "the managed Google Ads browser window is visible",
  riskLevel: "observe",
  permission: "OBSERVE",
  surface: taskSurface
});
if (!live.surface) throw new Error("native active-window identity is unavailable");
if (!/chrome|safari|edge|arc|brave|firefox/i.test(`${live.surface.app} ${live.surface.bundleId ?? ""}`)) {
  throw new Error(`foreground app is not a supported browser: ${live.surface.app}`);
}

const startedAt = new Date().toISOString();
const runId = `${startedAt.replace(/[:.]/g, "-")}-${mode}`;
const artifactRoot = resolve(process.cwd(), "artifacts", "visual-validation", runId);
await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
await chmod(artifactRoot, 0o700);
const records: RealBrowserValidationRecord[] = [];
let screenshotIndex = 0;
const confirmationMinimumConfidence = 0.8;
const observeActions = ["screenshot", "done", "fail", "wait", "move"] satisfies VisualActionKind[];
const navigationActions = ["click", ...observeActions] satisfies VisualActionKind[];
const readScrollActions = ["scroll", ...observeActions] satisfies VisualActionKind[];

const readonlySteps = [
  {
    instruction: "Confirm from the visible logo and navigation that the foreground page is Google Ads; do not click if uncertain",
    target: "Google Ads visual identity",
    expectedResult: "Google Ads logo and navigation are visibly confirmed",
    riskLevel: "observe",
    permission: "OBSERVE",
    allowedActions: observeActions
  },
  {
    instruction: "Read and confirm the visible Google Ads customer account name and customer ID without opening the account switcher",
    target: "account identity",
    expectedResult: "the logged-in account name and customer ID are visibly confirmed",
    riskLevel: "observe",
    permission: "OBSERVE",
    allowedActions: observeActions
  },
  {
    instruction: "Open the Campaigns page using the visible Google Ads navigation",
    target: "Campaigns navigation",
    expectedResult: "the Campaigns page is visibly open",
    riskLevel: "interact",
    permission: "INTERACT",
    allowedActions: navigationActions,
    region: "left-navigation"
  },
  {
    instruction: "Open the visible date-range selector without changing campaign settings",
    target: "date range selector",
    expectedResult: "the date range menu is visibly open",
    riskLevel: "interact",
    permission: "INTERACT",
    allowedActions: navigationActions,
    region: "top-toolbar"
  },
  {
    instruction: "Choose Last 7 days in the open date-range selector",
    target: "Last 7 days",
    expectedResult: "the visible date range is Last 7 days",
    riskLevel: "interact",
    permission: "INTERACT",
    allowedActions: navigationActions,
    region: "date-menu"
  },
  {
    instruction: `Find the visible campaign named ${campaign} by scrolling only; do not open it or any edit control`,
    target: campaign,
    expectedResult: `campaign ${campaign} is visibly identified`,
    riskLevel: "interact",
    permission: "INTERACT",
    allowedActions: readScrollActions,
    region: "table"
  },
  {
    instruction: `Read the visible status for campaign ${campaign}; scroll only if needed and do not click it`,
    target: `${campaign} status`,
    expectedResult: "the campaign status is visibly readable",
    riskLevel: "interact",
    permission: "INTERACT",
    allowedActions: readScrollActions,
    region: "table"
  },
  {
    instruction: `Read the visible daily budget for campaign ${campaign}; scroll only if needed and do not edit it`,
    target: `${campaign} budget`,
    expectedResult: "the campaign budget is visibly readable",
    riskLevel: "interact",
    permission: "INTERACT",
    allowedActions: readScrollActions,
    region: "table"
  },
  {
    instruction: `Read the visible bid strategy or bid target for campaign ${campaign}; scroll only if needed and do not edit it`,
    target: `${campaign} bid target`,
    expectedResult: "the bid strategy or target is visibly readable",
    riskLevel: "interact",
    permission: "INTERACT",
    allowedActions: readScrollActions,
    region: "table"
  },
  {
    instruction: "Open the visible Goals or Conversions page using navigation; do not edit a goal",
    target: "Goals and conversions navigation",
    expectedResult: "conversion goals are visibly listed",
    riskLevel: "interact",
    permission: "INTERACT",
    allowedActions: navigationActions,
    region: "left-navigation"
  },
  {
    instruction: "Take final evidence and stop. Do not click Save, Apply, Publish, Remove, or Delete",
    target: "read-only completion",
    expectedResult: "Google Ads remains visible with no mutation confirmation",
    riskLevel: "observe",
    permission: "OBSERVE",
    allowedActions: observeActions
  }
] as const;

const prepareSteps = [
  {
    instruction: `The user has focused the visible daily budget input for ${campaign}. Replace only its draft value with ${draftBudget}; do not click or press Enter`,
    target: "daily budget input",
    expectedResult: `the unsaved draft budget visibly shows ${draftBudget}`,
    riskLevel: "interact",
    permission: "INTERACT",
    allowedActions: ["type", "fail"] as const,
    allowedText: draftBudget!
  },
  {
    instruction: "Inspect only. Confirm the draft remains unsubmitted and stop",
    target: "unsubmitted budget draft",
    expectedResult: `the draft budget ${draftBudget} is visible and no success confirmation is present`,
    riskLevel: "observe",
    permission: "OBSERVE",
    allowedActions: ["done", "fail", "screenshot"] as const
  }
] as const;

const steps = mode === "readonly" ? readonlySteps : prepareSteps;
for (let index = 0; index < steps.length; index += 1) {
  const step = steps[index]!;
  const { instruction, target, expectedResult } = step;
  const taskId = crypto.randomUUID();
  let task: VisualMicroTask = {
    clientId,
    taskId,
    stepId: `${mode}-${String(index + 1).padStart(2, "0")}`,
    platform: "google_ads",
    instruction,
    target,
    expectedResult,
    riskLevel: step.riskLevel,
    permission: step.permission,
    allowedActions: [...step.allowedActions],
    ...("allowedText" in step ? { allowedText: step.allowedText } : {}),
    retryPolicy: "none",
    surface: taskSurface
  };
  const startedAt = Date.now();
  let capturedBefore: Screenshot | undefined;
  let beforeEvidence: Awaited<ReturnType<typeof persistScreenshot>> | undefined;
  let capturedAfter: Screenshot | undefined;
  let afterEvidence: Awaited<ReturnType<typeof persistScreenshot>> | undefined;
  try {
    const initialScreenshot = await system.computer.captureForTask(task);
    capturedBefore = initialScreenshot;
    if ("region" in step) {
      task = {
        ...task,
        allowedRegion: validationRegion(step.region, initialScreenshot)
      };
    }
    beforeEvidence = await persistScreenshot(artifactRoot, task.stepId!, "before", initialScreenshot);
    const result = await system.tools.executeVisualTask(
      { clientId, taskId, actor: "google_ads_validation", permission: task.permission },
      task,
      initialScreenshot
    );
    const confirmation = result.status === "done"
      ? await system.computer.verifyVisible(expectedResult, task)
      : undefined;
    capturedAfter = confirmation?.screenshot;
    afterEvidence = capturedAfter
      ? await persistScreenshot(artifactRoot, task.stepId!, "after", capturedAfter)
      : undefined;
    const events = currentTaskEvents(system.events.history(clientId), taskId);
    const safeEvents = events.map(({ event }) => publicRuntimeEvent(event));
    const executedActions = events.flatMap(({ event }) =>
      event.type === "executed" && event.action ? [event.action] : []
    );
    const executedTargets = executedActions.map((action) => action.target);
    if (executedTargets.some((target) => /save|apply|publish|remove|delete|提交|保存|应用|发布|删除/i.test(target))) {
      throw new Error(`submission guard tripped on forbidden target: ${executedTargets.join(", ")}`);
    }
    if (executedActions.some((action) => action.action === "hotkey")) {
      throw new Error("submission guard tripped on a hotkey action");
    }
    const rawLastAction = result.status === "done" ? result.action : result.lastAction;
    if (rawLastAction && (
      (rawLastAction.action === "hotkey" && /enter|return/i.test(rawLastAction.keys)) ||
      (rawLastAction.action === "type" && /[\r\n]/.test(rawLastAction.text))
    )) {
      throw new Error("submission guard tripped on Enter/Return input");
    }
    const stepPassed = result.status === "done"
      && confirmation?.matched === true
      && confirmation.confidence >= confirmationMinimumConfidence;
    records.push(RealBrowserValidationRecord.parse({
      index: index + 1,
      task: publicValidationTask(task),
      stepPassed,
      result: publicVisualResult(
        result,
        beforeEvidence,
        afterEvidence,
        confirmation
          ? {
              matched: confirmation.matched,
              confidence: confirmation.confidence,
              minimumConfidence: confirmationMinimumConfidence,
              reason: confirmation.reason
            }
          : undefined
      ),
      evidence: {
        before: screenshotEvidence(initialScreenshot, beforeEvidence),
        ...(confirmation && afterEvidence
          ? { after: screenshotEvidence(confirmation.screenshot, afterEvidence) }
          : {})
      },
      latencyMs: Date.now() - startedAt,
      events: safeEvents
    }));
    if (!stepPassed) break;
  } catch (caught) {
    records.push(RealBrowserValidationRecord.parse({
      index: index + 1,
      task: publicValidationTask(task),
      stepPassed: false,
      result: {
        status: "error",
        message: caught instanceof Error ? caught.message : String(caught)
      },
      evidence: {
        ...(capturedBefore && beforeEvidence
          ? { before: screenshotEvidence(capturedBefore, beforeEvidence) }
          : {}),
        ...(capturedAfter && afterEvidence
          ? { after: screenshotEvidence(capturedAfter, afterEvidence) }
          : {})
      },
      latencyMs: Date.now() - startedAt,
      events: currentTaskEvents(system.events.history(clientId), taskId).flatMap(({ event }) => {
        try {
          return [publicRuntimeEvent(event)];
        } catch {
          return [];
        }
      })
    }));
    break;
  }
}

const passed = records.length === steps.length && records.every((record) => record.stepPassed === true);
const failures = records.flatMap((record) => {
  if (record.stepPassed) return [];
  const reason = record.result.status === "error"
    ? record.result.message
    : record.result.status === "failed"
      ? record.result.blocker
      : !record.result.confirmation.matched
        ? record.result.confirmation.reason
        : `visual confirmation confidence ${record.result.confirmation.confidence} is below ${confirmationMinimumConfidence}`;
  return [{ index: record.index, stepId: record.task.stepId, reason }];
});
const manifest = RealBrowserValidationManifest.parse({
  schemaVersion: 2,
  runId,
  mode,
  passed,
  safety: {
    domAutomation: false,
    submitAllowed: false,
    mutationsAllowed: false,
    confirmationMinimumConfidence,
    exactPrepareTextBound: mode === "prepare",
    coordinateActionsRegionBound: true,
    prepareActionAllowlist: mode === "prepare" ? [["type", "fail"], ["done", "fail", "screenshot"]] : null,
    prepareRetryPolicy: mode === "prepare" ? "none" : null
  },
  clientId,
  accountRef: account.accountRef,
  browserProfile,
  browserSession: publicBrowserSession(session),
  initialSurface: publicSurfaceIdentity(live),
  accountFingerprint: {
    status: "not-created",
    reason: "This harness never prepares or executes a mutation approval; it does not fabricate a mutation-grade account fingerprint."
  },
  screenshotPrivacyAudits: (await system.screenshotAudits.list(clientId)).filter((audit) => records.some((record) => record.task && (record.task as VisualMicroTask).taskId === audit.taskId)),
  models: system.modelStatus,
  tokenUsage: null,
  tokenUsageNote: "The configured provider did not expose per-request usage through the visual runtime interface.",
  startedAt,
  completedAt: new Date().toISOString(),
  failures,
  records
});
await writeFile(resolve(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600
});
console.log(JSON.stringify({ passed, mode, stepsCompleted: records.length, artifactRoot }, null, 2));
if (!passed) process.exitCode = 2;

function currentTaskEvents(
  events: ProductEvent[],
  taskId: string
): Array<Extract<ProductEvent, { type: "computer" }>> {
  return events.filter(
    (event): event is Extract<ProductEvent, { type: "computer" }> =>
      event.type === "computer" && event.taskId === taskId
  );
}

function validationRegion(
  kind: "left-navigation" | "top-toolbar" | "date-menu" | "table",
  screenshot: Screenshot
) {
  const regions = {
    "left-navigation": { x: 0, y: 0, width: 0.4, height: 1 },
    "top-toolbar": { x: 0.4, y: 0, width: 0.6, height: 0.4 },
    "date-menu": { x: 0.25, y: 0.05, width: 0.75, height: 0.85 },
    table: { x: 0.12, y: 0.15, width: 0.88, height: 0.8 }
  } as const;
  const region = regions[kind];
  const x = Math.floor(screenshot.width * region.x);
  const y = Math.floor(screenshot.height * region.y);
  return {
    x,
    y,
    width: Math.max(1, Math.min(screenshot.width - x, Math.floor(screenshot.width * region.width))),
    height: Math.max(1, Math.min(screenshot.height - y, Math.floor(screenshot.height * region.height))),
    coordinateSpace: "screenshot_pixels" as const
  };
}

async function persistScreenshot(
  artifactRoot: string,
  stepId: string,
  phase: "before" | "after",
  screenshot: Screenshot
): Promise<{ file: string; sha256: string }> {
  const filename = `${String(++screenshotIndex).padStart(3, "0")}-${stepId}-${phase}.png`;
  const bytes = Buffer.from(screenshot.base64, "base64");
  await writeFile(resolve(artifactRoot, filename), bytes, {
    mode: 0o600
  });
  return {
    file: filename,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}
