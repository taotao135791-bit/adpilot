import { useCallback, useEffect, useState } from "react";
import { formatTime, kernelTaskStatusLabel, kernelTaskStatusTone, workspaceCopy, type AppLocale } from "../labels.js";
import { kernelTasksUrl, shortId, type KernelTask } from "../workspace.js";
import { Badge, Button } from "../ui.js";
import { IconRefresh } from "../icons.js";

const REFRESH_INTERVAL_MS = 10_000;

/**
 * Automations view: the global list of live kernel tasks — everything the
 * task graph currently has running, plus the queue behind it. Real data only
 * (no scheduler pretense): two status-filtered queries, a manual refresh, and
 * a 10s poll while the view is mounted.
 */
export function AutomationsView({ locale, clientId }: { locale: AppLocale; clientId: string }) {
  const copy = workspaceCopy(locale);
  const [running, setRunning] = useState<KernelTask[] | null>(null);
  const [queued, setQueued] = useState<KernelTask[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      const [runningResponse, queuedResponse] = await Promise.all([
        fetch(kernelTasksUrl(clientId, { status: "running" })),
        fetch(kernelTasksUrl(clientId, { status: "queued" }))
      ]);
      if (!runningResponse.ok || !queuedResponse.ok) throw new Error(String(runningResponse.ok ? queuedResponse.status : runningResponse.status));
      setRunning(((await runningResponse.json()) as { tasks?: KernelTask[] }).tasks ?? []);
      setQueued(((await queuedResponse.json()) as { tasks?: KernelTask[] }).tasks ?? []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [clientId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const empty = running !== null && queued !== null && running.length === 0 && queued.length === 0;

  return (
    <div className="workbench automations-view">
      <header className="workbench-head">
        <div>
          <h1>{copy.automationsTitle}</h1>
          <p>{copy.automationsBody}</p>
        </div>
        <Button size="sm" variant="subtle" className="icon-button" icon={<IconRefresh size={14} />} aria-label={copy.refresh} onClick={() => void load()} />
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="subtle" onClick={() => void load()}>{copy.retry}</Button>
        </div>
      )}

      {empty && (
        <div className="empty-block">
          <strong>{copy.automationsEmpty}</strong>
          <p>{copy.automationsEmptyBody}</p>
        </div>
      )}

      <TaskSection title={copy.automationsRunning} tasks={running} locale={locale} loading={copy.loading} />
      <TaskSection title={copy.automationsQueued} tasks={queued} locale={locale} loading={copy.loading} />
    </div>
  );
}

function TaskSection({ title, tasks, locale, loading }: { title: string; tasks: KernelTask[] | null; locale: AppLocale; loading: string }) {
  if (tasks === null) return <p className="workbench-quiet">{loading}…</p>;
  if (tasks.length === 0) return null;
  return (
    <section className="home-section">
      <div className="home-section-head">
        <h2>{title}</h2>
        <Badge tone="neutral" variant="outline">{tasks.length}</Badge>
      </div>
      <ul className="home-list">
        {tasks.map((task) => (
          <li key={task.id} className="home-list-row" data-static>
            <span className="home-list-title">{task.title}</span>
            {task.goalId && <span className="home-list-meta mono">{shortId(task.goalId)}</span>}
            <Badge tone={kernelTaskStatusTone(task.status)} variant="soft">{kernelTaskStatusLabel(task.status, locale)}</Badge>
            <span className="home-list-meta">{formatTime(task.updatedAt, locale)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
