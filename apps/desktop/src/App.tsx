import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCopy, phaseLabel, phaseTone, nextStepLabel, roleLabel, formatTime, pluginsCopy, workspaceCopy, type AppLocale } from "./labels.js";
import {
  appendProductEvent,
  emptyState,
  type ComputerExecutionStatus,
  type ConversationMessage,
  type ProductEvent,
  type ProductSession,
  type State
} from "./types.js";
import { isApprovalOpen, type Approval } from "./approvalDisclosure.js";
import { mergeConversationTimeline, type TimelineInsight } from "./conversationTimeline.js";
import { localInsightCommand } from "./slashCommands.js";
import { normalizePlanMode, planModeEndpoint, planModeRequestBody } from "./planMode.js";
import { autonomyEndpoint, autonomyRequestBody, normalizeAutonomy } from "./autonomy.js";
import { kernelProjectsUrl, type KernelProject } from "./workspace.js";
import {
  SESSION_SEARCH_DEBOUNCE_MS,
  applySessionSnapshot,
  buildSessionListUrl,
  fallbackSession,
  isRevisionConflict,
  isSessionPinned,
  normalizeSessionQuery
} from "./sessionList.js";
import { SettingsPanel, type SettingsData, type SettingsTab } from "./SettingsPanel.js";
import { ConversationFeed } from "./components/ConversationFeed.js";
import { Composer } from "./components/Composer.js";
import { PluginsView } from "./components/PluginsView.js";
import { PrimarySidebar, type PrimaryView } from "./components/PrimarySidebar.js";
import { LogoMark } from "./components/LogoMark.js";
import { HomeView } from "./views/HomeView.js";
import { ProjectsView } from "./views/ProjectsView.js";
import { ProjectView } from "./views/ProjectView.js";
import { AutomationsView } from "./views/AutomationsView.js";
import { SkillsView } from "./views/SkillsView.js";
import type { ComputerControlAction } from "./components/ComputerUseCard.js";
import { Badge, Button, Tooltip } from "./ui.js";
import { IconDismiss, IconError, IconMenu, IconSettings } from "./icons.js";

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
  const [sidebarHidden, setSidebarHidden] = useState(() => localStorage.getItem("adpilot-sidebar") === "hidden");
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
  /** Main-area view switch: home, the conversation, the projects workspace, or the plugins catalog. */
  const [mainView, setMainView] = useState<PrimaryView>("home");
  /** Project open in the workbench (mainView === "project"). */
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);  /** Artifact to pre-select when the workbench opens (clicked from Home). */
  const [focusArtifactId, setFocusArtifactId] = useState<string | null>(null);
  const [codeHandoff, setCodeHandoff] = useState<{ projectId: string; mission: string } | null>(null);
  /** Bumped to make ProjectsView open its create dialog (from the Home empty state). */
  const [projectsDialogNonce, setProjectsDialogNonce] = useState(0);
  /** Bumped on every plugin SSE event; PluginsView refetches on change. */
  const [pluginTick, setPluginTick] = useState(0);
  /** Workspace-creation modal. */
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState({ id: "", name: "", target: "20" });
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
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
  const computerActive = computerMode === "running"
    || computerMode === "paused"
    || Boolean(
      selectedSessionId
      && state.selectedSessionId === selectedSessionId
      && state.computerUse?.currentBrowser?.sessionStatus === "connected"
    );
  const timeline = useMemo(
    () => mergeConversationTimeline<ConversationMessage, Approval>(state.messages, state.events, conversationId, {
      approvals: state.approvals,
      approvalAt: (approval) => approval.createdAt ?? approval.executionPlan?.createdAt ?? approval.guardrail?.evaluatedAt,
      computerActive,
      computerTaskIds: state.tasks.map((task) => task.id),
      insights
    }),
    [state.messages, state.events, state.approvals, state.tasks, conversationId, computerActive, insights]
  );
  const openApprovals = useMemo(() => state.approvals.filter((item) => isApprovalOpen(item.status)), [state.approvals]);
  const autonomy = normalizeAutonomy(state.autonomy);
  const selectedSession = useMemo(() => sessions.find((session) => session.id === selectedSessionId), [sessions, selectedSessionId]);
  const archivedSessions = useMemo(() => sessions
    .filter((session) => session.archivedAt && !session.deletedAt)
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
    .slice(0, 8), [sessions]);
  const pinnedSessions = useMemo(() => (sessionSearchResults ?? sessions).filter(isSessionPinned), [sessions, sessionSearchResults]);
  const visibleSessions = useMemo(() => (sessionSearchResults ?? sessions).filter((session) => !isSessionPinned(session)), [sessions, sessionSearchResults]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [kernelProjects, setKernelProjects] = useState<KernelProject[]>([]);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    void fetch(kernelProjectsUrl(clientId))
      .then((response) => response.ok ? response.json() as Promise<{ projects?: KernelProject[] }> : { projects: [] })
      .then((body) => { if (!cancelled) setKernelProjects(body.projects ?? []); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [clientId, mainView]);

  function applySettings(data: SettingsData) {
    setSettingsData(data);
    setLocale(data.locale);
    const nextTheme = data.appearance === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : data.appearance;
    setTheme(nextTheme);
    localStorage.setItem("adpilot-locale", data.locale);
    localStorage.setItem("adpilot-theme", nextTheme);
    // Model and capability states depend on settings (chat/vision auth) —
    // reload so a saved model switch takes effect immediately, not next launch.
    void loadState();
  }

  function toggleSidebarHidden() {
    setSidebarHidden((current) => {
      localStorage.setItem("adpilot-sidebar", current ? "expanded" : "hidden");
      return !current;
    });
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebarHidden();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  /** Universal Workspace navigation: the rail switches top-level views. */
  function navigateRail(view: "home" | "chat" | "projects" | "automations" | "skills") {
    setMainView(view);
  }

  function openProject(projectId: string, artifactId?: string) {
    setActiveProjectId(projectId);
    setFocusArtifactId(artifactId ?? null);
    setMainView("project");
  }

  /** Quick inputs (Home hero, project CTA) hand the message to the real chat submission path. */
  function submitAndChat(message: string) {
    setMainView("chat");
    void submitGoal(message);
  }

  /** Home's Code hand-off: a development project is created from the text and
     opened with the text prefilled in its mission composer. */
  async function submitCodeProject(message: string) {
    if (!clientId) return;
    try {
      const response = await fetch(`/api/kernel/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: clientId,
          name: message.replace(/\s+/g, " ").trim().slice(0, 40) || "Code task",
          type: "development"
        })
      });
      if (!response.ok) throw new Error(String(response.status));
      const project = await response.json() as { id: string };
      setCodeHandoff({ projectId: project.id, mission: message });
      setActiveProjectId(project.id);
      setFocusArtifactId(null);
      setMainView("project");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Home's project-scoped Ask: jump into the project workbench with the
     text prefilled in its mission composer (same hand-off as Code). */
  function submitProjectGoal(projectId: string, message: string) {
    setCodeHandoff({ projectId, mission: message });
    setActiveProjectId(projectId);
    setFocusArtifactId(null);
    setMainView("project");
  }

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    localStorage.setItem("adpilot-theme", nextTheme);
    void (async () => {
      try {
        const response = await fetch("/api/settings");
        if (!response.ok) return;
        const current = await response.json() as SettingsData;
        await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            locale: current.locale ?? locale,
            appearance: nextTheme,
            models: {
              fast: current.models.fast,
              ...(current.models.strongConfigured && current.models.strong ? { strong: current.models.strong } : {})
            }
          })
        });
      } catch {
        // The local toggle already took effect; persistence retries next time.
      }
    })();
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
    setGoal("");
    setError("");
    setMainView("chat");
    await loadState(clientId, session.runtimeConversationId);
  }

  async function deleteSession(session: ProductSession) {
    if (!clientId) return;
    try {
      const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(session.id)}?revision=${session.revision}`, { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      setSessions((current) => current.filter((candidate) => candidate.id !== session.id));
      if (selectedSessionId === session.id) {
        const next = sessions.find((candidate) => candidate.id !== session.id && !candidate.archivedAt && !candidate.deletedAt);
        if (next) selectSession(next);
        else {
          setSelectedSessionId(null);
          setConversationId("primary");
          await loadState(clientId, "primary");
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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
    if (next === "__new_workspace__") { setWorkspaceModalOpen(true); return; }
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
      const currentBrowser = state.computerUse?.currentBrowser;
      const response = await fetch(`/api/computer/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId,
          ...(selectedSessionId ? { productSessionId: selectedSessionId } : {}),
          ...(currentBrowser?.sessionId ? { browserSessionId: currentBrowser.sessionId } : {}),
          ...(state.computerUse?.computerSessionId ? { computerSessionId: state.computerUse.computerSessionId } : {}),
          ...(state.computerUse?.computerRevision !== undefined ? { computerRevision: state.computerUse.computerRevision } : {})
        })
      });
      const body = await response.json().catch(() => undefined) as {
        error?: string;
        code?: string;
        executionStatus?: ComputerExecutionStatus;
        controlState?: string;
        productSessionId?: string;
        computerSessionId?: string;
        computerRevision?: number;
      } | undefined;
      if (!response.ok) {
        throw new Error(
          body?.code === "COMPUTER_USE_UNAVAILABLE"
            ? copy.computerUnavailable
            : body?.code === "COMPUTER_STEP_UNAVAILABLE"
              ? copy.stepUnavailable
              : copy.executionError
        );
      }
      const nextControlState = body?.controlState;
      if (nextControlState) {
        setState((current) => ({
          ...current,
          computerUse: {
            ...current.computerUse,
            controlState: nextControlState,
            ...(body?.executionStatus ? { executionStatus: body.executionStatus } : {}),
            ...(body?.productSessionId ? { productSessionId: body.productSessionId } : {}),
            ...(body?.computerSessionId ? { computerSessionId: body.computerSessionId } : {}),
            ...(body?.computerRevision !== undefined ? { computerRevision: body.computerRevision } : {})
          }
        }));
      }
      await loadState(clientId, conversationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await loadState(clientId, conversationId);
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

  /** Dismiss a blocked/completed task banner — archives server-side (audited, restorable), then refetches. */
  async function dismissTask(taskId: string) {
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) });
      if (!response.ok) throw new Error(copy.taskError);
      await loadState(clientId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function createWorkspace() {
    const id = workspaceDraft.id.trim();
    const name = workspaceDraft.name.trim() || id;
    const target = Number(workspaceDraft.target);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !Number.isFinite(target) || target <= 0 || workspaceSaving) return;
    setWorkspaceSaving(true);
    try {
      const response = await fetch("/api/clients", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: { id, name }, kpi: { primary: "CPA", target, currency: "USD" } }) });
      const body = await response.json().catch(() => undefined) as { id?: string; error?: string } | undefined;
      if (!response.ok || !body?.id) throw new Error(body?.error ?? copy.taskError);
      setWorkspaceModalOpen(false);
      setWorkspaceDraft({ id: "", name: "", target: "20" });
      selectClient(body.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorkspaceSaving(false);
    }
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
      {!sidebarHidden && (
        <PrimarySidebar
          copy={workspaceCopy(locale)}
          consoleCopy={copy}
          locale={locale}
          view={mainView}
          theme={theme}
          clients={state.clients}
          clientId={clientId}
          projects={kernelProjects}
          sessions={visibleSessions}
          selectedSessionId={selectedSessionId}
          search={sessionSearch}
          pinnedSessions={pinnedSessions}
          archivedSessions={archivedSessions}
          archivedOpen={archivedOpen}
          renamingId={renamingId}
          renameDraft={renameDraft}
          pluginsLabel={pluginsCopy(locale).nav}
          settingsLabel={copy.settings}
          themeLabel={copy.themeToggle}
          onNavigate={navigateRail}
          onCreateProject={() => {
            setMainView("projects");
            setProjectsDialogNonce((nonce) => nonce + 1);
          }}
          onNewSession={() => void newSession()}
          onDeleteSession={(session) => void deleteSession(session)}
          onSelectClient={selectClient}
          onSelectSession={selectSession}
          onTogglePin={(session) => void togglePin(session)}
          onStartRename={(session) => {
            setRenamingId(session.id);
            setRenameDraft(session.title);
          }}
          onRenameDraft={setRenameDraft}
          onCommitRename={(session) => {
            const title = renameDraft.trim();
            setRenamingId(null);
            if (title && title !== session.title) void renameSession(session, title);
          }}
          onCancelRename={() => setRenamingId(null)}
          onArchive={(session) => void archiveSession(session)}
          onRestore={(session) => void restoreSession(session)}
          onToggleArchivedOpen={() => setArchivedOpen((open) => !open)}
          onSearchChange={setSessionSearch}
          onShowPlugins={() => setMainView("plugins")}
          onOpenSettings={() => openSettings("general")}
          onToggleTheme={toggleTheme}
          onHideSidebar={toggleSidebarHidden}
        />
      )}

      {sidebarHidden && (
        <button
          type="button"
          className="sidebar-reopen"
          aria-label={copy.expandSidebar}
          onClick={toggleSidebarHidden}
        >
          <IconMenu size={15} />
        </button>
      )}

      <main className="main-column">
        {mainView === "project" && activeProjectId ? (
          <ProjectView
            key={activeProjectId}
            locale={locale}
            clientId={clientId}
            projectId={activeProjectId}
            focusArtifactId={focusArtifactId}
            initialMission={codeHandoff?.projectId === activeProjectId ? codeHandoff.mission : undefined}
            onBack={() => setMainView("projects")}
            onModelSaved={applySettings}
            onOpenSettings={() => openSettings("models")}
            onSubmitGoal={submitAndChat}
          />
        ) : mainView !== "chat" ? (
          <div className="main-scroll">
            {mainView === "home" && (
              <HomeView
                locale={locale}
                workspaceName={state.clients.find((client) => client.id === clientId)?.name ?? clientId}
                projects={kernelProjects}
                onSubmitGoal={submitAndChat}
                onSubmitCode={(message) => void submitCodeProject(message)}
                onSubmitProjectGoal={submitProjectGoal}
                onModelSaved={applySettings}
                onOpenSettings={() => openSettings("models")}
              />
            )}
            {mainView === "projects" && (
              <ProjectsView
                locale={locale}
                clientId={clientId}
                dialogNonce={projectsDialogNonce}
                onOpenProject={(projectId) => openProject(projectId)}
              />
            )}
            {mainView === "automations" && <AutomationsView locale={locale} clientId={clientId} />}
            {mainView === "skills" && <SkillsView locale={locale} />}
            {mainView === "plugins" && <PluginsView locale={locale} clientId={clientId} pluginTick={pluginTick} />}
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
                <div className="task-header-actions">
                  <Badge tone={phaseTone(currentTask.phase)} variant="soft">{phaseLabel(currentTask.phase, locale)}</Badge>
                  <Tooltip content={copy.dismissTask} side="top">
                    <Button size="sm" variant="subtle" className="icon-button" aria-label={copy.dismissTask} icon={<IconDismiss size={13} />} onClick={() => void dismissTask(currentTask.id)} />
                  </Tooltip>
                </div>
              </section>
              <section className="task-ledger" aria-label={copy.activeMission}>
                <Metric label={copy.evidenceSteps} value={String(currentTask.completedSteps.length).padStart(2, "0")} />
                <Metric label={copy.blockers} value={String(currentTask.blockers.length).padStart(2, "0")} />
                <Metric label={copy.operator} value={currentTask.owner ? roleLabel(currentTask.owner, locale) : copy.agent} compact />
                <Metric label={copy.reviewWindow} value={currentTask.reviewAt ? formatTime(currentTask.reviewAt, locale) : copy.unscheduled} compact />
              </section>
            </>
          ) : state.messages.length === 0 ? (
            <div className="chat-empty">
              <LogoMark size={26} />
              <p>{copy.chatEmptyHint}</p>
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
              {...(state.computerUse?.controlState ? { computerControlState: state.computerUse.controlState } : {})}
              {...(selectedSession?.permissionProfile?.computerUse ? { computerPermission: selectedSession.permissionProfile.computerUse } : {})}
              {...(clientId ? { clientId } : {})}
              {...(selectedSessionId ? { productSessionId: selectedSessionId } : {})}
              {...(state.computerUse?.currentBrowser?.sessionId ? { browserSessionId: state.computerUse.currentBrowser.sessionId } : {})}
              {...(state.computerUse?.currentBrowser ? {
                browserBindingKey: [
                  selectedSessionId ?? "no-product-session",
                  state.computerUse.currentBrowser.sessionId,
                  state.computerUse.currentBrowser.processId ?? "no-process",
                  state.computerUse.currentBrowser.windowId ?? "no-window"
                ].join(":")
              } : {})}
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
            onModelSaved={applySettings}
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
        {...(selectedSession ? { productSession: selectedSession } : {})}
        {...(selectedSessionId ? { productSessionId: selectedSessionId } : {})}
        {...(state.computerUse?.currentBrowser?.sessionId ? { browserSessionId: state.computerUse.currentBrowser.sessionId } : {})}
        initialTab={settingsTab}
        {...(settingsError ? { loadError: settingsError } : {})}
        onReload={() => void loadSettings()}
        onClose={() => setSettingsOpen(false)}
        onSaved={applySettings}
        onProductSessionUpdated={(session) => {
          setSessions((current) => applySessionSnapshot(current, session));
          setState((current) => ({
            ...current,
            sessions: applySessionSnapshot(current.sessions ?? [], session)
          }));
          void loadState(clientId, conversationId);
        }}
      />

      {workspaceModalOpen && (
        <div className="plugin-confirm-overlay" role="presentation" onClick={() => setWorkspaceModalOpen(false)}>
          <div className="plugin-confirm" role="dialog" aria-modal="true" aria-label={copy.createWorkspaceTitle} onClick={(event) => event.stopPropagation()}>
            <h2>{copy.createWorkspaceTitle}</h2>
            <label className="workspace-field">
              <span>{copy.workspaceIdLabel}</span>
              <input value={workspaceDraft.id} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, id: event.target.value })} placeholder="demo-client" autoFocus />
            </label>
            <label className="workspace-field">
              <span>{copy.workspaceNameLabel}</span>
              <input value={workspaceDraft.name} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, name: event.target.value })} placeholder="Demo Client" />
            </label>
            <label className="workspace-field">
              <span>{copy.workspaceKpiLabel} (CPA · USD)</span>
              <input value={workspaceDraft.target} inputMode="decimal" onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, target: event.target.value })} />
            </label>
            <div className="plugin-confirm-actions">
              <Button size="sm" variant="subtle" onClick={() => setWorkspaceModalOpen(false)}>{pluginsCopy(locale).cancel}</Button>
              <Button size="sm" variant="primary" disabled={workspaceSaving || !/^[a-z0-9][a-z0-9-]*$/.test(workspaceDraft.id.trim())} onClick={() => void createWorkspace()}>{copy.createAction}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return <div className={compact ? "compact" : ""}><span>{label}</span><strong>{value}</strong></div>;
}
