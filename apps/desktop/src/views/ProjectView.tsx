import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactStatusLabel,
  artifactStatusTone,
  artifactTypeLabel,
  decisionConfidenceLabel,
  decisionStatusLabel,
  decisionStatusTone,
  formatTime,
  getCopy,
  goalStatusLabel,
  goalStatusTone,
  kernelTaskStatusLabel,
  kernelTaskStatusTone,
  projectTypeLabel,
  sessionStatusLabel,
  workspaceCopy,
  type AppLocale
} from "../labels.js";
import {
  adsDecisionsUrl,
  buildProjectMessageRequest,
  buildProjectSessionRequest,
  fsFileUrl,
  fsTreeUrl,
  groupKernelTasks,
  interpolate,
  kernelProjectSessionUrl,
  kernelProjectUrl,
  kernelTaskCompleteUrl,
  localProjectUserMessage,
  parseRootPathsInput,
  projectDefaultRoot,
  shortId,
  sortDecisionsRecent,
  type AdDecision,
  type DecisionConfidence,
  type FsFileResponse,
  type FsTreeEntry,
  type FsTreeResponse,
  type KernelArtifact,
  type KernelGoal,
  type ProjectDetail
} from "../workspace.js";
import type { SettingsData } from "../SettingsPanel.js";
import { ModelPicker } from "../components/ModelPicker.js";
import type { ConversationMessage, ProductSession } from "../types.js";
import { Badge, Button, Tooltip } from "../ui.js";
import {
  IconArrowLeft,
  IconBot,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDismiss,
  IconDoc,
  IconError,
  IconFile,
  IconFolder,
  IconInfo,
  IconPanelRight,
  IconPlus,
  IconRefresh,
  IconSend,
  IconSheet,
  IconSlides,
  IconStop
} from "../icons.js";
import { TerminalPanel } from "../panels/TerminalPanel.js";
import { GitPanel } from "../panels/GitPanel.js";
import { PreviewPanel } from "../panels/PreviewPanel.js";
import {
  projectChatCleanupStopRequest,
  projectChatStopRequest,
  projectChatStopUrl,
  ProjectChatRunLifecycle,
  ProjectSessionBindGuard,
  sameProjectChatRun,
  sameProjectChatProjectRunRequest,
  shouldSubmitProjectChatKey,
  type ProjectChatProjectRunTarget
} from "../projectChatRun.js";

type LeftTab = "goals" | "files" | "artifacts";
type RightTab = "terminal" | "git" | "preview";

/**
 * Project workbench: the three-column Universal Workspace surface. Left —
 * goals (progress + create), files (bounded tree over /api/fs with an inline
 * text preview), artifacts. Middle — the project chat: a durable product
 * Session bound to the kernel project (resolved via POST
 * /api/kernel/projects/:id/session), its message feed served by the same
 * conversation.jsonl projection as the main chat, a collapsible kernel task
 * timeline on top, and a mission composer at the bottom that posts one exact
 * /api/messages run; server-side triage creates any required goal/task inside
 * that same stoppable run. Right — collapsible dynamic panel
 * (terminal / git / artifact preview).
 */
