import { getCopy, type AppLocale } from "./i18n.js";

type ApprovalValue = string | number | boolean | null;

export type ExecutionPlan = {
  platform: string;
  browserProfile: string;
  applicationId: string;
  applicationName: string;
  windowId: string;
  domain: string | null;
  allowedApplications: string[];
  allowedDomains: string[];
  accountName: string;
  accountId: string;
  campaignName: string;
  campaignId: string;
  pageType: string;
  instruction: string;
  target: string;
  expectedResult: string;
  allowedRegion: { x: number; y: number; width: number; height: number; coordinateSpace: "screenshot_pixels" | "screen_points" };
  riskLevel: string;
  surfaceFingerprint: string;
  accountFingerprint: string;
  createdAt: string;
  expiresAt: string;
};

export type Approval = {
  id: string;
  taskId: string;
  status: string;
  executionPlan: ExecutionPlan | null;
  executionPlanFingerprint: string | null;
  guardrailFingerprint: string | null;
  guardrail: {
    decision: { allowed: boolean; changePercent: number; cappedValue: number; reasons: string[]; requiresFreshReview: boolean };
    evidenceFactIds: string[];
    singleVariable: boolean;
    operationFingerprint: string;
    evaluatedAt: string;
  } | null;
  operation: {
    platform?: string;
    account: string;
    campaign: string;
    operation: string;
    currentValue: ApprovalValue;
    proposedValue: ApprovalValue;
    changePercentage: number | null;
    reason: string;
    evidence: string[];
    expectedImpact: string;
    observationWindow: string;
    rollbackCondition: string;
    riskLevel: string;
  };
};

export type ApprovalDisclosureEntry = { label: string; value: string; fullValue?: string; mono?: boolean };
export type ApprovalDisclosureSection = { title: string; entries: ApprovalDisclosureEntry[] };

export function approvalDisclosure(approval: Approval, locale: AppLocale): ApprovalDisclosureSection[] {
  const copy = getCopy(locale);
  const plan = approval.executionPlan;
  const missingPlan = copy.notBound;
  const unavailable = copy.notAvailable;
  const boolean = (value: boolean) => value ? copy.yes : copy.no;
  const entry = (label: string, value: string, mono = false): ApprovalDisclosureEntry => ({ label, value, fullValue: value, mono });
  const fingerprint = (label: string, value: string | null): ApprovalDisclosureEntry => value
    ? { label, value: abbreviatedFingerprint(value), fullValue: value, mono: true }
    : entry(label, unavailable, true);
  const list = (values: string[] | undefined, empty = unavailable) => values?.length ? values.join(" · ") : empty;

  return [
    {
      title: copy.approvalScope,
      entries: [
        entry(copy.platform, formatPlatform(plan?.platform ?? approval.operation.platform, locale) ?? unavailable),
        entry(copy.browserConfiguration, plan?.browserProfile ?? missingPlan, true),
        entry(copy.nativeApplication, plan ? plan.applicationName : missingPlan),
        entry(copy.applicationId, plan?.applicationId ?? missingPlan, true),
        entry(copy.windowId, plan?.windowId ?? missingPlan, true),
        entry(copy.domain, plan?.domain ?? unavailable, true),
        entry(copy.allowedApplications, plan ? list(plan.allowedApplications) : missingPlan, true),
        entry(copy.allowedDomains, plan ? list(plan.allowedDomains) : missingPlan, true),
        entry(copy.pageType, plan ? formatPageType(plan.pageType, locale) : missingPlan, true),
        entry(copy.accountName, plan?.accountName ?? approval.operation.account),
        entry(copy.accountId, plan?.accountId ?? missingPlan, true),
        entry(copy.campaignName, plan?.campaignName ?? approval.operation.campaign),
        entry(copy.campaignId, plan?.campaignId ?? missingPlan, true),
        entry(copy.originalInstruction, plan?.instruction ?? missingPlan),
        entry(copy.targetControl, plan?.target ?? missingPlan),
        entry(copy.expectedResult, plan?.expectedResult ?? approval.operation.expectedImpact),
        entry(copy.allowedRegion, plan ? formatRegion(plan.allowedRegion, locale) : missingPlan, true),
        entry(copy.riskLevel, formatRisk(plan?.riskLevel ?? approval.operation.riskLevel, locale), true),
        entry(copy.validFrom, plan ? formatDate(plan.createdAt, locale) : missingPlan, true),
        entry(copy.expiresAt, plan ? formatDate(plan.expiresAt, locale) : missingPlan, true)
      ]
    },
    {
      title: copy.approvalBinding,
      entries: [
        fingerprint(copy.surfaceFingerprint, plan?.surfaceFingerprint ?? null),
        fingerprint(copy.accountFingerprint, plan?.accountFingerprint ?? null),
        fingerprint(copy.guardrailFingerprint, approval.guardrailFingerprint),
        fingerprint(copy.executionPlanFingerprint, approval.executionPlanFingerprint)
      ]
    },
    {
      title: copy.approvalGuardrail,
      entries: [
        entry(copy.guardrailAllowed, approval.guardrail ? boolean(approval.guardrail.decision.allowed) : unavailable),
        entry(copy.freshReviewRequired, approval.guardrail ? boolean(approval.guardrail.decision.requiresFreshReview) : unavailable),
        entry(copy.cappedValue, approval.guardrail ? String(approval.guardrail.decision.cappedValue) : unavailable, true),
        entry(copy.guardrailChangePercent, approval.guardrail ? `${approval.guardrail.decision.changePercent}%` : unavailable, true),
        entry(copy.singleVariable, approval.guardrail ? boolean(approval.guardrail.singleVariable) : unavailable),
        entry(copy.guardrailReasons, approval.guardrail ? list(approval.guardrail.decision.reasons.map((reason) => formatGuardrailReason(reason, locale)), copy.none) : unavailable),
        entry(copy.evidenceFactIds, approval.guardrail ? list(approval.guardrail.evidenceFactIds) : unavailable, true),
        entry(copy.guardrailEvaluatedAt, approval.guardrail ? formatDate(approval.guardrail.evaluatedAt, locale) : unavailable, true),
        fingerprint(copy.guardrailOperationFingerprint, approval.guardrail?.operationFingerprint ?? null)
      ]
    }
  ];
}

