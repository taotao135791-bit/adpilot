import { useCallback, useEffect, useMemo, useState } from "react";
import {
  artifactStatusLabel,
  artifactStatusTone,
  artifactTypeLabel,
  formatTime,
  goalStatusLabel,
  goalStatusTone,
  kernelTaskStatusLabel,
  kernelTaskStatusTone,
  projectTypeLabel,
  workspaceCopy,
  type AppLocale
} from "../labels.js";
import {
  fsFileUrl,
  fsTreeUrl,
  groupKernelTasks,
  interpolate,
  kernelProjectUrl,
  kernelTaskCompleteUrl,
  projectDefaultRoot,
  shortId,
  type FsFileResponse,
  type FsTreeEntry,
  type FsTreeResponse,
  type KernelArtifact,
  type KernelGoal,
  type ProjectDetail
} from "../workspace.js";
import { Badge, Button, Tooltip } from "../ui.js";
import {
  IconArrowLeft,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDismiss,
  IconDoc,
  IconFile,
  IconFolder,
  IconPanelRight,
  IconSend,
  IconSheet,
  IconSlides
} from "../icons.js";
import { TerminalPanel } from "../panels/TerminalPanel.js";
import { GitPanel } from "../panels/GitPanel.js";
import { PreviewPanel } from "../panels/PreviewPanel.js";

type LeftTab = "goals" | "files" | "artifacts";
type RightTab = "terminal" | "git" | "preview";

/**
 * Project workbench: the three-column Universal Workspace surface. Left —
 * goals (progress + create), files (bounded tree over /api/fs with an inline
 * text preview), artifacts. Middle — the kernel task timeline grouped by
 * status with the real complete action, plus a mission input that hands off
 * to the chat view. Right — collapsible dynamic panel (terminal / git /
 * artifact preview). All data comes from the project detail payload and is
 * refetched after every mutation.
 */
export function ProjectView({ locale, clientId, projectId, focusArtifactId, onBack, onSubmitGoal }: {
  locale: AppLocale;
  clientId: string;
  projectId: string;
  /** Artifact to pre-select in the preview panel (e.g. clicked from Home). */
  focusArtifactId?: string | null;
  onBack: () => void;
  onSubmitGoal: (message: string) => void;
}) {
  const copy = workspaceCopy(locale);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [leftTab, setLeftTab] = useState<LeftTab>("goals");
  const [rightTab, setRightTab] = useState<RightTab>("terminal");
  const [rightOpen, setRightOpen] = useState(true);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(focusArtifactId ?? null);
  const [mission, setMission] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(kernelProjectUrl(projectId, clientId));
      if (!response.ok) throw new Error(String(response.status));
      setDetail(await response.json() as ProjectDetail);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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

  function submitMission() {
    const message = mission.trim();
    if (!message) return;
    setMission("");
    onSubmitGoal(message);
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
          <div className="project-col-scroll">
            <span className="section-kicker">{copy.timelineTitle}</span>
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
          <div className="project-chat-cta">
            <span className="section-kicker">{copy.chatCtaTitle}</span>
            <div className="project-chat-row">
              <input
                value={mission}
                placeholder={copy.chatCtaPlaceholder}
                aria-label={copy.chatCtaPlaceholder}
                onChange={(event) => setMission(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitMission(); } }}
              />
              <Button size="sm" variant="primary" icon={<IconSend size={13} />} disabled={!mission.trim()} onClick={submitMission}>
                {copy.homeQuickSubmit}
              </Button>
            </div>
            <p className="workbench-quiet">{copy.chatCtaHint}</p>
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
                  <TerminalPanel locale={locale} defaultCwd={projectDefaultRoot(detail)} projectName={detail.name} />
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
      if (!response.ok) throw new Error(body?.error ?? String(response.status));
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
