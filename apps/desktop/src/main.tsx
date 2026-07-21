import "@fontsource-variable/plus-jakarta-sans";
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
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
import "./styles.css";

type Client = { id: string; name: string; industry: string; timezone: string };
type Task = { id: string; goal: string; phase: string; completedSteps: string[]; blockers: string[]; nextStep: string | null; owner: string | null; reviewAt: string | null; updatedAt: string };
type Approval = { id: string; taskId: string; status: string; executionPlan: { target: string } | null; operation: { account: string; campaign: string; operation: string; currentValue: unknown; proposedValue: unknown; changePercentage: number | null; reason: string; evidence: string[]; expectedImpact: string; observationWindow: string; rollbackCondition: string; riskLevel: string } };
type Experiment = { id: string; hypothesis: string; variable: string; status: string; reviewAt: string };
type Audit = { id: string; actor: string; action: string; status: string; at: string };
type ProductEvent = { type: string; status?: string; message?: string; approvalId?: string; event?: { type: string; phase?: string; attempt?: number; screenshot?: { base64: string; capturedAt: string }; action?: { action: string; target: string; reason: string }; reason?: string } };
type State = { clients: Client[]; selectedClientId?: string; tasks: Task[]; approvals: Approval[]; experiments: Experiment[]; audit: Audit[]; events: ProductEvent[]; models: { fast: string; strong: string; gui: string; guiStrong: string; guiConfigured: boolean } };

const emptyState: State = { clients: [], tasks: [], approvals: [], experiments: [], audit: [], events: [], models: { fast: "", strong: "", gui: "", guiStrong: "", guiConfigured: false } };
const starterGoals = [
  "检查投放不足的根因，并给出可审批的预算建议",
  "审计转化测量是否可信，列出缺失证据",
  "找出近 7 天 CPA 异常上升的主要驱动因素"
];

