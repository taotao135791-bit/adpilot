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
  Input,
  Spinner,
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
  TargetArrow24Regular,
  WeatherMoon24Regular,
  WeatherSunny24Regular
} from "@fluentui/react-icons";
import "./styles.css";

type Client = { id: string; name: string; industry: string; timezone: string };
type Task = { id: string; goal: string; phase: string; completedSteps: string[]; blockers: string[]; nextStep: string | null; owner: string | null; reviewAt: string | null; updatedAt: string };
type Approval = { id: string; taskId: string; status: string; executionPlan: { target: string } | null; operation: { account: string; campaign: string; operation: string; currentValue: unknown; proposedValue: unknown; changePercentage: number | null; reason: string; evidence: string[]; expectedImpact: string; observationWindow: string; rollbackCondition: string; riskLevel: string } };
type Experiment = { id: string; hypothesis: string; variable: string; status: string; reviewAt: string };
type Audit = { id: string; actor: string; action: string; status: string; at: string };
type ProductEvent = { type: string; status?: string; message?: string; approvalId?: string; event?: { type: string; phase?: string; attempt?: number; screenshot?: { base64: string; capturedAt: string }; action?: { action: string; target: string; reason: string }; reason?: string } };
type State = { clients: Client[]; selectedClientId?: string; tasks: Task[]; approvals: Approval[]; experiments: Experiment[]; audit: Audit[]; events: ProductEvent[]; models: { fast: string; strong: string; gui: string; guiConfigured: boolean } };

const emptyState: State = { clients: [], tasks: [], approvals: [], experiments: [], audit: [], events: [], models: { fast: "", strong: "", gui: "", guiConfigured: false } };