export function ProjectView({ locale, clientId, projectId, focusArtifactId, initialMission, onBack, onModelSaved, onOpenSettings }: {
  locale: AppLocale;
  clientId: string;
  projectId: string;
  /** Artifact to pre-select in the preview panel (e.g. clicked from Home). */
  focusArtifactId?: string | null;
  /** Prefill the mission composer (e.g. Home's Code hand-off). */
  initialMission?: string | undefined;
  onBack: () => void;
  onModelSaved: (data: SettingsData) => void;
  onOpenSettings: () => void;
  /** @deprecated Missions no longer hand off to the chat view; kept for App's prop contract. */
  onSubmitGoal?: (message: string) => void;
}) {
  const copy = workspaceCopy(locale);
  const consoleCopy = getCopy(locale);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [leftTab, setLeftTab] = useState<LeftTab>("goals");
  const [rightTab, setRightTab] = useState<RightTab>("terminal");
  const [rightOpen, setRightOpen] = useState(true);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(focusArtifactId ?? null);
  const [mission, setMission] = useState(initialMission ?? "");
  /** The durable session this project's chat is bound to. */
  const [session, setSession] = useState<ProductSession | null>(null);
  const sessionRef = useRef<ProductSession | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const bindGuardRef = useRef(new ProjectSessionBindGuard());
  const bindLockRef = useRef(false);
  const [bindingSession, setBindingSession] = useState(false);
  /** The immutable launch scope owns both the running indicator and Stop. */
  const [activeRunTarget, setActiveRunTarget] = useState<ProjectChatProjectRunTarget | null>(null);
  const runLifecycleRef = useRef(new ProjectChatRunLifecycle());
  const messageRequestRef = useRef<{
    target: ProjectChatProjectRunTarget;
    controller: AbortController;
  } | null>(null);
  const mountedRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);

  const selectedRunTarget = session
    ? { clientId, conversationId: session.runtimeConversationId }
    : null;
  const submitting = sameProjectChatRun(activeRunTarget, selectedRunTarget);

  function ownsMountedRun(target: ProjectChatProjectRunTarget): boolean {
    const currentSession = sessionRef.current;
    return mountedRef.current
      && runLifecycleRef.current.owns(target)
      && currentSession?.id === target.sessionId
      && currentSession?.clientId === target.clientId
      && currentSession.runtimeConversationId === target.conversationId;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const runScopeSessionId = session?.id;
  const runScopeConversationId = session?.runtimeConversationId;
  useEffect(() => {
    // A replacement scope starts with no locally owned Project run. This runs
    // after the previous scope's cleanup has atomically claimed its target.
    setActiveRunTarget(runLifecycleRef.current.current());
    setStopping(false);
    if (!runScopeSessionId || !runScopeConversationId) return;
    const scope = { clientId, projectId, sessionId: runScopeSessionId, conversationId: runScopeConversationId };
    return () => {
      const target = runLifecycleRef.current.claimForScopeExit(scope);
      if (!target) return; // StrictMode's empty probe cleanup is a no-op.
      void fetch(projectChatStopUrl(target), projectChatCleanupStopRequest(target)).catch(() => undefined);
      const request = messageRequestRef.current;
      if (request && sameProjectChatProjectRunRequest(request.target, target)) {
        messageRequestRef.current = null;
        request.controller.abort();
      }
    };
  }, [clientId, projectId, runScopeConversationId, runScopeSessionId]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(kernelProjectUrl(projectId, clientId));
      if (!response.ok) throw new Error(String(response.status));
      const nextDetail = await response.json() as ProjectDetail;
      if (!mountedRef.current) return;
      setDetail(nextDetail);
      setError("");
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [clientId, projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (focusArtifactId) {
      setSelectedArtifactId(focusArtifactId);
      setRightTab("preview");
      setRightOpen(true);
    }
  }, [focusArtifactId]);

  /** Read a session transcript without committing it. Session binding fetches
   * session + messages first, then publishes both atomically. */
  const readMessages = useCallback(async (target: ProductSession) => {
    const response = await fetch(`/api/state?clientId=${encodeURIComponent(target.clientId)}&conversationId=${encodeURIComponent(target.runtimeConversationId)}`);
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json() as {
      selectedClientId?: string;
      selectedConversationId?: string;
      messages?: ConversationMessage[];
    };
    if (
      (data.selectedClientId !== undefined && data.selectedClientId !== target.clientId)
      || (data.selectedConversationId !== undefined && data.selectedConversationId !== target.runtimeConversationId)
    ) {
      throw new Error(consoleCopy.loadError);
    }
    const next = data.messages ?? [];
    if (next.some((message) => message.clientId !== target.clientId || message.conversationId !== target.runtimeConversationId)) {
      throw new Error(consoleCopy.loadError);
    }
    return next;
  }, [consoleCopy.loadError]);

  /** Refresh only the session that still owns this mounted Project view. */
  const loadMessages = useCallback(async (target: ProductSession, expectedRun: ProjectChatProjectRunTarget) => {
    const next = await readMessages(target);
    const current = sessionRef.current;
    if (
      mountedRef.current
      && runLifecycleRef.current.owns(expectedRun)
      && current?.id === target.id
      && current.clientId === target.clientId
      && current.runtimeConversationId === target.runtimeConversationId
    ) {
      setMessages(next);
    }
  }, [readMessages]);

  /** Resolve (or, with force, freshly create) the project's session and load its feed. */
  const bindSession = useCallback(async (force: boolean) => {
    if (bindLockRef.current || runLifecycleRef.current.current()) return null;
    bindLockRef.current = true;
    setBindingSession(true);
    const requestId = bindGuardRef.current.begin();
    try {
      const response = await fetch(kernelProjectSessionUrl(projectId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildProjectSessionRequest(clientId, force))
      });
      const body = await response.json().catch(() => undefined) as { session?: ProductSession; error?: string } | undefined;
      if (!response.ok || !body?.session) throw new Error(body?.error ?? String(response.status));
      if (
        body.session.clientId !== clientId
        || (body.session.projectId !== undefined && body.session.projectId !== projectId)
      ) {
        throw new Error(consoleCopy.loadError);
      }
      if (!mountedRef.current || !bindGuardRef.current.canCommit(requestId)) return null;
      const nextMessages = await readMessages(body.session);
      if (!mountedRef.current || !bindGuardRef.current.canCommit(requestId)) return null;
      sessionRef.current = body.session;
      setSession(body.session);
      setMessages(nextMessages);
      setError("");
      return body.session;
    } catch (cause) {
      if (mountedRef.current && bindGuardRef.current.canCommit(requestId)) setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      if (mountedRef.current && bindGuardRef.current.canCommit(requestId)) {
        bindLockRef.current = false;
        setBindingSession(false);
      }
    }
  }, [clientId, consoleCopy.loadError, projectId, readMessages]);

  useEffect(() => { void bindSession(false); }, [bindSession]);
  useEffect(() => () => {
    // Invalidate any binding response queued after this Project instance was
    // replaced (client/project switch or development Strict Mode remount).
    bindGuardRef.current.begin();
    bindLockRef.current = false;
  }, []);

  const goalById = useMemo(() => new Map((detail?.goals ?? []).map((goal) => [goal.id, goal])), [detail?.goals]);
  const taskGroups = useMemo(() => groupKernelTasks(detail?.tasks ?? []), [detail?.tasks]);

  function openArtifact(artifact: KernelArtifact) {
    setSelectedArtifactId(artifact.id);
    setRightTab("preview");
    setRightOpen(true);
  }

  async function completeTask(taskId: string) {
    try {
      const response = await fetch(kernelTaskCompleteUrl(taskId), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error(String(response.status));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /**
   * Mission submit is one exact run. Server-side complexity triage now occurs
   * inside /api/messages after that runId has been reserved, so Stop cannot be
   * lost in a separate pre-processing request. The response carries any Goal
   * and Task materialized for a complex mission.
   */
  async function submitMission() {
    const message = mission.trim();
    if (!message || bindLockRef.current || runLifecycleRef.current.current() || !session) return;
    const targetSession = session;
    const target: ProjectChatProjectRunTarget = {
      clientId,
      projectId,
      sessionId: targetSession.id,
      conversationId: targetSession.runtimeConversationId,
      runId: crypto.randomUUID()
    };
    runLifecycleRef.current.start(target);
    const messageController = new AbortController();
    messageRequestRef.current = { target, controller: messageController };
    setActiveRunTarget(target);
    setStopping(false);
    setMission("");
    setMessages((current) => [...current, localProjectUserMessage(target.clientId, target.conversationId, message)]);
    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        signal: messageController.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildProjectMessageRequest({
          clientId,
          conversationId: target.conversationId,
          runId: target.runId,
          sessionId: targetSession.id,
          projectId,
          message,
          locale
        }))
      });
      const body = await response.json().catch(() => undefined) as { goalId?: string; taskId?: string; error?: string } | undefined;
      if (!response.ok) throw new Error(body?.error ?? String(response.status));
      if (!ownsMountedRun(target)) return;
      if (body?.goalId || body?.taskId) await load();
      if (!ownsMountedRun(target)) return;
      await loadMessages(targetSession, target);
      if (ownsMountedRun(target)) setError("");
    } catch (cause) {
      if (ownsMountedRun(target)) {
        setError(cause instanceof Error ? cause.message : String(cause));
        await loadMessages(targetSession, target).catch(() => undefined);
      }
    } finally {
      if (sameProjectChatProjectRunRequest(messageRequestRef.current?.target ?? null, target)) {
        messageRequestRef.current = null;
      }
      if (runLifecycleRef.current.complete(target) && mountedRef.current) {
        setActiveRunTarget(null);
        setStopping(false);
      }
    }
  }

  async function stopProjectRun() {
    // Read the ref captured before the message request started. Never derive
    // this URL from the project/session currently on screen: either can
    // change while the run is awaiting the server.
    const target = runLifecycleRef.current.current();
    if (!target || stopping) return;
    setStopping(true);
    setError("");
    try {
      const response = await fetch(projectChatStopUrl(target), projectChatStopRequest(target));
      const body = await response.json().catch(() => undefined) as { stopped?: boolean; error?: string } | undefined;
      if (!response.ok) throw new Error(body?.error ?? consoleCopy.stopRunError);
      if (ownsMountedRun(target) && body?.stopped !== true) setStopping(false);
    } catch (cause) {
      if (ownsMountedRun(target)) {
        setStopping(false);
        setError(cause instanceof Error ? cause.message : consoleCopy.stopRunError);
      }
    }
  }

  return (
    <div className="project-shell">
      <header className="project-head">
        <Button size="sm" variant="subtle" icon={<IconArrowLeft size={14} />} onClick={onBack}>{copy.backToProjects}</Button>
        <div className="project-head-title">
          <h1>{detail?.name ?? "…"}</h1>
          {detail && <Badge tone="neutral" variant="outline">{projectTypeLabel(detail.type, locale)}</Badge>}
        </div>
        <span className="panel-spacer" />
        <Tooltip content={rightOpen ? copy.collapsePanel : copy.expandPanel} side="bottom">
          <Button
            size="sm"
            variant="subtle"
            className="icon-button"
            icon={<IconPanelRight size={15} />}
            aria-label={rightOpen ? copy.collapsePanel : copy.expandPanel}
            aria-pressed={rightOpen}
            data-active={rightOpen || undefined}
            onClick={() => setRightOpen((open) => !open)}
          />
        </Tooltip>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="subtle" onClick={() => void load()}>{copy.retry}</Button>
        </div>
      )}

      <div className="project-layout" data-right={rightOpen ? "open" : "closed"}>
        <aside className="project-col project-left">
          <div className="project-tabs" role="tablist">
            {(["goals", "files", "artifacts"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={leftTab === tab}
                className="project-tab"
                data-active={leftTab === tab || undefined}
                onClick={() => setLeftTab(tab)}
              >
                {tab === "goals" ? copy.tabGoals : tab === "files" ? copy.tabFiles : copy.tabArtifacts}
              </button>
            ))}
          </div>
          <div className="project-col-scroll">
            {leftTab === "goals" && detail && <GoalsTab locale={locale} goals={detail.goals} projectId={detail.id} onChanged={() => void load()} onError={setError} />}
            {leftTab === "files" && detail && <FilesTab locale={locale} rootPaths={detail.rootPaths} />}
            {leftTab === "artifacts" && detail && (
              <ArtifactsTab locale={locale} artifacts={detail.artifacts} selectedId={selectedArtifactId} onOpen={openArtifact} />
            )}
          </div>
        </aside>

        <section className="project-col project-middle">
          <div className="project-chat-head">
            <div className="project-chat-head-main">
              <span className="section-kicker">{copy.projectChatTitle}</span>
              <strong className="project-chat-session-title">{session?.title ?? "…"}</strong>
            </div>
            {session && (
              <Badge tone={sessionChatTone(session.status)} variant="soft">{sessionStatusLabel(session.status, locale)}</Badge>
            )}
            <Button size="sm" variant="outline" icon={<IconPlus size={12} />} disabled={bindingSession || activeRunTarget !== null} aria-busy={bindingSession} onClick={() => void bindSession(true)}>
              {copy.projectChatNewSession}
            </Button>
          </div>

          <div className="project-timeline">
            <button type="button" className="project-timeline-toggle" aria-expanded={timelineOpen} onClick={() => setTimelineOpen((open) => !open)}>
              {timelineOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
              <span>{copy.timelineTitle} · {(detail?.tasks ?? []).length}</span>
            </button>
            {timelineOpen && (
              <div className="project-timeline-body">
                {taskGroups.length === 0 ? (
                  <div className="empty-block">
                    <strong>{copy.timelineEmpty}</strong>
                    <p>{copy.timelineEmptyBody}</p>
                  </div>
                ) : (
                  taskGroups.map((group) => (
                    <section key={group.status} className="task-group">
                      <span className="section-kicker">{kernelTaskStatusLabel(group.status, locale)} · {group.tasks.length}</span>
                      <ul>
                        {group.tasks.map((task) => (
                          <li key={task.id} className="task-row">
                            <div className="task-row-main">
                              <span className="task-row-title">{task.title}</span>
                              <span className="task-row-meta">
                                {task.goalId && goalById.get(task.goalId) ? goalById.get(task.goalId)?.title : shortId(task.id)}
                                {" · "}{formatTime(task.updatedAt, locale)}
                              </span>
                            </div>
                            <Badge tone={kernelTaskStatusTone(task.status)} variant="soft">{kernelTaskStatusLabel(task.status, locale)}</Badge>
                            {group.status !== "completed" && group.status !== "failed" && (
                              <Button size="sm" variant="outline" icon={<IconCheck size={12} />} onClick={() => void completeTask(task.id)}>
                                {copy.taskComplete}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="project-col-scroll project-chat-scroll">
            {detail?.type === "advertising" && (
              <DecisionLedger locale={locale} clientId={clientId} projectId={projectId} />
            )}
            {messages.length === 0 && !submitting ? (
              <div className="empty-block">
                <strong>{copy.projectChatEmpty}</strong>
                <p>{copy.projectChatEmptyBody}</p>
              </div>
            ) : (
              messages.map((message) => <ProjectChatMessage key={message.id} message={message} locale={locale} />)
            )}
            {submitting && <div className="thinking"><span className="thinking-pulse" aria-hidden="true" /><span>{consoleCopy.investigating}</span></div>}
          </div>

          <div className="project-chat-cta">
            <div className="project-chat-row">
              <ModelPicker locale={locale} settingsLabel={consoleCopy.configureModel} onSaved={onModelSaved} onOpenSettings={onOpenSettings} />
              <input
                value={mission}
                placeholder={copy.chatCtaPlaceholder}
                aria-label={copy.chatCtaPlaceholder}
                disabled={bindingSession || activeRunTarget !== null || !session}
                onChange={(event) => setMission(event.target.value)}
                onKeyDown={(event) => {
                  if (shouldSubmitProjectChatKey({ key: event.key, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) {
                    event.preventDefault();
                    void submitMission();
                  }
                }}
              />
              {submitting ? (
                <Button size="sm" variant="primary" icon={<IconStop size={13} />} disabled={stopping} onClick={() => void stopProjectRun()}>
                  {stopping ? consoleCopy.stoppingRun : consoleCopy.stopRun}
                </Button>
              ) : (
                <Button size="sm" variant="primary" icon={<IconSend size={13} />} disabled={!mission.trim() || bindingSession || activeRunTarget !== null || !session} onClick={() => void submitMission()}>
                  {copy.homeQuickSubmit}
                </Button>
              )}
            </div>
            <p className="workbench-quiet">{copy.projectChatHint}</p>
          </div>
        </section>

        {rightOpen && (
          <aside className="project-col project-right">
            <div className="project-tabs" role="tablist">
              {(["terminal", "git", "preview"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={rightTab === tab}
                  className="project-tab"
                  data-active={rightTab === tab || undefined}
                  onClick={() => setRightTab(tab)}
                >
                  {tab === "terminal" ? copy.tabTerminal : tab === "git" ? copy.tabGit : copy.tabPreview}
                </button>
              ))}
            </div>
            {detail && (
              <div className="project-panel-body">
                {/* Terminal sessions stay alive across right-tab switches; the
                    panel unmounts only when the workbench itself closes. */}
                <div hidden={rightTab !== "terminal"} className="project-panel-fill">
                  <TerminalPanel
                    locale={locale}
                    clientId={clientId}
                    projectId={projectId}
                    defaultCwd={projectDefaultRoot(detail)}
                    projectName={detail.name}
                  />
                </div>
                <div hidden={rightTab !== "git"} className="project-panel-fill">
                  <GitPanel locale={locale} root={projectDefaultRoot(detail)} workspaceId={clientId} />
                </div>
                <div hidden={rightTab !== "preview"} className="project-panel-fill">
                  <PreviewPanel locale={locale} workspaceId={clientId} artifacts={detail.artifacts} selectedId={selectedArtifactId} onSelect={setSelectedArtifactId} />
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Middle column — project chat                                        */
/* ------------------------------------------------------------------ */

/** Status badge tone for the bound session, mirroring the kernel task tones. */
function sessionChatTone(status: ProductSession["status"]): "accent" | "success" | "warning" | "danger" | "neutral" {
  if (status === "running" || status === "queued") return "accent";
  if (status === "waiting_for_approval" || status === "paused") return "warning";
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "neutral";
}

/**
 * One message row in the project chat. A simplified ConversationFeed item —
 * same `message` classes and markdown-ish body rendering, without the
 * approval/computer-use cards and fork action (those stay on the main chat).
 */
function ProjectChatMessage({ message, locale }: { message: ConversationMessage; locale: AppLocale }) {
  const copy = getCopy(locale);
  const role = message.role;
  const isSystemNotice = role === "system" && message.status === "complete";
  const name = role === "user" ? copy.you : role === "system" ? copy.system : copy.agent;
  return (
    <article className={`message ${role} ${message.status}${isSystemNotice ? " notice" : ""}`}>
      <div className="message-avatar" aria-hidden="true">
        {role === "system"
          ? (message.status === "error" ? <IconError size={14} /> : <IconInfo size={14} />)
          : role === "assistant"
            ? <IconBot size={14} />
            : <span>{locale === "zh-CN" ? "你" : "Y"}</span>}
      </div>
      <div className="message-main">
        <header className="message-meta">
          <strong>{name}</strong>
          <time>{formatTime(message.at, locale)}</time>
        </header>
        <ProjectChatBody content={message.content} />
      </div>
    </article>
  );
}

function ProjectChatBody({ content }: { content: string }) {
  const blocks = content.trim().split(/\n{2,}/);
  return (
    <div className="message-body">
      {blocks.map((block, index) => {
        const lines = block.split("\n");
        if (block.startsWith("```") && block.endsWith("```")) return <pre key={index}>{block.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "")}</pre>;
        if (lines.every((line) => /^[-*]\s+/.test(line))) return <ul key={index}>{lines.map((line, lineIndex) => <li key={`${index}-${lineIndex}`}>{line.replace(/^[-*]\s+/, "")}</li>)}</ul>;
        if (lines.every((line) => /^\d+[.)]\s+/.test(line))) return <ol key={index}>{lines.map((line, lineIndex) => <li key={`${index}-${lineIndex}`}>{line.replace(/^\d+[.)]\s+/, "")}</li>)}</ol>;
        if (/^#{1,3}\s+/.test(block)) return <h4 key={index}>{block.replace(/^#{1,3}\s+/, "")}</h4>;
        return <p key={index}>{block}</p>;
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Left column tabs                                                    */
/* ------------------------------------------------------------------ */

function GoalsTab({ locale, goals, projectId, onChanged, onError }: {
  locale: AppLocale;
  goals: KernelGoal[];
  projectId: string;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const copy = workspaceCopy(locale);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [saving, setSaving] = useState(false);

  async function createGoal() {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/kernel/goals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, title: title.trim(), objective: objective.trim() })
      });
      const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
      if (!response.ok) throw new Error(publicWorkspaceError(body?.error, copy.goalCreateFailed));
      setTitle("");
      setObjective("");
      onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="goals-tab">
      {goals.length === 0 ? (
        <div className="empty-block">
          <strong>{copy.goalEmpty}</strong>
          <p>{copy.goalEmptyBody}</p>
        </div>
      ) : (
        <ul className="goal-list">
          {goals.map((goal) => (
            <li key={goal.id} className="goal-row">
              <div className="goal-row-head">
                <strong>{goal.title}</strong>
                <Badge tone={goalStatusTone(goal.status)} variant="soft">{goalStatusLabel(goal.status, locale)}</Badge>
              </div>
              {goal.objective && <p className="goal-objective">{goal.objective}</p>}
              <div className="goal-progress" role="progressbar" aria-valuenow={Math.round(goal.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={interpolate(copy.goalProgress, { percent: String(Math.round(goal.progress * 100)) })}>
                <span style={{ width: `${Math.round(goal.progress * 100)}%` }} />
              </div>
              <span className="goal-progress-label">{interpolate(copy.goalProgress, { percent: String(Math.round(goal.progress * 100)) })}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="goal-form">
        <span className="section-kicker">{copy.goalNew}</span>
        <input value={title} placeholder={copy.goalTitlePlaceholder} aria-label={copy.goalTitlePlaceholder} onChange={(event) => setTitle(event.target.value)} />
        <input value={objective} placeholder={copy.goalObjectivePlaceholder} aria-label={copy.goalObjectivePlaceholder} onChange={(event) => setObjective(event.target.value)} />
        <Button size="sm" variant="primary" disabled={saving || !title.trim()} onClick={() => void createGoal()}>{copy.goalCreate}</Button>
      </div>
    </div>
  );
}

function publicWorkspaceError(detail: string | undefined, fallback: string): string {
  if (!detail) return fallback;
  // Zod's default stringified issue array is an implementation detail, not
  // actionable product copy. Keep ordinary domain errors visible while
  // replacing validation internals with localized guidance.
  if (detail.trimStart().startsWith("[") || detail.includes('"code"')) return fallback;
  return detail;
}

function FilesTab({ locale, rootPaths }: { locale: AppLocale; rootPaths: string[] }) {
  const copy = workspaceCopy(locale);
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [fileError, setFileError] = useState("");

  async function openFile(path: string) {
    setFileError("");
    try {
      const response = await fetch(fsFileUrl(path));
      const body = await response.json().catch(() => undefined) as (FsFileResponse & { error?: string }) | undefined;
      if (!response.ok || !body) throw new Error(body?.error ?? copy.fileLoadFailed);
      setFile({ path: body.path, content: body.content });
    } catch (cause) {
      setFile(null);
      setFileError(cause instanceof Error ? cause.message : copy.fileLoadFailed);
    }
  }

  if (rootPaths.length === 0) {
    return (
      <div className="empty-block">
        <strong>{copy.filesEmpty}</strong>
        <p>{copy.filesEmptyBody}</p>
      </div>
    );
  }
  return (
    <div className="files-tab">
      {rootPaths.map((root) => (
        <FileTree key={root} root={root} locale={locale} onOpenFile={(path) => void openFile(path)} />
      ))}
      {fileError && <p className="workbench-quiet" role="alert">{fileError}</p>}
      <div className="file-viewer">
        {file ? (
          <>
            <div className="file-viewer-head">
              <span className="mono" title={file.path}>{file.path}</span>
              <button type="button" aria-label={copy.close} onClick={() => setFile(null)}><IconDismiss size={11} /></button>
            </div>
            <pre className="file-viewer-body">{file.content}</pre>
          </>
        ) : (
          <p className="workbench-quiet">{copy.filePreviewEmpty}</p>
        )}
      </div>
    </div>
  );
}

function FileTree({ root, locale, onOpenFile }: { root: string; locale: AppLocale; onOpenFile: (path: string) => void }) {
  const copy = workspaceCopy(locale);
  const [tree, setTree] = useState<FsTreeResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(fsTreeUrl(root, 2));
        if (!response.ok) throw new Error(String(response.status));
        if (!cancelled) setTree(await response.json() as FsTreeResponse);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [root]);

  if (failed) return <p className="workbench-quiet mono" title={root}>{root} — {copy.fileLoadFailed}</p>;
  if (!tree) return <p className="workbench-quiet">{copy.loading}…</p>;
  return (
    <section className="file-tree">
      <span className="section-kicker mono" title={tree.root}>{tree.root}</span>
      {tree.truncated && <p className="workbench-quiet">{copy.filesTruncated}</p>}
      <ul>{tree.entries.map((entry) => <FileTreeNode key={entry.path} entry={entry} depth={0} onOpenFile={onOpenFile} />)}</ul>
    </section>
  );
}

function FileTreeNode({ entry, depth, onOpenFile }: { entry: FsTreeEntry; depth: number; onOpenFile: (path: string) => void }) {
  const [open, setOpen] = useState(depth === 0);
  if (entry.kind === "directory") {
    return (
      <li>
        <button type="button" className="file-row" style={{ paddingLeft: `${depth * 14 + 4}px` }} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
          <IconFolder size={13} />
          <span>{entry.name}</span>
        </button>
        {open && entry.children && entry.children.length > 0 && (
          <ul>{entry.children.map((child) => <FileTreeNode key={child.path} entry={child} depth={depth + 1} onOpenFile={onOpenFile} />)}</ul>
        )}
      </li>
    );
  }
  return (
    <li>
      <button type="button" className="file-row" style={{ paddingLeft: `${depth * 14 + 4}px` }} onClick={() => onOpenFile(entry.path)}>
        <span className="file-row-indent" />
        <IconFile size={13} />
        <span>{entry.name}</span>
      </button>
    </li>
  );
}

function ArtifactsTab({ locale, artifacts, selectedId, onOpen }: {
  locale: AppLocale;
  artifacts: KernelArtifact[];
  selectedId: string | null;
  onOpen: (artifact: KernelArtifact) => void;
}) {
  const copy = workspaceCopy(locale);
  if (artifacts.length === 0) {
    return (
      <div className="empty-block">
        <strong>{copy.artifactsEmpty}</strong>
        <p>{copy.artifactsEmptyBody}</p>
      </div>
    );
  }
  return (
    <ul className="artifact-list">
      {artifacts.map((artifact) => (
        <li key={artifact.id}>
          <button type="button" className="artifact-row" data-active={artifact.id === selectedId || undefined} onClick={() => onOpen(artifact)}>
            <ArtifactIcon type={artifact.type} />
            <span className="artifact-row-title">{artifact.title}</span>
            <Badge tone="neutral" variant="outline">{artifactTypeLabel(artifact.type, locale)}</Badge>
            <Badge tone="neutral" variant="outline">{interpolate(copy.artifactVersion, { version: String(artifact.version) })}</Badge>
            <Badge tone={artifactStatusTone(artifact.status)} variant="soft">{artifactStatusLabel(artifact.status, locale)}</Badge>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ArtifactIcon({ type }: { type: string }) {
  if (type === "slides") return <IconSlides size={14} />;
  if (type === "document") return <IconDoc size={14} />;
  if (type === "spreadsheet") return <IconSheet size={14} />;
  return <IconFile size={14} />;
}

/* ------------------------------------------------------------------ */
/* Action queue (advertising projects only)                            */
/* ------------------------------------------------------------------ */

type DecisionDraft = {
  recommendation: string;
  confidence: DecisionConfidence;
  /** One rationale entry per line. */
  rationale: string;
  /** One risk per line. */
  risks: string;
  observationWindow: string;
  rollbackPlan: string;
};

const EMPTY_DECISION_DRAFT: DecisionDraft = {
  recommendation: "",
  confidence: "medium",
  rationale: "",
  risks: "",
  observationWindow: "",
  rollbackPlan: ""
};

/**
 * Read-only decision ledger for advertising projects. A record captures a
 * proposal and its planning context; it is not an Approval, Computer Action,
 * Experiment outcome, or proof that an advertising account changed. Legacy
 * lifecycle values remain visible with explicitly unverified labels, but this
 * surface never advances them.
 */
function DecisionLedger({ locale, clientId, projectId }: { locale: AppLocale; clientId: string; projectId: string }) {
  const copy = workspaceCopy(locale);
  const [decisions, setDecisions] = useState<AdDecision[] | null>(null);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<DecisionDraft>(EMPTY_DECISION_DRAFT);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [duplicateId, setDuplicateId] = useState<string | null>(null);
  const [duplicateNotice, setDuplicateNotice] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(adsDecisionsUrl(clientId, projectId));
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { decisions?: AdDecision[] };
      setDecisions(sortDecisionsRecent(body.decisions ?? []));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [clientId, projectId]);

  useEffect(() => { void load(); }, [load]);

  async function createDecision() {
    if (!draft.recommendation.trim() || saving) return;
    setSaving(true);
    setFormError("");
    try {
      const response = await fetch("/api/ads/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: clientId,
          projectId,
          recommendation: draft.recommendation.trim(),
          rationale: parseRootPathsInput(draft.rationale),
          risks: parseRootPathsInput(draft.risks),
          confidence: draft.confidence,
          ...(draft.observationWindow.trim() ? { observationWindow: draft.observationWindow.trim() } : {}),
          ...(draft.rollbackPlan.trim() ? { rollbackPlan: draft.rollbackPlan.trim() } : {})
        })
      });
      const body = await response.json().catch(() => undefined) as { error?: string; code?: string; decision?: AdDecision } | undefined;
      if (!response.ok) {
        // 409 DECISION_DUPLICATE: point at the existing open decision instead.
        if (response.status === 409 && body?.code === "DECISION_DUPLICATE" && body.decision) {
          setDialogOpen(false);
          setDraft(EMPTY_DECISION_DRAFT);
          await load();
          setDuplicateId(body.decision.id);
          setExpandedId(body.decision.id);
          setDuplicateNotice(true);
          return;
        }
        throw new Error(body?.error ?? String(response.status));
      }
      setDialogOpen(false);
      setDraft(EMPTY_DECISION_DRAFT);
      setDuplicateId(null);
      setDuplicateNotice(false);
      await load();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="action-queue" aria-label={copy.decisionQueue}>
      <div className="home-section-head">
        <span className="section-kicker">{copy.decisionQueue}</span>
        <div className="brief-head-actions">
          <Button size="sm" variant="subtle" className="icon-button" icon={<IconRefresh size={14} />} aria-label={copy.refresh} onClick={() => void load()} />
          <Button size="sm" variant="primary" icon={<IconPlus size={13} />} onClick={() => { setFormError(""); setDraft(EMPTY_DECISION_DRAFT); setDialogOpen(true); }}>
            {copy.decisionNew}
          </Button>
        </div>
      </div>

      <div className="decision-duplicate-note" role="note">
        <IconInfo size={14} aria-hidden="true" />
        <span>{copy.decisionReadOnlyNotice}</span>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="subtle" onClick={() => void load()}>{copy.retry}</Button>
        </div>
      )}
      {duplicateNotice && (
        <div className="decision-duplicate-note" role="status">
          <span>{copy.decisionDuplicate}</span>
          <Button size="sm" variant="subtle" onClick={() => setDuplicateNotice(false)}>{copy.close}</Button>
        </div>
      )}

      {decisions === null ? (
        <p className="workbench-quiet">{copy.loading}…</p>
      ) : decisions.length === 0 ? (
        <div className="empty-block">
          <strong>{copy.decisionQueueEmpty}</strong>
          <p>{copy.decisionQueueEmptyBody}</p>
        </div>
      ) : (
        <ul className="decision-list">
          {decisions.map((decision) => {
            const expanded = expandedId === decision.id;
            return (
              <li key={decision.id} className="decision-card" data-duplicate={decision.id === duplicateId || undefined}>
                <div className="decision-card-head">
                  <button
                    type="button"
                    className="automation-expand"
                    data-open={expanded || undefined}
                    aria-label={copy.decisionRationale}
                    onClick={() => setExpandedId(expanded ? null : decision.id)}
                  >
                    <IconChevronDown size={13} />
                  </button>
                  <div className="decision-card-main">
                    <strong>{decision.recommendation}</strong>
                    <span className="home-list-meta">
                      {formatTime(decision.updatedAt, locale)}
                      {decision.observationWindow ? ` · ${decision.observationWindow}` : ""}
                    </span>
                  </div>
                  <Badge tone="accent" variant="soft">{decisionConfidenceLabel(decision.confidence, locale)}</Badge>
                  <Badge tone={decisionStatusTone(decision.status)} variant="soft">{decisionStatusLabel(decision.status, locale)}</Badge>
                </div>
                {expanded && (
                  <div className="decision-card-detail">
                    {decision.rationale.length > 0 && (
                      <div className="decision-detail-block">
                        <span className="section-kicker">{copy.decisionRationale}</span>
                        <ul>{decision.rationale.map((line) => <li key={line}>{line}</li>)}</ul>
                      </div>
                    )}
                    {decision.risks.length > 0 && (
                      <div className="decision-detail-block">
                        <span className="section-kicker">{copy.decisionRisks}</span>
                        <ul>{decision.risks.map((line) => <li key={line}>{line}</li>)}</ul>
                      </div>
                    )}
                    {decision.rollbackPlan && (
                      <div className="decision-detail-block">
                        <span className="section-kicker">{copy.decisionRollbackPlanLabel}</span>
                        <p>{decision.rollbackPlan}</p>
                      </div>
                    )}
                    {decision.evidenceIds.length > 0 && (
                      <div className="decision-detail-block">
                        <span className="section-kicker">{copy.decisionEvidence}</span>
                        <div className="brief-evidence">
                          {decision.evidenceIds.map((evidenceId) => <code key={evidenceId} className="brief-evidence-id">{evidenceId}</code>)}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {dialogOpen && (
        <div className="plugin-confirm-overlay" role="presentation" onClick={() => setDialogOpen(false)}>
          <div className="plugin-confirm" role="dialog" aria-modal="true" aria-label={copy.decisionCreateTitle} onClick={(event) => event.stopPropagation()}>
            <h2>{copy.decisionCreateTitle}</h2>
            {formError && <p className="decision-form-error" role="alert">{formError}</p>}
            <label className="workspace-field">
              <span>{copy.decisionRecommendationLabel}</span>
              <textarea rows={2} autoFocus value={draft.recommendation} placeholder={copy.decisionRecommendationPlaceholder} onChange={(event) => setDraft({ ...draft, recommendation: event.target.value })} />
            </label>
            <label className="workspace-field">
              <span>{copy.decisionConfidenceLabel}</span>
              <select value={draft.confidence} onChange={(event) => setDraft({ ...draft, confidence: event.target.value as DecisionConfidence })}>
                <option value="low">{copy.decisionConfidenceLow}</option>
                <option value="medium">{copy.decisionConfidenceMedium}</option>
                <option value="high">{copy.decisionConfidenceHigh}</option>
              </select>
            </label>
            <label className="workspace-field">
              <span>{copy.decisionRationaleLabel}</span>
              <textarea rows={3} value={draft.rationale} onChange={(event) => setDraft({ ...draft, rationale: event.target.value })} />
            </label>
            <label className="workspace-field">
              <span>{copy.decisionRisksLabel}</span>
              <textarea rows={2} value={draft.risks} onChange={(event) => setDraft({ ...draft, risks: event.target.value })} />
            </label>
            <label className="workspace-field">
              <span>{copy.decisionObservationWindowLabel}</span>
              <input value={draft.observationWindow} placeholder={copy.decisionObservationWindowPlaceholder} onChange={(event) => setDraft({ ...draft, observationWindow: event.target.value })} />
            </label>
            <label className="workspace-field">
              <span>{copy.decisionRollbackPlanLabel}</span>
              <input value={draft.rollbackPlan} onChange={(event) => setDraft({ ...draft, rollbackPlan: event.target.value })} />
            </label>
            <div className="plugin-confirm-actions">
              <Button size="sm" variant="subtle" onClick={() => setDialogOpen(false)}>{copy.cancel}</Button>
              <Button size="sm" variant="primary" disabled={saving || !draft.recommendation.trim()} onClick={() => void createDecision()}>{copy.decisionCreate}</Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
