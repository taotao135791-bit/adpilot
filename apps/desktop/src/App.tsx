import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCopy, phaseLabel, phaseTone, nextStepLabel, roleLabel, formatTime, pluginsCopy, type AppLocale } from "./labels.js";
import { appendProductEvent, emptyState, type ConversationMessage, type ProductEvent, type ProductSession, type State } from "./types.js";
import { isApprovalOpen, type Approval } from "./approvalDisclosure.js";
import { mergeConversationTimeline, type TimelineInsight } from "./conversationTimeline.js";
import { localInsightCommand } from "./slashCommands.js";
import { normalizePlanMode, planModeEndpoint, planModeRequestBody } from "./planMode.js";
import { autonomyEndpoint, autonomyRequestBody, normalizeAutonomy } from "./autonomy.js";
import { modelChipLabel } from "./composerKeys.js";
import {
  SESSION_SEARCH_DEBOUNCE_MS,
  applySessionSnapshot,
  buildSessionListUrl,
  fallbackSession,
  isRevisionConflict,
  normalizeSessionQuery
} from "./sessionList.js";
import { SettingsPanel, type SettingsData, type SettingsTab } from "./SettingsPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { ConversationFeed } from "./components/ConversationFeed.js";
import { Composer } from "./components/Composer.js";
import { MissionZero } from "./components/MissionZero.js";
import { PluginsView } from "./components/PluginsView.js";
import type { ComputerControlAction } from "./components/ComputerUseCard.js";
import { Badge, Button } from "./ui.js";
import { IconError, IconSettings } from "./icons.js";

/**
 * Codex-style skeleton: a collapsible sidebar (brand, new conversation,
 * session history, workspace + settings) next to a main conversation
 * column. The sidebar is driven by real product Sessions — the selected
 * session's runtimeConversationId keys the message projection — so several
 * sessions can run concurrently and switching between them never cancels
 * in-flight work. The main column splits into a scrolling region (banners,
 * task header, feed, empty state) and a fixed composer dock, so the composer
 * never moves while the feed scrolls. Approvals, the live computer-use
 * session, and on-demand insight cards still render inline in the feed.
 */
