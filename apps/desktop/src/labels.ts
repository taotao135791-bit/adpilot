/**
 * Single source of truth for every user-facing string in the desktop app:
 * console copy, settings copy, computer-use copy, and all enum label
 * localizers. Pure module — no React, no fetch — so it stays trivially
 * testable and tree-shakeable.
 */

import {
  describeCron,
  interpolate,
  type AutomationTrigger,
  type BriefSectionKey,
  type BriefSeverity,
  type CronDescription,
  type DecisionConfidence,
  type DecisionStatus
} from "./workspace.js";

export type AppLocale = "zh-CN" | "en";

/* ------------------------------------------------------------------ */
/* Console copy                                                        */
/* ------------------------------------------------------------------ */

const zh = {
  boot: "正在载入工作台",
  brandLine: "广告优化工作台",
  workspace: "工作区",
  newWorkspace: "新建工作区…",
  createWorkspaceTitle: "新建工作区",
  workspaceIdLabel: "标识(小写字母/数字/连字符)",
  workspaceNameLabel: "名称",
  workspaceKpiLabel: "KPI 目标",
  createAction: "创建",
  dismissTask: "关闭此任务",
  noWorkspace: "尚无工作区",
  systemsNominal: "系统正常",
  groundingOffline: "视觉模型离线",
  conversationReady: "对话已就绪",
  modelRequired: "连接模型后即可对话",
  settings: "设置",
  themeToggle: "切换深浅色",
  navigation: "产品导航",
  mission: "任务",
  tests: "实验",
  review: "审批",
  ledger: "审计",
  retry: "重试",
  loadError: "无法读取产品状态",
  settingsLoadError: "无法读取设置，请重试",
  connectionError: "实时连接已断开，正在自动重连",
  taskError: "任务执行失败",
  riskError: "风险复核失败",
  approvalError: "审批失败",
  executionError: "执行失败",
  activeMission: "当前任务",
  preparingEvidence: "正在整理证据和下一步行动。",
  evidenceSteps: "证据步骤",
  blockers: "阻塞项",
  operator: "负责人",
  reviewWindow: "复查时间",
  unscheduled: "待确定",
  system: "系统",
  agent: "AdPilot 智能体",
  investigating: "正在调查账户事实并调度专业智能体",
  directive: "任务指令",
  launchHint: "Enter 发送 · Shift + Enter 换行 · 输入 / 使用命令",
  goalPlaceholder: "描述目标、症状和不可改变的业务约束…",
  goalLabel: "任务目标",
  investigatingShort: "调查中",
  launch: "启动调查",
  send: "发送",
  configureModel: "配置模型",
  you: "你",
  liveOperations: "实时",
  executionStack: "运行状态",
  computer: "电脑控制",
  live: "运行中",
  paused: "已暂停",
  takeover: "用户接管",
  cancelled: "已取消",
  computerUnavailable: "电脑控制不可用",
  screenshotAlt: "广告后台最新操作画面",
  visualChannel: "视觉通道",
  awaitingSignal: "等待任务信号",
  modelNotConfigured: "所选代码模型不支持图像或缺少凭据",
  chatEmptyHint: "输入消息开始对话，或从左侧选择已有会话。",
  currentMicroTask: "当前微任务",
  standby: "待命",
  oneAction: "每次只执行一个经过验证的视觉动作",
  pause: "暂停",
  takeOver: "接管",
  resume: "恢复",
  returnControl: "归还控制",
  stepComputer: "单步",
  stepUnavailable: "仅在安全运行时拥有待执行原子动作时可用",
  stopComputer: "停止",
  openFullView: "打开实时画面",
  closeFullView: "关闭实时画面",
  replayFrame: "回看上一帧",
  returnLive: "返回实时",
  liveFrameUnavailable: "暂时无法获取真实画面",
  noManagedBrowser: "请先在设置中启动并绑定专属浏览器",
  currentApplication: "当前应用",
  currentWindow: "当前窗口",
  currentUrl: "当前网址",
  currentProfile: "浏览器配置",
  controlOwner: "控制方",
  actionIsolation: "动作隔离",
  exactWindowBound: "已锁定此应用与窗口",
  agentControl: "AdPilot",
  userControl: "用户",
  framePrivacy: "画面仅来自当前绑定窗口；鼠标动作只能落在此窗口内，切换应用会立即停止",
  agentNetwork: "智能体网络",
  coordinatorReady: "协调智能体已就绪",
  specialistsAttached: "专业智能体已加入当前任务",
  waitingDirective: "等待任务指令",
  fast: "快速模型",
  deep: "深度模型",
  vision: "截图模型",
  visionPlus: "视觉复核",
  unassigned: "未配置",
  unsupported: "当前模型不支持",
  approvalGate: "审批门",
  approvalDisclosure: "授权披露",
  approvalScope: "授权范围与身份",
  approvalOperationBasis: "操作依据",
  approvalBinding: "执行绑定",
  approvalGuardrail: "确定性护栏证明",
  platform: "平台",
  approvalSchemaVersion: "审批架构版本",
  approvalId: "审批标识",
  clientId: "客户标识",
  taskId: "任务标识",
  executionPlanSchemaVersion: "执行计划架构版本",
  executionPlanId: "执行计划标识",
  executionPlanTaskId: "执行计划任务标识",
  executionPlanClientId: "执行计划客户标识",
  browserConfiguration: "浏览器配置",
  browserProfile: "浏览器配置文件",
  nativeApplication: "原生应用",
  applicationId: "应用标识",
  windowId: "窗口标识",
  domain: "域名",
  allowedApplications: "允许的应用",
  allowedDomains: "允许的域名",
  pageType: "页面类型",
  accountName: "账户名称",
  accountId: "账户标识",
  campaignName: "广告系列名称",
  campaignId: "广告系列标识",
  operation: "操作",
  originalInstruction: "原始指令",
  targetControl: "目标控件",
  expectedResult: "期望结果",
  allowedRegion: "允许区域",
  riskLevel: "风险级别",
  validFrom: "生效时间",
  expiresAt: "有效期至",
  surfaceFingerprint: "界面指纹",
  accountFingerprint: "账户指纹",
  guardrailFingerprint: "护栏指纹",
  executionPlanFingerprint: "执行计划指纹",
  guardrailAllowed: "护栏允许",
  freshReviewRequired: "需要重新复核",
  cappedValue: "护栏上限值",
  guardrailChangePercent: "护栏变更比例",
  singleVariable: "单变量变更",
  guardrailReasons: "护栏判定依据",
  evidenceFactIds: "证据事实标识",
  guardrailEvaluatedAt: "护栏评估时间",
  guardrailOperationFingerprint: "护栏操作指纹",
  guardrailReasonUnavailable: "护栏未提供可展示的判定依据",
  changePercentage: "变更比例",
  reason: "变更原因",
  evidence: "依据与证据",
  expectedImpact: "预期影响",
  observationWindow: "观察窗口",
  rollbackCondition: "回滚条件",
  notBound: "未绑定到完整执行计划",
  notAvailable: "不可用",
  none: "无",
  yes: "是",
  no: "否",
  current: "当前值",
  proposed: "建议值",
  runRisk: "运行独立风险复核",
  approveOnce: "批准一次性执行",
  executeApproved: "执行已批准操作",
  missingPlan: "缺少执行计划",
  gateClear: "暂无待审批操作",
  gateClearBody: "真实账户操作会在执行前出现在这里。",
  experiments: "实验",
  noTests: "暂无进行中的实验",
  noTestsBody: "获批操作会成为单变量实验。",
  auditTrace: "审计轨迹",
  tracePristine: "暂无审计记录",
  traceBody: "每个关键动作都会留下不可跳过的记录。",
  heroBody: "把症状交给 AdPilot。它会核验测量、调度专业智能体，并在任何真实修改前停在审批门口。",
  autonomy: "受控\n自治",
  workspaceReady: "工作区",
  connected: "已连接",
  required: "需要配置",
  ready: "已就绪",
  offline: "离线",
  safetyGate: "安全门",
  enforced: "已启用",
  conversation: "会话",
  forkHere: "从此分叉",
  forkError: "会话分叉失败",
  commands: "斜杠命令",
  alert: "监控告警",
  alertMetrics: "绑定 {count} 个已验证指标",
  details: "详情",
  collapse: "收起",
  technicalDetails: "技术细节",
  pendingApprovals: "待审批",
  jumpToApproval: "定位到最早待审批的卡片",
  experimentsCommand: "/experiments",
  auditCommand: "/audit-trail",
  recordsTotal: "共 {count} 条",
  modelBannerBody: "连接对话模型后即可开始任务；模型路由在设置中配置。",
  planMode: "计划模式",
  planModeReadOnly: "计划模式 · 只读",
  planModeHint: "只读探索：自由调查并产出编号计划，不做任何修改；关闭后计划走正常审批链执行",
  planModePlaceholder: "计划模式：描述要调查的问题，先产出编号计划，不做任何修改…",
  planModeError: "切换计划模式失败",
  newChat: "新建对话",
  primaryConversation: "主会话",
  searchSessions: "搜索会话",
  clearSearch: "清除搜索",
  pinnedGroup: "已置顶",
  archivedGroup: "已归档",
  archiveSession: "归档",
  deleteSession: "删除会话",
  deleteSessionConfirm: "删除这个会话？",
  deleteSessionYes: "删除",
  restoreSession: "恢复",
  renameSession: "重命名",
  pinSession: "置顶",
  unpinSession: "取消置顶",
  emptySessions: "还没有会话",
  ungroupedSessions: "未分组",
  noSessionMatches: "没有匹配的会话",
  untitledSession: "未命名会话",
  sessionConflict: "会话已在别处更新，列表已刷新",
  sessionActionError: "会话操作失败",
  collapseSidebar: "收起侧栏",
  expandSidebar: "展开侧栏",
  emptyTitle: "今天优化什么？",
  insertCommand: "插入斜杠命令",
  autonomyGuarded: "守护",
  autonomyFull: "完全访问",
  autonomyHint: "执行权限：守护模式下真实账户修改必须经审批门；完全访问允许直接执行",
  autonomyError: "切换自主权模式失败",
  modelChipHint: "当前日常模型 · 点击打开模型设置"
} as const;