function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
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
  const latestComputer = [...state.events].reverse().find((item) => item.type === "computer")?.event;
  const latestShot = [...state.events].reverse().find((item) => item.type === "computer" && item.event?.type === "screenshot")?.event?.screenshot;
  const activeAgents = useMemo(() => {
    const roles = new Set(state.tasks.map((task) => task.owner).filter(Boolean) as string[]);
    if (currentTask && !["completed", "blocked", "cancelled"].includes(currentTask.phase)) roles.add("adpilot_agent");
    return [...roles];
  }, [state.tasks, currentTask]);

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

  if (loading) return <FluentProvider theme={theme === "dark" ? webDarkTheme : webLightTheme}><div className="boot"><Spinner label="正在载入 AdPilot Workspace" /></div></FluentProvider>;

  return (
    <FluentProvider theme={theme === "dark" ? webDarkTheme : webLightTheme} className="provider">
      <div className="shell" data-theme={theme}>
        <header className="topbar">
          <div className="brand"><span className="brand-mark">A</span><span>AdPilot</span></div>
          <div className="top-status">
            <Badge appearance="outline" color={state.models.guiConfigured ? "success" : "warning"}>{state.models.guiConfigured ? "Computer ready" : "GUI model needs setup"}</Badge>
            <Tooltip content="切换主题" relationship="label"><Button appearance="subtle" icon={theme === "dark" ? <WeatherSunny24Regular /> : <WeatherMoon24Regular />} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} /></Tooltip>
            <Tooltip content="关于与设置" relationship="label"><Button appearance="subtle" icon={<Settings24Regular />} onClick={() => setAboutOpen(true)} /></Tooltip>
          </div>
        </header>

        <aside className="sidebar">
          <label className="field-label" htmlFor="client-select">客户 Workspace</label>
          {state.clients.length ? (
            <select id="client-select" value={clientId} onChange={(event) => { setClientId(event.target.value); void loadState(event.target.value); }}>
              {state.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
            </select>
          ) : <Empty title="还没有客户" body="先通过 API 或 CLI 创建一个隔离 Workspace。" />}

          <nav aria-label="产品导航">
            <Nav icon={<Chat24Regular />} label="对话与任务" active onClick={() => document.querySelector(".main-column")?.scrollTo({ top: 0, behavior: "smooth" })} />
            <Nav icon={<TargetArrow24Regular />} label="实验" count={state.experiments.length} onClick={() => document.querySelector(".experiments-panel")?.scrollIntoView({ behavior: "smooth" })} />
            <Nav icon={<ShieldCheckmark24Regular />} label="审批" count={state.approvals.filter((item) => !["executed", "rejected", "failed"].includes(item.status)).length} onClick={() => document.querySelector(".queue-panel")?.scrollIntoView({ behavior: "smooth" })} />
            <Nav icon={<DataUsage24Regular />} label="操作审计" count={state.audit.length} onClick={() => document.querySelector(".audit-panel")?.scrollIntoView({ behavior: "smooth" })} />
          </nav>

          <section className="model-stack" aria-label="模型状态">
            <h2>模型路由</h2>
            <ModelRow label="Fast" value={state.models.fast} />
            <ModelRow label="Strong" value={state.models.strong} />
            <ModelRow label="Grounding" value={state.models.gui} warn={!state.models.guiConfigured} />
          </section>
        </aside>

        <main className="main-column">
          {error && <div className="error-banner"><ErrorCircle24Regular /><span>{error}</span><Button size="small" appearance="subtle" onClick={() => void loadState()}>重试</Button></div>}
          <section className="task-header">
            <div>
              <span className="section-kicker">当前任务</span>
              <h1>{currentTask?.goal ?? "告诉 AdPilot 你要调查什么"}</h1>
              <p>{currentTask?.nextStep ?? "Agent 会先检查测量可信度，再组织专业子 Agent 获取证据。"}</p>
            </div>
            {currentTask && <Badge appearance="filled" color={phaseColor(currentTask.phase)}>{phaseLabel(currentTask.phase)}</Badge>}
          </section>

          {currentTask && <section className="task-ledger">
            <div><span>已完成</span><strong>{currentTask.completedSteps.length}</strong></div>
            <div><span>阻塞项</span><strong>{currentTask.blockers.length}</strong></div>
            <div><span>负责人</span><strong>{currentTask.owner ? roleLabel(currentTask.owner) : "AdPilot Agent"}</strong></div>
            <div><span>复查时间</span><strong>{currentTask.reviewAt ? formatTime(currentTask.reviewAt) : "待确定"}</strong></div>
          </section>}

          <section className="conversation" aria-label="对话记录">
            {state.events.filter((item) => item.type === "task" || item.type === "error").length ? state.events.filter((item) => item.type === "task" || item.type === "error").map((item, index) => (
              <article className={`message ${item.type}`} key={`${item.type}-${index}`}>
                <div className="message-avatar">{item.type === "error" ? <ErrorCircle24Regular /> : <Bot24Regular />}</div>
                <div><strong>{item.type === "error" ? "系统" : "AdPilot Agent"}</strong><p>{item.message}</p></div>
              </article>
            )) : <Empty title="等待第一个目标" body="例如：检查投放不足的根因，并给出可审批的预算建议。" />}
            {submitting && <div className="thinking"><Spinner size="tiny" /><span>正在调查账户事实并调度专业 Agent</span></div>}
          </section>

          <div className="composer">
            <Textarea resize="vertical" value={goal} onChange={(_, data) => setGoal(data.value)} placeholder="描述目标、症状和不可改变的业务约束" aria-label="任务目标" onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submitGoal(); }} />
            <Button appearance="primary" icon={<Send24Regular />} disabled={!clientId || !goal.trim() || submitting} onClick={() => void submitGoal()}>开始调查</Button>
          </div>
        </main>

        <aside className="operation-rail">
          <section className="computer-panel">
            <div className="panel-heading"><div><Desktop24Regular /><h2>Computer Use</h2></div><Badge appearance="outline" color={computerMode === "running" ? "success" : "warning"}>{computerMode === "running" ? "运行中" : computerMode === "paused" ? "已暂停" : "用户接管"}</Badge></div>
            <div className="screen-frame">
              {latestShot ? <img src={`data:image/png;base64,${latestShot.base64}`} alt="广告后台的最新 Computer Use 画面" /> : <Empty title="暂无实时画面" body={state.models.guiConfigured ? "开始视觉任务后会显示最新截图。" : "配置 GUI grounding model 后可启用原生画面。"} />}
              {latestComputer?.type === "grounded" && latestComputer.action && <div className="action-overlay"><strong>{latestComputer.action.action}</strong><span>{latestComputer.action.target}</span></div>}
            </div>
            <div className="micro-task"><span>当前微任务</span><strong>{latestComputer?.action?.target ?? "等待任务"}</strong><small>{latestComputer?.action?.reason ?? "每次只执行一个经验证的视觉动作"}</small></div>
            <div className="control-row">
              <Button icon={<Pause24Regular />} disabled={computerMode !== "running"} onClick={() => void computerControl("pause")}>暂停</Button>
              <Button icon={<PersonArrowLeft24Regular />} onClick={() => void computerControl("takeover")}>接管</Button>
              <Button appearance="primary" icon={<Play24Regular />} disabled={computerMode === "running"} onClick={() => void computerControl("resume")}>恢复</Button>
            </div>
          </section>

          <section className="agents-panel">
            <div className="panel-heading"><div><Bot24Regular /><h2>Agent 状态</h2></div></div>
            {activeAgents.length ? activeAgents.map((role) => <div className="agent-row" key={role}><span>{roleLabel(role)}</span><Badge color="brand" appearance="tint">运行中</Badge></div>) : <Empty title="Agent 待命" body="专业 Agent 会在调查树中按需启动。" />}
          </section>

          <section className="queue-panel">
            <div className="panel-heading"><div><ShieldCheckmark24Regular /><h2>审批队列</h2></div><span>{state.approvals.length}</span></div>
            {state.approvals.length ? state.approvals.slice().reverse().map((approval) => (
              <article className="approval-item" key={approval.id}>
                <div><strong>{approval.operation.operation}</strong><Badge appearance="outline" color={approval.status === "rejected" || approval.status === "failed" ? "danger" : approval.status === "executed" ? "success" : "warning"}>{approval.status}</Badge></div>
                <p>{approval.operation.campaign}</p>
                <dl><div><dt>当前</dt><dd>{String(approval.operation.currentValue)}</dd></div><div><dt>建议</dt><dd>{String(approval.operation.proposedValue)}</dd></div></dl>
                {approval.status === "pending_risk_review" && <Button size="small" onClick={() => void riskReview(approval)}>运行独立风险复核</Button>}
                {approval.status === "pending_user" && <Button size="small" appearance="primary" onClick={() => void approve(approval)}>批准一次性执行</Button>}
                {approval.status === "approved" && <Button size="small" appearance="primary" disabled={!approval.executionPlan} onClick={() => void commit(approval)}>{approval.executionPlan ? "执行已批准操作" : "缺少执行计划"}</Button>}
              </article>
            )) : <Empty title="没有待审批操作" body="所有真实修改都会先出现在这里。" />}
          </section>

          <section className="experiments-panel">
            <div className="panel-heading"><div><TargetArrow24Regular /><h2>实验</h2></div><span>{state.experiments.length}</span></div>
            {state.experiments.length ? state.experiments.slice(0, 3).map((experiment) => <div className="experiment-row" key={experiment.id}><div><strong>{experiment.variable}</strong><span>{experiment.hypothesis}</span></div><Badge appearance="outline">{experiment.status}</Badge></div>) : <Empty title="暂无实验" body="执行获批操作后会创建单变量实验。" />}
          </section>

          <section className="audit-panel">
            <div className="panel-heading"><div><DataUsage24Regular /><h2>最近审计</h2></div></div>
            {state.audit.slice(-4).reverse().map((event) => <div className="audit-row" key={event.id}><span>{event.action}</span><time>{formatTime(event.at)}</time></div>)}
          </section>
        </aside>
        <Dialog open={aboutOpen} onOpenChange={(_, data) => setAboutOpen(data.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>关于 AdPilot</DialogTitle>
              <DialogContent className="about-content">
                <p>版本 0.1.0。原生、可审批、以证据为中心的广告优化 Agent。</p>
                <dl>
                  <div><dt>主运行时</dt><dd>Pi 0.80.10 · MIT</dd></div>
                  <div><dt>视觉执行</dt><dd>UI-TARS 1.2.3 · Apache-2.0</dd></div>
                  <div><dt>广告策略来源</dt><dd>codex-ads 1.9.2 · MIT</dd></div>
                </dl>
                <p className="about-note">真实账户修改需要独立风险复核、用户批准和一次性执行令牌。完整署名与许可证位于仓库 THIRD_PARTY_NOTICES.md。</p>
              </DialogContent>
              <DialogActions><Button appearance="primary" onClick={() => setAboutOpen(false)}>关闭</Button></DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    </FluentProvider>
  );
}