export function App() {
  const isNativeDesktop = new URLSearchParams(window.location.search).get("desktop") === "1";
  const [locale, setLocale] = useState<AppLocale>(() => localStorage.getItem("adpilot-locale") === "en" ? "en" : "zh-CN");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("adpilot-theme");
    return stored === "light" || stored === "dark" ? stored : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("adpilot-sidebar") === "collapsed");
  const [state, setState] = useState<State>(emptyState);
  const [clientId, setClientId] = useState("");
  const [conversationId, setConversationId] = useState("primary");
  const [sessions, setSessions] = useState<ProductSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionSearchResults, setSessionSearchResults] = useState<ProductSession[] | null>(null);
  const [goal, setGoal] = useState("");
  const [insights, setInsights] = useState<TimelineInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [settingsData, setSettingsData] = useState<SettingsData>();
  const [settingsError, setSettingsError] = useState("");
  /** Main-area view switch: the conversation, or the plugins catalog. */
  const [mainView, setMainView] = useState<"chat" | "plugins">("chat");
  /** Bumped on every plugin SSE event; PluginsView refetches on change. */
  const [pluginTick, setPluginTick] = useState(0);
  const copy = getCopy(locale);

  /** One-time adoption of the server-selected (or most recent) session per client. */
  const sessionBootstrap = useRef(false);

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
      const serverSessions = data.sessions ?? [];
      setSessions(serverSessions);
      if (!clientId && data.selectedClientId) setClientId(data.selectedClientId);
      if (!sessionBootstrap.current) {
        sessionBootstrap.current = true;
        const explicit = data.selectedSessionId ? serverSessions.find((session) => session.id === data.selectedSessionId) : undefined;
        const target = explicit ?? fallbackSession(serverSessions, "");
        if (target) {
          setSelectedSessionId(target.id);
          if (target.runtimeConversationId !== conversation) {
            setConversationId(target.runtimeConversationId);
            void loadState(selected, target.runtimeConversationId);
            return;
          }
        }
      }
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
   *   payloads (the timeline folds alert transitions by id and computer
   *   bursts into one pinned card), so they merge into the local event
   *   buffer with no network round-trip.
   * - `session` events carry the full mutated session snapshot (run-status
   *   transitions, renames, pins), so they upsert straight into the sidebar
   *   list — a session keeps its live status dot even while another session
   *   is open in the main column.
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
      if (event.type === "session") {
        const snapshot = event.session;
        if (snapshot) setSessions((current) => applySessionSnapshot(current, snapshot));
      } else if (event.type === "plugin") {
        setPluginTick((tick) => tick + 1);
      } else if (event.type === "alert" || event.type === "computer") {
        setState((current) => ({ ...current, events: appendProductEvent(current.events, event) }));
      } else {
        scheduleRefresh();
      }
    };
    source.onerror = () => setError(copyRef.current.connectionError);
    return () => { window.clearTimeout(refreshTimer); source.close(); };
  }, [clientId]);

  /* Sidebar search: debounce keystrokes, then query the server-side search.
     An empty normalized query means "not searching" and shows the full list. */
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(normalizeSessionQuery(sessionSearch)), SESSION_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [sessionSearch]);

  useEffect(() => {
    if (!clientId || !debouncedSearch) { setSessionSearchResults(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(buildSessionListUrl(clientId, { q: debouncedSearch }));
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as { sessions?: ProductSession[] };
        if (!cancelled) setSessionSearchResults(body.sessions ?? []);
      } catch { if (!cancelled) setSessionSearchResults([]); }
    })();
    return () => { cancelled = true; };
  }, [clientId, debouncedSearch, sessions]);

  const currentTask = state.tasks[0];
  const computerMode = state.computerUse?.executionStatus ?? "unavailable";
  const computerActive = computerMode === "running" || computerMode === "paused";
  const timeline = useMemo(
    () => mergeConversationTimeline<ConversationMessage, Approval>(state.messages, state.events, conversationId, {
      approvals: state.approvals,
      approvalAt: (approval) => approval.createdAt ?? approval.executionPlan?.createdAt ?? approval.guardrail?.evaluatedAt,
      computerActive,
      insights
    }),
    [state.messages, state.events, state.approvals, conversationId, computerActive, insights]
  );
  const openApprovals = useMemo(() => state.approvals.filter((item) => isApprovalOpen(item.status)), [state.approvals]);
  const autonomy = normalizeAutonomy(state.autonomy);
  const selectedSession = useMemo(() => sessions.find((session) => session.id === selectedSessionId), [sessions, selectedSessionId]);

  function applySettings(data: SettingsData) {
    setSettingsData(data);
    setLocale(data.locale);
    const nextTheme = data.appearance === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : data.appearance;
    setTheme(nextTheme);
    localStorage.setItem("adpilot-locale", data.locale);
    localStorage.setItem("adpilot-theme", nextTheme);
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      localStorage.setItem("adpilot-sidebar", current ? "expanded" : "collapsed");
      return !current;
    });
  }

  /** Resyncs the sidebar list from the server — the rollback path after a
     failed optimistic mutation, including 409 revision conflicts. */
  async function refreshSessions() {
    if (!clientId) return;
    try {
      const response = await fetch(buildSessionListUrl(clientId));
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { sessions?: ProductSession[] };
      setSessions(body.sessions ?? []);
    } catch { setError(copy.sessionActionError); }
  }

  /**
   * Shared session-mutation plumbing. Every write goes through the revision
   * chain: the request carries the revision of the entity the user acted on,
   * the response carries the next revision and replaces the local entity.
   * A 409 REVISION_CONFLICT means another writer moved first — resync the
   * list and say so instead of retrying blindly.
   */
  async function sessionMutation(url: string, init: RequestInit): Promise<ProductSession | undefined> {
    try {
      const response = await fetch(url, init);
      const body = await response.json().catch(() => undefined) as (ProductSession & { error?: string; code?: string }) | undefined;
      if (response.ok && body) return body;
      await refreshSessions();
      setError(isRevisionConflict(body) ? copy.sessionConflict : (body?.error ?? copy.sessionActionError));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    return undefined;
  }

  function selectSession(session: ProductSession) {
    if (session.id === selectedSessionId && mainView === "chat") return;
    setMainView("chat");
    setSelectedSessionId(session.id);
    setConversationId(session.runtimeConversationId);
    setInsights([]);
    void loadState(clientId, session.runtimeConversationId);
  }

  async function newSession() {
    if (!clientId) return;
    const session = await sessionMutation(`/api/clients/${encodeURIComponent(clientId)}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    if (!session) return;
    setSessions((current) => applySessionSnapshot(current, session));
    setSessionSearch("");
    setSelectedSessionId(session.id);
    setConversationId(session.runtimeConversationId);
    setInsights([]);
    await loadState(clientId, session.runtimeConversationId);
  }

  async function togglePin(session: ProductSession) {
    const pinned = session.pinnedAt === undefined;
    const optimistic: ProductSession = { ...session };
    if (pinned) optimistic.pinnedAt = new Date().toISOString(); else delete optimistic.pinnedAt;
    setSessions((current) => applySessionSnapshot(current, optimistic));
    const updated = await sessionMutation(`/api/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: session.revision, pinned })
    });
    if (updated) setSessions((current) => applySessionSnapshot(current, updated));
  }

  async function renameSession(session: ProductSession, title: string) {
    setSessions((current) => applySessionSnapshot(current, { ...session, title }));
    const updated = await sessionMutation(`/api/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: session.revision, title })
    });
    if (updated) setSessions((current) => applySessionSnapshot(current, updated));
  }

  async function archiveSession(session: ProductSession) {
    const updated = await sessionMutation(`/api/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(session.id)}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: session.revision })
    });
    if (!updated) return;
    const next = applySessionSnapshot(sessions, updated);
    setSessions(next);
    if (session.id === selectedSessionId) {
      const fallback = fallbackSession(next, session.id);
      if (fallback) selectSession(fallback);
      else {
        setSelectedSessionId(null);
        setConversationId("primary");
        void loadState(clientId, "primary");
      }
    }
  }

  async function restoreSession(session: ProductSession) {
    const updated = await sessionMutation(`/api/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(session.id)}/unarchive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: session.revision })
    });
    if (updated) setSessions((current) => applySessionSnapshot(current, updated));
  }

  function selectClient(next: string) {
    setClientId(next);
    setSelectedSessionId(null);
    setConversationId("primary");
    setSessionSearch("");
    setSessionSearchResults(null);
    setInsights([]);
    sessionBootstrap.current = false;
    void loadState(next, "primary");
  }

  async function submitGoal(override?: string) {
    const message = (override ?? goal).trim();
    if (!message) return;
    const insightKind = localInsightCommand(message);
    if (insightKind) {
      setGoal("");
      setInsights((current) => [...current, { id: `insight-${Date.now()}`, kind: insightKind, at: new Date().toISOString() }]);
      return;
    }
    const isSlashCommand = message.startsWith("/");
    if (!state.models.chatConfigured && !isSlashCommand) { setSettingsTab("models"); setSettingsOpen(true); return; }
    setSubmitting(true); setError("");
    setGoal("");
    // Resolve the target session: the selected one, or a freshly created one
    // so the very first message of a workspace already lives in a Session.
    let session = selectedSession;
    if (!session && clientId) {
      const created = await sessionMutation(`/api/clients/${encodeURIComponent(clientId)}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      if (created) {
        session = created;
        setSessions((current) => applySessionSnapshot(current, created));
        setSelectedSessionId(created.id);
        setConversationId(created.runtimeConversationId);
      }
    }
    const targetConversationId = session ? session.runtimeConversationId : conversationId;
    setState((current) => ({ ...current, messages: [...current.messages, { id: `local-${Date.now()}`, clientId: clientId || "personal", conversationId: targetConversationId, role: "user", content: message, status: "complete", at: new Date().toISOString() }] }));
    try {
      const response = await fetch("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(clientId ? { clientId } : {}), ...(session ? { sessionId: session.id } : { conversationId: targetConversationId }), message, locale }) });
      const body = await response.json(); if (!response.ok) throw new Error(copy.taskError);
      await loadState(clientId || body.message?.clientId, targetConversationId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await loadState(clientId, targetConversationId); }
    finally { setSubmitting(false); }
  }

  async function forkMessage(messageId: string) {
    try {
      if (selectedSession) {
        // Branch produces a brand-new product Session at the given message;
        // the original keeps running untouched.
        const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(selectedSession.id)}/branch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ atMessageId: messageId }) });
        const body = await response.json().catch(() => undefined) as (ProductSession & { error?: string }) | undefined;
        if (!response.ok || !body?.id) throw new Error(body?.error ?? copy.forkError);
        setSessions((current) => applySessionSnapshot(current, body));
        setSelectedSessionId(body.id);
        setConversationId(body.runtimeConversationId);
        setInsights([]);
        await loadState(clientId, body.runtimeConversationId);
      } else {
        // Legacy conversations without a Session keep the old fork endpoint.
        const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/conversations/${encodeURIComponent(conversationId)}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ atMessageId: messageId }) });
        const body = await response.json() as { conversationId?: string; error?: string };
        if (!response.ok || !body.conversationId) throw new Error(body.error ?? copy.forkError);
        setConversationId(body.conversationId);
        await loadState(clientId, body.conversationId);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function togglePlanMode() {
    if (!clientId) return;
    try {
      const response = await fetch(planModeEndpoint(clientId, conversationId), { method: "POST", headers: { "content-type": "application/json" }, body: planModeRequestBody(state.planMode?.enabled !== true) });
      const body = await response.json();
      if (!response.ok) throw new Error(copy.planModeError);
      setState((current) => ({ ...current, planMode: normalizePlanMode(body) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Autonomy switch: PUT the desired mode, then quietly confirm by
     rendering the server-echoed mode — no modal, no banner on success. */
  async function toggleAutonomy() {
    if (!clientId) return;
    const next = autonomy === "guarded" ? "full_access" : "guarded";
    try {
      const response = await fetch(autonomyEndpoint(clientId), { method: "PUT", headers: { "content-type": "application/json" }, body: autonomyRequestBody(next) });
      const body = await response.json();
      if (!response.ok) throw new Error(copy.autonomyError);
      setState((current) => ({ ...current, autonomy: { mode: normalizeAutonomy(body) } }));
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

  function jumpToApprovals() {
    const target = openApprovals[0] ?? state.approvals[0];
    if (!target) return;
    document.querySelector(`[data-approval="${CSS.escape(target.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
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
      <Sidebar
        copy={copy}
        locale={locale}
        clients={state.clients}
        clientId={clientId}
        sessions={sessionSearchResults ?? sessions}
        searching={sessionSearchResults !== null}
        selectedSessionId={selectedSessionId}
        search={sessionSearch}
        pendingApprovals={openApprovals.length}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
        onNewSession={() => void newSession()}
        onSelectSession={selectSession}
        onTogglePin={(session) => void togglePin(session)}
        onRename={(session, title) => void renameSession(session, title)}
        onArchive={(session) => void archiveSession(session)}
        onRestore={(session) => void restoreSession(session)}
        onSearchChange={setSessionSearch}
        onSelectClient={selectClient}
        onJumpToApprovals={jumpToApprovals}
        onOpenSettings={() => openSettings("general")}
        pluginsLabel={pluginsCopy(locale).nav}
        pluginsActive={mainView === "plugins"}
        onShowPlugins={() => setMainView("plugins")}
      />

      <main className="main-column">
        {mainView === "plugins" ? (
          <div className="main-scroll">
            <PluginsView locale={locale} clientId={clientId} pluginTick={pluginTick} />
          </div>
        ) : (
        <>
        <div className="main-scroll">
          {error && (
            <div className="error-banner" role="alert">
              <IconError size={15} />
              <span>{error}</span>
              <Button size="sm" variant="subtle" onClick={() => void loadState()}>{copy.retry}</Button>
            </div>
          )}

          {!state.models.chatConfigured && (
            <div className="model-banner" role="status">
              <span className="model-banner-dot" aria-hidden="true" />
              <div>
                <strong>{copy.modelRequired}</strong>
                <p>{copy.modelBannerBody}</p>
              </div>
              <Button size="sm" variant="outline" icon={<IconSettings size={13} />} onClick={() => openSettings("models")}>{copy.configureModel}</Button>
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
          ) : state.messages.length === 0 ? (
            <div className="empty-stage">
              <MissionZero onPick={(prompt) => void submitGoal(prompt)} guiReady={state.models.guiConfigured} clients={state.clients.length} locale={locale} />
            </div>
          ) : null}

          {(timeline.length > 0 || submitting) && (
            <ConversationFeed
              copy={copy}
              locale={locale}
              timeline={timeline}
              experiments={state.experiments}
              audit={state.audit}
              computerMode={computerMode}
              guiConfigured={state.models.guiConfigured}
              submitting={submitting}
              onFork={(messageId) => void forkMessage(messageId)}
              onRiskReview={(approval) => void riskReview(approval)}
              onApprove={(approval) => void approve(approval)}
              onCommit={(approval) => void commit(approval)}
              onComputerControl={(action) => void computerControl(action)}
            />
          )}
        </div>

        <div className="composer-dock">
          <Composer
            copy={copy}
            locale={locale}
            goal={goal}
            onGoalChange={setGoal}
            chatConfigured={state.models.chatConfigured}
            submitting={submitting}
            onSubmit={() => void submitGoal()}
            onConfigureModel={() => openSettings("models")}
            planMode={state.planMode?.enabled === true}
            planModeDisabled={!clientId}
            onTogglePlanMode={() => void togglePlanMode()}
            clients={state.clients}
            clientId={clientId}
            onSelectClient={selectClient}
            autonomy={autonomy}
            autonomyDisabled={!clientId}
            onToggleAutonomy={() => void toggleAutonomy()}
            modelLabel={modelChipLabel(state.models.fast, copy.unassigned)}
            onOpenModelSettings={() => openSettings("models")}
          />
        </div>
        </>
        )}
      </main>

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