const en: Record<keyof typeof zh, string> = {
  boot: "Loading your workspace",
  brandLine: "Advertising workspace",
  workspace: "Workspace",
  newWorkspace: "New workspace…",
  createWorkspaceTitle: "New workspace",
  workspaceIdLabel: "ID (lowercase letters, digits, hyphens)",
  workspaceNameLabel: "Name",
  workspaceKpiLabel: "KPI target",
  createAction: "Create",
  dismissTask: "Dismiss this task",
  noWorkspace: "No workspace",
  systemsNominal: "Systems nominal",
  groundingOffline: "Vision model offline",
  conversationReady: "Chat ready",
  modelRequired: "Connect a model to start chatting",
  settings: "Settings",
  themeToggle: "Toggle theme",
  navigation: "Product navigation",
  mission: "Mission",
  tests: "Tests",
  review: "Review",
  ledger: "Ledger",
  retry: "Retry",
  loadError: "Could not load product state",
  settingsLoadError: "Could not load settings. Please retry",
  connectionError: "Live connection lost. Reconnecting automatically",
  taskError: "Investigation failed",
  riskError: "Risk review failed",
  approvalError: "Approval failed",
  executionError: "Execution failed",
  activeMission: "Active mission",
  preparingEvidence: "Organizing evidence and the next action.",
  evidenceSteps: "Evidence steps",
  blockers: "Blockers",
  operator: "Operator",
  reviewWindow: "Review window",
  unscheduled: "Unscheduled",
  system: "System",
  agent: "AdPilot agent",
  investigating: "Investigating account facts and assigning specialists",
  directive: "Directive",
  launchHint: "Enter to send · Shift + Enter for a newline · type / for commands",
  goalPlaceholder: "Describe the goal, symptoms, and fixed business constraints…",
  goalLabel: "Mission directive",
  investigatingShort: "Investigating",
  launch: "Start investigation",
  send: "Send",
  configureModel: "Configure model",
  you: "You",
  liveOperations: "Live",
  executionStack: "Run status",
  computer: "Computer",
  live: "Live",
  paused: "Paused",
  takeover: "Takeover",
  cancelled: "Cancelled",
  computerUnavailable: "Computer control unavailable",
  screenshotAlt: "Latest advertising console view",
  visualChannel: "Visual channel",
  awaitingSignal: "Awaiting mission signal",
  modelNotConfigured: "Selected code models lack vision or credentials",
  chatEmptyHint: "Type a message to start, or pick a session on the left.",
  currentMicroTask: "Current micro-task",
  standby: "Standby",
  oneAction: "One verified visual action at a time",
  pause: "Pause",
  takeOver: "Take over",
  resume: "Resume",
  returnControl: "Return control",
  stepComputer: "Step",
  stepUnavailable: "Available only when the safe runtime has one queued atomic action",
  stopComputer: "Stop",
  openFullView: "Open Live View",
  closeFullView: "Close Live View",
  replayFrame: "Previous frame",
  returnLive: "Return live",
  liveFrameUnavailable: "A fresh native frame is temporarily unavailable",
  noManagedBrowser: "Start and bind a dedicated browser in Settings first",
  currentApplication: "Current app",
  currentWindow: "Current window",
  currentUrl: "Current URL",
  currentProfile: "Browser Profile",
  controlOwner: "Control",
  actionIsolation: "Action isolation",
  exactWindowBound: "Locked to this app and window",
  agentControl: "AdPilot",
  userControl: "User",
  framePrivacy: "Only the bound window is shown; pointer actions stay inside it and stop on an app switch",
  agentNetwork: "Agent network",
  coordinatorReady: "Coordinator ready",
  specialistsAttached: "Specialists are attached to this mission",
  waitingDirective: "Waiting for a directive",
  fast: "Fast",
  deep: "Deep",
  vision: "Screenshot model",
  visionPlus: "Visual review",
  unassigned: "Unassigned",
  unsupported: "Not supported by selected model",
  approvalGate: "Approval gate",
  approvalDisclosure: "Approval disclosure",
  approvalScope: "Authorized scope & identity",
  approvalOperationBasis: "Operation basis",
  approvalBinding: "Execution binding",
  approvalGuardrail: "Deterministic guardrail evidence",
  platform: "Platform",
  approvalSchemaVersion: "Approval schema version",
  approvalId: "Approval ID",
  clientId: "Client ID",
  taskId: "Task ID",
  executionPlanSchemaVersion: "Execution plan schema version",
  executionPlanId: "Execution plan ID",
  executionPlanTaskId: "Execution plan task ID",
  executionPlanClientId: "Execution plan client ID",
  browserConfiguration: "Browser configuration",
  browserProfile: "Browser Profile",
  nativeApplication: "Native application",
  applicationId: "Application ID",
  windowId: "Window ID",
  domain: "Domain",
  allowedApplications: "Allowed applications",
  allowedDomains: "Allowed domains",
  pageType: "Page type",
  accountName: "Account name",
  accountId: "Account ID",
  campaignName: "Campaign name",
  campaignId: "Campaign ID",
  operation: "Operation",
  originalInstruction: "Original instruction",
  targetControl: "Target control",
  expectedResult: "Expected result",
  allowedRegion: "Allowed region",
  riskLevel: "Risk level",
  validFrom: "Valid from",
  expiresAt: "Expires at",
  surfaceFingerprint: "Surface fingerprint",
  accountFingerprint: "Account fingerprint",
  guardrailFingerprint: "Guardrail fingerprint",
  executionPlanFingerprint: "Execution plan fingerprint",
  guardrailAllowed: "Guardrail allows",
  freshReviewRequired: "Fresh review required",
  cappedValue: "Guardrail capped value",
  guardrailChangePercent: "Guardrail change percent",
  singleVariable: "Single-variable change",
  guardrailReasons: "Guardrail reasons",
  evidenceFactIds: "Evidence fact IDs",
  guardrailEvaluatedAt: "Guardrail evaluated at",
  guardrailOperationFingerprint: "Guardrail operation fingerprint",
  guardrailReasonUnavailable: "No displayable guardrail rationale is available",
  changePercentage: "Change percentage",
  reason: "Change rationale",
  evidence: "Evidence",
  expectedImpact: "Expected impact",
  observationWindow: "Observation window",
  rollbackCondition: "Rollback condition",
  notBound: "Not bound to a complete execution plan",
  notAvailable: "Not available",
  none: "None",
  yes: "Yes",
  no: "No",
  current: "Current",
  proposed: "Proposed",
  runRisk: "Run independent risk review",
  approveOnce: "Approve one-time execution",
  executeApproved: "Execute approved operation",
  missingPlan: "Execution plan missing",
  gateClear: "Gate is clear",
  gateClearBody: "Live account changes will appear here before execution.",
  experiments: "Experiments",
  noTests: "No active tests",
  noTestsBody: "Approved operations become single-variable experiments.",
  auditTrace: "Audit trace",
  tracePristine: "No audit events",
  traceBody: "Every critical action leaves a mandatory record.",
  heroBody: "Give AdPilot the symptom. It verifies measurement, assigns specialists, and stops at the approval gate before any live change.",
  autonomy: "Controlled\nautonomy",
  workspaceReady: "Workspace",
  connected: "Connected",
  required: "Required",
  ready: "Ready",
  offline: "Offline",
  safetyGate: "Safety gate",
  enforced: "Enforced",
  conversation: "Conversation",
  forkHere: "Fork from here",
  forkError: "Could not fork the conversation",
  commands: "Slash commands",
  alert: "Monitoring alert",
  alertMetrics: "{count} verified metric(s) bound",
  details: "Details",
  collapse: "Collapse",
  technicalDetails: "Technical details",
  pendingApprovals: "Pending approvals",
  jumpToApproval: "Jump to the oldest pending approval card",
  experimentsCommand: "/experiments",
  auditCommand: "/audit-trail",
  recordsTotal: "{count} total",
  modelBannerBody: "Connect a chat model to start a mission. Model routing lives in Settings.",
  planMode: "Plan mode",
  planModeReadOnly: "Plan mode · read-only",
  planModeHint: "Read-only exploration: investigate freely and draft a numbered plan; disable to execute it through the normal approval chain",
  planModePlaceholder: "Plan mode: describe what to investigate and get a numbered plan — nothing changes…",
  planModeError: "Could not switch plan mode",
  newChat: "New conversation",
  primaryConversation: "Primary",
  searchSessions: "Search conversations",
  clearSearch: "Clear search",
  pinnedGroup: "Pinned",
  archivedGroup: "Archived",
  archiveSession: "Archive",
  deleteSession: "Delete conversation",
  deleteSessionConfirm: "Delete this conversation?",
  deleteSessionYes: "Delete",
  restoreSession: "Restore",
  renameSession: "Rename",
  pinSession: "Pin",
  unpinSession: "Unpin",
  emptySessions: "No conversations yet",
  ungroupedSessions: "Ungrouped",
  noSessionMatches: "No conversations match",
  untitledSession: "Untitled session",
  sessionConflict: "This session changed elsewhere; the list was refreshed",
  sessionActionError: "Session action failed",
  collapseSidebar: "Collapse sidebar",
  expandSidebar: "Expand sidebar",
  emptyTitle: "What are we optimizing today?",
  insertCommand: "Insert a slash command",
  autonomyGuarded: "Guarded",
  autonomyFull: "Full access",
  autonomyHint: "Execution permission: Guarded routes every live account change through the approval gate; Full access allows direct execution",
  autonomyError: "Could not switch autonomy mode",
  modelChipHint: "Current daily model · click to open model settings"
};

export type ConsoleCopy = { readonly [K in keyof typeof zh]: string };

export function getCopy(locale: AppLocale): ConsoleCopy {
  return locale === "zh-CN" ? zh : en;
}

/* ------------------------------------------------------------------ */
/* Enum label localizers (console)                                     */
/* ------------------------------------------------------------------ */