function App() {
  const isNativeDesktop = new URLSearchParams(window.location.search).get("desktop") === "1";
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
  const [aboutOpen, setAboutOpen] = useState(false);

  const loadState = useCallback(async (requestedClientId?: string) => {
    try {
      const selected = requestedClientId ?? clientId;
      const response = await fetch(`/api/state${selected ? `?clientId=${encodeURIComponent(selected)}` : ""}`);
      if (!response.ok) throw new Error("无法读取产品状态");
      const data = await response.json() as State;
      setState(data);
      if (!clientId && data.selectedClientId) setClientId(data.selectedClientId);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [clientId]);

  useEffect(() => { void loadState(); }, []);
  useEffect(() => {
    const source = new EventSource("/events");
    source.onmessage = () => void loadState();
    source.onerror = () => setError("实时连接已断开，正在自动重连");
    return () => source.close();
  }, [loadState]);

  const currentTask = state.tasks[0];
  const taskEvents = state.events.filter((item) => item.type === "task" || item.type === "error");
  const latestComputer = [...state.events].reverse().find((item) => item.type === "computer")?.event;
  const latestShot = [...state.events].reverse().find((item) => item.type === "computer" && item.event?.type === "screenshot")?.event?.screenshot;
  const activeAgents = useMemo(() => {
    const roles = new Set(state.tasks.map((task) => task.owner).filter(Boolean) as string[]);
    if (currentTask && !["completed", "blocked", "cancelled"].includes(currentTask.phase)) roles.add("adpilot_agent");
    return [...roles];
  }, [state.tasks, currentTask]);
  const pendingApprovals = state.approvals.filter((item) => !["executed", "rejected", "failed"].includes(item.status)).length;

  function changeTheme(next: "dark" | "light") {
    setTheme(next);
    localStorage.setItem("adpilot-theme", next);
  }

  async function submitGoal() {
    if (!clientId || !goal.trim()) return;
    setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, goal: goal.trim(), sharedFacts: {} }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "任务执行失败");
      setGoal(""); await loadState(clientId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSubmitting(false); }
  }

  async function computerControl(action: "pause" | "resume" | "takeover") {
    await fetch(`/api/computer/${action}`, { method: "POST" });
    setComputerMode(action === "resume" ? "running" : action === "pause" ? "paused" : "takeover");
  }

  async function riskReview(approval: Approval) {
    const response = await fetch(`/api/approvals/${approval.id}/risk-review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) });
    const body = await response.json(); if (!response.ok) setError(body.error ?? "风险复核失败"); await loadState(clientId);
  }

  async function approve(approval: Approval) {
    const response = await fetch(`/api/approvals/${approval.id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, approvedBy: "workspace-owner" }) });
    const body = await response.json(); if (!response.ok) setError(body.error ?? "审批失败"); await loadState(clientId);
  }

  async function commit(approval: Approval) {
    const response = await fetch(`/api/approvals/${approval.id}/commit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) });
    const body = await response.json(); if (!response.ok) setError(body.error ?? "执行失败"); await loadState(clientId);
  }

  if (loading) return (
    <FluentProvider theme={theme === "dark" ? webDarkTheme : webLightTheme}>
      <div className="boot" data-theme={theme}>
        <div className="boot-lockup"><span className="brand-glyph">AP</span><strong>ADPILOT</strong></div>
        <div className="boot-track"><span /></div>
        <p>Assembling your operations workspace</p>
      </div>
    </FluentProvider>
  );

  return (
    <FluentProvider theme={theme === "dark" ? webDarkTheme : webLightTheme} className="provider">
      <div className="shell" data-theme={theme} data-native={isNativeDesktop}>
        <header className="topbar">
          <div className="brand"><span className="brand-glyph">AP</span><div><strong>AdPilot</strong><small>CONTROL SYSTEM</small></div></div>
          <div className="workspace-switcher">
            <span className="status-orbit" data-live={Boolean(clientId)} />
            <label htmlFor="client-select">Workspace</label>
            {state.clients.length ? (
              <select id="client-select" value={clientId} onChange={(event) => { setClientId(event.target.value); void loadState(event.target.value); }}>
                {state.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
              </select>
            ) : <strong>No workspace</strong>}
          </div>
          <div className="top-status">
            <span className="live-label"><i data-ready={state.models.guiConfigured} />{state.models.guiConfigured ? "Systems nominal" : "Grounding offline"}</span>
            <Tooltip content="关于与设置" relationship="label"><Button className="icon-button" appearance="subtle" icon={<Settings24Regular />} onClick={() => setAboutOpen(true)} /></Tooltip>
          </div>
        </header>

        <aside className="sidebar">
          <nav aria-label="产品导航">
            <Nav icon={<Chat24Regular />} label="Mission" active onClick={() => document.querySelector(".main-column")?.scrollTo({ top: 0, behavior: "smooth" })} />
            <Nav icon={<TargetArrow24Regular />} label="Tests" count={state.experiments.length} onClick={() => document.querySelector(".experiments-panel")?.scrollIntoView({ behavior: "smooth" })} />
            <Nav icon={<ShieldCheckmark24Regular />} label="Review" count={pendingApprovals} onClick={() => document.querySelector(".queue-panel")?.scrollIntoView({ behavior: "smooth" })} />
            <Nav icon={<DataUsage24Regular />} label="Ledger" count={state.audit.length} onClick={() => document.querySelector(".audit-panel")?.scrollIntoView({ behavior: "smooth" })} />
          </nav>
          <div className="dock-index"><span>01</span><i /><span>04</span></div>
          <button className="dock-help" onClick={() => setAboutOpen(true)} aria-label="关于 AdPilot">?</button>
        </aside>

        <main className="main-column">
          {error && <div className="error-banner"><ErrorCircle24Regular /><span>{error}</span><Button size="small" appearance="subtle" onClick={() => void loadState()}>重试</Button></div>}

          {currentTask ? (
            <>
              <section className="task-header">
                <div><span className="section-kicker">Active mission / {currentTask.id.slice(0, 6)}</span><h1>{currentTask.goal}</h1><p>{currentTask.nextStep ?? "正在整理证据和下一步行动。"}</p></div>
                <Badge appearance="filled" color={phaseColor(currentTask.phase)}>{phaseLabel(currentTask.phase)}</Badge>
              </section>
              <section className="task-ledger">
                <Metric label="Evidence steps" value={String(currentTask.completedSteps.length).padStart(2, "0")} />
                <Metric label="Blockers" value={String(currentTask.blockers.length).padStart(2, "0")} />
                <Metric label="Operator" value={currentTask.owner ? roleLabel(currentTask.owner) : "AdPilot Agent"} compact />
                <Metric label="Review window" value={currentTask.reviewAt ? formatTime(currentTask.reviewAt) : "Unscheduled"} compact />
              </section>
            </>
          ) : <MissionZero onPick={setGoal} guiReady={state.models.guiConfigured} clients={state.clients.length} />}

          {(taskEvents.length > 0 || submitting) && <section className="conversation" aria-label="对话记录">
            {taskEvents.map((item, index) => (
              <article className={`message ${item.type}`} key={`${item.type}-${index}`}>
                <div className="message-avatar">{item.type === "error" ? <ErrorCircle24Regular /> : <Bot24Regular />}</div>
                <div><strong>{item.type === "error" ? "SYSTEM" : "ADPILOT / AGENT"}</strong><p>{item.message}</p></div>
              </article>
            ))}
            {submitting && <div className="thinking"><span className="thinking-pulse" /><span>正在调查账户事实并调度专业 Agent</span></div>}
          </section>}

          <div className="composer-shell">
            <div className="composer">
              <div className="composer-copy"><span>DIRECTIVE</span><small>⌘ + Enter to launch</small></div>
              <Textarea resize="vertical" value={goal} onChange={(_, data) => setGoal(data.value)} placeholder="描述目标、症状和不可改变的业务约束…" aria-label="任务目标" onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submitGoal(); }} />
              <Button className="launch-button" appearance="primary" icon={<Send24Regular />} disabled={!clientId || !goal.trim() || submitting} onClick={() => void submitGoal()}>{submitting ? "调查中" : "启动调查"}</Button>
            </div>
          </div>
        </main>

        <aside className="operation-rail">
          <div className="rail-heading"><div><span className="section-kicker">Live operations</span><h2>Execution stack</h2></div><span className="rail-clock">{new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())}</span></div>

          <section className="computer-panel panel-shell">
            <div className="panel-heading"><div><Desktop24Regular /><h2>Computer</h2></div><span className={`mode-pill ${computerMode}`}>{computerMode === "running" ? "LIVE" : computerMode === "paused" ? "PAUSED" : "TAKEOVER"}</span></div>
            <div className="screen-bezel">
              <div className="screen-frame">
                {latestShot ? <img src={`data:image/png;base64,${latestShot.base64}`} alt="广告后台的最新 Computer Use 画面" /> : <div className="screen-idle"><span className="scanline" /><i>AP</i><strong>VISUAL CHANNEL</strong><small>{state.models.guiConfigured ? "Awaiting mission signal" : "Grounding model not configured"}</small></div>}
                {latestComputer?.type === "grounded" && latestComputer.action && <div className="action-overlay"><strong>{latestComputer.action.action}</strong><span>{latestComputer.action.target}</span></div>}
              </div>
            </div>
            <div className="micro-task"><span>Current micro-task</span><strong>{latestComputer?.action?.target ?? "Standby"}</strong><small>{latestComputer?.action?.reason ?? "One verified visual action at a time"}</small></div>
            <div className="control-row">
              <Button icon={<Pause24Regular />} disabled={computerMode !== "running"} onClick={() => void computerControl("pause")}>暂停</Button>
              <Button icon={<PersonArrowLeft24Regular />} onClick={() => void computerControl("takeover")}>接管</Button>
              <Button appearance="primary" icon={<Play24Regular />} disabled={computerMode === "running"} onClick={() => void computerControl("resume")}>恢复</Button>
            </div>
          </section>

          <section className="system-panel panel-shell">
            <div className="panel-heading"><div><Bot24Regular /><h2>Agent network</h2></div><span className="network-count">{activeAgents.length || 1} / 07</span></div>
            <div className="agent-network">
              <div className="network-core">AP</div>
              <div><strong>{activeAgents.length ? activeAgents.map(roleLabel).join(" · ") : "Coordinator ready"}</strong><span>{currentTask ? "Specialists are attached to this mission" : "Waiting for a directive"}</span></div>
            </div>
            <div className="model-grid">
              <ModelRow label="Fast" value={state.models.fast} />
              <ModelRow label="Deep" value={state.models.strong} />
              <ModelRow label="Vision" value={state.models.gui} warn={!state.models.guiConfigured} />
              <ModelRow label="Vision+" value={state.models.guiStrong} warn={!state.models.guiConfigured} />
            </div>
          </section>

          <section className="queue-panel panel-shell">
            <div className="panel-heading"><div><ShieldCheckmark24Regular /><h2>Approval gate</h2></div><span className="section-count">{String(state.approvals.length).padStart(2, "0")}</span></div>
            {state.approvals.length ? state.approvals.slice().reverse().map((approval) => (
              <article className="approval-item" key={approval.id}>
                <div><strong>{approval.operation.operation}</strong><Badge appearance="outline" color={approval.status === "rejected" || approval.status === "failed" ? "danger" : approval.status === "executed" ? "success" : "warning"}>{approval.status}</Badge></div>
                <p>{approval.operation.campaign}</p>
                <dl><div><dt>Current</dt><dd>{String(approval.operation.currentValue)}</dd></div><div><dt>Proposed</dt><dd>{String(approval.operation.proposedValue)}</dd></div></dl>
                {approval.status === "pending_risk_review" && <Button size="small" onClick={() => void riskReview(approval)}>运行独立风险复核</Button>}
                {approval.status === "pending_user" && <Button size="small" appearance="primary" onClick={() => void approve(approval)}>批准一次性执行</Button>}
                {approval.status === "approved" && <Button size="small" appearance="primary" disabled={!approval.executionPlan} onClick={() => void commit(approval)}>{approval.executionPlan ? "执行已批准操作" : "缺少执行计划"}</Button>}
              </article>
            )) : <Empty title="Gate is clear" body="真实账户操作会在执行前出现在这里。" />}
          </section>

          <section className="experiments-panel panel-shell compact-panel">
            <div className="panel-heading"><div><TargetArrow24Regular /><h2>Experiments</h2></div><span className="section-count">{String(state.experiments.length).padStart(2, "0")}</span></div>
            {state.experiments.length ? state.experiments.slice(0, 3).map((experiment) => <div className="experiment-row" key={experiment.id}><div><strong>{experiment.variable}</strong><span>{experiment.hypothesis}</span></div><Badge appearance="outline">{experiment.status}</Badge></div>) : <Empty title="No active tests" body="获批操作会成为单变量实验。" />}
          </section>

          <section className="audit-panel panel-shell compact-panel">
            <div className="panel-heading"><div><DataUsage24Regular /><h2>Audit trace</h2></div></div>
            {state.audit.length ? state.audit.slice(-4).reverse().map((event) => <div className="audit-row" key={event.id}><span>{event.action}</span><time>{formatTime(event.at)}</time></div>) : <Empty title="Trace is pristine" body="每个关键动作都会留下不可跳过的记录。" />}
          </section>
        </aside>

        <Dialog open={aboutOpen} onOpenChange={(_, data) => setAboutOpen(data.open)}>
          <DialogSurface className="settings-dialog">
            <DialogBody>
              <DialogTitle>AdPilot / System</DialogTitle>
              <DialogContent className="about-content">
                <p>版本 0.1.0。原生、可审批、以证据为中心的广告优化 Agent。</p>
                <div className="appearance-setting"><div><strong>Appearance</strong><span>选择操作台的显示模式</span></div><div><Button appearance={theme === "dark" ? "primary" : "subtle"} onClick={() => changeTheme("dark")}>Obsidian</Button><Button appearance={theme === "light" ? "primary" : "subtle"} onClick={() => changeTheme("light")}>Paper</Button></div></div>
                <dl>
                  <div><dt>主运行时</dt><dd>Pi 0.80.10 · MIT</dd></div>
                  <div><dt>视觉执行</dt><dd>UI-TARS 1.2.3 · Apache-2.0</dd></div>
                  <div><dt>广告策略来源</dt><dd>codex-ads 1.9.2 · MIT</dd></div>
                </dl>
                <p className="about-note">真实账户修改需要独立风险复核、用户批准和一次性执行令牌。完整署名与许可证位于仓库 THIRD_PARTY_NOTICES.md。</p>
              </DialogContent>
              <DialogActions><Button appearance="primary" onClick={() => setAboutOpen(false)}>完成</Button></DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    </FluentProvider>
  );
}

function MissionZero({ onPick, guiReady, clients }: { onPick: (goal: string) => void; guiReady: boolean; clients: number }) {
  return <section className="mission-zero">
    <div className="mission-copy">
      <span className="section-kicker">Decision intelligence / 001</span>
      <h1>Turn ad signals<br />into <em>controlled</em><br />action.</h1>
      <p>把症状交给 AdPilot。它会核验测量、调度专业 Agent，并在任何真实修改前停在审批门口。</p>
    </div>
    <div className="mission-orbit" aria-hidden="true"><span className="orbit orbit-one" /><span className="orbit orbit-two" /><span className="orbit-core">AP<i /></span><b>CONTROLLED<br />AUTONOMY</b></div>
    <div className="starter-grid">
      {starterGoals.map((item, index) => <button key={item} onClick={() => onPick(item)}><span>0{index + 1}</span><strong>{item}</strong><i>↗</i></button>)}
    </div>
    <div className="readiness-strip">
      <Readiness label="Workspace" value={clients ? "Connected" : "Required"} ready={clients > 0} />
      <Readiness label="Vision" value={guiReady ? "Ready" : "Offline"} ready={guiReady} />
      <Readiness label="Safety gate" value="Enforced" ready />
    </div>
  </section>;
}

function Readiness({ label, value, ready }: { label: string; value: string; ready: boolean }) { return <div className="readiness"><span>{label}</span><strong><i data-ready={ready} />{value}</strong></div>; }
function Metric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) { return <div className={compact ? "compact" : ""}><span>{label}</span><strong>{value}</strong></div>; }
function Nav({ icon, label, count, active = false, onClick }: { icon: React.ReactNode; label: string; count?: number; active?: boolean; onClick: () => void }) { return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span>{count !== undefined && count > 0 && <b>{count}</b>}</button>; }
function ModelRow({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) { return <div className="model-row"><span>{label}</span><strong className={warn ? "warn" : ""}>{value || "Unassigned"}</strong></div>; }
function Empty({ title, body }: { title: string; body: string }) { return <div className="empty"><i>—</i><strong>{title}</strong><span>{body}</span></div>; }
function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function roleLabel(role: string) { return ({ adpilot_agent: "AdPilot Agent", account_operator: "Account Operator", performance_analyst: "Performance Analyst", media_buyer: "Media Buyer", measurement_reviewer: "Measurement Reviewer", creative_strategist: "Creative Strategist", risk_reviewer: "Risk Reviewer" } as Record<string, string>)[role] ?? role; }
function phaseLabel(phase: string) { return ({ intake: "接收目标", investigating: "调查中", analyzing: "分析中", reviewing_risk: "风险复核", awaiting_approval: "等待审批", executing: "执行中", verifying: "验证中", monitoring: "观察中", completed: "已完成", blocked: "已阻塞", cancelled: "已取消" } as Record<string, string>)[phase] ?? phase; }
function phaseColor(phase: string): "brand" | "success" | "warning" | "danger" { if (phase === "completed") return "success"; if (phase === "blocked" || phase === "cancelled") return "danger"; if (phase === "awaiting_approval") return "warning"; return "brand"; }

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
