import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCopy, phaseLabel, phaseTone, nextStepLabel, roleLabel, formatTime, type AppLocale } from "./labels.js";
import { appendProductEvent, emptyState, type ProductEvent, type State } from "./types.js";
import type { Approval } from "./approvalDisclosure.js";
import { mergeConversationTimeline } from "./conversationTimeline.js";
import { SettingsPanel, type SettingsData, type SettingsTab } from "./SettingsPanel.js";
import { TopBar, NavRail, type NavTarget } from "./components/TopBar.js";
import { ConversationFeed } from "./components/ConversationFeed.js";
import { Composer } from "./components/Composer.js";
import { MissionZero } from "./components/MissionZero.js";
import { ComputerUsePanel, type ComputerControlAction } from "./components/ComputerUsePanel.js";
import { AgentRail, Empty } from "./components/AgentRail.js";
import { ApprovalQueue } from "./components/ApprovalCard.js";
import { Badge, Button } from "./ui.js";
import { IconError } from "./icons.js";

export function App() {
  const isNativeDesktop = new URLSearchParams(window.location.search).get("desktop") === "1";
  const [locale, setLocale] = useState<AppLocale>(() => localStorage.getItem("adpilot-locale") === "en" ? "en" : "zh-CN");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("adpilot-theme");
    return stored === "light" || stored === "dark" ? stored : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [state, setState] = useState<State>(emptyState);
  const [clientId, setClientId] = useState("");
  const [conversationId, setConversationId] = useState("primary");
  const [goal, setGoal] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [settingsData, setSettingsData] = useState<SettingsData>();
  const [settingsError, setSettingsError] = useState("");
  const copy = getCopy(locale);

  const loadState = useCallback(async (requestedClientId?: string, requestedConversationId?: string) => {
    try {
      const selected = requestedClientId ?? clientId;
      const conversation = requestedConversationId ?? conversationId;
      const params = new URLSearchParams();
      if (selected) params.set("clientId", selected);
      if (conversation) params.set("conversationId", conversation);
      const query = params.toString();
      const response = await fetch(`/api/state${query ? `?${query}` : ""}`);
      if (!response.ok) throw new Error(getCopy(locale).loadError);
      const data = await response.json() as State;
      setState(data);
      if (!clientId && data.selectedClientId) setClientId(data.selectedClientId);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [clientId, conversationId, locale]);

  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings");
      if (!response.ok) throw new Error(getCopy(locale).settingsLoadError);
      applySettings(await response.json() as SettingsData);
      setSettingsError("");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setSettingsError(message);
      setError(message);
    }
  }, [locale]);

  useEffect(() => { void loadState(); }, []);
  useEffect(() => { void loadSettings(); }, []);

  /**
   * Live updates, differentiated by event type:
   * - `alert` and `computer` events are high-frequency, self-contained
   *   payloads (the timeline folds alert transitions by id; the computer
   *   panel only reads the latest event), so they merge into the local
   *   event buffer with no network round-trip.
   * - `task` / `approval` / `conversation` / `error` events mutate
   *   server-side resources the client cannot reconstruct, so they trigger
   *   a state refetch, debounced to one fetch per 250ms burst.
   *
   * Refs keep the subscription stable across conversation/locale changes;
   * the EventSource only reconnects when the workspace changes.
   */
  const loadStateRef = useRef(loadState);
  useEffect(() => { loadStateRef.current = loadState; }, [loadState]);
  const copyRef = useRef(copy);
  useEffect(() => { copyRef.current = copy; }, [copy]);

  useEffect(() => {
    if (!clientId) return;
    const source = new EventSource(`/events?clientId=${encodeURIComponent(clientId)}`);
    let refreshTimer: number | undefined;
    const scheduleRefresh = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void loadStateRef.current(), 250);
    };
    source.onmessage = (message) => {
      let event: ProductEvent;
      try { event = JSON.parse(message.data as string) as ProductEvent; } catch { return; }
      if (event.type === "alert" || event.type === "computer") {
        setState((current) => ({ ...current, events: appendProductEvent(current.events, event) }));
      } else {
        scheduleRefresh();
      }
    };
    source.onerror = () => setError(copyRef.current.connectionError);
    return () => { window.clearTimeout(refreshTimer); source.close(); };
  }, [clientId]);

  const currentTask = state.tasks[0];
  const latestComputer = [...state.events].reverse().find((item) => item.type === "computer")?.event;
  const latestShot = [...state.events].reverse().find((item) => item.type === "computer" && item.event?.type === "screenshot")?.event?.screenshot;
  const timeline = useMemo(() => mergeConversationTimeline(state.messages, state.events, conversationId), [state.messages, state.events, conversationId]);
  const conversationOptions = useMemo(() => [...new Set([...(state.conversations ?? []), conversationId])], [state.conversations, conversationId]);
  const activeAgents = useMemo(() => {
    const roles = new Set(state.tasks.map((task) => task.owner).filter(Boolean) as string[]);
    if (currentTask && !["completed", "blocked", "cancelled"].includes(currentTask.phase)) roles.add("adpilot_agent");
    return [...roles];
  }, [state.tasks, currentTask]);
  const pendingApprovals = state.approvals.filter((item) => !["executed", "rejected", "failed"].includes(item.status)).length;
  const computerMode = state.computerUse?.executionStatus ?? "unavailable";

  function applySettings(data: SettingsData) {
    setSettingsData(data);
    setLocale(data.locale);
    const nextTheme = data.appearance === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : data.appearance;
    setTheme(nextTheme);
    localStorage.setItem("adpilot-locale", data.locale);
    localStorage.setItem("adpilot-theme", nextTheme);
  }

  async function submitGoal() {
    const isSlashCommand = goal.trim().startsWith("/");
    if (!state.models.chatConfigured && !isSlashCommand) { setSettingsTab("models"); setSettingsOpen(true); return; }
    if (!goal.trim()) return;
    const message = goal.trim();
    setSubmitting(true); setError("");
    setGoal("");
    setState((current) => ({ ...current, messages: [...current.messages, { id: `local-${Date.now()}`, clientId: clientId || "personal", conversationId, role: "user", content: message, status: "complete", at: new Date().toISOString() }] }));
    try {
      const response = await fetch("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(clientId ? { clientId } : {}), conversationId, message, locale }) });
      const body = await response.json(); if (!response.ok) throw new Error(copy.taskError);
      await loadState(clientId || body.message?.clientId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await loadState(clientId); }
    finally { setSubmitting(false); }
  }

  async function forkMessage(messageId: string) {
    try {
      const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/conversations/${encodeURIComponent(conversationId)}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ atMessageId: messageId }) });
      const body = await response.json() as { conversationId?: string; error?: string };
      if (!response.ok || !body.conversationId) throw new Error(body.error ?? copy.forkError);
      setConversationId(body.conversationId);
      await loadState(clientId, body.conversationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function computerControl(action: ComputerControlAction) {
    try {
      const response = await fetch(`/api/computer/${action}`, { method: "POST" });
      const body = await response.json().catch(() => undefined) as { error?: string; code?: string } | undefined;
      if (!response.ok) throw new Error(body?.code === "COMPUTER_USE_UNAVAILABLE" ? copy.computerUnavailable : copy.executionError);
      await loadState(clientId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await loadState(clientId);
    }
  }

  async function riskReview(approval: Approval) {
    const response = await fetch(`/api/approvals/${approval.id}/risk-review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) });
    await response.json(); if (!response.ok) setError(copy.riskError); await loadState(clientId);
  }

  async function approve(approval: Approval) {
    const response = await fetch(`/api/approvals/${approval.id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, approvedBy: "workspace-owner" }) });
    await response.json(); if (!response.ok) setError(copy.approvalError); await loadState(clientId);
  }

  async function commit(approval: Approval) {
    const response = await fetch(`/api/approvals/${approval.id}/commit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) });
    await response.json(); if (!response.ok) setError(copy.executionError); await loadState(clientId);
  }

  function handleNavigate(target: NavTarget) {
    const selector = target === "mission" ? ".main-column" : target === "tests" ? ".experiments-panel" : target === "review" ? ".queue-panel" : ".audit-panel";
    if (target === "mission") document.querySelector(".main-column")?.scrollTo({ top: 0, behavior: "smooth" });
    else document.querySelector(selector)?.scrollIntoView({ behavior: "smooth" });
  }

  function openSettings(tab: SettingsTab) {
    setSettingsTab(tab);
    setSettingsOpen(true);
    if (!settingsData) void loadSettings();
  }

  if (loading) return (
    <div className="boot" data-theme={theme}>
      <div className="boot-lockup"><span className="brand-glyph">AP</span><strong>AdPilot</strong></div>
      <div className="boot-track"><span /></div>
      <p>{copy.boot}</p>
    </div>
  );

  return (
    <div className="shell" data-theme={theme} data-native={isNativeDesktop}>
      <TopBar
        copy={copy}
        clients={state.clients}
        clientId={clientId}
        chatConfigured={state.models.chatConfigured}
        onSelectClient={(next) => { setClientId(next); setConversationId("primary"); void loadState(next, "primary"); }}
        onOpenSettings={() => openSettings("general")}
      />

      <NavRail
        copy={copy}
        testsCount={state.experiments.length}
        reviewCount={pendingApprovals}
        ledgerCount={state.audit.length}
        onNavigate={handleNavigate}
        onOpenAbout={() => openSettings("about")}
      />

      <main className="main-column">
        {error && (
          <div className="error-banner" role="alert">
            <IconError size={15} />
            <span>{error}</span>
            <Button size="sm" variant="subtle" onClick={() => void loadState()}>{copy.retry}</Button>
          </div>
        )}

        {currentTask ? (
          <>
            <section className="task-header">
              <div>
                <span className="section-kicker">{copy.activeMission} · {currentTask.id.slice(0, 6)}</span>
                <h1>{currentTask.goal}</h1>
                <p>{currentTask.nextStep ? nextStepLabel(currentTask.nextStep, locale) : copy.preparingEvidence}</p>
              </div>
              <Badge tone={phaseTone(currentTask.phase)} variant="soft">{phaseLabel(currentTask.phase, locale)}</Badge>
            </section>
            <section className="task-ledger" aria-label={copy.activeMission}>
              <Metric label={copy.evidenceSteps} value={String(currentTask.completedSteps.length).padStart(2, "0")} />
              <Metric label={copy.blockers} value={String(currentTask.blockers.length).padStart(2, "0")} />
              <Metric label={copy.operator} value={currentTask.owner ? roleLabel(currentTask.owner, locale) : copy.agent} compact />
              <Metric label={copy.reviewWindow} value={currentTask.reviewAt ? formatTime(currentTask.reviewAt, locale) : copy.unscheduled} compact />
            </section>
          </>
        ) : state.messages.length === 0 ? <MissionZero onPick={setGoal} guiReady={state.models.guiConfigured} clients={state.clients.length} locale={locale} /> : null}

        {(state.messages.length > 0 || submitting) && (
          <ConversationFeed
            copy={copy}
            locale={locale}
            timeline={timeline}
            conversationOptions={conversationOptions}
            conversationId={conversationId}
            submitting={submitting}
            onSelectConversation={(next) => { setConversationId(next); void loadState(clientId, next); }}
            onFork={(messageId) => void forkMessage(messageId)}
          />
        )}

        <Composer
          copy={copy}
          locale={locale}
          goal={goal}
          onGoalChange={setGoal}
          chatConfigured={state.models.chatConfigured}
          submitting={submitting}
          onSubmit={() => void submitGoal()}
        />
      </main>

      <aside className="operation-rail">
        <div className="rail-heading">
          <div><span className="section-kicker">{copy.liveOperations}</span><h2>{copy.executionStack}</h2></div>
          <span className="rail-clock">{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())}</span>
        </div>

        <ComputerUsePanel
          copy={copy}
          locale={locale}
          mode={computerMode}
          latest={latestComputer}
          latestShot={latestShot}
          guiConfigured={state.models.guiConfigured}
          onControl={(action) => void computerControl(action)}
        />

        <ApprovalQueue
          approvals={state.approvals}
          copy={copy}
          locale={locale}
          onRiskReview={(approval) => void riskReview(approval)}
          onApprove={(approval) => void approve(approval)}
          onCommit={(approval) => void commit(approval)}
        />

        <AgentRail
          copy={copy}
          locale={locale}
          activeAgents={activeAgents}
          models={state.models}
          taskActive={Boolean(currentTask)}
          experiments={state.experiments}
          audit={state.audit}
        />
      </aside>

      <SettingsPanel
        open={settingsOpen}
        data={settingsData}
        {...(clientId || state.selectedClientId ? { clientId: clientId || state.selectedClientId } : {})}
        initialTab={settingsTab}
        {...(settingsError ? { loadError: settingsError } : {})}
        onReload={() => void loadSettings()}
        onClose={() => setSettingsOpen(false)}
        onSaved={applySettings}
      />
    </div>
  );
}

function Metric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return <div className={compact ? "compact" : ""}><span>{label}</span><strong>{value}</strong></div>;
}
