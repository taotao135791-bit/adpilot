import { describe, expect, it } from "vitest";
import { abbreviatedFingerprint, approvalDisclosure, type Approval } from "./approvalDisclosure.js";

const fingerprint = "a".repeat(64);
const approval: Approval = {
  id: "approval-1", taskId: "task-1", status: "pending_user",
  executionPlanFingerprint: "b".repeat(64), guardrailFingerprint: "c".repeat(64),
  executionPlan: {
    platform: "google_ads", browserProfile: "ads-work", applicationId: "com.google.Chrome", applicationName: "Google Chrome", windowId: "42", domain: "ads.google.com",
    allowedApplications: ["com.google.Chrome"], allowedDomains: ["ads.google.com"], accountName: "Northwind", accountId: "123-456", campaignName: "Summer", campaignId: "789", pageType: "campaign_settings",
    instruction: "Raise the daily budget to 110", target: "Daily budget input and Save", expectedResult: "The daily budget reads 110", allowedRegion: { x: 10, y: 20, width: 300, height: 120, coordinateSpace: "screenshot_pixels" }, riskLevel: "mutate",
    surfaceFingerprint: fingerprint, accountFingerprint: "d".repeat(64), createdAt: "2026-07-22T00:00:00.000Z", expiresAt: "2026-07-22T00:05:00.000Z"
  },
  guardrail: { decision: { allowed: true, changePercent: 10, cappedValue: 110, reasons: ["Within 20% cap"], requiresFreshReview: false }, evidenceFactIds: ["fact-spend", "fact-cpa"], singleVariable: true, operationFingerprint: "e".repeat(64), evaluatedAt: "2026-07-22T00:00:00.000Z" },
  operation: { platform: "google_ads", account: "Northwind", campaign: "Summer", operation: "update_daily_budget", currentValue: 100, proposedValue: 110, changePercentage: 10, reason: "Test", evidence: ["fact-spend"], expectedImpact: "More volume", observationWindow: "7 days", rollbackCondition: "CPA rises", riskLevel: "mutate" }
};

describe("approval disclosure", () => {
  it("discloses the complete plan binding and deterministic guardrail facts in English", () => {
    const sections = approvalDisclosure(approval, "en");
    const labels = sections.flatMap((section) => section.entries.map((entry) => entry.label));
    expect(sections.map((section) => section.title)).toEqual(["Authorized scope & identity", "Execution binding", "Deterministic guardrail evidence"]);
    expect(labels).toEqual(expect.arrayContaining(["Platform", "Browser configuration", "Page type", "Account name", "Account ID", "Campaign name", "Campaign ID", "Original instruction", "Target control", "Expected result", "Allowed region", "Risk level", "Expires at", "Surface fingerprint", "Account fingerprint", "Guardrail fingerprint", "Guardrail allows", "Evidence fact IDs", "Guardrail operation fingerprint"]));
    expect(sections[2]?.entries.find((entry) => entry.label === "Evidence fact IDs")?.value).toBe("fact-spend · fact-cpa");
    expect(sections[1]?.entries[0]).toMatchObject({ value: `${"a".repeat(12)}…${"a".repeat(8)}`, fullValue: fingerprint, mono: true });
  });

  it("uses strict Chinese labels and exposes unbound plan fields instead of inventing values", () => {
    const unbound = { ...approval, executionPlan: null, executionPlanFingerprint: null, guardrail: null, guardrailFingerprint: null };
    const sections = approvalDisclosure(unbound, "zh-CN");
    expect(sections.map((section) => section.title)).toEqual(["授权范围与身份", "执行绑定", "确定性护栏证明"]);
    expect(sections[0]?.entries.find((entry) => entry.label === "账户标识")?.value).toBe("未绑定到完整执行计划");
    expect(sections[2]?.entries.find((entry) => entry.label === "证据事实标识")?.value).toBe("不可用");
  });

  it("keeps a readable fingerprint excerpt while retaining the full value for assistive presentation", () => {
    expect(abbreviatedFingerprint(fingerprint)).toBe(`${"a".repeat(12)}…${"a".repeat(8)}`);
  });
});