function Nav({ icon, label, count, active = false, onClick }: { icon: React.ReactNode; label: string; count?: number; active?: boolean; onClick: () => void }) { return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span>{count !== undefined && <b>{count}</b>}</button>; }
function ModelRow({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) { return <div className="model-row"><span>{label}</span><strong className={warn ? "warn" : ""}>{value}</strong></div>; }
function Empty({ title, body }: { title: string; body: string }) { return <div className="empty"><strong>{title}</strong><span>{body}</span></div>; }
function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function roleLabel(role: string) { return ({ adpilot_agent: "AdPilot Agent", account_operator: "Account Operator", performance_analyst: "Performance Analyst", media_buyer: "Media Buyer", measurement_reviewer: "Measurement Reviewer", creative_strategist: "Creative Strategist", risk_reviewer: "Risk Reviewer" } as Record<string, string>)[role] ?? role; }
function phaseLabel(phase: string) { return ({ intake: "接收目标", investigating: "调查中", analyzing: "分析中", reviewing_risk: "风险复核", awaiting_approval: "等待审批", executing: "执行中", verifying: "验证中", monitoring: "观察中", completed: "已完成", blocked: "已阻塞", cancelled: "已取消" } as Record<string, string>)[phase] ?? phase; }
function phaseColor(phase: string): "brand" | "success" | "warning" | "danger" { if (phase === "completed") return "success"; if (phase === "blocked" || phase === "cancelled") return "danger"; if (phase === "awaiting_approval") return "warning"; return "brand"; }

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
