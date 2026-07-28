import { useCallback, useEffect, useState } from "react";
import {
  artifactStatusLabel,
  artifactStatusTone,
  artifactTypeLabel,
  formatTime,
  kernelTaskStatusLabel,
  kernelTaskStatusTone,
  operationLabel,
  projectTypeLabel,
  workspaceCopy,
  type AppLocale
} from "../labels.js";
import type { Approval } from "../approvalDisclosure.js";
import {
  homeGreetingKey,
  interpolate,
  kernelArtifactsUrl,
  kernelProjectsUrl,
  kernelTasksUrl,
  shortId,
  sortArtifactsRecent,
  sortProjectsRecent,
  type KernelArtifact,
  type KernelProject,
  type KernelTask
} from "../workspace.js";
import { Badge, Button } from "../ui.js";
import { IconArrowUpRight, IconSend, IconShieldCheck } from "../icons.js";

const MAX_ARTIFACT_PROJECTS = 8;
const MAX_HOME_ARTIFACTS = 6;
const MAX_HOME_PROJECTS = 6;
const MAX_HOME_TASKS = 8;

/**
 * Home view: the landing surface of the Universal Workspace. Aggregates real
 * data from the kernel (projects, their artifacts, running/queued tasks) and
 * the approvals already loaded by the App shell, plus a quick-goal input that
 * hands off to the chat view's real submission path. Every card navigates to
 * the view that owns the entity.
 */