export function abbreviatedFingerprint(value: string): string {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function formatRegion(region: ExecutionPlan["allowedRegion"], locale: AppLocale): string {
  const coordinateSpace = locale === "zh-CN"
    ? region.coordinateSpace === "screenshot_pixels" ? "截图像素" : "屏幕点"
    : region.coordinateSpace === "screenshot_pixels" ? "screenshot pixels" : "screen points";
  return `${region.x}, ${region.y} · ${region.width} × ${region.height} ${coordinateSpace}`;
}

function formatPlatform(value: string | undefined, locale: AppLocale): string | undefined {
  if (!value) return undefined;
  const labels: Record<string, string> = {
    google_ads: "Google Ads", meta_ads: "Meta Ads", tiktok_ads: "TikTok Ads", apple_ads: "Apple Ads",
    microsoft_ads: "Microsoft Ads", amazon_ads: "Amazon Ads", linkedin_ads: "LinkedIn Ads", youtube_ads: "YouTube Ads",
    other: locale === "zh-CN" ? "其他" : "Other"
  };
  return labels[value] ?? value;
}

function formatRisk(value: string, locale: AppLocale): string {
  const labels = locale === "zh-CN"
    ? { observe: "只读", interact: "交互", mutate: "修改", destructive: "破坏性操作" }
    : { observe: "Observe", interact: "Interact", mutate: "Mutate", destructive: "Destructive" };
  return labels[value as keyof typeof labels] ?? value;
}

function formatPageType(value: string, locale: AppLocale): string {
  const zh: Record<string, string> = {
    campaign_budget_editor: "广告系列预算编辑器",
    campaign_settings: "广告系列设置",
    campaign_table: "广告系列表格",
    account_settings: "账户设置"
  };
  if (locale === "zh-CN") return zh[value] ?? value;
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatGuardrailReason(value: string, locale: AppLocale): string {
  if (locale !== "zh-CN") return value;
  return ({
    "measurement reliability blocks optimization": "测量可靠性不足，禁止优化",
    "data is not mature": "数据尚未成熟",
    "campaign is in a learning phase": "广告系列仍处于学习期",
    "single-variable experiment guardrail blocks variable stacking": "单变量实验护栏禁止叠加变量"
  } as Record<string, string>)[value] ?? value;
}

function formatDate(value: string, locale: AppLocale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium", hour12: false }).format(date);
}
