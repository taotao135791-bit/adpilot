import "@fontsource-variable/plus-jakarta-sans";
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Button,
  FluentProvider,
  Textarea,
  Tooltip,
  webDarkTheme,
  webLightTheme
} from "@fluentui/react-components";
import {
  Bot24Regular,
  Chat24Regular,
  DataUsage24Regular,
  Desktop24Regular,
  ErrorCircle24Regular,
  Pause24Regular,
  PersonArrowLeft24Regular,
  Play24Regular,
  Send24Regular,
  Settings24Regular,
  ShieldCheckmark24Regular,
  TargetArrow24Regular
} from "@fluentui/react-icons";
import { getCopy, starterGoals, type AppLocale } from "./i18n.js";
import { SettingsPanel, type SettingsData, type SettingsTab } from "./SettingsPanel.js";
import "./styles.css";

type Client = { id: string; name: string; industry: string; timezone: string };
type Task = { id: string; goal: string; phase: string; completedSteps: string[]; blockers: string[]; nextStep: string | null; owner: string | null; reviewAt: string | null; updatedAt: string };
type Approval = { id: string; taskId: string; status: string; executionPlan: { target: string } | null; operation: { account: string; campaign: string; operation: string; currentValue: unknown; proposedValue: unknown; changePercentage: number | null; reason: string; evidence: string[]; expectedImpact: string; observationWindow: string; rollbackCondition: string; riskLevel: string } };
type Experiment = { id: string; hypothesis: string; variable: string; status: string; reviewAt: string };
type Audit = { id: string; actor: string; action: string; status: string; at: string };
type ConversationMessage = { id: string; clientId: string; role: "user" | "assistant" | "system"; content: string; status: "complete" | "error"; taskId?: string; at: string };
type ProductEvent = { type: string; status?: string; message?: string; approvalId?: string; event?: { type: string; phase?: string; attempt?: number; screenshot?: { base64: string; capturedAt: string }; action?: { action: string; target: string; reason: string }; reason?: string } };
type State = { clients: Client[]; selectedClientId?: string; tasks: Task[]; approvals: Approval[]; experiments: Experiment[]; audit: Audit[]; messages: ConversationMessage[]; events: ProductEvent[]; models: { fast: string; strong: string; gui: string; guiStrong: string; chatConfigured: boolean; guiConfigured: boolean } };