export function HomeView({ locale, clientId, workspaceName, openApprovals, onSubmitGoal, onOpenProject, onOpenProjects, onCreateProject, onOpenAutomations, onOpenApprovals }: {
  locale: AppLocale;
  clientId: string;
  workspaceName: string;
  openApprovals: Approval[];
  onSubmitGoal: (message: string) => void;
  onOpenProject: (projectId: string, artifactId?: string) => void;
  onOpenProjects: () => void;
  onCreateProject: () => void;
  onOpenAutomations: () => void;
  onOpenApprovals: () => void;
}) {
  const copy = workspaceCopy(locale);
  const [goal, setGoal] = useState("");
  const [projects, setProjects] = useState<KernelProject[] | null>(null);
  const [artifacts, setArtifacts] = useState<KernelArtifact[]>([]);
  const [tasks, setTasks] = useState<KernelTask[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      const projectsResponse = await fetch(kernelProjectsUrl(clientId));
      if (!projectsResponse.ok) throw new Error(String(projectsResponse.status));
      const projectsBody = await projectsResponse.json() as { projects?: KernelProject[] };
      const list = projectsBody.projects ?? [];
      setProjects(list);
      const [artifactLists, running, queued] = await Promise.all([
        Promise.all(
          list.slice(0, MAX_ARTIFACT_PROJECTS).map(async (project) => {
            try {
              const response = await fetch(kernelArtifactsUrl(clientId, project.id));
              if (!response.ok) return [] as KernelArtifact[];
              const body = await response.json() as { artifacts?: KernelArtifact[] };
              return body.artifacts ?? [];
            } catch {
              return [] as KernelArtifact[];
            }
          })
        ),
        fetch(kernelTasksUrl(clientId, { status: "running" })).then((response) => response.ok ? response.json() as Promise<{ tasks?: KernelTask[] }> : { tasks: [] }),
        fetch(kernelTasksUrl(clientId, { status: "queued" })).then((response) => response.ok ? response.json() as Promise<{ tasks?: KernelTask[] }> : { tasks: [] })
      ]);
      setArtifacts(sortArtifactsRecent(artifactLists.flat(), MAX_HOME_ARTIFACTS));
      setTasks([...(running.tasks ?? []), ...(queued.tasks ?? [])].slice(0, MAX_HOME_TASKS));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [clientId]);

  useEffect(() => { void load(); }, [load]);

  function submitQuick() {
    const message = goal.trim();
    if (!message) return;
    setGoal("");
    onSubmitGoal(message);
  }

  const recentProjects = sortProjectsRecent(projects ?? [], MAX_HOME_PROJECTS);

  return (
    <div className="workbench home-view">
      <header className="home-hero">
        <span className="section-kicker">{copy[homeGreetingKey(new Date())]} · {workspaceName || clientId}</span>
        <h1>AdPilot</h1>
        <div className="home-quick">
          <input
            value={goal}
            placeholder={copy.homeQuickPlaceholder}
            aria-label={copy.homeQuickPlaceholder}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitQuick(); } }}
          />
          <Button size="md" variant="primary" icon={<IconSend size={14} />} disabled={!goal.trim()} onClick={submitQuick}>
            {copy.homeQuickSubmit}
          </Button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="subtle" onClick={() => void load()}>{copy.retry}</Button>
        </div>
      )}

      <section className="home-section" aria-label={copy.homeProjects}>
        <div className="home-section-head">
          <h2>{copy.homeProjects}</h2>
          <Button size="sm" variant="subtle" icon={<IconArrowUpRight size={12} />} onClick={onOpenProjects}>{copy.viewAll}</Button>
        </div>
        {projects === null ? (
          <p className="workbench-quiet">{copy.loading}…</p>
        ) : recentProjects.length === 0 ? (
          <div className="empty-block">
            <strong>{copy.homeProjectsEmpty}</strong>
            <p>{copy.homeProjectsEmptyBody}</p>
            <Button size="sm" variant="primary" onClick={onCreateProject}>{copy.homeProjectsCreate}</Button>
          </div>
        ) : (
          <div className="card-grid">
            {recentProjects.map((project) => (
              <button key={project.id} type="button" className="project-card" onClick={() => onOpenProject(project.id)}>
                <div className="project-card-head">
                  <strong>{project.name}</strong>
                  <Badge tone="neutral" variant="outline">{projectTypeLabel(project.type, locale)}</Badge>
                </div>
                <div className="project-card-meta">
                  <span>{interpolate(copy.projectGoalCount, { count: String(project.goalIds.length) })}</span>
                  <span>{interpolate(copy.projectArtifactCount, { count: String(project.artifactIds.length) })}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="home-section" aria-label={copy.homeApprovals}>
        <div className="home-section-head">
          <h2>{copy.homeApprovals}</h2>
          {openApprovals.length > 0 && <Badge tone="warning" variant="soft">{openApprovals.length}</Badge>}
        </div>
        {openApprovals.length === 0 ? (
          <p className="workbench-quiet">{copy.homeApprovalsEmpty}</p>
        ) : (
          <ul className="home-list">
            {openApprovals.slice(0, 5).map((approval) => (
              <li key={approval.id}>
                <button type="button" className="home-list-row" onClick={onOpenApprovals}>
                  <IconShieldCheck size={14} />
                  <span className="home-list-title">
                    {operationLabel(approval.operation.operation, locale)} · {approval.operation.campaign || approval.operation.account}
                  </span>
                  <Badge tone="warning" variant="soft">{shortId(approval.id)}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="home-section" aria-label={copy.homeArtifacts}>
        <div className="home-section-head"><h2>{copy.homeArtifacts}</h2></div>
        {artifacts.length === 0 ? (
          <p className="workbench-quiet">{copy.homeArtifactsEmpty}</p>
        ) : (
          <ul className="home-list">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <button type="button" className="home-list-row" onClick={() => onOpenProject(artifact.projectId, artifact.id)}>
                  <span className="home-list-title">{artifact.title}</span>
                  <Badge tone="neutral" variant="outline">{artifactTypeLabel(artifact.type, locale)}</Badge>
                  <Badge tone={artifactStatusTone(artifact.status)} variant="soft">{artifactStatusLabel(artifact.status, locale)}</Badge>
                  <span className="home-list-meta">{interpolate(copy.artifactVersion, { version: String(artifact.version) })} · {formatTime(artifact.updatedAt, locale)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="home-section" aria-label={copy.homeTasks}>
        <div className="home-section-head">
          <h2>{copy.homeTasks}</h2>
          <Button size="sm" variant="subtle" icon={<IconArrowUpRight size={12} />} onClick={onOpenAutomations}>{copy.viewAll}</Button>
        </div>
        {tasks.length === 0 ? (
          <p className="workbench-quiet">{copy.homeTasksEmpty}</p>
        ) : (
          <ul className="home-list">
            {tasks.map((task) => (
              <li key={task.id}>
                <button type="button" className="home-list-row" onClick={onOpenAutomations}>
                  <span className="home-list-title">{task.title}</span>
                  <Badge tone={kernelTaskStatusTone(task.status)} variant="soft">{kernelTaskStatusLabel(task.status, locale)}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
