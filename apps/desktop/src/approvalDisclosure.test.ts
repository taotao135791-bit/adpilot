import { describe, expect, it } from "vitest";
import { abbreviatedFingerprint, approvalDisclosure, type Approval } from "./approvalDisclosure.js";

const fingerprint = "a".repeat(64);
const approval: Approval = {
  schemaVersion: 2, id: "approval-1", clientId: "client-1", taskId: "task-1", status: "pending_user",
  executionPlanFingerprint: "b".repeat(64), guardrailFingerprint: "c".repeat(64),
  executionPlan: {
    schemaVersion: 1, planId: "plan-1", taskId: "task-1", clientId: "client-1", platform: "google_ads", browserProfile: "ads-work", applicationId: "com.google.Chrome", applicationName: "Google Chrome", windowId: "42", domain: "ads.google.com",
    allowedApplications: ["com.google.Chrome"], allowedDomains: ["ads.google.com"], accountName: "Northwind", accountId: "123-456", campaignName: "Summer", campaignId: "789", pageType: "campaign_settings",
    operation: "update_daily_budget", currentValue: 100, proposedValue: 110, instruction: "Raise the daily budget to 110", target: "Daily budget input and Save", expectedResult: "The daily budget reads 110", allowedRegion: { x: 10, y: 20, width: 300, height: 120, coordinateSpace: "screenshot_pixels" }, riskLevel: "mutate",
    surfaceFingerprint: fingerprint, accountFingerprint: "d".repeat(64), createdAt: "2026-07-22T00:00:00.000Z", expiresAt: "2026-07-22T00:05:00.000Z"
  },
  guardrail: { decision: { allowed: true, changePercent: 10, cappedValue: 110, reasons: ["Within 20% cap"], requiresFreshReview: false }, evidenceFactIds: ["fact-spend", "fact-cpa"], singleVariable: true, operationFingerprint: "e".repeat(64), evaluatedAt: "2026-07-22T00:00:00.000Z" },
  operation: { platform: "google_ads", account: "Northwind", campaign: "Summer", operation: "update_daily_budget", currentValue: 100, proposedValue: 110, changePercentage: 10, reason: "Test", evidence: ["fact-spend"], expectedImpact: "More volume", observationWindow: "7 days", rollbackCondition: "CPA rises", riskLevel: "mutate" }
};

describe("approval disclosure", () => {
  it("discloses the complete plan binding and deterministic guardrail facts in English", () => {
    const sections = approvalDisclosure(approval, "en");
    const labels = sections.flatMap((section) => section.entries.map((entry) => entry.label));
    expect(sections.map((section) => section.title)).toEqual(["Authorized scope & identity", "Operation basis", "Execution binding", "Deterministic guardrail evidence"]);
    expect(labels).toEqual(expect.arrayContaining(["Approval schema version", "Approval ID", "Client ID", "Task ID", "Execution plan schema version", "Execution plan ID", "Execution plan task ID", "Execution plan client ID", "Platform", "Operation", "Current", "Proposed", "Browser configuration", "Page type", "Account name", "Account ID", "Campaign name", "Campaign ID", "Original instruction", "Target control", "Expected result", "Allowed region", "Risk level", "Expires at", "Change percentage", "Change rationale", "Evidence", "Expected impact", "Observation window", "Rollback condition", "Surface fingerprint", "Account fingerprint", "Guardrail fingerprint", "Guardrail allows", "Evidence fact IDs", "Guardrail operation fingerprint"]));
    expect(sections[0]?.entries).toEqual(expect.arrayContaining([
      { label: "Approval schema version", value: "2", fullValue: "2", mono: true },
      { label: "Approval ID", value: "approval-1", fullValue: "approval-1", mono: true },
      { label: "Client ID", value: "client-1", fullValue: "client-1", mono: true },
      { label: "Task ID", value: "task-1", fullValue: "task-1", mono: true },
      { label: "Execution plan schema version", value: "1", fullValue: "1", mono: true },
      { label: "Execution plan ID", value: "plan-1", fullValue: "plan-1", mono: true },
      { label: "Execution plan task ID", value: "task-1", fullValue: "task-1", mono: true },
      { label: "Execution plan client ID", value: "client-1", fullValue: "client-1", mono: true },
      { label: "Operation", value: "Update daily budget", fullValue: "Update daily budget", mono: true },
      { label: "Current", value: "100", fullValue: "100", mono: true },
      { label: "Proposed", value: "110", fullValue: "110", mono: true }
    ]));
    expect(sections[1]?.entries).toEqual(expect.arrayContaining([
      { label: "Change percentage", value: "+10%", fullValue: "+10%", mono: true },
      { label: "Change rationale", value: "Test", fullValue: "Test", mono: false },
      { label: "Evidence", value: "fact-spend", fullValue: "fact-spend", mono: true },
      { label: "Expected impact", value: "More volume", fullValue: "More volume", mono: false },
      { label: "Observation window", value: "7 days", fullValue: "7 days", mono: false },
      { label: "Rollback condition", value: "CPA rises", fullValue: "CPA rises", mono: false }
    ]));
    expect(sections[3]?.entries.find((entry) => entry.label === "Evidence fact IDs")?.value).toBe("fact-spend · fact-cpa");
    expect(sections[2]?.entries[0]).toMatchObject({ value: `${"a".repeat(12)}…${"a".repeat(8)}`, fullValue: fingerprint, mono: true });
  });

  it("uses strict Chinese labels and exposes unbound plan fields instead of inventing values", () => {
    const unbound = { ...approval, executionPlan: null, executionPlanFingerprint: null, guardrail: null, guardrailFingerprint: null };
    const sections = approvalDisclosure(unbound, "zh-CN");
    expect(sections.map((section) => section.title)).toEqual(["授权范围与身份", "操作依据", "执行绑定", "确定性护栏证明"]);
    expect(sections[0]?.entries.find((entry) => entry.label === "账户标识")?.value).toBe("未绑定到完整执行计划");
    expect(sections[3]?.entries.find((entry) => entry.label === "证据事实标识")?.value).toBe("不可用");
    expect(sections[1]?.entries).toEqual(expect.arrayContaining([
      { label: "变更比例", value: "+10%", fullValue: "+10%", mono: true },
      { label: "变更原因", value: "Test", fullValue: "Test", mono: false },
      { label: "依据与证据", value: "fact-spend", fullValue: "fact-spend", mono: true },
      { label: "预期影响", value: "More volume", fullValue: "More volume", mono: false },
      { label: "观察窗口", value: "7 days", fullValue: "7 days", mono: false },
      { label: "回滚条件", value: "CPA rises", fullValue: "CPA rises", mono: false }
    ]));
  });

  it("localizes known guardrail reasons and never exposes an unknown internal reason", () => {
    const unknownReason = {
      ...approval,
      guardrail: { ...approval.guardrail!, decision: { ...approval.guardrail!.decision, reasons: ["internal_evaluator_exception: trace-123"] } }
    };
    const zhReason = approvalDisclosure(unknownReason, "zh-CN")[3]?.entries.find((entry) => entry.label === "护栏判定依据")?.value;
    const enReason = approvalDisclosure(unknownReason, "en")[3]?.entries.find((entry) => entry.label === "Guardrail reasons")?.value;
    expect(zhReason).toBe("护栏未提供可展示的判定依据");
    expect(enReason).toBe("No displayable guardrail rationale is available");
  });

  it("keeps a readable fingerprint excerpt while retaining the full value for assistive presentation", () => {
    expect(abbreviatedFingerprint(fingerprint)).toBe(`${"a".repeat(12)}…${"a".repeat(8)}`);
  });
});
