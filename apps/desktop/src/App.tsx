import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCopy, phaseLabel, phaseTone, nextStepLabel, pluginsCopy, workspaceCopy, type AppLocale } from "./labels.js";
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
import {
  eventBelongsToSelectedClient,
  sameStateLoadScope,
  sourceOwnsSelectedClient,
  StateLoadGuard,
  type StateLoadScope
} from "./stateLoadGuard.js";
import {
  projectChatRunBusyElsewhere,
  projectChatStopRequest,
  projectChatStopUrl,
  sameProjectChatRun,
  type ProjectChatRunTarget
} from "./projectChatRun.js";

/**
 * Codex-style skeleton: a collapsible sidebar (brand, new conversation,
 * session history, workspace + settings) next to a main conversation
 * column. The sidebar is driven by real product Sessions — the selected
 * session's runtimeConversationId keys the message projection. Switching
 * sessions never cancels in-flight work; while the current App request owns
 * the single run lock, other sessions report that run explicitly. The main
 * column splits into a scrolling region (banners,
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
  const [stopping, setStopping] = useState(false);
  const [activeRunTarget, setActiveRunTarget] = useState<ProjectChatRunTarget | null>(null);
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
  const [pendingCodeMission, setPendingCodeMission] = useState<string | null>(null);
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
  /** Synchronous lock prevents Enter and click from launching overlapping runs before React re-renders. */
  const submitLock = useRef(false);
  /** Stop always targets the run that was launched, even if the user switches sessions while it is active. */
  const activeRunTargetRef = useRef<ProjectChatRunTarget | null>(null);
  /** The exact connection-error string currently shown, so a successful SSE
      reconnect clears only its own error and never an unrelated task error. */
  const connectionErrorMessageRef = useRef<string | null>(null);
  /** Async state reads may resolve out of order. The guard binds every
      response to the workspace + conversation that launched it. */
  const stateLoadGuardRef = useRef(new StateLoadGuard({ clientId: "", conversationId: "primary" }));

  function selectStateScope(nextClientId: string, nextConversationId: string) {
    const previous = stateLoadGuardRef.current.selection();
    stateLoadGuardRef.current.select({ clientId: nextClientId, conversationId: nextConversationId });
    setClientId(nextClientId);
    setConversationId(nextConversationId);
    // `loading` is the one-time application boot gate. Later scope switches
    // keep the shell/composer mounted so an active run never loses Stop.
    // Clear scope-owned projections synchronously. Waiting for the new fetch
    // while retaining the previous payload can expose workspace A's
    // `primary` messages in workspace B (the conversation ids may match).
    setState((current) => ({
      ...emptyState,
      clients: current.clients,
      models: current.models,
      selectedClientId: nextClientId,
      selectedConversationId: nextConversationId,
      sessions: previous.clientId === nextClientId ? (current.sessions ?? []) : []
    }));
  }

  function scopeStillSelected(scope: StateLoadScope): boolean {
    return sameStateLoadScope(stateLoadGuardRef.current.selection(), scope);
  }

  const loadState = useCallback(async (requestedClientId?: string, requestedConversationId?: string) => {
    const ticket = stateLoadGuardRef.current.begin(requestedClientId, requestedConversationId);
    let resolvedClientId = ticket.clientId;
    let resolvedConversationId = ticket.conversationId;
    try {
      const params = new URLSearchParams();
      if (ticket.clientId) params.set("clientId", ticket.clientId);
      if (ticket.conversationId) params.set("conversationId", ticket.conversationId);
      const query = params.toString();
      const response = await fetch(`/api/state${query ? `?${query}` : ""}`);
      if (!response.ok) throw new Error(getCopy(locale).loadError);
      const data = await response.json() as State;
      resolvedClientId = data.selectedClientId ?? ticket.clientId;
      resolvedConversationId = data.selectedConversationId ?? ticket.conversationId;
      if (!stateLoadGuardRef.current.canCommit(ticket, resolvedClientId, resolvedConversationId)) return;
      const serverSessions = data.sessions ?? [];
      setSessions(serverSessions);
      if (!stateLoadGuardRef.current.selection().clientId && resolvedClientId) {
        stateLoadGuardRef.current.select({ clientId: resolvedClientId, conversationId: ticket.conversationId });
        setClientId(resolvedClientId);
      }
      if (!sessionBootstrap.current) {
        sessionBootstrap.current = true;
        const explicit = data.selectedSessionId ? serverSessions.find((session) => session.id === data.selectedSessionId) : undefined;
        const target = explicit ?? fallbackSession(serverSessions, "");
        if (target) {
          setSelectedSessionId(target.id);
          if (target.runtimeConversationId !== ticket.conversationId) {
            selectStateScope(resolvedClientId, target.runtimeConversationId);
            void loadState(resolvedClientId, target.runtimeConversationId);
            return;
          }
        }
      }
      // Commit only after bootstrap has resolved the real conversation. This
      // prevents primary/old-session messages flashing in the new view.
      if (!stateLoadGuardRef.current.canCommit(ticket, resolvedClientId, resolvedConversationId)) return;
      setState(data);
      setError("");
    } catch (cause) {
      if (stateLoadGuardRef.current.canCommit(ticket, resolvedClientId, resolvedConversationId)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (stateLoadGuardRef.current.canCommit(ticket, resolvedClientId, resolvedConversationId)) setLoading(false);
    }
  }, [locale]);

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
    const sourceClientId = clientId;
    const source = new EventSource(`/events?clientId=${encodeURIComponent(sourceClientId)}`);
    let active = true;
    let refreshTimer: number | undefined;
    const sourceOwnsScreen = () => active
      && sourceOwnsSelectedClient(sourceClientId, stateLoadGuardRef.current.selection());
    const scheduleRefresh = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void loadStateRef.current(), 250);
    };
    source.onmessage = (message) => {
      let event: ProductEvent;
      try { event = JSON.parse(message.data as string) as ProductEvent; } catch { return; }
      if (!sourceOwnsScreen()) return;
      // The server's synthetic handshake is scoped by the URL/connection and
      // intentionally has no clientId. It is the authoritative reconnect
      // signal, but may clear only the connection error that source created.
      if (event.type === "connected") {
        const connectionError = connectionErrorMessageRef.current;
        connectionErrorMessageRef.current = null;
        if (connectionError) setError((current) => current === connectionError ? "" : current);
        return;
      }
      // React can switch workspaces before the previous EventSource cleanup
      // drains an already queued message. Never merge that old client's event
      // into the newly selected workspace.
      if (!eventBelongsToSelectedClient(event.clientId, stateLoadGuardRef.current.selection(), sourceClientId)) return;
      if (event.type === "session") {
        const snapshot = event.session;
        if (snapshot?.clientId === sourceClientId) setSessions((current) => applySessionSnapshot(current, snapshot));
      } else if (event.type === "plugin") {
        setPluginTick((tick) => tick + 1);
      } else if (event.type === "alert" || event.type === "computer") {
        setState((current) => ({ ...current, events: appendProductEvent(current.events, event) }));
      } else {
        scheduleRefresh();
      }
    };
    source.onerror = () => {
      if (!sourceOwnsScreen()) return;
      const connectionError = copyRef.current.connectionError;
      connectionErrorMessageRef.current = connectionError;
      setError(connectionError);
    };
    return () => {
      active = false;
      window.clearTimeout(refreshTimer);
      source.close();
    };
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
  const submittingCurrentConversation = submitting && sameProjectChatRun(activeRunTarget, {
    clientId: clientId || "personal",
    conversationId
  });
  const runBusyElsewhere = submitting && projectChatRunBusyElsewhere(activeRunTarget, {
    clientId: clientId || "personal",
    conversationId
  });
  const canStopCurrentRun = submittingCurrentConversation
    && sameProjectChatRun(activeRunTargetRef.current, activeRunTarget);
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
  async function refreshSessions(ownerScope: StateLoadScope) {
    if (!ownerScope.clientId) return;
    try {
      const response = await fetch(buildSessionListUrl(ownerScope.clientId));
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { sessions?: ProductSession[] };
      if (scopeStillSelected(ownerScope)) setSessions(body.sessions ?? []);
    } catch {
      if (scopeStillSelected(ownerScope)) setError(copy.sessionActionError);
    }
  }

  /**
   * Shared session-mutation plumbing. Every write goes through the revision
   * chain: the request carries the revision of the entity the user acted on,
   * the response carries the next revision and replaces the local entity.
   * A 409 REVISION_CONFLICT means another writer moved first — resync the
   * list and say so instead of retrying blindly.
   */
  async function sessionMutation(ownerScope: StateLoadScope, url: string, init: RequestInit): Promise<ProductSession | undefined> {
    try {
      const response = await fetch(url, init);
      const body = await response.json().catch(() => undefined) as (ProductSession & { error?: string; code?: string }) | undefined;
      if (response.ok && body?.clientId === ownerScope.clientId) return body;
      if (!scopeStillSelected(ownerScope)) return undefined;
      await refreshSessions(ownerScope);
      if (scopeStillSelected(ownerScope)) {
        setError(isRevisionConflict(body) ? copy.sessionConflict : (body?.error ?? copy.sessionActionError));
      }
    } catch (cause) {
      if (scopeStillSelected(ownerScope)) setError(cause instanceof Error ? cause.message : String(cause));
    }
    return undefined;
  }

  function selectSession(session: ProductSession) {
    if (session.clientId !== clientId) return;
    if (session.id === selectedSessionId && mainView === "chat") return;
    setMainView("chat");
    setSelectedSessionId(session.id);
    selectStateScope(clientId, session.runtimeConversationId);
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

  /** Code work must bind a real project root before any coding tool exists. */
  function submitCodeProject(message: string) {
    if (!clientId) return;
    setPendingCodeMission(message);
    setMainView("projects");
    setProjectsDialogNonce((nonce) => nonce + 1);
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
    const ownerScope = stateLoadGuardRef.current.selection();
    if (ownerScope.clientId !== clientId) return;
    const session = await sessionMutation(ownerScope, `/api/clients/${encodeURIComponent(ownerScope.clientId)}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: copy.untitledSession })
    });
    if (!session || !scopeStillSelected(ownerScope)) return;
    setSessions((current) => applySessionSnapshot(current, session));
    setSessionSearch("");
    setSelectedSessionId(session.id);
    selectStateScope(ownerScope.clientId, session.runtimeConversationId);
    setInsights([]);
    setGoal("");
    setError("");
    setMainView("chat");
    await loadState(ownerScope.clientId, session.runtimeConversationId);
  }

  async function deleteSession(session: ProductSession) {
    if (!clientId) return;
    const ownerScope = stateLoadGuardRef.current.selection();
    if (session.clientId !== ownerScope.clientId) return;
    try {
      const response = await fetch(`/api/clients/${encodeURIComponent(ownerScope.clientId)}/sessions/${encodeURIComponent(session.id)}?revision=${session.revision}`, { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      if (!scopeStillSelected(ownerScope)) return;
      setSessions((current) => current.filter((candidate) => candidate.id !== session.id));
      if (selectedSessionId === session.id) {
        const next = sessions.find((candidate) => candidate.id !== session.id && !candidate.archivedAt && !candidate.deletedAt);
        if (next) selectSession(next);
        else {
          setSelectedSessionId(null);
          selectStateScope(ownerScope.clientId, "primary");
          await loadState(ownerScope.clientId, "primary");
        }
      }
    } catch (cause) {
      if (scopeStillSelected(ownerScope)) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function togglePin(session: ProductSession) {
    const ownerScope = stateLoadGuardRef.current.selection();
    if (session.clientId !== ownerScope.clientId) return;
    const pinned = session.pinnedAt === undefined;
    const optimistic: ProductSession = { ...session };
    if (pinned) optimistic.pinnedAt = new Date().toISOString(); else delete optimistic.pinnedAt;
    setSessions((current) => applySessionSnapshot(current, optimistic));
    const updated = await sessionMutation(ownerScope, `/api/clients/${encodeURIComponent(ownerScope.clientId)}/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: session.revision, pinned })
    });
    if (updated && scopeStillSelected(ownerScope)) setSessions((current) => applySessionSnapshot(current, updated));
  }

  async function renameSession(session: ProductSession, title: string) {
    const ownerScope = stateLoadGuardRef.current.selection();
    if (session.clientId !== ownerScope.clientId) return;
    setSessions((current) => applySessionSnapshot(current, { ...session, title }));
    const updated = await sessionMutation(ownerScope, `/api/clients/${encodeURIComponent(ownerScope.clientId)}/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: session.revision, title })
    });
    if (updated && scopeStillSelected(ownerScope)) setSessions((current) => applySessionSnapshot(current, updated));
  }

  async function archiveSession(session: ProductSession) {
    const ownerScope = stateLoadGuardRef.current.selection();
    if (session.clientId !== ownerScope.clientId) return;
    const updated = await sessionMutation(ownerScope, `/api/clients/${encodeURIComponent(ownerScope.clientId)}/sessions/${encodeURIComponent(session.id)}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: session.revision })
    });
    if (!updated || !scopeStillSelected(ownerScope)) return;
    const next = applySessionSnapshot(sessions, updated);
    setSessions(next);
    if (session.id === selectedSessionId) {
      const fallback = fallbackSession(next, session.id);
      if (fallback) selectSession(fallback);
      else {
        setSelectedSessionId(null);
        selectStateScope(ownerScope.clientId, "primary");
        void loadState(ownerScope.clientId, "primary");
      }
    }
  }

  async function restoreSession(session: ProductSession) {
    const ownerScope = stateLoadGuardRef.current.selection();
    if (session.clientId !== ownerScope.clientId) return;
    const updated = await sessionMutation(ownerScope, `/api/clients/${encodeURIComponent(ownerScope.clientId)}/sessions/${encodeURIComponent(session.id)}/unarchive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: session.revision })
    });
    if (updated && scopeStillSelected(ownerScope)) setSessions((current) => applySessionSnapshot(current, updated));
  }

  function selectClient(next: string) {
    if (next === "__new_workspace__") { setWorkspaceModalOpen(true); return; }
    setSelectedSessionId(null);
    selectStateScope(next, "primary");
    setSessions([]);
    setKernelProjects([]);
    setSessionSearch("");
    setSessionSearchResults(null);
    setInsights([]);
    // Drafts are workspace-private. Never carry a chat/code mission from one
    // advertiser or repository context into another workspace.
    setGoal("");
    setCodeHandoff(null);
    setPendingCodeMission(null);
    setFocusArtifactId(null);
    if (mainView === "project") {
      setActiveProjectId(null);
      setMainView("projects");
    }
    sessionBootstrap.current = false;
    void loadState(next, "primary");
  }

  async function submitGoal(override?: string) {
    const message = (override ?? goal).trim();
    if (!message) return;
    if (submitLock.current) {
      setError(copy.runBusyElsewhereHint);
      return;
    }
    const insightKind = localInsightCommand(message);
    if (insightKind) {
      setGoal("");
      setInsights((current) => [...current, { id: `insight-${Date.now()}`, kind: insightKind, at: new Date().toISOString() }]);
      return;
    }
    const isSlashCommand = message.startsWith("/");
    if (!state.models.chatConfigured && !isSlashCommand) { setSettingsTab("models"); setSettingsOpen(true); return; }
    submitLock.current = true;
    setSubmitting(true); setError("");
    setGoal("");
    const runId = crypto.randomUUID();
    const launchScope = stateLoadGuardRef.current.selection();
    const launchClientId = launchScope.clientId || clientId || "personal";
    // Publish the launch scope immediately so a workspace switch during
    // Session creation reports "running elsewhere" instead of looking idle.
    // The Stop ref remains null until the real server conversation is known.
    setActiveRunTarget({ clientId: launchClientId, conversationId: launchScope.conversationId, runId });
    let targetConversationId = launchScope.conversationId;
    let session = selectedSession?.clientId === launchClientId ? selectedSession : undefined;
    try {
      // Resolve the target session: the selected one, or a freshly created one
      // so the very first message of a workspace already lives in a Session.
      if (!session && launchScope.clientId) {
        const created = await sessionMutation(launchScope, `/api/clients/${encodeURIComponent(launchScope.clientId)}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        });
        if (created) {
          session = created;
          const currentScope = stateLoadGuardRef.current.selection();
          if (currentScope.clientId === launchScope.clientId && currentScope.conversationId === launchScope.conversationId) {
            setSessions((current) => applySessionSnapshot(current, created));
            setSelectedSessionId(created.id);
            selectStateScope(created.clientId, created.runtimeConversationId);
          }
        }
      }
      targetConversationId = session ? session.runtimeConversationId : launchScope.conversationId;
      const target = { clientId: session?.clientId ?? launchClientId, conversationId: targetConversationId, runId };
      activeRunTargetRef.current = target;
      setActiveRunTarget(target);
      if (sameProjectChatRun(stateLoadGuardRef.current.selection(), target)) {
        setState((current) => ({ ...current, messages: [...current.messages, { id: `local-${Date.now()}`, clientId: target.clientId, conversationId: targetConversationId, role: "user", content: message, status: "complete", at: new Date().toISOString() }] }));
      }
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: target.clientId,
          conversationId: targetConversationId,
          runId,
          ...(session ? { sessionId: session.id } : {}),
          message,
          locale
        })
      });
      const body = await response.json(); if (!response.ok) throw new Error(copy.taskError);
      await loadState(target.clientId || body.message?.clientId, targetConversationId);
    } catch (cause) {
      const target = { clientId: session?.clientId ?? launchClientId, conversationId: targetConversationId, runId };
      if (sameProjectChatRun(stateLoadGuardRef.current.selection(), target)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      await loadState(target.clientId, targetConversationId);
    }
    finally {
      submitLock.current = false;
      activeRunTargetRef.current = null;
      setActiveRunTarget(null);
      setStopping(false);
      setSubmitting(false);
    }
  }

  async function stopActiveRun() {
    const target = activeRunTargetRef.current;
    if (!target || stopping) return;
    setStopping(true);
    setError("");
    try {
      const response = await fetch(projectChatStopUrl(target), projectChatStopRequest(target));
      const body = await response.json().catch(() => undefined) as { stopped?: boolean; error?: string } | undefined;
      if (!response.ok) throw new Error(body?.error ?? copy.stopRunError);
      // Keep the control in its "Stopping" state until the original message
      // request observes the abort and releases the run lock.
      if (body?.stopped !== true) setStopping(false);
    } catch (cause) {
      setStopping(false);
      setError(cause instanceof Error ? cause.message : copy.stopRunError);
    }
  }

  async function forkMessage(messageId: string) {
    const ownerScope = stateLoadGuardRef.current.selection();
    const ownerSession = selectedSession;
    try {
      if (ownerSession) {
        if (ownerSession.clientId !== ownerScope.clientId) return;
        // Branch produces a brand-new product Session at the given message;
        // the original keeps running untouched.
        const response = await fetch(`/api/clients/${encodeURIComponent(ownerScope.clientId)}/sessions/${encodeURIComponent(ownerSession.id)}/branch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ atMessageId: messageId }) });
        const body = await response.json().catch(() => undefined) as (ProductSession & { error?: string }) | undefined;
        if (!response.ok || !body?.id || body.clientId !== ownerScope.clientId) throw new Error(body?.error ?? copy.forkError);
        if (!scopeStillSelected(ownerScope)) return;
        setSessions((current) => applySessionSnapshot(current, body));
        setSelectedSessionId(body.id);
        selectStateScope(ownerScope.clientId, body.runtimeConversationId);
        setInsights([]);
        await loadState(ownerScope.clientId, body.runtimeConversationId);
      } else {
        // Legacy conversations without a Session keep the old fork endpoint.
        const response = await fetch(`/api/clients/${encodeURIComponent(ownerScope.clientId)}/conversations/${encodeURIComponent(ownerScope.conversationId)}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ atMessageId: messageId }) });
        const body = await response.json() as { conversationId?: string; error?: string };
        if (!response.ok || !body.conversationId) throw new Error(body.error ?? copy.forkError);
        if (!scopeStillSelected(ownerScope)) return;
        selectStateScope(ownerScope.clientId, body.conversationId);
        await loadState(ownerScope.clientId, body.conversationId);
      }
    } catch (cause) {
      if (scopeStillSelected(ownerScope)) setError(cause instanceof Error ? cause.message : String(cause));
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
    const ownerScope = stateLoadGuardRef.current.selection();
    const ownerSessionId = selectedSessionId;
    try {
      const currentBrowser = state.computerUse?.currentBrowser;
      const response = await fetch(`/api/computer/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: ownerScope.clientId,
          ...(ownerSessionId ? { productSessionId: ownerSessionId } : {}),
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
      if (!scopeStillSelected(ownerScope)) return;
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
      await loadState(ownerScope.clientId, ownerScope.conversationId);
    } catch (cause) {
      if (!scopeStillSelected(ownerScope)) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      await loadState(ownerScope.clientId, ownerScope.conversationId);
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
            key={`${clientId}:${activeProjectId}`}
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
                onSubmitCode={submitCodeProject}
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
                {...(pendingCodeMission ? { initialCodeMission: pendingCodeMission } : {})}
                onOpenProject={(projectId) => openProject(projectId)}
                onProjectCreated={(project) => {
                  if (pendingCodeMission && project.type === "development") {
                    setCodeHandoff({ projectId: project.id, mission: pendingCodeMission });
                  }
                  setPendingCodeMission(null);
                  openProject(project.id);
                }}
                onCreateCancelled={() => setPendingCodeMission(null)}
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
            <section className="task-banner" data-phase={currentTask.phase}>
              <span className="task-banner-label">{copy.activeMission} · {currentTask.id.slice(0, 6)}</span>
              <span className="task-banner-goal" title={currentTask.goal}>{currentTask.goal}</span>
              <span className="task-banner-next">{currentTask.nextStep ? nextStepLabel(currentTask.nextStep, locale) : copy.preparingEvidence}</span>
              <Badge tone={phaseTone(currentTask.phase)} variant="soft">{phaseLabel(currentTask.phase, locale)}</Badge>
              <Tooltip content={copy.dismissTask} side="top">
                <Button size="sm" variant="subtle" className="icon-button" aria-label={copy.dismissTask} icon={<IconDismiss size={13} />} onClick={() => void dismissTask(currentTask.id)} />
              </Tooltip>
            </section>
          ) : state.messages.length === 0 ? (
            <div className="chat-empty">
              <LogoMark size={26} />
              <p>{copy.chatEmptyHint}</p>
            </div>
          ) : null}

          {(timeline.length > 0 || submittingCurrentConversation) && (
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
              submitting={submittingCurrentConversation}
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
            submitting={submittingCurrentConversation}
            busyElsewhere={runBusyElsewhere}
            stopping={stopping}
            onSubmit={() => void submitGoal()}
            {...(isNativeDesktop && canStopCurrentRun ? { onStop: () => void stopActiveRun() } : {})}
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