const emptyState: State = { clients: [], tasks: [], approvals: [], experiments: [], audit: [], messages: [], events: [], models: { fast: "", strong: "", gui: "", guiStrong: "", chatConfigured: false, guiConfigured: false } };
function App() {
  const isNativeDesktop = new URLSearchParams(window.location.search).get("desktop") === "1";
  const [locale, setLocale] = useState<AppLocale>(() => localStorage.getItem("adpilot-locale") === "en" ? "en" : "zh-CN");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("adpilot-theme");
    return stored === "light" || stored === "dark" ? stored : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [state, setState] = useState<State>(emptyState);
  const [clientId, setClientId] = useState("");
  const [goal, setGoal] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [computerMode, setComputerMode] = useState<"running" | "paused" | "takeover">("running");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [settingsData, setSettingsData] = useState<SettingsData>();
  const copy = getCopy(locale);

  const loadState = useCallback(async (requestedClientId?: string) => {
    try {
      const selected = requestedClientId ?? clientId;
      const response = await fetch(`/api/state${selected ? `?clientId=${encodeURIComponent(selected)}` : ""}`);
      if (!response.ok) throw new Error(getCopy(locale).loadError);
      const data = await response.json() as State;
      setState(data);
      if (!clientId && data.selectedClientId) setClientId(data.selectedClientId);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [clientId, locale]);

  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings");
      if (!response.ok) throw new Error(getCopy(locale).settingsLoadError);
      applySettings(await response.json() as SettingsData);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [locale]);

  useEffect(() => { void loadState(); }, []);
  useEffect(() => { void loadSettings(); }, []);
  useEffect(() => {
    const source = new EventSource("/events");
    source.onmessage = () => void loadState();
    source.onerror = () => setError(getCopy(locale).connectionError);
    return () => source.close();
  }, [loadState, locale]);

  const currentTask = state.tasks[0];
  const latestComputer = [...state.events].reverse().find((item) => item.type === "computer")?.event;
  const latestShot = [...state.events].reverse().find((item) => item.type === "computer" && item.event?.type === "screenshot")?.event?.screenshot;
  const activeAgents = useMemo(() => {
    const roles = new Set(state.tasks.map((task) => task.owner).filter(Boolean) as string[]);
    if (currentTask && !["completed", "blocked", "cancelled"].includes(currentTask.phase)) roles.add("adpilot_agent");
    return [...roles];
  }, [state.tasks, currentTask]);
  const pendingApprovals = state.approvals.filter((item) => !["executed", "rejected", "failed"].includes(item.status)).length;

  function applySettings(data: SettingsData) {
    setSettingsData(data);
    setLocale(data.locale);
    const nextTheme = data.appearance === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : data.appearance;
    setTheme(nextTheme);
    localStorage.setItem("adpilot-locale", data.locale);
    localStorage.setItem("adpilot-theme", nextTheme);
  }

  async function submitGoal() {
    if (!state.models.chatConfigured) { setSettingsTab("models"); setSettingsOpen(true); return; }
    if (!goal.trim()) return;
    const message = goal.trim();
    setSubmitting(true); setError("");
    setGoal("");
    setState((current) => ({ ...current, messages: [...current.messages, { id: `local-${Date.now()}`, clientId: clientId || "personal", role: "user", content: message, status: "complete", at: new Date().toISOString() }] }));
    try {
      const response = await fetch("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(clientId ? { clientId } : {}), message, locale }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? copy.taskError);
      await loadState(clientId || body.message?.clientId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await loadState(clientId); }
    finally { setSubmitting(false); }
  }

  async function computerControl(action: "pause" | "resume" | "takeover") {
    await fetch(`/api/computer/${action}`, { method: "POST" });
    setComputerMode(action === "resume" ? "running" : action === "pause" ? "paused" : "takeover");
  }

  async function riskReview(approval: Approval) {
    const response = await fetch(`/api/approvals/${approval.id}/risk-review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) });
    const body = await response.json(); if (!response.ok) setError(body.error ?? copy.riskError); await loadState(clientId);
  }

  async function approve(approval: Approval) {
    const response = await fetch(`/api/approvals/${approval.id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, approvedBy: "workspace-owner" }) });
    const body = await response.json(); if (!response.ok) setError(body.error ?? copy.approvalError); await loadState(clientId);
  }

  async function commit(approval: Approval) {
    const response = await fetch(`/api/approvals/${approval.id}/commit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) });
    const body = await response.json(); if (!response.ok) setError(body.error ?? copy.executionError); await loadState(clientId);
  }

  if (loading) return (
    <FluentProvider theme={theme === "dark" ? webDarkTheme : webLightTheme}>
      <div className="boot" data-theme={theme}>
        <div className="boot-lockup"><span className="brand-glyph">AP</span><strong>ADPILOT</strong></div>
        <div className="boot-track"><span /></div>
        <p>{copy.boot}</p>
      </div>
    </FluentProvider>
  );

  return (
    <FluentProvider theme={theme === "dark" ? webDarkTheme : webLightTheme} className="provider">
      <div className="shell" data-theme={theme} data-native={isNativeDesktop}>
        <header className="topbar">
          <div className="brand"><span className="brand-glyph">AP</span><div><strong>AdPilot</strong><small>{copy.brandLine}</small></div></div>
          <div className="workspace-switcher">
            <span className="status-orbit" data-live={Boolean(clientId)} />
            <label htmlFor="client-select">{copy.workspace}</label>
            {state.clients.length ? (
              <select id="client-select" value={clientId} onChange={(event) => { setClientId(event.target.value); void loadState(event.target.value); }}>
                {state.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
              </select>
            ) : <strong>{copy.noWorkspace}</strong>}
          </div>
          <div className="top-status">
            <span className="live-label"><i data-ready={state.models.chatConfigured} />{state.models.chatConfigured ? copy.conversationReady : copy.modelRequired}</span>
            <Tooltip content={copy.settings} relationship="label"><Button className="icon-button" appearance="subtle" icon={<Settings24Regular />} onClick={() => { setSettingsTab("general"); setSettingsOpen(true); if (!settingsData) void loadSettings(); }} /></Tooltip>
          </div>
        </header>

        <aside className="sidebar">
          <nav aria-label={copy.navigation}>
            <Nav icon={<Chat24Regular />} label={copy.mission} active onClick={() => document.querySelector(".main-column")?.scrollTo({ top: 0, behavior: "smooth" })} />
            <Nav icon={<TargetArrow24Regular />} label={copy.tests} count={state.experiments.length} onClick={() => document.querySelector(".experiments-panel")?.scrollIntoView({ behavior: "smooth" })} />
            <Nav icon={<ShieldCheckmark24Regular />} label={copy.review} count={pendingApprovals} onClick={() => document.querySelector(".queue-panel")?.scrollIntoView({ behavior: "smooth" })} />
            <Nav icon={<DataUsage24Regular />} label={copy.ledger} count={state.audit.length} onClick={() => document.querySelector(".audit-panel")?.scrollIntoView({ behavior: "smooth" })} />
          </nav>
          <div className="dock-index"><span>01</span><i /><span>04</span></div>
          <button className="dock-help" onClick={() => { setSettingsTab("about"); setSettingsOpen(true); }} aria-label={copy.settings}>?</button>
        </aside>

        <main className="main-column">
          {error && <div className="error-banner"><ErrorCircle24Regular /><span>{error}</span><Button size="small" appearance="subtle" onClick={() => void loadState()}>{copy.retry}</Button></div>}

          {currentTask ? (
            <>
              <section className="task-header">
                <div><span className="section-kicker">{copy.activeMission} / {currentTask.id.slice(0, 6)}</span><h1>{currentTask.goal}</h1><p>{currentTask.nextStep ? nextStepLabel(currentTask.nextStep, locale) : copy.preparingEvidence}</p></div>
                <Badge appearance="filled" color={phaseColor(currentTask.phase)}>{phaseLabel(currentTask.phase, locale)}</Badge>
              </section>
              <section className="task-ledger">
                <Metric label={copy.evidenceSteps} value={String(currentTask.completedSteps.length).padStart(2, "0")} />
                <Metric label={copy.blockers} value={String(currentTask.blockers.length).padStart(2, "0")} />
                <Metric label={copy.operator} value={currentTask.owner ? roleLabel(currentTask.owner, locale) : copy.agent} compact />
                <Metric label={copy.reviewWindow} value={currentTask.reviewAt ? formatTime(currentTask.reviewAt, locale) : copy.unscheduled} compact />
              </section>
            </>
          ) : state.messages.length === 0 ? <MissionZero onPick={setGoal} guiReady={state.models.guiConfigured} clients={state.clients.length} locale={locale} /> : null}

          {(state.messages.length > 0 || submitting) && <section className="conversation" aria-label={copy.mission}>
            {state.messages.map((item) => (
              <article className={`message ${item.role} ${item.status}`} key={item.id}>
                <div className="message-avatar">{item.role === "system" ? <ErrorCircle24Regular /> : item.role === "assistant" ? <Bot24Regular /> : <span>{locale === "zh-CN" ? "你" : "Y"}</span>}</div>
                <div><strong>{item.role === "user" ? copy.you : item.role === "system" ? copy.system : copy.agent}</strong><p>{item.content}</p><time>{formatTime(item.at, locale)}</time></div>
              </article>
            ))}
            {submitting && <div className="thinking"><span className="thinking-pulse" /><span>{copy.investigating}</span></div>}
          </section>}

          <div className="composer-shell">
            <div className="composer">
              <div className="composer-copy"><span>{copy.directive}</span><small>{copy.launchHint}</small></div>
              <Textarea resize="vertical" value={goal} onChange={(_, data) => setGoal(data.value)} placeholder={copy.goalPlaceholder} aria-label={copy.goalLabel} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submitGoal(); }} />
              <Button className="launch-button" appearance="primary" icon={<Send24Regular />} disabled={state.models.chatConfigured && (!goal.trim() || submitting)} onClick={() => void submitGoal()}>{!state.models.chatConfigured ? copy.configureModel : submitting ? copy.investigatingShort : copy.send}</Button>
            </div>
          </div>
        </main>

        <aside className="operation-rail">
          <div className="rail-heading"><div><span className="section-kicker">{copy.liveOperations}</span><h2>{copy.executionStack}</h2></div><span className="rail-clock">{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())}</span></div>

          <section className="computer-panel panel-shell">
            <div className="panel-heading"><div><Desktop24Regular /><h2>{copy.computer}</h2></div><span className={`mode-pill ${computerMode}`}>{computerMode === "running" ? copy.live : computerMode === "paused" ? copy.paused : copy.takeover}</span></div>
            <div className="screen-bezel">
              <div className="screen-frame">
                {latestShot ? <img src={`data:image/png;base64,${latestShot.base64}`} alt={copy.screenshotAlt} /> : <div className="screen-idle"><span className="scanline" /><i>AP</i><strong>{copy.visualChannel}</strong><small>{state.models.guiConfigured ? copy.awaitingSignal : copy.modelNotConfigured}</small></div>}
                {latestComputer?.type === "grounded" && latestComputer.action && <div className="action-overlay"><strong>{visualActionLabel(latestComputer.action.action, locale)}</strong><span>{latestComputer.action.target}</span></div>}
              </div>
            </div>
            <div className="micro-task"><span>{copy.currentMicroTask}</span><strong>{latestComputer?.action?.target ?? copy.standby}</strong><small>{latestComputer?.action?.reason ?? copy.oneAction}</small></div>
            <div className="control-row">
              <Button icon={<Pause24Regular />} disabled={computerMode !== "running"} onClick={() => void computerControl("pause")}>{copy.pause}</Button>
              <Button icon={<PersonArrowLeft24Regular />} onClick={() => void computerControl("takeover")}>{copy.takeOver}</Button>
              <Button appearance="primary" icon={<Play24Regular />} disabled={computerMode === "running"} onClick={() => void computerControl("resume")}>{copy.resume}</Button>
            </div>
          </section>

          <section className="system-panel panel-shell">
            <div className="panel-heading"><div><Bot24Regular /><h2>{copy.agentNetwork}</h2></div><span className="network-count">{activeAgents.length || 1} / 07</span></div>
            <div className="agent-network">
              <div className="network-core">AP</div>
              <div><strong>{activeAgents.length ? activeAgents.map((role) => roleLabel(role, locale)).join(" · ") : copy.coordinatorReady}</strong><span>{currentTask ? copy.specialistsAttached : copy.waitingDirective}</span></div>
            </div>
            <div className="model-grid">
              <ModelRow label={copy.fast} value={state.models.fast} empty={copy.unassigned} />
              <ModelRow label={copy.deep} value={state.models.strong} empty={copy.unassigned} />
              <ModelRow label={copy.vision} value={state.models.gui} warn={!state.models.guiConfigured} empty={copy.unassigned} />
              <ModelRow label={copy.visionPlus} value={state.models.guiStrong} warn={!state.models.guiConfigured} empty={copy.unassigned} />
            </div>
          </section>

          <section className="queue-panel panel-shell">
            <div className="panel-heading"><div><ShieldCheckmark24Regular /><h2>{copy.approvalGate}</h2></div><span className="section-count">{String(state.approvals.length).padStart(2, "0")}</span></div>
            {state.approvals.length ? state.approvals.slice().reverse().map((approval) => (
              <article className="approval-item" key={approval.id}>
                <div><strong>{operationLabel(approval.operation.operation, locale)}</strong><Badge appearance="outline" color={approval.status === "rejected" || approval.status === "failed" ? "danger" : approval.status === "executed" ? "success" : "warning"}>{approvalStatusLabel(approval.status, locale)}</Badge></div>
                <p>{approval.operation.campaign}</p>
                <dl><div><dt>{copy.current}</dt><dd>{String(approval.operation.currentValue)}</dd></div><div><dt>{copy.proposed}</dt><dd>{String(approval.operation.proposedValue)}</dd></div></dl>
                {approval.status === "pending_risk_review" && <Button size="small" onClick={() => void riskReview(approval)}>{copy.runRisk}</Button>}
                {approval.status === "pending_user" && <Button size="small" appearance="primary" onClick={() => void approve(approval)}>{copy.approveOnce}</Button>}
                {approval.status === "approved" && <Button size="small" appearance="primary" disabled={!approval.executionPlan} onClick={() => void commit(approval)}>{approval.executionPlan ? copy.executeApproved : copy.missingPlan}</Button>}
              </article>
            )) : <Empty title={copy.gateClear} body={copy.gateClearBody} />}
          </section>

          <section className="experiments-panel panel-shell compact-panel">
            <div className="panel-heading"><div><TargetArrow24Regular /><h2>{copy.experiments}</h2></div><span className="section-count">{String(state.experiments.length).padStart(2, "0")}</span></div>
            {state.experiments.length ? state.experiments.slice(0, 3).map((experiment) => <div className="experiment-row" key={experiment.id}><div><strong>{variableLabel(experiment.variable, locale)}</strong><span>{experiment.hypothesis}</span></div><Badge appearance="outline">{experimentStatusLabel(experiment.status, locale)}</Badge></div>) : <Empty title={copy.noTests} body={copy.noTestsBody} />}
          </section>

          <section className="audit-panel panel-shell compact-panel">
            <div className="panel-heading"><div><DataUsage24Regular /><h2>{copy.auditTrace}</h2></div></div>
            {state.audit.length ? state.audit.slice(-4).reverse().map((event) => <div className="audit-row" key={event.id}><span>{auditActionLabel(event.action, locale)}</span><time>{formatTime(event.at, locale)}</time></div>) : <Empty title={copy.tracePristine} body={copy.traceBody} />}
          </section>
        </aside>
        <SettingsPanel open={settingsOpen} data={settingsData} initialTab={settingsTab} onClose={() => setSettingsOpen(false)} onSaved={applySettings} />
      </div>
    </FluentProvider>
  );
}

function MissionZero({ onPick, guiReady, clients, locale }: { onPick: (goal: string) => void; guiReady: boolean; clients: number; locale: AppLocale }) {
  const copy = getCopy(locale);
  return <section className="mission-zero">
    <div className="mission-copy">
      <span className="section-kicker">{copy.heroKicker}</span>
      <h1>{copy.heroLine1}<br /><em>{copy.heroLine2}</em><br />{copy.heroLine3}</h1>
      <p>{copy.heroBody}</p>
    </div>
    <div className="mission-orbit" aria-hidden="true"><span className="orbit orbit-one" /><span className="orbit orbit-two" /><span className="orbit-core">AP<i /></span><b>{copy.autonomy.split("\n").map((line: string, index: number) => <span key={line}>{index > 0 && <br />}{line}</span>)}</b></div>
    <div className="starter-grid">
      {starterGoals(locale).map((item: string, index: number) => <button key={item} onClick={() => onPick(item)}><span>0{index + 1}</span><strong>{item}</strong><i>↗</i></button>)}
    </div>
    <div className="readiness-strip">
      <Readiness label={copy.workspaceReady} value={clients ? copy.connected : copy.required} ready={clients > 0} />
      <Readiness label={copy.vision} value={guiReady ? copy.ready : copy.offline} ready={guiReady} />
      <Readiness label={copy.safetyGate} value={copy.enforced} ready />
    </div>
  </section>;
}

function Readiness({ label, value, ready }: { label: string; value: string; ready: boolean }) { return <div className="readiness"><span>{label}</span><strong><i data-ready={ready} />{value}</strong></div>; }
function Metric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) { return <div className={compact ? "compact" : ""}><span>{label}</span><strong>{value}</strong></div>; }
function Nav({ icon, label, count, active = false, onClick }: { icon: React.ReactNode; label: string; count?: number; active?: boolean; onClick: () => void }) { return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span>{count !== undefined && count > 0 && <b>{count}</b>}</button>; }
function ModelRow({ label, value, warn = false, empty }: { label: string; value: string; warn?: boolean; empty: string }) { return <div className="model-row"><span>{label}</span><strong className={warn ? "warn" : ""}>{!value || value === "not configured" ? empty : value}</strong></div>; }
function Empty({ title, body }: { title: string; body: string }) { return <div className="empty"><i>—</i><strong>{title}</strong><span>{body}</span></div>; }
function formatTime(value: string, locale: AppLocale) { return new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function roleLabel(role: string, locale: AppLocale) {
  const zh = { adpilot_agent: "AdPilot 智能体", account_operator: "账户操作员", performance_analyst: "效果分析师", media_buyer: "媒介投手", measurement_reviewer: "测量复核员", creative_strategist: "创意策略师", risk_reviewer: "风险复核员" } as Record<string, string>;
  const en = { adpilot_agent: "AdPilot agent", account_operator: "Account operator", performance_analyst: "Performance analyst", media_buyer: "Media buyer", measurement_reviewer: "Measurement reviewer", creative_strategist: "Creative strategist", risk_reviewer: "Risk reviewer" } as Record<string, string>;
  return (locale === "zh-CN" ? zh : en)[role] ?? role;
}
function phaseLabel(phase: string, locale: AppLocale) {
  const zh = { intake: "接收目标", investigating: "调查中", analyzing: "分析中", reviewing_risk: "风险复核", awaiting_approval: "等待审批", executing: "执行中", verifying: "验证中", monitoring: "观察中", completed: "已完成", blocked: "已阻塞", cancelled: "已取消" } as Record<string, string>;
  const en = { intake: "Intake", investigating: "Investigating", analyzing: "Analyzing", reviewing_risk: "Risk review", awaiting_approval: "Awaiting approval", executing: "Executing", verifying: "Verifying", monitoring: "Monitoring", completed: "Completed", blocked: "Blocked", cancelled: "Cancelled" } as Record<string, string>;
  return (locale === "zh-CN" ? zh : en)[phase] ?? phase;
}
function approvalStatusLabel(status: string, locale: AppLocale) {
  const zh = { pending_risk_review: "等待风险复核", rejected: "已拒绝", pending_user: "等待用户批准", approved: "已批准", executing: "执行中", executed: "已执行", failed: "失败", expired: "已过期", cancelled: "已取消" } as Record<string, string>;
  const en = { pending_risk_review: "Pending risk review", rejected: "Rejected", pending_user: "Pending user approval", approved: "Approved", executing: "Executing", executed: "Executed", failed: "Failed", expired: "Expired", cancelled: "Cancelled" } as Record<string, string>;
  return (locale === "zh-CN" ? zh : en)[status] ?? (locale === "zh-CN" ? "未知状态" : humanize(status));
}
function experimentStatusLabel(status: string, locale: AppLocale) {
  const zh = { draft: "草稿", active: "进行中", waiting: "等待数据", won: "胜出", lost: "未胜出", inconclusive: "结论不足", stopped: "已停止", invalidated: "已失效" } as Record<string, string>;
  const en = { draft: "Draft", active: "Active", waiting: "Waiting for data", won: "Won", lost: "Lost", inconclusive: "Inconclusive", stopped: "Stopped", invalidated: "Invalidated" } as Record<string, string>;
  return (locale === "zh-CN" ? zh : en)[status] ?? (locale === "zh-CN" ? "未知状态" : humanize(status));
}
function operationLabel(operation: string, locale: AppLocale) {
  const zh = { set_daily_budget: "设置每日预算" } as Record<string, string>;
  const en = { set_daily_budget: "Set daily budget" } as Record<string, string>;
  return (locale === "zh-CN" ? zh : en)[operation] ?? (locale === "zh-CN" ? "自定义账户操作" : humanize(operation));
}
function variableLabel(variable: string, locale: AppLocale) {
  const zh = { daily_budget: "每日预算" } as Record<string, string>;
  const en = { daily_budget: "Daily budget" } as Record<string, string>;
  return (locale === "zh-CN" ? zh : en)[variable] ?? (locale === "zh-CN" ? "自定义实验变量" : humanize(variable));
}
function auditActionLabel(action: string, locale: AppLocale) {
  const zh = { read_workspace: "读取工作区", analyze_performance: "分析投放效果", evaluate_change_guardrail: "评估变更护栏", create_approval: "创建审批", write_experiment: "写入实验", execute_visual_task: "执行视觉任务", capture_screen: "捕获画面", click: "点击" } as Record<string, string>;
  const en = { read_workspace: "Read workspace", analyze_performance: "Analyze performance", evaluate_change_guardrail: "Evaluate change guardrail", create_approval: "Create approval", write_experiment: "Write experiment", execute_visual_task: "Execute visual task", capture_screen: "Capture screen", click: "Click" } as Record<string, string>;
  return (locale === "zh-CN" ? zh : en)[action] ?? (locale === "zh-CN" ? "系统操作" : humanize(action));
}
function visualActionLabel(action: string, locale: AppLocale) {
  const zh = { click: "点击", type: "输入", scroll: "滚动", press_key: "按键", wait: "等待", done: "完成", fail: "失败" } as Record<string, string>;
  const en = { click: "Click", type: "Type", scroll: "Scroll", press_key: "Press key", wait: "Wait", done: "Done", fail: "Failed" } as Record<string, string>;
  return (locale === "zh-CN" ? zh : en)[action] ?? (locale === "zh-CN" ? "视觉操作" : humanize(action));
}
function nextStepLabel(step: string, locale: AppLocale) {
  const zh = { "Build an evidence-driven investigation tree": "建立证据驱动的调查树", "Dispatch specialists and collect evidence": "调度专业智能体并收集证据", "Resolve the recorded blocker and retry": "解决已记录的阻塞项并重试" } as Record<string, string>;
  return locale === "zh-CN" ? zh[step] ?? step : step;
}
function humanize(value: string) { return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase()); }
function phaseColor(phase: string): "brand" | "success" | "warning" | "danger" { if (phase === "completed") return "success"; if (phase === "blocked" || phase === "cancelled") return "danger"; if (phase === "awaiting_approval") return "warning"; return "brand"; }

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
