/**
 * Single source of truth for every user-facing string in the desktop app:
 * console copy, settings copy, computer-use copy, and all enum label
 * localizers. Pure module — no React, no fetch — so it stays trivially
 * testable and tree-shakeable.
 */

export type AppLocale = "zh-CN" | "en";

/* ------------------------------------------------------------------ */
/* Console copy                                                        */
/* ------------------------------------------------------------------ */

const zh = {
  boot: "正在载入工作台",
  brandLine: "广告优化工作台",
  workspace: "工作区",
  noWorkspace: "尚无工作区",
  systemsNominal: "系统正常",
  groundingOffline: "视觉模型离线",
  conversationReady: "对话已就绪",
  modelRequired: "连接模型后即可对话",
  settings: "设置",
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
  currentMicroTask: "当前微任务",
  standby: "待命",
  oneAction: "每次只执行一个经过验证的视觉动作",
  pause: "暂停",
  takeOver: "接管",
  resume: "恢复",
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
  restoreSession: "恢复",
  renameSession: "重命名",
  pinSession: "置顶",
  unpinSession: "取消置顶",
  emptySessions: "还没有会话",
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
  noWorkspace: "No workspace",
  systemsNominal: "Systems nominal",
  groundingOffline: "Vision model offline",
  conversationReady: "Chat ready",
  modelRequired: "Connect a model to start chatting",
  settings: "Settings",
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
  currentMicroTask: "Current micro-task",
  standby: "Standby",
  oneAction: "One verified visual action at a time",
  pause: "Pause",
  takeOver: "Take over",
  resume: "Resume",
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
  restoreSession: "Restore",
  renameSession: "Rename",
  pinSession: "Pin",
  unpinSession: "Unpin",
  emptySessions: "No conversations yet",
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

/**
 * Empty-state suggestion cards: a short display title plus the exact
 * directive sent when the card is picked. Clicking a card submits the
 * prompt immediately (Codex-style), it does not stage text in the composer.
 */
export function starterCards(locale: AppLocale): { title: string; prompt: string }[] {
  return locale === "zh-CN" ? [
    { title: "诊断投放不足", prompt: "检查投放不足的根因，并给出可审批的预算建议" },
    { title: "审计转化测量", prompt: "审计转化测量是否可信，列出缺失证据" },
    { title: "解析 CPA 异常", prompt: "找出近 7 天 CPA 异常上升的主要驱动因素" },
    { title: "生成投放日报", prompt: "/report daily" }
  ] : [
    { title: "Diagnose underspend", prompt: "Find the cause of underspend and propose an approvable budget change" },
    { title: "Audit conversion tracking", prompt: "Audit conversion measurement and list the missing evidence" },
    { title: "Explain the CPA spike", prompt: "Explain the primary drivers of the seven-day CPA increase" },
    { title: "Daily performance report", prompt: "/report daily" }
  ];
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
  title: "设置", close: "关闭设置", navigation: "设置导航", general: "通用", models: "模型", computer: "电脑控制", about: "关于", connections: "已配置连接", loading: "正在读取安全配置", loadingFailed: "无法读取设置", retry: "重试",
  generalTitle: "语言与外观", generalBody: "界面在任一时刻只使用一种语言。产品名和模型名保持原名。", language: "界面语言", languageHint: "应用到操作台和设置页", appearance: "显示模式", appearanceHint: "选择深色、浅色或跟随系统", dark: "深色", light: "浅色", system: "跟随系统", localeRule: "保存后界面会立即切换；模型配置需要重启运行时。",
  modelsTitle: "模型路由", modelsBody: "选择日常对话模型和高强度推理模型；支持看图的代码模型会自动作为电脑控制的视觉模型。", fastRoute: "日常模型", fastHint: "自然对话、分类、报告与普通任务", strongRoute: "深度模型", strongHint: "因果分析、风险复核与失败升级",
  runtimeRoutes: "运行时", runtimeRoutesTitle: "当前生效的模型路由",
  providerConnection: "供应商连接", credentials: "凭据", providers: "个供应商", provider: "供应商", model: "模型", visionCapability: "视觉", apiKey: "API 密钥", modelsCount: "个模型", noStaticModels: "该供应商使用动态模型目录，首次认证后获取。",
  oauthTitle: "订阅账户登录", oauthBody: "通过 Pi 的原生授权流程连接订阅账户；访问令牌只保存在本机工作区。", oauthConnected: "OAuth 已连接", connect: "连接账户", connecting: "连接中", disconnect: "断开连接", openAuthorization: "请在浏览器中完成授权。", openBrowser: "打开浏览器", deviceCode: "在授权页面输入此代码", choose: "请选择", continue: "继续", oauthWaiting: "正在等待授权供应商响应。", oauthSelectPrompt: "请选择授权账户。", oauthCodePrompt: "请输入授权页面显示的代码。", oauthSecretPrompt: "请输入授权流程要求的安全值。", oauthInputPrompt: "请输入授权流程要求的信息。", oauthInputPlaceholder: "在此输入", oauthComplete: "授权完成，重启后即可使用。", oauthFailed: "OAuth 授权失败",
  computerTitle: "电脑控制", computerBody: "使用日常与深度代码模型完成看图、定位和复核。专用视觉端点属于可选的高级设置。", computerNote: "系统每次只执行一个可校验动作。账户修改仍需要实时窗口绑定、独立身份校验、风险复核和一次性批准。", showAdvanced: "显示高级开发者设置", hideAdvanced: "收起高级开发者设置",
  visualPrimary: "截图与动作", visualReview: "结果复核", chatStatus: "自然语言对话", visionStatus: "电脑控制", ready: "已就绪", needsCredential: "需要供应商凭据", needsVision: "请选择支持图像且已认证的代码模型",
  aboutTitle: "系统清单", aboutBody: "本地优先、证据驱动、审批后执行的广告优化智能体。", runtime: "主运行时", visualRuntime: "视觉执行", strategyCore: "广告策略核心", providersAvailable: "可用供应商", legal: "真实账户修改需要独立风险复核、用户批准和一次性执行令牌。完整许可证随应用分发。", localStorage: "配置保存在本机工作区，不会通过设置接口返回密钥明文。",
  save: "保存配置", saving: "正在保存", saved: "配置已保存；模型路由将在重启后生效。", saveFailed: "保存配置失败", reloadFailed: "无法重新读取配置", restartNow: "立即重启", restartManual: "请关闭并重新启动 AdPilot"
} as const;

const settingsEn: Record<keyof typeof settingsZh, string> = {
  title: "Settings", close: "Close settings", navigation: "Settings navigation", general: "General", models: "Models", computer: "Computer use", about: "About", connections: "Configured connections", loading: "Loading secure settings", loadingFailed: "Could not load settings", retry: "Retry",
  generalTitle: "Language and appearance", generalBody: "The interface uses one language at a time. Product and model names retain their proper names.", language: "Interface language", languageHint: "Applies to the console and settings", appearance: "Appearance", appearanceHint: "Choose dark, light, or system mode", dark: "Dark", light: "Light", system: "System", localeRule: "The interface changes immediately after saving. Model settings require a runtime restart.",
  modelsTitle: "Model routing", modelsBody: "Choose daily and high-assurance reasoning models. Image-capable code models become the Computer Use vision models automatically.", fastRoute: "Daily model", fastHint: "Natural conversation, classification, reports, and routine work", strongRoute: "Deep model", strongHint: "Causal analysis, risk review, and failure escalation",
  runtimeRoutes: "Runtime", runtimeRoutesTitle: "Effective model routing",
  providerConnection: "Provider connection", credentials: "Credentials", providers: "providers", provider: "Provider", model: "Model", visionCapability: "vision", apiKey: "API key", modelsCount: "models", noStaticModels: "This provider uses a dynamic model catalog fetched after authentication.",
  oauthTitle: "Subscription login", oauthBody: "Connect a subscription account through Pi's native authorization flow. Tokens remain in the local workspace.", oauthConnected: "OAuth connected", connect: "Connect account", connecting: "Connecting", disconnect: "Disconnect", openAuthorization: "Complete authorization in your browser.", openBrowser: "Open browser", deviceCode: "Enter this code on the authorization page", choose: "Choose an option", continue: "Continue", oauthWaiting: "Waiting for the provider to continue authorization.", oauthSelectPrompt: "Choose the account to authorize.", oauthCodePrompt: "Enter the code shown on the authorization page.", oauthSecretPrompt: "Enter the secure value requested by the authorization flow.", oauthInputPrompt: "Enter the information requested by the authorization flow.", oauthInputPlaceholder: "Enter here", oauthComplete: "Authorization complete. Restart to use this connection.", oauthFailed: "OAuth authorization failed",
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
