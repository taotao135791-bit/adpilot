import { useCallback, useEffect, useState } from "react";
import {
  formatTime,
  projectTypeLabel,
  workspaceCopy,
  type AppLocale
} from "../labels.js";
import {
  interpolate,
  kernelArchiveProjectUrl,
  kernelProjectsUrl,
  parseRootPathsInput,
  sortProjectsRecent,
  type KernelProject
} from "../workspace.js";
import { Badge, Button } from "../ui.js";
import { IconArchive, IconPlus } from "../icons.js";

const PROJECT_TYPES = ["general", "advertising", "development", "research", "creative"] as const;

/**
 * Projects view: a grid of the workspace's kernel projects with the real
 * create flow (name, type, one root path per line) and an archive action
 * guarded by an explicit confirmation dialog. Cards open the project
 * workbench.
 */
export function ProjectsView({ locale, clientId, dialogNonce, onOpenProject }: {
  locale: AppLocale;
  clientId: string;
  /** Bumped by other views (Home) to open the create dialog here. */
  dialogNonce: number;
  onOpenProject: (projectId: string) => void;
}) {
  const copy = workspaceCopy(locale);
  const [projects, setProjects] = useState<KernelProject[] | null>(null);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", type: "general", roots: "" });
  const [saving, setSaving] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<KernelProject | null>(null);
  const [archiving, setArchiving] = useState(false);

  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      const response = await fetch(kernelProjectsUrl(clientId));
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { projects?: KernelProject[] };
      setProjects(sortProjectsRecent(body.projects ?? []));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [clientId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (dialogNonce > 0) setDialogOpen(true); }, [dialogNonce]);

  async function createProject() {
    const name = draft.name.trim();
    if (!name || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/kernel/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: clientId, name, type: draft.type, rootPaths: parseRootPathsInput(draft.roots) })
      });
      const body = await response.json().catch(() => undefined) as (KernelProject & { error?: string }) | undefined;
      if (!response.ok || !body?.id) throw new Error(body?.error ?? String(response.status));
      setDialogOpen(false);
      setDraft({ name: "", type: "general", roots: "" });
      onOpenProject(body.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function archiveProject() {
    if (!archiveTarget || archiving) return;
    setArchiving(true);
    try {
      const response = await fetch(kernelArchiveProjectUrl(archiveTarget.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: clientId })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
        throw new Error(body?.error ?? String(response.status));
      }
      setArchiveTarget(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setArchiving(false);
    }
  }

  return (
    <div className="workbench projects-view">
      <header className="workbench-head">
        <div>
          <h1>{copy.projectsTitle}</h1>
          <p>{copy.projectsBody}</p>
        </div>
        <Button size="sm" variant="primary" icon={<IconPlus size={13} />} onClick={() => setDialogOpen(true)} disabled={!clientId}>
          {copy.projectsNew}
        </Button>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="subtle" onClick={() => void load()}>{copy.retry}</Button>
        </div>
      )}

      {projects === null ? (
        <p className="workbench-quiet">{copy.loading}…</p>
      ) : projects.length === 0 ? (
        <div className="empty-block">
          <strong>{copy.projectsEmpty}</strong>
          <p>{copy.projectsEmptyBody}</p>
          <Button size="sm" variant="primary" icon={<IconPlus size={13} />} onClick={() => setDialogOpen(true)}>{copy.projectsNew}</Button>
        </div>
      ) : (
        <div className="card-grid">
          {projects.map((project) => (
            <div key={project.id} className="project-card-shell">
              <button type="button" className="project-card" onClick={() => onOpenProject(project.id)}>
                <div className="project-card-head">
                  <strong>{project.name}</strong>
                  <Badge tone="neutral" variant="outline">{projectTypeLabel(project.type, locale)}</Badge>
                </div>
                <div className="project-card-meta">
                  <span>{interpolate(copy.projectGoalCount, { count: String(project.goalIds.length) })}</span>
                  <span>{interpolate(copy.projectArtifactCount, { count: String(project.artifactIds.length) })}</span>
                  <span>{interpolate(copy.projectUpdatedAt, { time: formatTime(project.updatedAt, locale) })}</span>
                </div>
              </button>
              <Button
                size="sm"
                variant="subtle"
                className="icon-button project-card-archive"
                icon={<IconArchive size={13} />}
                aria-label={`${copy.archiveProject}: ${project.name}`}
                onClick={() => setArchiveTarget(project)}
              />
            </div>
          ))}
        </div>
      )}

      {dialogOpen && (
        <div className="plugin-confirm-overlay" role="presentation" onClick={() => setDialogOpen(false)}>
          <div className="plugin-confirm" role="dialog" aria-modal="true" aria-label={copy.newProjectTitle} onClick={(event) => event.stopPropagation()}>
            <h2>{copy.newProjectTitle}</h2>
            <label className="workspace-field">
              <span>{copy.projectNameLabel}</span>
              <input value={draft.name} autoFocus placeholder={copy.projectNamePlaceholder} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label className="workspace-field">
              <span>{copy.projectTypeLabel}</span>
              <select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
                {PROJECT_TYPES.map((type) => <option key={type} value={type}>{projectTypeLabel(type, locale)}</option>)}
              </select>
            </label>
            <label className="workspace-field">
              <span>{copy.projectRootsLabel}</span>
              <textarea rows={3} value={draft.roots} placeholder="/Users/you/project" onChange={(event) => setDraft({ ...draft, roots: event.target.value })} />
            </label>
            <p className="workbench-quiet">{copy.projectRootsHint}</p>
            <div className="plugin-confirm-actions">
              <Button size="sm" variant="subtle" onClick={() => setDialogOpen(false)}>{copy.cancel}</Button>
              <Button size="sm" variant="primary" disabled={saving || !draft.name.trim()} onClick={() => void createProject()}>{copy.projectCreate}</Button>
            </div>
          </div>
        </div>
      )}

      {archiveTarget && (
        <div className="plugin-confirm-overlay" role="presentation" onClick={() => setArchiveTarget(null)}>
          <div className="plugin-confirm" role="alertdialog" aria-modal="true" aria-label={copy.archiveProjectTitle} onClick={(event) => event.stopPropagation()}>
            <h2>{copy.archiveProjectTitle}</h2>
            <p><strong>{archiveTarget.name}</strong></p>
            <p>{copy.archiveProjectBody}</p>
            <div className="plugin-confirm-actions">
              <Button size="sm" variant="subtle" onClick={() => setArchiveTarget(null)}>{copy.cancel}</Button>
              <Button size="sm" variant="primary" disabled={archiving} onClick={() => void archiveProject()}>{copy.archiveConfirm}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
