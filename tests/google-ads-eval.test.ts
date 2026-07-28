import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyHarnessBlocker,
  evaluateGoogleAds,
  parseGoogleAdsEvalArguments
} from "../scripts/run-google-ads-eval.js";

const roots: string[] = [];
const now = new Date("2026-07-28T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Google Ads evaluation command", () => {
  it("returns structured blocked output with null rates when no test target is named", async () => {
    const report = await evaluateGoogleAds(
      parseGoogleAdsEvalArguments("readonly", []),
      { now }
    );

    expect(report.status).toBe("blocked-by-no-test-account");
    expect(report.metrics.runs).toBe(0);
    expect(report.metrics.successRate).toBeNull();
    expect(report.execution).toEqual({
      fixtureUsed: false,
      liveModelCalled: false,
      realBrowserUsed: false,
      nativeInputExecuted: false,
      mutationExecuted: false
    });
  });

  it("keeps target selection explicit and rejects duplicate or unsafe flags", () => {
    expect(() => parseGoogleAdsEvalArguments("readonly", [
      "--client", "test",
      "--client", "production"
    ])).toThrow("only once");
    expect(() => parseGoogleAdsEvalArguments("readonly", [
      "--allow-test-mutation"
    ])).toThrow("only for mutation");
    expect(() => parseGoogleAdsEvalArguments("mutation", [
      "--mystery", "value"
    ])).toThrow("unknown");
  });

  it("classifies missing permissions, credentials, test accounts and sessions separately", () => {
    expect(classifyHarnessBlocker("Screen Recording permission denied")).toBe("blocked-by-permission");
    expect(classifyHarnessBlocker("Computer Use is not ready; connect an image-capable model")).toBe("blocked-by-missing-credentials");
    expect(classifyHarnessBlocker("client demo has no google_ads account bound")).toBe("blocked-by-no-test-account");
    expect(classifyHarnessBlocker("managed browser is not connected")).toBe("not-run");
    expect(classifyHarnessBlocker("unexpected verifier response")).toBe("failed");
  });

  it("reports a simulated real-browser run without mixing it with fixture evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-google-eval-"));
    roots.push(root);
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      failures: [],
      records: [{
        events: [
          { type: "grounded", action: { action: "click" } },
          { type: "executed", action: { action: "click" } },
          { type: "verified", matched: true }
        ]
      }]
    }));
    const report = await evaluateGoogleAds(
      fullOptions("readonly"),
      {
        now,
        runHarness: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ passed: true, artifactRoot: root }),
          stderr: ""
        })
      }
    );

    expect(report.status).toBe("passed");
    expect(report.evidenceClass).toBe("real-browser-readonly");
    expect(report.execution).toMatchObject({
      fixtureUsed: false,
      liveModelCalled: true,
      realBrowserUsed: true,
      nativeInputExecuted: true,
      mutationExecuted: false
    });
    expect(report.metrics).toMatchObject({
      runs: 1,
      successRate: 1,
      actionAttempts: 1,
      actionSuccessRate: 1
    });
  });

  it("counts a blocked grounded native proposal as an action attempt, not a success", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-google-eval-"));
    roots.push(root);
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      failures: [{ reason: "Accessibility permission denied" }],
      records: [{
        events: [
          { type: "grounded", action: { action: "click" } },
          { type: "blocked" }
        ]
      }]
    }));
    const report = await evaluateGoogleAds(
      fullOptions("readonly"),
      {
        now,
        runHarness: async () => ({
          exitCode: 2,
          stdout: JSON.stringify({ passed: false, artifactRoot: root }),
          stderr: ""
        })
      }
    );

    expect(report.status).toBe("blocked-by-permission");
    expect(report.metrics).toMatchObject({
      runs: 1,
      blockedRuns: 1,
      actionAttempts: 1,
      successfulActions: 0,
      actionSuccessRate: 0
    });
  });

  it("blocks mutation unless opt-in and a fresh bound approval are both present", async () => {
    const withoutOptIn = await evaluateGoogleAds(fullOptions("mutation"), { now });
    expect(withoutOptIn.status).toBe("blocked-by-permission");
    expect(withoutOptIn.blockers[0]?.code).toBe("EXPLICIT_MUTATION_OPT_IN_REQUIRED");

    const withOptIn = fullOptions("mutation");
    withOptIn.mutationOptIn = true;
    const withoutApproval = await evaluateGoogleAds(withOptIn, { now });
    expect(withoutApproval.status).toBe("blocked-by-permission");
    expect(withoutApproval.execution.mutationExecuted).toBe(false);
  });

  it("executes one exact pending approval only through the injected production commit path", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-google-approval-"));
    roots.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const approvalPath = join(root, "approval.json");
    await writeFile(approvalPath, JSON.stringify({
      schema: "AdPilotGoogleAdsTestMutationApproval",
      schemaVersion: 1,
      approvalId: "161c363c-c75b-4a72-adcc-e55aab08c997",
      approvedBy: "test-operator",
      issuedAt: "2026-07-28T09:58:00.000Z",
      expiresAt: "2026-07-28T10:03:00.000Z",
      singleUse: true,
      productSessionId: "37801a20-aa4f-48ed-ab72-aa4f36addb70",
      clientId: "client-test",
      testAccount: "customer-test-123",
      browserProfile: "isolated-test-profile",
      campaign: "P0 Safety Campaign",
      campaignId: "campaign-test-456",
      field: "set_daily_budget",
      oldValue: "100",
      newValue: "101"
    }), { mode: 0o600 });
    const options = fullOptions("mutation");
    options.mutationOptIn = true;
    options.values.set("--approval-file", approvalPath);
    const executeMutation = vi.fn(async () => ({
      status: "passed" as const,
      nativeInputExecuted: true,
      mutationExecuted: true,
      persistenceVerified: true,
      actionAttempts: 1,
      successfulActions: 1,
      verificationAttempts: 2,
      successfulVerifications: 2
    }));

    const report = await evaluateGoogleAds(options, { now, executeMutation });

    expect(executeMutation).toHaveBeenCalledTimes(1);
    expect(report.status).toBe("passed");
    expect(report.metrics.runs).toBe(1);
    expect(report.metrics.successRate).toBe(1);
    expect(report.execution.mutationExecuted).toBe(true);
  });

  it("never retries or claims success when refreshed persistence proof is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-google-approval-"));
    roots.push(root);
    const approvalPath = join(root, "approval.json");
    await writeFile(approvalPath, JSON.stringify(approvalMaterial()), { mode: 0o600 });
    const options = fullOptions("mutation");
    options.mutationOptIn = true;
    options.values.set("--approval-file", approvalPath);
    const executeMutation = vi.fn(async () => ({
      status: "failed" as const,
      nativeInputExecuted: true,
      mutationExecuted: true,
      persistenceVerified: false,
      actionAttempts: 1,
      successfulActions: 1,
      verificationAttempts: 2,
      successfulVerifications: 1,
      reason: "refresh could not prove the exact value"
    }));

    const report = await evaluateGoogleAds(options, { now, executeMutation });

    expect(executeMutation).toHaveBeenCalledTimes(1);
    expect(report.status).toBe("failed");
    expect(report.blockers[0]?.code).toBe("MUTATION_OUTCOME_UNKNOWN");
    expect(report.execution.mutationExecuted).toBe(true);
  });
});