export function alertSeverityLabel(severity: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { info: "提示", warning: "警告", critical: "严重" };
  const enLabels: Record<string, string> = { info: "Info", warning: "Warning", critical: "Critical" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[severity] ?? humanize(severity);
}

/** Sidebar status-dot accessible label for a product Session run status. */
export function sessionStatusLabel(status: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { idle: "空闲", queued: "排队中", running: "运行中", waiting_for_approval: "待审批", paused: "已暂停", failed: "失败", completed: "已完成", deleted: "已删除" };
  const enLabels: Record<string, string> = { idle: "Idle", queued: "Queued", running: "Running", waiting_for_approval: "Waiting for approval", paused: "Paused", failed: "Failed", completed: "Completed", deleted: "Deleted" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[status] ?? humanize(status);
}

export function alertKindLabel(kind: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { budget_overspend: "预算超支", kpi_anomaly: "KPI 异常", learning_phase_complete: "学习期结束", measurement_broken: "测量中断", creative_fatigue: "素材疲劳", pacing_anomaly: "消耗节奏异常", tracking_outage: "追踪中断", other: "其他" };
  const enLabels: Record<string, string> = { budget_overspend: "Budget overspend", kpi_anomaly: "KPI anomaly", learning_phase_complete: "Learning phase complete", measurement_broken: "Measurement broken", creative_fatigue: "Creative fatigue", pacing_anomaly: "Pacing anomaly", tracking_outage: "Tracking outage", other: "Other" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[kind] ?? humanize(kind);
}

export function alertDeliveryLabel(status: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { injected: "已注入会话", pending: "待投递", rate_limited: "已限流", deduplicated: "已去重", delivered: "已投递", requeued: "已重新排队" };
  const enLabels: Record<string, string> = { injected: "Injected", pending: "Pending", rate_limited: "Rate limited", deduplicated: "Deduplicated", delivered: "Delivered", requeued: "Requeued" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[status] ?? humanize(status);
}

export function roleLabel(role: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { adpilot_agent: "AdPilot 智能体", account_operator: "账户操作员", performance_analyst: "效果分析师", media_buyer: "媒介投手", measurement_reviewer: "测量复核员", creative_strategist: "创意策略师", risk_reviewer: "风险复核员" };
  const enLabels: Record<string, string> = { adpilot_agent: "AdPilot agent", account_operator: "Account operator", performance_analyst: "Performance analyst", media_buyer: "Media buyer", measurement_reviewer: "Measurement reviewer", creative_strategist: "Creative strategist", risk_reviewer: "Risk reviewer" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[role] ?? role;
}

export function phaseLabel(phase: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { intake: "接收目标", investigating: "调查中", analyzing: "分析中", reviewing_risk: "风险复核", awaiting_approval: "等待审批", executing: "执行中", verifying: "验证中", monitoring: "观察中", completed: "已完成", blocked: "已阻塞", cancelled: "已取消" };
  const enLabels: Record<string, string> = { intake: "Intake", investigating: "Investigating", analyzing: "Analyzing", reviewing_risk: "Risk review", awaiting_approval: "Awaiting approval", executing: "Executing", verifying: "Verifying", monitoring: "Monitoring", completed: "Completed", blocked: "Blocked", cancelled: "Cancelled" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[phase] ?? phase;
}

export function approvalStatusLabel(status: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { pending_risk_review: "等待风险复核", rejected: "已拒绝", pending_user: "等待用户批准", approved: "已批准", executing: "执行中", executed: "已执行", failed: "失败", expired: "已过期", cancelled: "已取消" };
  const enLabels: Record<string, string> = { pending_risk_review: "Pending risk review", rejected: "Rejected", pending_user: "Pending user approval", approved: "Approved", executing: "Executing", executed: "Executed", failed: "Failed", expired: "Expired", cancelled: "Cancelled" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[status] ?? (locale === "zh-CN" ? "未知状态" : humanize(status));
}

export function experimentStatusLabel(status: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { draft: "草稿", active: "进行中", waiting: "等待数据", won: "胜出", lost: "未胜出", inconclusive: "结论不足", stopped: "已停止", invalidated: "已失效" };
  const enLabels: Record<string, string> = { draft: "Draft", active: "Active", waiting: "Waiting for data", won: "Won", lost: "Lost", inconclusive: "Inconclusive", stopped: "Stopped", invalidated: "Invalidated" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[status] ?? (locale === "zh-CN" ? "未知状态" : humanize(status));
}

export function operationLabel(operation: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { set_daily_budget: "设置每日预算", update_daily_budget: "更新每日预算", update_campaign_budget: "更新广告系列预算", update_target_cpa: "更新目标 CPA", pause_campaign: "暂停广告系列", resume_campaign: "恢复广告系列" };
  const enLabels: Record<string, string> = { set_daily_budget: "Set daily budget", update_daily_budget: "Update daily budget", update_campaign_budget: "Update campaign budget", update_target_cpa: "Update target CPA", pause_campaign: "Pause campaign", resume_campaign: "Resume campaign" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[operation] ?? (locale === "zh-CN" ? "自定义账户操作" : humanize(operation));
}

export function variableLabel(variable: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { daily_budget: "每日预算" };
  const enLabels: Record<string, string> = { daily_budget: "Daily budget" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[variable] ?? (locale === "zh-CN" ? "自定义实验变量" : humanize(variable));
}

export function auditActionLabel(action: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { read_workspace: "读取工作区", analyze_performance: "分析投放效果", evaluate_change_guardrail: "评估变更护栏", create_approval: "创建审批", write_experiment: "写入实验", execute_visual_task: "执行视觉任务", capture_screen: "捕获画面", click: "点击" };
  const enLabels: Record<string, string> = { read_workspace: "Read workspace", analyze_performance: "Analyze performance", evaluate_change_guardrail: "Evaluate change guardrail", create_approval: "Create approval", write_experiment: "Write experiment", execute_visual_task: "Execute visual task", capture_screen: "Capture screen", click: "Click" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[action] ?? (locale === "zh-CN" ? "系统操作" : humanize(action));
}

export function visualActionLabel(action: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { click: "点击", type: "输入", scroll: "滚动", press_key: "按键", wait: "等待", done: "完成", fail: "失败" };
  const enLabels: Record<string, string> = { click: "Click", type: "Type", scroll: "Scroll", press_key: "Press key", wait: "Wait", done: "Done", fail: "Failed" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[action] ?? (locale === "zh-CN" ? "视觉操作" : humanize(action));
}

export function nextStepLabel(step: string, locale: AppLocale): string {
  const zhLabels: Record<string, string> = { "Build an evidence-driven investigation tree": "建立证据驱动的调查树", "Dispatch specialists and collect evidence": "调度专业智能体并收集证据", "Resolve the recorded blocker and retry": "解决已记录的阻塞项并重试" };
  return locale === "zh-CN" ? zhLabels[step] ?? step : step;
}

export function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

/** Tone mapping shared by Badge-like status renderers. */
export type StatusTone = "accent" | "success" | "warning" | "danger";

export function phaseTone(phase: string): StatusTone {
  if (phase === "completed") return "success";
  if (phase === "blocked" || phase === "cancelled") return "danger";
  if (phase === "awaiting_approval") return "warning";
  return "accent";
}

export function approvalStatusTone(status: string): StatusTone {
  if (status === "rejected" || status === "failed") return "danger";
  if (status === "executed") return "success";
  if (status === "pending_user" || status === "pending_risk_review" || status === "approved") return "warning";
  return "accent";
}

export function riskLevelTone(riskLevel: string): StatusTone {
  if (riskLevel === "destructive") return "danger";
  if (riskLevel === "mutate") return "warning";
  return "accent";
}

export function alertSeverityTone(severity: string): StatusTone {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  return "accent";
}

/* ------------------------------------------------------------------ */
/* Time formatting                                                     */
/* ------------------------------------------------------------------ */

export function formatTime(value: string, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function formatDateTime(value: string, locale: AppLocale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/* ------------------------------------------------------------------ */
/* Settings copy                                                       */
/* ------------------------------------------------------------------ */

const settingsZh = {
  title: "设置", close: "关闭设置", navigation: "设置导航", general: "通用", models: "模型", permissions: "权限", computer: "电脑控制", about: "关于", connections: "已配置连接", loading: "正在读取安全配置", loadingFailed: "无法读取设置", retry: "重试",
  generalTitle: "语言与外观", generalBody: "界面在任一时刻只使用一种语言。产品名和模型名保持原名。", language: "界面语言", languageHint: "应用到操作台和设置页", appearance: "显示模式", appearanceHint: "选择深色、浅色或跟随系统", dark: "深色", light: "浅色", system: "跟随系统", localeRule: "保存后界面会立即切换；模型配置需要重启运行时。",
  modelsTitle: "模型", modelsBody: "只需配置一个模型即可使用全部能力；支持看图的代码模型会自动作为电脑控制的视觉模型。", fastRoute: "模型", fastHint: "对话、分析与执行共用的模型", strongRoute: "深度模型", strongHint: "因果分析、风险复核与失败升级",
  dualModel: "为深度角色单独配置模型", dualModelHint: "默认所有角色共用上面同一个模型", reasoningTitle: "思考模式", reasoningBody: "为支持的模型开启推理强度；不支持的模型会自动忽略。", reasoningEffort: "推理强度", reasoningScope: "作用范围", effortOff: "关闭", effortLow: "低", effortMedium: "中", effortHigh: "高", scopeStrong: "仅深度角色", scopeAll: "全部角色", reasoningUnsupported: "当前所选模型不支持思考模式，保存后不会生效。",
  runtimeRoutes: "运行时", runtimeRoutesTitle: "当前生效的模型路由",
  providerConnection: "供应商连接", credentials: "凭据", providers: "个供应商", provider: "供应商", model: "模型", visionCapability: "视觉", apiKey: "API 密钥", modelsCount: "个模型", noStaticModels: "该供应商使用动态模型目录，首次认证后获取。",
  oauthTitle: "订阅账户登录", oauthBody: "通过 Pi 的原生授权流程连接订阅账户；访问令牌只保存在本机工作区。", oauthConnected: "OAuth 已连接", connect: "连接账户", connecting: "连接中", disconnect: "断开连接", openAuthorization: "请在浏览器中完成授权。", openBrowser: "打开浏览器", deviceCode: "在授权页面输入此代码", choose: "请选择", continue: "继续", oauthWaiting: "正在等待授权供应商响应。", oauthSelectPrompt: "请选择授权账户。", oauthCodePrompt: "请输入授权页面显示的代码。", oauthSecretPrompt: "请输入授权流程要求的安全值。", oauthInputPrompt: "请输入授权流程要求的信息。", oauthInputPlaceholder: "在此输入", oauthComplete: "授权完成，重启后即可使用。", oauthFailed: "OAuth 授权失败",
  permissionsTitle: "权限中心", permissionsBody: "检查真正持有 macOS 权限的进程，并运行无副作用的能力测试。",
  computerTitle: "电脑控制", computerBody: "使用日常与深度代码模型完成看图、定位和复核。专用视觉端点属于可选的高级设置。", computerNote: "系统每次只执行一个可校验动作。账户修改仍需要实时窗口绑定、独立身份校验、风险复核和一次性批准。", showAdvanced: "显示高级开发者设置", hideAdvanced: "收起高级开发者设置",
  visualPrimary: "截图与动作", visualReview: "结果复核", chatStatus: "自然语言对话", visionStatus: "电脑控制", ready: "已就绪", needsCredential: "需要供应商凭据", needsVision: "请选择支持图像且已认证的代码模型",
  aboutTitle: "系统清单", aboutBody: "本地优先、证据驱动、审批后执行的广告优化智能体。", runtime: "主运行时", visualRuntime: "视觉执行", strategyCore: "广告策略核心", providersAvailable: "可用供应商", legal: "真实账户修改需要独立风险复核、用户批准和一次性执行令牌。完整许可证随应用分发。", localStorage: "配置保存在本机工作区，不会通过设置接口返回密钥明文。",
  save: "保存配置", saving: "正在保存", saved: "配置已保存；模型路由将在重启后生效。", saveFailed: "保存配置失败", reloadFailed: "无法重新读取配置", restartNow: "立即重启", restartManual: "请关闭并重新启动 AdPilot"
} as const;

const settingsEn: Record<keyof typeof settingsZh, string> = {
  title: "Settings", close: "Close settings", navigation: "Settings navigation", general: "General", models: "Models", permissions: "Permissions", computer: "Computer use", about: "About", connections: "Configured connections", loading: "Loading secure settings", loadingFailed: "Could not load settings", retry: "Retry",
  generalTitle: "Language and appearance", generalBody: "The interface uses one language at a time. Product and model names retain their proper names.", language: "Interface language", languageHint: "Applies to the console and settings", appearance: "Appearance", appearanceHint: "Choose dark, light, or system mode", dark: "Dark", light: "Light", system: "System", localeRule: "The interface changes immediately after saving. Model settings require a runtime restart.",
  modelsTitle: "Models", modelsBody: "One model covers every capability. Image-capable code models automatically become the Computer Use vision models.", fastRoute: "Model", fastHint: "Shared by conversation, analysis, and execution", strongRoute: "Deep model", strongHint: "Causal analysis, risk review, and failure escalation",
  dualModel: "Use a separate model for the deep role", dualModelHint: "Off: every role shares the model above", reasoningTitle: "Thinking mode", reasoningBody: "Set a reasoning effort for models that support it; unsupported models ignore it quietly.", reasoningEffort: "Reasoning effort", reasoningScope: "Applies to", effortOff: "Off", effortLow: "Low", effortMedium: "Medium", effortHigh: "High", scopeStrong: "Deep role only", scopeAll: "All roles", reasoningUnsupported: "The selected model does not support thinking mode; this setting will have no effect.",
  runtimeRoutes: "Runtime", runtimeRoutesTitle: "Effective model routing",
  providerConnection: "Provider connection", credentials: "Credentials", providers: "providers", provider: "Provider", model: "Model", visionCapability: "vision", apiKey: "API key", modelsCount: "models", noStaticModels: "This provider uses a dynamic model catalog fetched after authentication.",
  oauthTitle: "Subscription login", oauthBody: "Connect a subscription account through Pi's native authorization flow. Tokens remain in the local workspace.", oauthConnected: "OAuth connected", connect: "Connect account", connecting: "Connecting", disconnect: "Disconnect", openAuthorization: "Complete authorization in your browser.", openBrowser: "Open browser", deviceCode: "Enter this code on the authorization page", choose: "Choose an option", continue: "Continue", oauthWaiting: "Waiting for the provider to continue authorization.", oauthSelectPrompt: "Choose the account to authorize.", oauthCodePrompt: "Enter the code shown on the authorization page.", oauthSecretPrompt: "Enter the secure value requested by the authorization flow.", oauthInputPrompt: "Enter the information requested by the authorization flow.", oauthInputPlaceholder: "Enter here", oauthComplete: "Authorization complete. Restart to use this connection.", oauthFailed: "OAuth authorization failed",
  permissionsTitle: "Permission Center", permissionsBody: "Inspect the process that actually owns each macOS capability and run side-effect-free tests.",
  computerTitle: "Computer use", computerBody: "Daily and Deep code models handle screenshots, grounding, and verification. Dedicated vision endpoints are optional advanced settings.", computerNote: "AdPilot performs one verifiable action at a time. Account changes still require live-window binding, independent identity checks, risk review, and one-time approval.", showAdvanced: "Show advanced developer settings", hideAdvanced: "Hide advanced developer settings",
  visualPrimary: "Screenshot and action", visualReview: "Result verification", chatStatus: "Natural-language chat", visionStatus: "Computer use", ready: "Ready", needsCredential: "Provider credentials required", needsVision: "Select and authenticate an image-capable code model",
  aboutTitle: "System manifest", aboutBody: "A local-first, evidence-led advertising agent that acts only after approval.", runtime: "Primary runtime", visualRuntime: "Visual execution", strategyCore: "Advertising core", providersAvailable: "Available providers", legal: "Live account changes require independent risk review, user approval, and a one-time execution token. Complete license files ship with the application.", localStorage: "Settings stay in the local workspace. Secret values are never returned by the settings API.",
  save: "Save settings", saving: "Saving", saved: "Settings saved. Model routing takes effect after restart.", saveFailed: "Could not save settings", reloadFailed: "Could not reload settings", restartNow: "Restart now", restartManual: "Close and relaunch AdPilot"
};

export type SettingsCopy = { readonly [K in keyof typeof settingsZh]: string };

export function settingsCopy(locale: AppLocale): SettingsCopy {
  return locale === "zh-CN" ? settingsZh : settingsEn;
}

/* ------------------------------------------------------------------ */
/* Computer-use copy                                                   */
/* ------------------------------------------------------------------ */

const computerZh = {
  ready: "系统就绪", needsSetup: "需要配置", readyTitle: "电脑控制已就绪", setupTitle: "电脑控制尚未就绪",
  visionHint: "无需专门的视觉模型：在模型配置里选一个带「视觉」标记的代码模型（日常或深度，可两个 Provider），保存并重启后即自动启用定位与校验链路。",
  permission: "当前权限", activePrivacy: "生效中的隐私模式", localOnly: "仅本机", masked: "最小化传输",
  modelRoute: "自动模型路由", modelRouteBody: "系统按任务难度与失败次数自动选择模型。", automatic: "自动",
  dailyModel: "日常对话模型", deepModel: "深度推理模型", groundingModel: "界面定位模型", verificationModel: "独立校验模型",
  privacyMode: "截图隐私", privacyBody: "完整截图始终保存在本机；模型只能接收经过裁剪和遮挡的区域。",
  maskedBody: "允许向远程模型发送经过裁剪和遮挡的必要区域。", localOnlyBody: "禁止截图离开本机；远程视觉请求会被阻止。", restartPrivacy: "保存并重启后，新的隐私模式才会应用到运行时。",
  managedBrowser: "受管浏览器", managedBrowserBody: "AdPilot 使用隔离的浏览器配置档案。登录由你在浏览器中手动完成。", refreshBrowser: "刷新浏览器会话", refresh: "刷新",
  noWorkspace: "尚未选择工作区", noWorkspaceBody: "选择一个客户工作区后才能管理浏览器会话和查看截图审计。", loadingBrowser: "正在读取浏览器会话", browserLoadFailed: "无法读取浏览器会话。", browserActionFailed: "浏览器操作失败。", retry: "重试",
  browserClosed: "浏览器会话尚未启动", browserLoginBody: "启动后请在新浏览器窗口中手动登录。AdPilot 不读取密码或登录存储。", browserProfile: "浏览器配置档案", automaticProfile: "使用工作区绑定配置", optionalProfile: "可选：指定配置档案名称", browserProfileHint: "留空时使用客户工作区中唯一的账户绑定。",
  startBrowser: "启动浏览器", startingBrowser: "正在启动", resumeBrowser: "恢复原会话", resumingBrowser: "正在恢复", closeBrowser: "关闭会话", closingBrowser: "正在关闭",
  browserLostBody: "原进程或窗口绑定不再可信。系统不会自动接管其他窗口。", browserStartingBody: "正在等待受管浏览器窗口完成绑定。", browserConnectedBody: "进程、窗口和配置档案已绑定。每次操作前都会重新检查。", browserLostReason: "浏览器身份校验失败。请将原窗口置于前台后恢复，或关闭会话后重新启动。",
  application: "应用", platform: "广告平台", process: "进程号", window: "窗口号", bounds: "窗口尺寸", lastChecked: "最近校验", runtime: "运行平台", notAvailable: "不可用",
  screenshotAudits: "最近模型截图审计", screenshotAuditsBody: "仅显示元数据，不显示或上传本机保存的完整截图。", refreshAudits: "刷新截图审计", loadingAudits: "正在读取截图审计", auditLoadFailed: "无法读取截图审计。", noAuditWorkspace: "尚无审计范围", noAudits: "暂无模型截图记录", noAuditsBody: "当电脑控制模型首次接收安全区域后，审计记录会显示在这里。",
  roi: "发送区域", masks: "遮挡数量", disclosure: "数据去向", outcome: "处理结果", sentMinimized: "已发送安全区域", stayedLocal: "未离开本机", blocked: "已阻止", prepared: "已准备", fullScreenshotLocal: "完整截图仅保存在本机工作区"
} as const;

const computerEn: Record<keyof typeof computerZh, string> = {
  ready: "System ready", needsSetup: "Setup required", readyTitle: "Computer use is ready", setupTitle: "Computer use is not ready",
  visionHint: "No dedicated vision model needed: pick any code model flagged “vision” in model settings (daily or deep role — two providers are fine), save and restart, and grounding plus verification come up automatically.",
  permission: "Current permission", activePrivacy: "Active privacy mode", localOnly: "Local only", masked: "Minimized transfer",
  modelRoute: "Automatic model routing", modelRouteBody: "AdPilot selects a model from task complexity and previous failures.", automatic: "Automatic",
  dailyModel: "Daily conversation model", deepModel: "Deep reasoning model", groundingModel: "GUI grounding model", verificationModel: "Independent verifier",
  privacyMode: "Screenshot privacy", privacyBody: "Full screenshots always stay local. Models receive only cropped and masked regions.",
  maskedBody: "Remote models may receive only the necessary cropped and masked region.", localOnlyBody: "Screenshots cannot leave this Mac. Remote visual requests are blocked.", restartPrivacy: "Save and restart before the new privacy mode takes effect in the runtime.",
  managedBrowser: "Managed browser", managedBrowserBody: "AdPilot uses an isolated browser Profile. You complete sign-in manually in the browser.", refreshBrowser: "Refresh browser session", refresh: "Refresh",
  noWorkspace: "No workspace selected", noWorkspaceBody: "Select a client workspace to manage its browser session and screenshot audits.", loadingBrowser: "Loading browser session", browserLoadFailed: "Could not load the browser session.", browserActionFailed: "The browser action failed.", retry: "Retry",
  browserClosed: "No browser session is running", browserLoginBody: "After launch, sign in manually in the new browser window. AdPilot never reads passwords or login storage.", browserProfile: "Browser Profile", automaticProfile: "Use workspace binding", optionalProfile: "Optional Profile name", browserProfileHint: "Leave blank to use the only account binding in the client workspace.",
  startBrowser: "Start browser", startingBrowser: "Starting", resumeBrowser: "Resume original session", resumingBrowser: "Resuming", closeBrowser: "Close session", closingBrowser: "Closing",
  browserLostBody: "The original process or window binding is no longer trusted. AdPilot never adopts another window automatically.", browserStartingBody: "Waiting for the managed browser window to finish binding.", browserConnectedBody: "Process, window, and Profile are bound and rechecked before every action.", browserLostReason: "Browser identity validation failed. Bring the original window to the foreground and resume, or close the session and start again.",
  application: "Application", platform: "Advertising platform", process: "Process ID", window: "Window ID", bounds: "Window size", lastChecked: "Last validated", runtime: "Runtime platform", notAvailable: "Unavailable",
  screenshotAudits: "Recent model screenshot audits", screenshotAuditsBody: "Metadata only. Full local screenshots are neither displayed nor uploaded.", refreshAudits: "Refresh screenshot audits", loadingAudits: "Loading screenshot audits", auditLoadFailed: "Could not load screenshot audits.", noAuditWorkspace: "No audit scope", noAudits: "No model screenshot records", noAuditsBody: "Records appear here after a Computer Use model receives its first safe region.",
  roi: "Sent region", masks: "Masks", disclosure: "Data destination", outcome: "Outcome", sentMinimized: "Safe region sent", stayedLocal: "Stayed local", blocked: "Blocked", prepared: "Prepared", fullScreenshotLocal: "The full screenshot stays in the local workspace"
};

export type ComputerUseCopy = { readonly [K in keyof typeof computerZh]: string };

export function computerUseCopy(locale: AppLocale): ComputerUseCopy {
  return locale === "zh-CN" ? computerZh : computerEn;
}

const permissionCenterZh = {
  title: "macOS 权限",
  body: "这里显示真正持有系统权限的进程、最近检查时间，以及权限缺失时受影响的能力。",
  welcome: "欢迎使用 AdPilot Computer Use",
  welcomeBody: "开始前请完成屏幕录制与辅助功能授权。任何广告修改仍会经过审批。",
  welcomeScreen: "屏幕录制：让 AdPilot 看见受管广告后台窗口",
  welcomeAccessibility: "辅助功能：让 Helper 聚焦窗口并执行已批准的单步操作",
  welcomeBrowser: "专属浏览器：隔离登录环境并绑定进程、窗口和配置档案",
  welcomeApproval: "操作审批：广告修改必须与一次性批准完全一致",
  refresh: "重新检测",
  refreshing: "正在检测",
  request: "请求权限",
  openSettings: "打开系统设置",
  runTest: "运行测试",
  testing: "测试中",
  process: "授权进程",
  bundle: "Bundle ID",
  checked: "检查时间",
  affected: "受影响功能",
  revocation: "撤销权限：打开系统设置，关闭 AdPilot Computer Helper；返回后点击“重新检测”。",
  helperReady: "Native Helper 已连接",
  helperUnavailable: "Native Helper 不可用",
  desktopOnly: "权限中心仅在 AdPilot macOS 桌面应用中可用。",
  loadFailed: "无法读取当前权限状态。",
  retry: "重试",
  previewAlt: "屏幕录制权限测试的新鲜窗口截图",
  restart: "授权已生效，但需要重启 AdPilot 后才能安全使用。",
  testPassed: "测试通过",
  testFailed: "测试未通过",
  technicalDetails: "技术细节"
} as const;

const permissionCenterEn: Record<keyof typeof permissionCenterZh, string> = {
  title: "macOS permissions",
  body: "See the process that actually owns each capability, when it was checked, and what is unavailable without it.",
  welcome: "Welcome to AdPilot Computer Use",
  welcomeBody: "Grant Screen Recording and Accessibility before starting. Advertising changes still pass through approval.",
  welcomeScreen: "Screen Recording: lets AdPilot see the managed advertising window",
  welcomeAccessibility: "Accessibility: lets the Helper focus a window and perform one approved step",
  welcomeBrowser: "Dedicated browser: isolates sign-in and binds the exact process, window, and Profile",
  welcomeApproval: "Approval gate: every advertising change must match a one-time approval",
  refresh: "Check again",
  refreshing: "Checking",
  request: "Request permission",
  openSettings: "Open System Settings",
  runTest: "Run test",
  testing: "Testing",
  process: "Authorized process",
  bundle: "Bundle ID",
  checked: "Checked",
  affected: "Affected features",
  revocation: "To revoke access, disable AdPilot Computer Helper in System Settings, then return and select Check again.",
  helperReady: "Native Helper connected",
  helperUnavailable: "Native Helper unavailable",
  desktopOnly: "Permission Center is available only in the AdPilot macOS desktop app.",
  loadFailed: "Could not read the current permission state.",
  retry: "Retry",
  previewAlt: "Fresh window screenshot from the Screen Recording permission test",
  restart: "Permission is enabled, but AdPilot must restart before it can be used safely.",
  testPassed: "Test passed",
  testFailed: "Test did not pass",
  technicalDetails: "Technical details"
};

export type PermissionCenterCopy = { readonly [K in keyof typeof permissionCenterZh]: string };

export function permissionCenterCopy(locale: AppLocale): PermissionCenterCopy {
  return locale === "zh-CN" ? permissionCenterZh : permissionCenterEn;
}

export function desktopPermissionName(id: string, locale: AppLocale): string {
  const zh: Record<string, string> = {
    "screen-recording": "屏幕录制",
    accessibility: "辅助功能",
    "files-and-folders": "文件与文件夹",
    "browser-control": "浏览器控制",
    notifications: "通知",
    keychain: "钥匙串",
    "native-helper": "Native Helper",
    "background-service": "后台服务"
  };
  const en: Record<string, string> = {
    "screen-recording": "Screen Recording",
    accessibility: "Accessibility",
    "files-and-folders": "Files and Folders",
    "browser-control": "Browser Control",
    notifications: "Notifications",
    keychain: "Keychain",
    "native-helper": "Native Helper",
    "background-service": "Background Service"
  };
  return (locale === "zh-CN" ? zh : en)[id] ?? id;
}

export function desktopPermissionStatusLabel(status: string, locale: AppLocale): string {
  const zh: Record<string, string> = {
    granted: "已授权",
    denied: "已拒绝",
    "not-determined": "尚未请求",
    restricted: "受系统限制",
    "requires-restart": "需要重启",
    "helper-unavailable": "Helper 不可用",
    unknown: "未知"
  };
  const en: Record<string, string> = {
    granted: "Granted",
    denied: "Denied",
    "not-determined": "Not requested",
    restricted: "Restricted",
    "requires-restart": "Restart required",
    "helper-unavailable": "Helper unavailable",
    unknown: "Unknown"
  };
  return (locale === "zh-CN" ? zh : en)[status] ?? status;
}

export function desktopPermissionReason(id: string, locale: AppLocale): string {
  const zh: Record<string, string> = {
    "screen-recording": "仅截取已绑定的浏览器窗口，用于定位和验证可见变化。",
    accessibility: "允许通过已认证 Helper 聚焦窗口并发送经过批准的鼠标或键盘输入。",
    "files-and-folders": "在 AdPilot 私有目录保存设置、有限期截图证据和审计记录。",
    "browser-control": "将 Computer Use 绑定到唯一浏览器配置档案、进程和窗口。",
    notifications: "AdPilot 在后台时显示审批与人工介入提醒。",
    keychain: "预留给未来的凭据代理；当前文件凭据存储不会冒充已使用钥匙串。",
    "native-helper": "运行持有截图与原生输入能力的本地认证执行进程。",
    "background-service": "在用户明确开启后维持计划监控和后台提醒。"
  };
  const en: Record<string, string> = {
    "screen-recording": "Captures only the bound browser window for grounding and visible verification.",
    accessibility: "Lets the authenticated Helper focus the window and post approved mouse or keyboard input.",
    "files-and-folders": "Stores settings, bounded screenshot evidence, and audits in AdPilot's private directory.",
    "browser-control": "Binds Computer Use to one browser Profile, process, and window.",
    notifications: "Shows approval and intervention alerts while AdPilot is in the background.",
    keychain: "Reserved for a future credential broker; the current file-backed store does not claim Keychain access.",
    "native-helper": "Runs the authenticated local executor that owns capture and native input.",
    "background-service": "Keeps explicitly enabled monitoring and alerts available in the background."
  };
  return (locale === "zh-CN" ? zh : en)[id] ?? id;
}

export function desktopPermissionFeatureLabel(feature: string, locale: AppLocale): string {
  if (locale === "en") return feature;
  const labels: Record<string, string> = {
    "Computer Live View": "电脑实时画面",
    "visual grounding": "视觉定位",
    "before/after evidence": "操作前后证据",
    click: "点击",
    scroll: "滚动",
    typing: "输入",
    "window focus": "窗口聚焦",
    "workspace persistence": "工作区持久化",
    "local evidence": "本地证据",
    "audit export": "审计导出",
    "Google Ads observation": "Google Ads 观察",
    "surface identity": "页面身份绑定",
    "safe actions": "安全操作",
    "approval alerts": "审批提醒",
    "takeover alerts": "接管提醒",
    "credential storage": "凭据存储",
    "provider sign-in": "供应商登录",
    permissions: "系统权限",
    "window capture": "窗口截图",
    "native input": "原生输入",
    "scheduled monitoring": "计划监控",
    "background alerts": "后台提醒"
  };
  return labels[feature] ?? feature;
}

/* ------------------------------------------------------------------ */
/* Computer-use localizers                                             */
/* ------------------------------------------------------------------ */

export function localizeRuntimeRoute(route: string, locale: AppLocale): string {
  if (!route || route === "not configured") return locale === "zh-CN" ? "尚未配置自动视觉路由" : "Automatic visual routing is not configured";
  if (locale === "en") return route;
  const labels: Record<string, string> = {
    "Built-in GUI": "内置 GUI 定位",
    "Fast Vision": "快速视觉模型",
    "Deep Vision": "深度视觉模型"
  };
  return route.split(/\s*→\s*/).map((item) => labels[item] ?? item).join(" → ");
}

export function localizeRuntimeValue(value: string, locale: AppLocale): string {
  if (!value || value === "not configured") return locale === "zh-CN" ? "未配置" : "Not configured";
  if (value === "not supported") return locale === "zh-CN" ? "不支持" : "Not supported";
  return value;
}

export type ComputerPermission = "OBSERVE" | "INTERACT" | "MUTATE" | "DESTRUCTIVE";

export function permissionLabel(permission: ComputerPermission, locale: AppLocale): string {
  const zhLabels: Record<ComputerPermission, string> = { OBSERVE: "仅观察", INTERACT: "可交互", MUTATE: "可修改", DESTRUCTIVE: "可执行破坏性操作" };
  const enLabels: Record<ComputerPermission, string> = { OBSERVE: "Observe only", INTERACT: "Interaction allowed", MUTATE: "Mutation allowed", DESTRUCTIVE: "Destructive actions allowed" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[permission];
}

export type BrowserSessionStatus = "starting" | "connected" | "lost" | "closed";

export function browserStatusLabel(status: BrowserSessionStatus, locale: AppLocale): string {
  const zhLabels: Record<BrowserSessionStatus, string> = { starting: "正在启动", connected: "已连接", lost: "连接已丢失", closed: "已关闭" };
  const enLabels: Record<BrowserSessionStatus, string> = { starting: "Starting", connected: "Connected", lost: "Connection lost", closed: "Closed" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[status];
}

export type AuditPurpose = "grounding" | "verification" | "table_read" | "account_identity" | "other";

export function auditPurposeLabel(purpose: AuditPurpose, locale: AppLocale): string {
  const zhLabels: Record<AuditPurpose, string> = { grounding: "界面定位", verification: "结果校验", table_read: "表格读取", account_identity: "账户识别", other: "其他视觉任务" };
  const enLabels: Record<AuditPurpose, string> = { grounding: "GUI grounding", verification: "Result verification", table_read: "Table reading", account_identity: "Account identity", other: "Other visual task" };
  return (locale === "zh-CN" ? zhLabels : enLabels)[purpose];
}

export function platformLabel(platform: string): string {
  return platform === "google_ads" ? "Google Ads" : platform;
}

/* ------------------------------------------------------------------ */
/* Plugins copy                                                        */
/* ------------------------------------------------------------------ */

const pluginsZh = {
  nav: "插件",
  title: "插件",
  body: "精选目录中的签名插件。广告修改类权限始终显著标识。",
  backToList: "返回列表",
  closeView: "返回对话",
  retry: "重试",
  loading: "正在读取插件目录",
  loadFailed: "无法读取插件目录",
  installedGroup: "已安装",
  curatedGroup: "精选目录",
  candidateGroup: "候选集成",
  candidateGroupBody: "来自官方来源的调研线索，尚未打包、签名或接入；候选卡没有安装入口。",
  candidateOnly: "不可安装",
  candidateReadOnly: "建议只读",
  candidateSource: "查看官方来源",
  empty: "目录为空",
  emptyBody: "精选目录中暂时没有可用插件。",
  developerModeTitle: "开发者模式已启用",
  developerModeBody: "目录中存在未签名的已审查插件包；安装未签名插件需要逐次显式确认。",
  catalogErrorTitle: "插件目录不可用",
  catalogErrorBody: "目录校验未通过，插件子系统已按失败关闭策略降级；其余功能不受影响。",
  updateAvailable: "可更新",
  statusActive: "已启用",
  statusDisabled: "已禁用",
  statusNeedsReview: "待权限复核",
  install: "安装",
  uninstall: "卸载",
  disable: "禁用",
  enable: "启用",
  updateAction: "更新",
  actionFailed: "插件操作失败",
  permissions: "权限",
  noPermissions: "未声明权限",
  adsMutation: "广告修改",
  tools: "工具",
  noTools: "未声明工具",
  toolReadOnly: "只读",
  toolMutable: "可变",
  signature: "签名",
  signed: "已签名",
  unsigned: "未签名",
  signerFingerprint: "签名指纹",
  verification: "完整性校验",
  verificationOk: "校验通过",
  verificationFailed: "校验失败",
  review: "审查",
  reviewApproved: "已通过审查",
  reviewPending: "审查中",
  reviewRejected: "审查未通过",
  version: "版本",
  developerLabel: "开发者",
  supervisor: "隔离运行时",
  logs: "运行日志",
  logsEmpty: "暂无日志记录",
  logsShow: "查看日志",
  logsHide: "收起日志",
  permReviewTitle: "确认新增权限",
  permReviewBody: "更新到 {version} 将授予以下新增权限。明确接受后才会继续。",
  permReviewConfirm: "接受权限并继续",
  permReviewRemoved: "同时将移除 {count} 项权限",
  unsignedTitle: "未签名插件 · 高危",
  unsignedBody: "此插件包没有签名，无法核验发布者身份。只有完全信任来源时才应继续。",
  unsignedReason: "服务端原因",
  unsignedConfirm: "仍要继续",
  cancel: "取消",
  riskLow: "低",
  riskMedium: "中",
  riskHigh: "高",
  riskCritical: "严重",
  categoryCapability: "能力",
  categoryFilesystem: "文件系统",
  categoryNetwork: "网络",
  categorySecret: "密钥",
  categoryBrowser: "浏览器",
  categoryComputerUse: "电脑控制",
  categoryAdvertising: "广告数据",
  categoryStorage: "存储"
} as const;

const pluginsEn: Record<keyof typeof pluginsZh, string> = {
  nav: "Plugins",
  title: "Plugins",
  body: "Signed plugins from the curated catalog. Advertising-mutation grants are always flagged.",
  backToList: "Back to list",
  closeView: "Back to conversation",
  retry: "Retry",
  loading: "Loading the plugin catalog",
  loadFailed: "Could not load the plugin catalog",
  installedGroup: "Installed",
  curatedGroup: "Curated",
  candidateGroup: "Candidate integrations",
  candidateGroupBody: "Research leads from official sources. They are not packaged, signed, or connected, so candidate cards have no install action.",
  candidateOnly: "Not installable",
  candidateReadOnly: "Read-only first",
  candidateSource: "Official source",
  empty: "Catalog is empty",
  emptyBody: "No plugins are available in the curated catalog yet.",
  developerModeTitle: "Developer mode is on",
  developerModeBody: "The catalog contains an unsigned reviewed bundle. Installing unsigned plugins requires explicit per-action confirmation.",
  catalogErrorTitle: "Plugin catalog unavailable",
  catalogErrorBody: "Catalog verification failed, so the plugin subsystem degraded fail-closed. Everything else keeps working.",
  updateAvailable: "Update available",
  statusActive: "Enabled",
  statusDisabled: "Disabled",
  statusNeedsReview: "Permission review",
  install: "Install",
  uninstall: "Uninstall",
  disable: "Disable",
  enable: "Enable",
  updateAction: "Update",
  actionFailed: "Plugin action failed",
  permissions: "Permissions",
  noPermissions: "No permissions declared",
  adsMutation: "Ads mutation",
  tools: "Tools",
  noTools: "No tools declared",
  toolReadOnly: "Read-only",
  toolMutable: "Mutable",
  signature: "Signature",
  signed: "Signed",
  unsigned: "Unsigned",
  signerFingerprint: "Signer fingerprint",
  verification: "Integrity check",
  verificationOk: "Verified",
  verificationFailed: "Verification failed",
  review: "Review",
  reviewApproved: "Review approved",
  reviewPending: "Review pending",
  reviewRejected: "Review rejected",
  version: "Version",
  developerLabel: "Developer",
  supervisor: "Isolation runtime",
  logs: "Runtime logs",
  logsEmpty: "No log entries yet",
  logsShow: "Show logs",
  logsHide: "Hide logs",
  permReviewTitle: "Confirm new permissions",
  permReviewBody: "Updating to {version} grants the following new permissions. Nothing continues until you explicitly accept.",
  permReviewConfirm: "Accept permissions and continue",
  permReviewRemoved: "{count} permission(s) will also be removed",
  unsignedTitle: "Unsigned plugin · high risk",
  unsignedBody: "This bundle is unsigned, so the publisher identity cannot be verified. Continue only if you fully trust the source.",
  unsignedReason: "Server reason",
  unsignedConfirm: "Continue anyway",
  cancel: "Cancel",
  riskLow: "Low",
  riskMedium: "Medium",
  riskHigh: "High",
  riskCritical: "Critical",
  categoryCapability: "Capability",
  categoryFilesystem: "Filesystem",
  categoryNetwork: "Network",
  categorySecret: "Secret",
  categoryBrowser: "Browser",
  categoryComputerUse: "Computer use",
  categoryAdvertising: "Advertising",
  categoryStorage: "Storage"
};

export type PluginsCopy = { readonly [K in keyof typeof pluginsZh]: string };

export function pluginsCopy(locale: AppLocale): PluginsCopy {
  return locale === "zh-CN" ? pluginsZh : pluginsEn;
}

export function pluginRiskLabel(risk: string, locale: AppLocale): string {
  const copy = pluginsCopy(locale);
  const labels: Record<string, string> = { low: copy.riskLow, medium: copy.riskMedium, high: copy.riskHigh, critical: copy.riskCritical };
  return labels[risk] ?? humanize(risk);
}

export function pluginStatusLabel(status: string, locale: AppLocale): string {
  const copy = pluginsCopy(locale);
  const labels: Record<string, string> = { active: copy.statusActive, disabled: copy.statusDisabled, needs_review: copy.statusNeedsReview };
  return labels[status] ?? humanize(status);
}

export function pluginReviewLabel(status: string, locale: AppLocale): string {
  const copy = pluginsCopy(locale);
  const labels: Record<string, string> = { approved: copy.reviewApproved, pending: copy.reviewPending, rejected: copy.reviewRejected };
  return labels[status] ?? humanize(status);
}

export function pluginCategoryLabel(category: string, locale: AppLocale): string {
  const copy = pluginsCopy(locale);
  const labels: Record<string, string> = {
    capability: copy.categoryCapability,
    filesystem: copy.categoryFilesystem,
    network: copy.categoryNetwork,
    secret: copy.categorySecret,
    browser: copy.categoryBrowser,
    "computer-use": copy.categoryComputerUse,
    advertising: copy.categoryAdvertising,
    storage: copy.categoryStorage
  };
  return labels[category] ?? humanize(category);
}

export function runtimePlatformLabel(platform: string): string {
  return platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";
}

/* ------------------------------------------------------------------ */
/* Universal Workspace copy (home / projects / workbench panels)       */
/* ------------------------------------------------------------------ */

const workspaceZh = {
  navHome: "首页",
  navChat: "对话",
  navProjects: "项目",
  navAutomations: "自动化",
  navSkills: "技能",
  newChat: "新建会话",
  newProject: "新建项目",
  workspace: "工作区",
  settings: "设置",
  loading: "载入中",
  retry: "重试",
  cancel: "取消",
  create: "创建",
  close: "关闭",
  refresh: "刷新",
  download: "下载",
  viewAll: "查看全部",
  greetingMorning: "早上好",
  greetingAfternoon: "下午好",
  greetingEvening: "晚上好",
  homeQuickPlaceholder: "输入一个目标，回车后在对话中继续…",
  homeHeading: "今天优化什么？",
  homeComposerPlaceholder: "让 AdPilot 审转化、排查 CPA 异常、或生成日报 — 截图、链接、纯文字都可以。",
  homeAttach: "附件（即将支持）",
  homeCodeMode: "代码",
  homeSlashHint: "输入 / 使用命令",
  homeSendHint: "按 ⏎ 发送 · ⇧⏎ 换行",
  homeRecent: "最近",
  homeArchive: "归档",
  homeFeedEmpty: "还没有任务",
  homeFeedEmptyBody: "从上方输入一个目标开始，或到项目里查看全部。",
  homeArchiveEmpty: "没有归档会话",
  selectProject: "选择项目",
  justChat: "仅对话（不关联项目）",
  modelPickerLabel: "选择模型",
  modelProviderNeedsKey: "未配置密钥",
  modelVisionCapable: "视觉",
  modelRestartHint: "重启生效",
  homeQuickSubmit: "开始",
  homeProjects: "进行中的项目",
  homeProjectsEmpty: "还没有项目",
  homeProjectsEmptyBody: "项目把目标、任务、文件和工件组织在一起。创建第一个项目开始。",
  homeProjectsCreate: "新建项目",
  homeApprovals: "等待审批",
  homeApprovalsEmpty: "没有待审批事项",
  homeArtifacts: "最近的工件",
  homeArtifactsEmpty: "还没有工件",
  homeTasks: "任务",
  homeTasksEmpty: "没有运行中或排队中的任务",
  homeSessions: "最近的会话",
  homeSessionsEmpty: "还没有会话",
  projectsTitle: "项目",
  projectsBody: "每个项目聚合目标、任务图、文件根目录和工件。",
  projectsNew: "新建项目",
  projectsEmpty: "还没有项目",
  projectsEmptyBody: "创建第一个项目，把目标、文件和工件组织进同一个工作台。",
  projectGoalCount: "{count} 个目标",
  projectArtifactCount: "{count} 个工件",
  projectUpdatedAt: "更新于 {time}",
  newProjectTitle: "新建项目",
  projectNameLabel: "名称",
  projectNamePlaceholder: "例如:Q3 投放重构",
  projectTypeLabel: "类型",
  projectRootsLabel: "文件根目录(每行一个绝对路径)",
  projectRootsHint: "可选;第一个根目录会作为终端与 Git 面板的默认目录。",
  projectCreate: "创建项目",
  archiveProject: "归档项目",
  archiveProjectTitle: "归档此项目?",
  archiveProjectBody: "归档后项目从列表隐藏,目标与工件保留在磁盘上。此操作会写入审计链。",
  archiveConfirm: "确认归档",
  typeGeneral: "通用",
  typeAdvertising: "广告",
  typeDevelopment: "开发",
  typeResearch: "研究",
  typeCreative: "创意",
  backToProjects: "返回项目列表",
  tabGoals: "目标",
  tabFiles: "文件",
  tabArtifacts: "工件",
  tabTerminal: "终端",
  tabGit: "Git",
  tabPreview: "预览",
  collapsePanel: "收起面板",
  expandPanel: "展开面板",
  goalNew: "新建目标",
  goalTitlePlaceholder: "目标标题,例如:CPA 稳定在 100 以内",
  goalObjectivePlaceholder: "衡量标准(可选),例如:CPA ≤ 100 且日消耗 ≥ 500",
  goalCreate: "添加目标",
  goalCreateFailed: "无法创建目标，请检查填写内容后重试。",
  goalEmpty: "还没有目标",
  goalEmptyBody: "目标是项目里可追踪的结果,任务挂在目标下。",
  goalProgress: "进度 {percent}%",
  filesEmpty: "项目没有文件根目录",
  filesEmptyBody: "创建项目时填写 rootPaths 后,这里会显示文件树。",
  filesTruncated: "条目过多,已截断(最多 500 条)",
  filePreviewEmpty: "点击文件查看内容",
  fileLoadFailed: "无法读取文件",
  artifactsEmpty: "还没有工件",
  artifactsEmptyBody: "工件由渲染管线产出(slides / document / spreadsheet)。",
  artifactVersion: "v{version}",
  timelineTitle: "任务时间线",
  timelineEmpty: "还没有任务",
  timelineEmptyBody: "任务来自项目目标下的 kernel 任务图。",
  taskComplete: "完成",
  chatCtaTitle: "就这个项目发起任务",
  chatCtaPlaceholder: "描述要在此项目上推进的工作…",
  chatCtaHint: "提交后将在对话视图中继续",
  projectChatTitle: "项目会话",
  projectChatNewSession: "新会话",
  projectChatEmpty: "开始这个项目的第一次对话",
  projectChatEmptyBody: "消息绑定到项目专属会话;复杂目标会自动拆成目标与任务。",
  projectChatHint: "对话在项目内进行;长目标或含成功条件关键词的消息会自动创建 Goal。",
  statusQueued: "排队中",
  statusRunning: "运行中",
  statusBlocked: "已阻塞",
  statusWaitingApproval: "等待审批",
  statusCompleted: "已完成",
  statusFailed: "已失败",
  goalDraft: "草稿",
  goalActive: "进行中",
  artifactReady: "就绪",
  artifactRendering: "渲染中",
  artifactFailed: "失败",
  artifactDraft: "草稿",
  terminalNew: "新会话",
  terminalStarting: "正在启动终端…",
  terminalCloseTab: "关闭会话",
  terminalInterrupt: "中断 (Ctrl+C)",
  terminalPlaceholder: "输入命令,回车写入 shell",
  terminalExited: "会话已退出",
  terminalExecLabel: "exec",
  terminalExecPlaceholder: "一次性命令,点击运行查看退出码",
  terminalExecRun: "运行",
  terminalExitCode: "退出码 {code}",
  terminalApprovalTitle: "命令需要审批",
  terminalApprovalBody: "该命令被分类为 {verdict}:{reason}",
  terminalRunAnyway: "仍然执行",
  terminalCreateFailed: "终端启动失败",
  gitNotRepo: "不是 Git 仓库",
  gitNotRepoBody: "项目的第一个根目录不是 Git 仓库,Git 面板不可用。",
  gitStaged: "已暂存",
  gitUnstaged: "未暂存",
  gitUntracked: "未跟踪",
  gitClean: "工作区干净,没有变更",
  gitAhead: "领先 {count}",
  gitBehind: "落后 {count}",
  gitStage: "暂存",
  gitUnstage: "取消暂存",
  gitCommitPlaceholder: "提交信息…",
  gitCommit: "提交",
  gitBranches: "分支",
  gitSwitch: "切换",
  gitNewBranchPlaceholder: "新分支名…",
  gitCreateBranch: "创建分支",
  gitCheckpoints: "检查点",
  checkpointPlaceholder: "检查点标签…",
  checkpointCreate: "创建检查点",
  checkpointEmpty: "还没有检查点",
  checkpointRestore: "恢复",
  checkpointRestoreTitle: "恢复此检查点?",
  checkpointRestoreBody: "工作区将回到检查点 {label} 的快照状态,未提交的当前变更可能被覆盖。",
  checkpointForce: "强制恢复",
  diffLegend: "图例",
  diffAdded: "新增行",
  diffRemoved: "删除行",
  diffHunk: "块头",
  gitActionFailed: "Git 操作失败",
  previewEmpty: "没有可预览的工件",
  previewEmptyBody: "工件渲染完成后,在这里预览 slides / document / spreadsheet。",
  previewSelect: "在左侧工件列表中选择一个工件进行预览",
  previewDownload: "下载原文件",
  previewOf: "{index} / {total}",
  previewLoadFailed: "预览加载失败",
  artifactSlides: "幻灯片",
  artifactDocument: "文档",
  artifactSpreadsheet: "表格",
  artifactCode: "代码",
  artifactPdf: "PDF",
  artifactWebsite: "网站",
  artifactImage: "图片",
  artifactVideo: "视频",
  artifactInteractive: "交互",
  artifactReport: "报告",
  automationsTitle: "自动化",
  automationsBody: "定时或事件触发的自动化:真实调度、幂等执行、每日预算与审批门禁。",
  automationsNew: "新建自动化",
  automationsEmpty: "还没有自动化",
  automationsEmptyBody: "创建一个定时简报、周期任务或通知,调度器按 cron(UTC)自动触发;含变更的动作会先停在审批门。",
  automationNotifications: "通知",
  automationNotificationsEmpty: "没有通知",
  automationUnread: "{count} 条未读",
  notificationMarkRead: "标记已读",
  automationNextFire: "下次 {time}",
  automationNoFire: "无调度",
  automationRunCount: "已运行 {count} 次",
  automationPause: "暂停",
  automationResume: "恢复",
  automationRunNow: "立即运行",
  automationDelete: "删除",
  automationDeleteTitle: "删除此自动化?",
  automationDeleteBody: "自动化及其运行记录将被删除,操作会写入审计链。",
  automationDeleteConfirm: "删除",
  automationRuns: "运行记录",
  automationRunsEmpty: "还没有运行记录",
  automationApprove: "批准执行",
  automationStateActive: "运行中",
  automationStatePaused: "已暂停",
  runRunning: "运行中",
  runSucceeded: "成功",
  runFailed: "失败",
  runSkippedDuplicate: "幂等跳过",
  runWaitingApproval: "等待审批",
  automationCreateTitle: "新建自动化",
  automationTitleLabel: "标题",
  automationTitlePlaceholder: "例如:每天早上投放简报",
  automationTriggerLabel: "触发方式",
  triggerSchedule: "定时(cron)",
  triggerEvent: "事件",
  automationPresetLabel: "预设",
  presetDailyMorning: "每天早上 9:00",
  presetHourly: "每小时整点",
  presetWeeklyMonday: "每周一 9:00",
  presetCustom: "自定义",
  cronFieldMinute: "分",
  cronFieldHour: "时",
  cronFieldDom: "日",
  cronFieldMonth: "月",
  cronFieldDow: "周",
  automationCronHint: "5 段 cron(UTC):支持 * , - / 与数字",
  automationEventNameLabel: "事件名",
  automationEventConditionLabel: "条件(可选)",
  automationActionLabel: "动作",
  actionDailyBrief: "生成每日简报",
  actionCreateTask: "创建 kernel 任务",
  actionNotify: "发送通知",
  automationTaskTitleLabel: "任务标题",
  automationTaskDescriptionLabel: "任务描述",
  automationMessageLabel: "通知内容",
  automationMaxRunsLabel: "每日最大运行次数",
  automationCreate: "创建自动化",
  automationEventPrefix: "事件 {event}",
  cronEveryMinute: "每分钟",
  cronHourly: "每小时第 {minute} 分",
  cronDaily: "每天 {time}",
  cronWeekly: "每周{dow} {time}",
  cronMonthly: "每月 {dom} 日 {time}",
  dow0: "日",
  dow1: "一",
  dow2: "二",
  dow3: "三",
  dow4: "四",
  dow5: "五",
  dow6: "六",
  skillsTitle: "技能",
  skillsBody: "内置技能与用户技能统一目录；用户级和工作区同名技能可覆盖内置内容。所有技能仅注入参考知识，不授予工具或权限。",
  skillsEmpty: "还没有可用技能",
  skillsEmptyBody: "在 ~/.adpilot/skills 或工作区 .adpilot/skills 下放置 SKILL.md 即可被发现。",
  skillTriggers: "触发词",
  skillSource: "来源 {source}",
  skillSourceBuiltIn: "内置",
  skillSourceUser: "用户",
  skillSourceWorkspace: "工作区",
  skillLicense: "许可证 {license}",
  skillsWarnings: "部分技能未通过校验",
  homeBrief: "广告 Daily Brief",
  homeBriefGenerate: "生成简报",
  homeBriefGenerating: "正在生成简报…",
  homeBriefIdle: "点击生成简报,自动组装账户、活动、素材与决策事实。",
  homeBriefEmpty: "没有待处理的发现",
  homeBriefSummary: "{total} 项发现 · 严重 {critical} · 警告 {warning}",
  homeBriefGeneratedAt: "生成于 {time}",
  briefEvidence: "证据",
  briefNoEvidence: "无证据 ID",
  briefSectionAnomalyAccounts: "异常账户",
  briefSectionCreativeFatigue: "素材衰退",
  briefSectionLearningPhaseRisks: "学习期风险",
  briefSectionPendingObservations: "等待观察",
  briefSectionPendingApprovals: "等待批准",
  briefSectionPendingReports: "待发送报告",
  briefSectionMeasurementIssues: "口径提醒",
  decisionQueue: "行动队列",
  decisionQueueEmpty: "还没有决策",
  decisionQueueEmptyBody: "决策把建议、理由、风险与回滚方案记入账本,按状态推进批准、执行与观察。",
  decisionNew: "新建决策",
  decisionCreateTitle: "新建决策",
  decisionRecommendationLabel: "建议",
  decisionRecommendationPlaceholder: "例如:把 tCPA 提高 10%,观察 3 天",
  decisionConfidenceLabel: "置信度",
  decisionConfidenceLow: "低",
  decisionConfidenceMedium: "中",
  decisionConfidenceHigh: "高",
  decisionRationaleLabel: "理由(每行一条)",
  decisionRisksLabel: "风险(每行一条)",
  decisionObservationWindowLabel: "观察窗口(可选)",
  decisionObservationWindowPlaceholder: "例如:3 天 / 2 个转化周期",
  decisionRollbackPlanLabel: "回滚方案(可选)",
  decisionCreate: "创建决策",
  decisionRationale: "理由",
  decisionRisks: "风险",
  decisionEvidence: "证据",
  decisionDuplicate: "已存在相同建议,已在下方高亮",
  decisionStatusProposed: "待批准",
  decisionStatusApproved: "已批准",
  decisionStatusExecuted: "已执行",
  decisionStatusObserving: "观察中",
  decisionStatusSuccessful: "成功",
  decisionStatusFailed: "已失败",
  decisionStatusReverted: "已回滚",
  decisionApprove: "批准",
  decisionReject: "拒绝",
  decisionMarkExecuted: "标记已执行",
  decisionStartObserving: "开始观察",
  decisionMarkSuccessful: "成功",
  decisionRevert: "失败回滚"
} as const;

const workspaceEn: Record<keyof typeof workspaceZh, string> = {
  navHome: "Home",
  navChat: "Chat",
  navProjects: "Projects",
  navAutomations: "Automations",
  navSkills: "Skills",
  newChat: "New session",
  newProject: "New project",
  workspace: "Workspace",
  settings: "Settings",
  loading: "Loading",
  retry: "Retry",
  cancel: "Cancel",
  create: "Create",
  close: "Close",
  refresh: "Refresh",
  download: "Download",
  viewAll: "View all",
  greetingMorning: "Good morning",
  greetingAfternoon: "Good afternoon",
  greetingEvening: "Good evening",
  homeQuickPlaceholder: "Type a goal, press Enter to continue in chat…",
  homeHeading: "What should AdPilot do next?",
  homeComposerPlaceholder: "Ask AdPilot to audit conversion, diagnose a CPA spike, or draft a daily report. Paste a link, a screenshot, or a sentence.",
  homeAttach: "Attachments (coming soon)",
  homeCodeMode: "Code",
  homeSlashHint: "Type / for commands",
  homeSendHint: "press ⏎ to send · ⇧⏎ for newline",
  homeRecent: "Recent",
  homeArchive: "Archive",
  homeFeedEmpty: "No tasks yet",
  homeFeedEmptyBody: "Type a goal above to start, or open Projects to see everything.",
  homeArchiveEmpty: "No archived sessions",
  selectProject: "Select project",
  justChat: "Just chat (no project)",
  modelPickerLabel: "Choose model",
  modelProviderNeedsKey: "no API key",
  modelVisionCapable: "vision",
  modelRestartHint: "Restart to apply",
  homeQuickSubmit: "Start",
  homeProjects: "Active projects",
  homeProjectsEmpty: "No projects yet",
  homeProjectsEmptyBody: "Projects organize goals, tasks, files and artifacts. Create your first one to start.",
  homeProjectsCreate: "New project",
  homeApprovals: "Waiting for approval",
  homeApprovalsEmpty: "Nothing is waiting for approval",
  homeArtifacts: "Recent artifacts",
  homeArtifactsEmpty: "No artifacts yet",
  homeTasks: "Tasks",
  homeTasksEmpty: "No running or queued tasks",
  homeSessions: "Recent sessions",
  homeSessionsEmpty: "No sessions yet",
  projectsTitle: "Projects",
  projectsBody: "Each project bundles goals, a task graph, file roots and artifacts.",
  projectsNew: "New project",
  projectsEmpty: "No projects yet",
  projectsEmptyBody: "Create your first project to organize goals, files and artifacts in one workbench.",
  projectGoalCount: "{count} goals",
  projectArtifactCount: "{count} artifacts",
  projectUpdatedAt: "Updated {time}",
  newProjectTitle: "New project",
  projectNameLabel: "Name",
  projectNamePlaceholder: "e.g. Q3 ads rebuild",
  projectTypeLabel: "Type",
  projectRootsLabel: "File roots (one absolute path per line)",
  projectRootsHint: "Optional; the first root becomes the default directory for the terminal and Git panels.",
  projectCreate: "Create project",
  archiveProject: "Archive project",
  archiveProjectTitle: "Archive this project?",
  archiveProjectBody: "Archiving hides the project from the list; goals and artifacts stay on disk. The action is written to the audit chain.",
  archiveConfirm: "Archive",
  typeGeneral: "General",
  typeAdvertising: "Advertising",
  typeDevelopment: "Development",
  typeResearch: "Research",
  typeCreative: "Creative",
  backToProjects: "Back to projects",
  tabGoals: "Goals",
  tabFiles: "Files",
  tabArtifacts: "Artifacts",
  tabTerminal: "Terminal",
  tabGit: "Git",
  tabPreview: "Preview",
  collapsePanel: "Collapse panel",
  expandPanel: "Expand panel",
  goalNew: "New goal",
  goalTitlePlaceholder: "Goal title, e.g. keep CPA under 100",
  goalObjectivePlaceholder: "Success measure (optional), e.g. CPA ≤ 100 with daily spend ≥ 500",
  goalCreate: "Add goal",
  goalCreateFailed: "Could not create the goal. Check the fields and try again.",
  goalEmpty: "No goals yet",
  goalEmptyBody: "Goals are trackable outcomes; tasks hang underneath them.",
  goalProgress: "Progress {percent}%",
  filesEmpty: "This project has no file roots",
  filesEmptyBody: "Fill rootPaths when creating a project and the file tree shows up here.",
  filesTruncated: "Too many entries — truncated at 500",
  filePreviewEmpty: "Click a file to view its contents",
  fileLoadFailed: "Could not read the file",
  artifactsEmpty: "No artifacts yet",
  artifactsEmptyBody: "Artifacts are produced by the render pipeline (slides / document / spreadsheet).",
  artifactVersion: "v{version}",
  timelineTitle: "Task timeline",
  timelineEmpty: "No tasks yet",
  timelineEmptyBody: "Tasks come from the kernel task graph under this project's goals.",
  taskComplete: "Complete",
  chatCtaTitle: "Start a mission on this project",
  chatCtaPlaceholder: "Describe the work to push forward on this project…",
  chatCtaHint: "Continues in the chat view after submitting",
  projectChatTitle: "Project session",
  projectChatNewSession: "New session",
  projectChatEmpty: "Start this project's first conversation",
  projectChatEmptyBody: "Messages bind to the project's own session; complex missions split into goals and tasks automatically.",
  projectChatHint: "The conversation stays in the project; long messages or success-criteria keywords create a goal automatically.",
  statusQueued: "Queued",
  statusRunning: "Running",
  statusBlocked: "Blocked",
  statusWaitingApproval: "Waiting for approval",
  statusCompleted: "Completed",
  statusFailed: "Failed",
  goalDraft: "Draft",
  goalActive: "Active",
  artifactReady: "Ready",
  artifactRendering: "Rendering",
  artifactFailed: "Failed",
  artifactDraft: "Draft",
  terminalNew: "New session",
  terminalStarting: "Starting the terminal…",
  terminalCloseTab: "Close session",
  terminalInterrupt: "Interrupt (Ctrl+C)",
  terminalPlaceholder: "Type a command, Enter writes to the shell",
  terminalExited: "Session exited",
  terminalExecLabel: "exec",
  terminalExecPlaceholder: "One-shot command — run it to see the exit code",
  terminalExecRun: "Run",
  terminalExitCode: "Exit code {code}",
  terminalApprovalTitle: "Command needs approval",
  terminalApprovalBody: "The command was classified as {verdict}: {reason}",
  terminalRunAnyway: "Run anyway",
  terminalCreateFailed: "Could not start the terminal",
  gitNotRepo: "Not a Git repository",
  gitNotRepoBody: "The project's first root is not a Git repository, so the Git panel is unavailable.",
  gitStaged: "Staged",
  gitUnstaged: "Unstaged",
  gitUntracked: "Untracked",
  gitClean: "Working tree clean — no changes",
  gitAhead: "ahead {count}",
  gitBehind: "behind {count}",
  gitStage: "Stage",
  gitUnstage: "Unstage",
  gitCommitPlaceholder: "Commit message…",
  gitCommit: "Commit",
  gitBranches: "Branches",
  gitSwitch: "Switch",
  gitNewBranchPlaceholder: "New branch name…",
  gitCreateBranch: "Create branch",
  gitCheckpoints: "Checkpoints",
  checkpointPlaceholder: "Checkpoint label…",
  checkpointCreate: "Create checkpoint",
  checkpointEmpty: "No checkpoints yet",
  checkpointRestore: "Restore",
  checkpointRestoreTitle: "Restore this checkpoint?",
  checkpointRestoreBody: "The working tree returns to the snapshot labelled {label}; uncommitted changes may be overwritten.",
  checkpointForce: "Force restore",
  diffLegend: "Legend",
  diffAdded: "Added lines",
  diffRemoved: "Removed lines",
  diffHunk: "Hunk header",
  gitActionFailed: "Git action failed",
  previewEmpty: "Nothing to preview",
  previewEmptyBody: "Once artifacts finish rendering, preview slides / documents / spreadsheets here.",
  previewSelect: "Pick an artifact in the left list to preview it",
  previewDownload: "Download the original file",
  previewOf: "{index} / {total}",
  previewLoadFailed: "Could not load the preview",
  artifactSlides: "Slides",
  artifactDocument: "Document",
  artifactSpreadsheet: "Spreadsheet",
  artifactCode: "Code",
  artifactPdf: "PDF",
  artifactWebsite: "Website",
  artifactImage: "Image",
  artifactVideo: "Video",
  artifactInteractive: "Interactive",
  artifactReport: "Report",
  automationsTitle: "Automations",
  automationsBody: "Scheduled and event-triggered automations: real scheduling, idempotent runs, daily budgets, and approval gates.",
  automationsNew: "New automation",
  automationsEmpty: "No automations yet",
  automationsEmptyBody: "Create a scheduled brief, recurring task, or notification; the scheduler fires it on cron (UTC), and mutating actions park at the approval gate.",
  automationNotifications: "Notifications",
  automationNotificationsEmpty: "No notifications",
  automationUnread: "{count} unread",
  notificationMarkRead: "Mark read",
  automationNextFire: "next {time}",
  automationNoFire: "no schedule",
  automationRunCount: "{count} runs",
  automationPause: "Pause",
  automationResume: "Resume",
  automationRunNow: "Run now",
  automationDelete: "Delete",
  automationDeleteTitle: "Delete this automation?",
  automationDeleteBody: "The automation and its run history are deleted; the action is written to the audit chain.",
  automationDeleteConfirm: "Delete",
  automationRuns: "Runs",
  automationRunsEmpty: "No runs yet",
  automationApprove: "Approve run",
  automationStateActive: "Active",
  automationStatePaused: "Paused",
  runRunning: "Running",
  runSucceeded: "Succeeded",
  runFailed: "Failed",
  runSkippedDuplicate: "Skipped (duplicate)",
  runWaitingApproval: "Waiting for approval",
  automationCreateTitle: "New automation",
  automationTitleLabel: "Title",
  automationTitlePlaceholder: "e.g. Morning ads brief",
  automationTriggerLabel: "Trigger",
  triggerSchedule: "Schedule (cron)",
  triggerEvent: "Event",
  automationPresetLabel: "Preset",
  presetDailyMorning: "Every morning at 09:00",
  presetHourly: "Hourly on the hour",
  presetWeeklyMonday: "Mondays at 09:00",
  presetCustom: "Custom",
  cronFieldMinute: "minute",
  cronFieldHour: "hour",
  cronFieldDom: "day",
  cronFieldMonth: "month",
  cronFieldDow: "weekday",
  automationCronHint: "Five cron fields (UTC): *, lists, ranges, and / steps",
  automationEventNameLabel: "Event name",
  automationEventConditionLabel: "Condition (optional)",
  automationActionLabel: "Action",
  actionDailyBrief: "Generate daily brief",
  actionCreateTask: "Create kernel task",
  actionNotify: "Send notification",
  automationTaskTitleLabel: "Task title",
  automationTaskDescriptionLabel: "Task description",
  automationMessageLabel: "Message",
  automationMaxRunsLabel: "Max runs per day",
  automationCreate: "Create automation",
  automationEventPrefix: "event: {event}",
  cronEveryMinute: "every minute",
  cronHourly: "hourly at minute {minute}",
  cronDaily: "daily at {time}",
  cronWeekly: "weekly on {dow} at {time}",
  cronMonthly: "monthly on day {dom} at {time}",
  dow0: "Sun",
  dow1: "Mon",
  dow2: "Tue",
  dow3: "Wed",
  dow4: "Thu",
  dow5: "Fri",
  dow6: "Sat",
  skillsTitle: "Skills",
  skillsBody: "Built-in and user skills in one catalog. User and workspace skills can override built-ins by name. Skills are advisory knowledge only and grant no tools or permissions.",
  skillsEmpty: "No skills available",
  skillsEmptyBody: "Drop a SKILL.md under ~/.adpilot/skills or a workspace .adpilot/skills directory and it is discovered.",
  skillTriggers: "Triggers",
  skillSource: "Source: {source}",
  skillSourceBuiltIn: "Built-in",
  skillSourceUser: "User",
  skillSourceWorkspace: "Workspace",
  skillLicense: "License: {license}",
  skillsWarnings: "Some skills failed validation",
  homeBrief: "Ads Daily Brief",
  homeBriefGenerate: "Generate brief",
  homeBriefGenerating: "Generating the brief…",
  homeBriefIdle: "Generate a brief — facts are assembled automatically from accounts, campaigns, creatives and decisions.",
  homeBriefEmpty: "No open findings",
  homeBriefSummary: "{total} findings · {critical} critical · {warning} warnings",
  homeBriefGeneratedAt: "Generated {time}",
  briefEvidence: "Evidence",
  briefNoEvidence: "No evidence ids",
  briefSectionAnomalyAccounts: "Anomalous accounts",
  briefSectionCreativeFatigue: "Creative fatigue",
  briefSectionLearningPhaseRisks: "Learning-phase risks",
  briefSectionPendingObservations: "Awaiting observation",
  briefSectionPendingApprovals: "Awaiting approval",
  briefSectionPendingReports: "Reports to send",
  briefSectionMeasurementIssues: "Measurement reminders",
  decisionQueue: "Action queue",
  decisionQueueEmpty: "No decisions yet",
  decisionQueueEmptyBody: "Decisions record a recommendation with rationale, risks and a rollback plan in the ledger, then move through approval, execution and observation.",
  decisionNew: "New decision",
  decisionCreateTitle: "New decision",
  decisionRecommendationLabel: "Recommendation",
  decisionRecommendationPlaceholder: "e.g. Raise tCPA by 10%, observe for 3 days",
  decisionConfidenceLabel: "Confidence",
  decisionConfidenceLow: "Low",
  decisionConfidenceMedium: "Medium",
  decisionConfidenceHigh: "High",
  decisionRationaleLabel: "Rationale (one per line)",
  decisionRisksLabel: "Risks (one per line)",
  decisionObservationWindowLabel: "Observation window (optional)",
  decisionObservationWindowPlaceholder: "e.g. 3 days / 2 conversion cycles",
  decisionRollbackPlanLabel: "Rollback plan (optional)",
  decisionCreate: "Create decision",
  decisionRationale: "Rationale",
  decisionRisks: "Risks",
  decisionEvidence: "Evidence",
  decisionDuplicate: "An identical recommendation already exists — highlighted below",
  decisionStatusProposed: "Proposed",
  decisionStatusApproved: "Approved",
  decisionStatusExecuted: "Executed",
  decisionStatusObserving: "Observing",
  decisionStatusSuccessful: "Successful",
  decisionStatusFailed: "Failed",
  decisionStatusReverted: "Reverted",
  decisionApprove: "Approve",
  decisionReject: "Reject",
  decisionMarkExecuted: "Mark executed",
  decisionStartObserving: "Start observing",
  decisionMarkSuccessful: "Successful",
  decisionRevert: "Fail & roll back"
};

export type WorkspaceCopy = { readonly [K in keyof typeof workspaceZh]: string };

export function workspaceCopy(locale: AppLocale): WorkspaceCopy {
  return locale === "zh-CN" ? workspaceZh : workspaceEn;
}

export function projectTypeLabel(type: string, locale: AppLocale): string {
  const copy = workspaceCopy(locale);
  const labels: Record<string, string> = {
    general: copy.typeGeneral,
    advertising: copy.typeAdvertising,
    development: copy.typeDevelopment,
    research: copy.typeResearch,
    creative: copy.typeCreative
  };
  return labels[type] ?? humanize(type);
}

export function kernelTaskStatusLabel(status: string, locale: AppLocale): string {
  const copy = workspaceCopy(locale);
  const labels: Record<string, string> = {
    queued: copy.statusQueued,
    running: copy.statusRunning,
    blocked: copy.statusBlocked,
    waiting_approval: copy.statusWaitingApproval,
    completed: copy.statusCompleted,
    failed: copy.statusFailed
  };
  return labels[status] ?? humanize(status);
}

export function kernelTaskStatusTone(status: string): "accent" | "success" | "warning" | "danger" | "neutral" {
  if (status === "running") return "accent";
  if (status === "queued") return "neutral";
  if (status === "blocked" || status === "waiting_approval") return "warning";
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "neutral";
}

export function goalStatusLabel(status: string, locale: AppLocale): string {
  const copy = workspaceCopy(locale);
  const labels: Record<string, string> = {
    draft: copy.goalDraft,
    active: copy.goalActive,
    blocked: copy.statusBlocked,
    waiting_approval: copy.statusWaitingApproval,
    completed: copy.statusCompleted,
    failed: copy.statusFailed
  };
  return labels[status] ?? humanize(status);
}

export function goalStatusTone(status: string): "accent" | "success" | "warning" | "danger" | "neutral" {
  if (status === "active") return "accent";
  if (status === "blocked" || status === "waiting_approval") return "warning";
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "neutral";
}

export function artifactTypeLabel(type: string, locale: AppLocale): string {
  const copy = workspaceCopy(locale);
  const labels: Record<string, string> = {
    slides: copy.artifactSlides,
    document: copy.artifactDocument,
    spreadsheet: copy.artifactSpreadsheet,
    code: copy.artifactCode,
    pdf: copy.artifactPdf,
    website: copy.artifactWebsite,
    image: copy.artifactImage,
    video: copy.artifactVideo,
    interactive: copy.artifactInteractive,
    report: copy.artifactReport
  };
  return labels[type] ?? humanize(type);
}

export function artifactStatusLabel(status: string, locale: AppLocale): string {
  const copy = workspaceCopy(locale);
  const labels: Record<string, string> = {
    draft: copy.artifactDraft,
    rendering: copy.artifactRendering,
    ready: copy.artifactReady,
    failed: copy.artifactFailed
  };
  return labels[status] ?? humanize(status);
}

export function artifactStatusTone(status: string): "accent" | "success" | "warning" | "danger" | "neutral" {
  if (status === "ready") return "success";
  if (status === "rendering") return "accent";
  if (status === "failed") return "danger";
  return "neutral";
}


/* ------------------------------------------------------------------ */
/* Automation copy helpers                                             */
/* ------------------------------------------------------------------ */

export function automationStateLabel(state: string, locale: AppLocale): string {
  const copy = workspaceCopy(locale);
  const labels: Record<string, string> = {
    active: copy.automationStateActive,
    paused: copy.automationStatePaused
  };
  return labels[state] ?? humanize(state);
}

export function automationStateTone(state: string): "accent" | "success" | "warning" | "danger" | "neutral" {
  if (state === "active") return "success";
  if (state === "paused") return "neutral";
  return "neutral";
}

export function automationRunStatusLabel(status: string, locale: AppLocale): string {
  const copy = workspaceCopy(locale);
  const labels: Record<string, string> = {
    running: copy.runRunning,
    succeeded: copy.runSucceeded,
    failed: copy.runFailed,
    "skipped-duplicate": copy.runSkippedDuplicate,
    "waiting-approval": copy.runWaitingApproval
  };
  return labels[status] ?? humanize(status);
}

export function automationRunStatusTone(status: string): "accent" | "success" | "warning" | "danger" | "neutral" {
  if (status === "running") return "accent";
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "waiting-approval") return "warning";
  return "neutral";
}

/** Human-readable, localized rendering of a structured cron description. */
export function cronDescriptionText(description: CronDescription, locale: AppLocale): string {
  const copy = workspaceCopy(locale);
  if (description.kind === "every-minute") return copy.cronEveryMinute;
  if (description.kind === "hourly") return interpolate(copy.cronHourly, { minute: String(description.minute) });
  if (description.kind === "daily") return interpolate(copy.cronDaily, { time: description.time });
  if (description.kind === "weekly") {
    const dow = copy[`dow${description.dow}` as keyof typeof copy] ?? String(description.dow);
    return interpolate(copy.cronWeekly, { dow, time: description.time });
  }
  if (description.kind === "monthly") {
    return interpolate(copy.cronMonthly, { dom: String(description.dom), time: description.time });
  }
  return description.text;
}

/** One-line trigger summary for the automation list rows. */
export function automationTriggerText(trigger: AutomationTrigger, locale: AppLocale): string {
  if (trigger.kind === "schedule") return cronDescriptionText(describeCron(trigger.cron), locale);
  const copy = workspaceCopy(locale);
  return interpolate(copy.automationEventPrefix, { event: trigger.event });
}

/* ------------------------------------------------------------------ */
/* Ads copy helpers (Daily Brief + decision queue)                     */
/* ------------------------------------------------------------------ */

export function briefSectionLabel(key: BriefSectionKey, locale: AppLocale): string {
  const copy = workspaceCopy(locale);
  const labels: Record<BriefSectionKey, string> = {
    anomalyAccounts: copy.briefSectionAnomalyAccounts,
    creativeFatigue: copy.briefSectionCreativeFatigue,
    learningPhaseRisks: copy.briefSectionLearningPhaseRisks,
    pendingObservations: copy.briefSectionPendingObservations,
    pendingApprovals: copy.briefSectionPendingApprovals,
    pendingReports: copy.briefSectionPendingReports,
    measurementIssues: copy.briefSectionMeasurementIssues
  };
  return labels[key];
}

export function briefSeverityTone(severity: BriefSeverity): "neutral" | "warning" | "danger" {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  return "neutral";
}

export function decisionStatusLabel(status: DecisionStatus, locale: AppLocale): string {
  const copy = workspaceCopy(locale);
  const labels: Record<DecisionStatus, string> = {
    proposed: copy.decisionStatusProposed,
    approved: copy.decisionStatusApproved,
    executed: copy.decisionStatusExecuted,
    observing: copy.decisionStatusObserving,
    successful: copy.decisionStatusSuccessful,
    failed: copy.decisionStatusFailed,
    reverted: copy.decisionStatusReverted
  };
  return labels[status] ?? humanize(status);
}

export function decisionStatusTone(status: DecisionStatus): "accent" | "success" | "warning" | "danger" | "neutral" {
  if (status === "proposed") return "warning";
  if (status === "approved" || status === "observing") return "accent";
  if (status === "successful") return "success";
  if (status === "failed") return "danger";
  return "neutral";
}

export function decisionConfidenceLabel(confidence: DecisionConfidence, locale: AppLocale): string {
  const copy = workspaceCopy(locale);
  const labels: Record<DecisionConfidence, string> = {
    low: copy.decisionConfidenceLow,
    medium: copy.decisionConfidenceMedium,
    high: copy.decisionConfidenceHigh
  };
  return labels[confidence] ?? humanize(confidence);
}
