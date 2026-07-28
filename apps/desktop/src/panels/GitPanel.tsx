import { useCallback, useEffect, useState } from "react";
import { formatTime, workspaceCopy, type AppLocale } from "../labels.js";
import {
  diffLineKind,
  gitGetUrl,
  interpolate,
  type CheckpointSummary,
  type GitBranchInfo,
  type GitFileChange,
  type GitStatusPayload
} from "../workspace.js";
import { Badge, Button } from "../ui.js";
import { IconCheck, IconDismiss, IconPlus, IconRefresh } from "../icons.js";

type DiffPayload = { raw: string; files: Array<{ path: string; additions: number; deletions: number; status: string }> };

/**
 * Git panel for the project's first root: real status/diff/stage/commit over
 * /api/git, branch switching with the server's dirty-tree 409 surfaced
 * verbatim, and the checkpoint create/list/restore flow (restore is gated by
 * a confirm dialog; a CHECKPOINT_DIVERGED 409 offers the explicit force
 * path). When the root is not a repository the panel degrades to a quiet
 * empty state.
 */
export function GitPanel({ locale, root, workspaceId }: {
  locale: AppLocale;
  root: string;
  workspaceId: string;
}) {
  const copy = workspaceCopy(locale);
  const [status, setStatus] = useState<GitStatusPayload | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [notRepo, setNotRepo] = useState(false);
  const [error, setError] = useState("");
  const [diff, setDiff] = useState<{ path: string; staged: boolean; payload: DiffPayload } | null>(null);
  const [message, setMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [checkpointLabel, setCheckpointLabel] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<CheckpointSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const explain = useCallback(async (response: Response): Promise<Error> => {
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    return new Error(body?.error ?? `${response.status}`);
  }, []);

  const load = useCallback(async () => {
    if (!root) { setNotRepo(true); return; }
    try {
      const [statusResponse, branchResponse, checkpointResponse] = await Promise.all([
        fetch(gitGetUrl("status", { root })),
        fetch(gitGetUrl("branches", { root })),
        fetch(gitGetUrl("checkpoints", { root }))
      ]);
      if (!statusResponse.ok) {
        const body = await statusResponse.json().catch(() => undefined) as { code?: string; error?: string } | undefined;
        if (body?.code === "NOT_A_REPOSITORY" || body?.code === "GIT_ROOT_INVALID") {
          setNotRepo(true);
          return;
        }
        throw new Error(body?.error ?? String(statusResponse.status));
      }
      setNotRepo(false);
      setStatus(await statusResponse.json() as GitStatusPayload);
      if (branchResponse.ok) setBranches(((await branchResponse.json()) as { branches?: GitBranchInfo[] }).branches ?? []);
      if (checkpointResponse.ok) setCheckpoints(((await checkpointResponse.json()) as { checkpoints?: CheckpointSummary[] }).checkpoints ?? []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [root]);

  useEffect(() => { void load(); }, [load]);

  async function mutate(url: string, payload: Record<string, unknown>) {
    setBusy(true);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw await explain(response);
      setError("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.gitActionFailed);
    } finally {
      setBusy(false);
    }
  }

  async function openDiff(path: string, staged: boolean) {
    try {
      const response = await fetch(gitGetUrl("diff", { root, staged: staged ? "true" : "false", paths: path }));
      if (!response.ok) throw await explain(response);
      setDiff({ path, staged, payload: await response.json() as DiffPayload });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function restoreCheckpoint(force: boolean) {
    if (!restoreTarget) return;
    const target = restoreTarget;
    setBusy(true);
    try {
      const response = await fetch(`/api/git/checkpoints/${encodeURIComponent(target.id)}/restore?root=${encodeURIComponent(root)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, confirm: true as const, ...(force ? { force: true } : {}) })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { code?: string; error?: string } | undefined;
        if (body?.code === "CHECKPOINT_DIVERGED" && !force) {
          setError(body.error ?? copy.gitActionFailed);
          return;
        }
        throw new Error(body?.error ?? String(response.status));
      }
      setRestoreTarget(null);
      setError("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.gitActionFailed);
    } finally {
      setBusy(false);
    }
  }

  if (notRepo) {
    return (
      <div className="panel git-panel">
        <div className="empty-block">
          <strong>{copy.gitNotRepo}</strong>
          <p>{copy.gitNotRepoBody}</p>
        </div>
      </div>
    );
  }

  const clean = status && status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0;

  return (
    <div className="panel git-panel">
      <div className="git-head">
        <Badge tone="accent" variant="soft">{status?.branch ?? "…"}</Badge>
        {status && status.ahead > 0 && <Badge tone="neutral" variant="outline">{interpolate(copy.gitAhead, { count: String(status.ahead) })}</Badge>}
        {status && status.behind > 0 && <Badge tone="warning" variant="soft">{interpolate(copy.gitBehind, { count: String(status.behind) })}</Badge>}
        <span className="panel-spacer" />
        <Button size="sm" variant="subtle" className="icon-button" icon={<IconRefresh size={13} />} aria-label={copy.refresh} onClick={() => void load()} />
      </div>

      {error && (
        <div className="panel-banner" data-tone="danger" role="alert">
          <span>{error}</span>
          <button type="button" aria-label={copy.close} onClick={() => setError("")}><IconDismiss size={11} /></button>
        </div>
      )}

      <div className="panel-scroll">
        {status && (
          <>
            {clean && <p className="workbench-quiet">{copy.gitClean}</p>}
            <ChangeGroup
              title={copy.gitStaged}
              changes={status.staged}
              actionLabel={copy.gitUnstage}
              onOpen={(path) => void openDiff(path, true)}
              onAction={(path) => void mutate("/api/git/unstage", { root, paths: [path] })}
            />
            <ChangeGroup
              title={copy.gitUnstaged}
              changes={status.unstaged}
              actionLabel={copy.gitStage}
              onOpen={(path) => void openDiff(path, false)}
              onAction={(path) => void mutate("/api/git/stage", { root, paths: [path] })}
            />
            {status.untracked.length > 0 && (
              <section className="git-group">
                <span className="section-kicker">{copy.gitUntracked} · {status.untracked.length}</span>
                <ul>
                  {status.untracked.map((path) => (
                    <li key={path} className="git-file-row">
                      <span className="git-file-path" title={path}>{path}</span>
                      <Button size="sm" variant="subtle" disabled={busy} onClick={() => void mutate("/api/git/stage", { root, paths: [path] })}>{copy.gitStage}</Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {diff && (
              <section className="git-group">
                <span className="section-kicker">{diff.path}{diff.staged ? ` · ${copy.gitStaged}` : ""}</span>
                <div className="diff-legend" aria-label={copy.diffLegend}>
                  <span>{copy.diffLegend}:</span>
                  <span className="diff-swatch" data-kind="add">{copy.diffAdded}</span>
                  <span className="diff-swatch" data-kind="del">{copy.diffRemoved}</span>
                  <span className="diff-swatch" data-kind="hunk">{copy.diffHunk}</span>
                </div>
                <pre className="diff-view">
                  {diff.payload.raw.split("\n").map((line, index) => (
                    <div key={index} className="diff-line" data-kind={diffLineKind(line)}>{line || " "}</div>
                  ))}
                </pre>
              </section>
            )}

            <section className="git-group">
              <span className="section-kicker">{copy.gitCommit}</span>
              <div className="git-commit-row">
                <input value={message} placeholder={copy.gitCommitPlaceholder} aria-label={copy.gitCommitPlaceholder} onChange={(event) => setMessage(event.target.value)} />
                <Button size="sm" variant="primary" icon={<IconCheck size={13} />} disabled={busy || !message.trim() || status.staged.length === 0} onClick={() => { const text = message; setMessage(""); void mutate("/api/git/commit", { workspaceId, root, message: text }); }}>
                  {copy.gitCommit}
                </Button>
              </div>
            </section>

            <section className="git-group">
              <span className="section-kicker">{copy.gitBranches}</span>
              <ul>
                {branches.map((branch) => (
                  <li key={branch.name} className="git-file-row">
                    <span className="git-file-path" data-current={branch.current || undefined}>{branch.name}</span>
                    {!branch.current && (
                      <Button size="sm" variant="subtle" disabled={busy} onClick={() => void mutate("/api/git/switch", { root, name: branch.name })}>
                        {copy.gitSwitch}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="git-commit-row">
                <input value={branchName} placeholder={copy.gitNewBranchPlaceholder} aria-label={copy.gitNewBranchPlaceholder} onChange={(event) => setBranchName(event.target.value)} />
                <Button size="sm" variant="outline" icon={<IconPlus size={13} />} disabled={busy || !branchName.trim()} onClick={() => { const name = branchName.trim(); setBranchName(""); void mutate("/api/git/branch", { root, name }); }}>
                  {copy.gitCreateBranch}
                </Button>
              </div>
            </section>

            <section className="git-group">
              <span className="section-kicker">{copy.gitCheckpoints}</span>
              {checkpoints.length === 0 ? (
                <p className="workbench-quiet">{copy.checkpointEmpty}</p>
              ) : (
                <ul>
                  {checkpoints.map((checkpoint) => (
                    <li key={checkpoint.id} className="git-file-row">
                      <span className="git-file-path" title={checkpoint.headSha}>{checkpoint.label}</span>
                      <span className="home-list-meta">{formatTime(checkpoint.createdAt, locale)}</span>
                      <Button size="sm" variant="subtle" disabled={busy} onClick={() => setRestoreTarget(checkpoint)}>{copy.checkpointRestore}</Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="git-commit-row">
                <input value={checkpointLabel} placeholder={copy.checkpointPlaceholder} aria-label={copy.checkpointPlaceholder} onChange={(event) => setCheckpointLabel(event.target.value)} />
                <Button size="sm" variant="outline" icon={<IconPlus size={13} />} disabled={busy || !checkpointLabel.trim()} onClick={() => { const label = checkpointLabel.trim(); setCheckpointLabel(""); void mutate("/api/git/checkpoints", { root, label }); }}>
                  {copy.checkpointCreate}
                </Button>
              </div>
            </section>
          </>
        )}
        {!status && !error && <p className="workbench-quiet">{copy.loading}…</p>}
      </div>

      {restoreTarget && (
        <div className="plugin-confirm-overlay" role="presentation" onClick={() => setRestoreTarget(null)}>
          <div className="plugin-confirm" role="alertdialog" aria-modal="true" aria-label={copy.checkpointRestoreTitle} onClick={(event) => event.stopPropagation()}>
            <h2>{copy.checkpointRestoreTitle}</h2>
            <p>{interpolate(copy.checkpointRestoreBody, { label: restoreTarget.label })}</p>
            <div className="plugin-confirm-actions">
              <Button size="sm" variant="subtle" onClick={() => setRestoreTarget(null)}>{copy.cancel}</Button>
              {error && <Button size="sm" variant="outline" disabled={busy} onClick={() => void restoreCheckpoint(true)}>{copy.checkpointForce}</Button>}
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void restoreCheckpoint(false)}>{copy.checkpointRestore}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChangeGroup({ title, changes, actionLabel, onOpen, onAction }: {
  title: string;
  changes: GitFileChange[];
  actionLabel: string;
  onOpen: (path: string) => void;
  onAction: (path: string) => void;
}) {
  if (changes.length === 0) return null;
  return (
    <section className="git-group">
      <span className="section-kicker">{title} · {changes.length}</span>
      <ul>
        {changes.map((change) => (
          <li key={`${change.status}:${change.path}`} className="git-file-row">
            <button type="button" className="git-file-open" title={change.path} onClick={() => onOpen(change.path)}>
              <Badge tone="neutral" variant="outline">{change.status}</Badge>
              {change.path}
            </button>
            <Button size="sm" variant="subtle" onClick={() => onAction(change.path)}>{actionLabel}</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