function fullOptions(mode: "readonly" | "prepare" | "mutation") {
  return parseGoogleAdsEvalArguments(mode, [
    "--client", "client-test",
    "--test-account", "customer-test-123",
    "--browser-profile", "isolated-test-profile",
    "--campaign", "P0 Safety Campaign",
    ...(mode === "prepare" ? ["--draft-budget", "101"] : []),
    ...(mode === "mutation"
      ? [
          "--product-session-id", "37801a20-aa4f-48ed-ab72-aa4f36addb70",
          "--approval-id", "161c363c-c75b-4a72-adcc-e55aab08c997",
          "--campaign-id", "campaign-test-456",
          "--field", "set_daily_budget",
          "--old-value", "100",
          "--new-value", "101"
        ]
      : [])
  ]);
}

function approvalMaterial() {
  return {
    schema: "AdPilotGoogleAdsTestMutationApproval",
    schemaVersion: 1,
    approvalId: "161c363c-c75b-4a72-adcc-e55aab08c997",
    approvedBy: "test-operator",
    issuedAt: "2026-07-28T09:58:00.000Z",
    expiresAt: "2026-07-28T10:03:00.000Z",
    singleUse: true,
    productSessionId: "37801a20-aa4f-48ed-ab72-aa4f36addb70",
    clientId: "client-test",
    testAccount: "customer-test-123",
    browserProfile: "isolated-test-profile",
    campaign: "P0 Safety Campaign",
    campaignId: "campaign-test-456",
    field: "set_daily_budget",
    oldValue: "100",
    newValue: "101"
  };
}
