import { useCallback, useEffect, useState } from "react";
import {
  automationRunStatusLabel,
  automationRunStatusTone,
  automationStateLabel,
  automationStateTone,
  automationTriggerText,
  formatTime,
  workspaceCopy,
  type AppLocale
} from "../labels.js";
import {
  automationActionUrl,
  automationRunApproveUrl,
  automationRunSummary,
  automationRunsUrl,
  automationsUrl,
  automationUrl,
  countUnread,
  cronFieldsComplete,
  cronPresetFields,
  interpolate,
  notificationReadUrl,
  notificationsUrl,
  sortRunsRecent,
  CRON_PRESETS,
  type AppNotification,
  type Automation,
  type AutomationRun,
  type CronPreset,
  type CronSpecFields
} from "../workspace.js";
import { Badge, Button } from "../ui.js";
import { IconBolt, IconChevronDown, IconArchive, IconPause, IconPlay, IconPlus, IconRefresh } from "../icons.js";

const REFRESH_INTERVAL_MS = 30_000;

type ActionKind = "daily-brief" | "create-task" | "notify";

type Draft = {
  title: string;
  triggerKind: "schedule" | "event";
  preset: CronPreset;
  cron: CronSpecFields;
  eventName: string;
  eventCondition: string;
  actionKind: ActionKind;
  taskTitle: string;
  taskDescription: string;
  message: string;
  maxRunsPerDay: string;
};

const EMPTY_DRAFT: Draft = {
  title: "",
  triggerKind: "schedule",
  preset: "daily-morning",
  cron: cronPresetFields("daily-morning"),
  eventName: "",
  eventCondition: "",
  actionKind: "daily-brief",
  taskTitle: "",
  taskDescription: "",
  message: "",
  maxRunsPerDay: "10"
};

function draftValid(draft: Draft): boolean {
  if (!draft.title.trim()) return false;
  if (draft.triggerKind === "schedule" && !cronFieldsComplete(draft.cron)) return false;
  if (draft.triggerKind === "event" && !draft.eventName.trim()) return false;
  if (draft.actionKind === "create-task" && !draft.taskTitle.trim()) return false;
  if (draft.actionKind === "notify" && !draft.message.trim()) return false;
  const maxRuns = Number(draft.maxRunsPerDay);
  return Number.isInteger(maxRuns) && maxRuns >= 1 && maxRuns <= 1_000;
}

/**
 * Automations view: real scheduled / event-triggered automations with their
 * run history, the approval gate for mutating actions, and the notification
 * inbox the notify action writes into. Polls every 30s while mounted.
 */
export function AutomationsView({ locale, clientId }: { locale: AppLocale; clientId: string }) {
  const copy = workspaceCopy(locale);
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [latestRuns, setLatestRuns] = useState<Record<string, AutomationRun>>({});
  const [notifications, setNotifications] = useState<AppNotification[] | null>(null);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runsByAutomation, setRunsByAutomation] = useState<Record<string, AutomationRun[]>>({});
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      const [automationsResponse, notificationsResponse] = await Promise.all([
        fetch(automationsUrl(clientId)),
        fetch(notificationsUrl(clientId))
      ]);
      if (!automationsResponse.ok || !notificationsResponse.ok) {
        throw new Error(String(automationsResponse.ok ? notificationsResponse.status : automationsResponse.status));
      }
      const body = await automationsResponse.json() as { automations?: Automation[]; latestRuns?: Record<string, AutomationRun> };
      setAutomations(body.automations ?? []);
      setLatestRuns(body.latestRuns ?? {});
      setNotifications(((await notificationsResponse.json()) as { notifications?: AppNotification[] }).notifications ?? []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [clientId]);

  const loadRuns = useCallback(async (automationId: string) => {
    if (!clientId) return;
    try {
      const response = await fetch(automationRunsUrl(automationId, clientId));
      if (!response.ok) return;
      const body = await response.json() as { runs?: AutomationRun[] };
      setRunsByAutomation((current) => ({ ...current, [automationId]: sortRunsRecent(body.runs ?? [], 20) }));
    } catch { /* the runs panel simply keeps its last data */ }
  }, [clientId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => { if (expandedId) void loadRuns(expandedId); }, [expandedId, loadRuns, automations]);

  async function post(url: string, payload: unknown): Promise<{ ok: boolean; error?: string }> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (response.ok) return { ok: true };
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    return { ok: false, error: body?.error ?? String(response.status) };
  }

  async function act(automation: Automation, action: "pause" | "resume" | "run-now") {
    if (busy) return;
    setBusy(`${automation.id}:${action}`);
    try {
      const result = await post(automationActionUrl(automation.id, action), { workspaceId: clientId });
      if (!result.ok) throw new Error(result.error);
      await load();
      if (expandedId === automation.id) await loadRuns(automation.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }

  async function approve(run: AutomationRun) {
    if (busy) return;
    setBusy(`approve:${run.id}`);
    try {
      // The server mints the central approval itself; clients only declare
      // the workspace and actor. Submitting an approvalId here was the exact
      // forgery pattern the unified approval chain now rejects.
      const result = await post(automationRunApproveUrl(run.id), {
        workspaceId: clientId,
        actor: "workspace-owner"
      });
      if (!result.ok) throw new Error(result.error);
      await load();
      await loadRuns(run.automationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }

  async function removeAutomation() {
    if (!deleteTarget || busy) return;
    setBusy(`delete:${deleteTarget.id}`);
    try {
      const response = await fetch(automationUrl(deleteTarget.id, clientId), { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
        throw new Error(body?.error ?? String(response.status));
      }
      if (expandedId === deleteTarget.id) setExpandedId(null);
      setDeleteTarget(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }

  async function markRead(notification: AppNotification) {
    const result = await post(notificationReadUrl(notification.id), { workspaceId: clientId });
    if (result.ok) await load();
  }

  async function createAutomation() {
    if (!draftValid(draft) || saving) return;
    setSaving(true);
    try {
      const payload = {
        workspaceId: clientId,
        title: draft.title.trim(),
        trigger: draft.triggerKind === "schedule"
          ? { kind: "schedule", cron: draft.cron }
          : {
              kind: "event",
              event: draft.eventName.trim(),
              ...(draft.eventCondition.trim() ? { condition: draft.eventCondition.trim() } : {})
            },
        action: draft.actionKind === "daily-brief"
          ? { kind: "daily-brief", input: {} }
          : draft.actionKind === "create-task"
            ? { kind: "create-task", task: { title: draft.taskTitle.trim(), description: draft.taskDescription } }
            : { kind: "notify", message: draft.message.trim() },
        guards: { maxRunsPerDay: Number(draft.maxRunsPerDay), requiresApprovalForMutation: true }
      };
      const result = await post("/api/automations", payload);
      if (!result.ok) throw new Error(result.error);
      setDialogOpen(false);
      setDraft(EMPTY_DRAFT);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const unread = notifications ? countUnread(notifications) : 0;

  return (
    <div className="workbench automations-view">
      <header className="workbench-head">
        <div>
          <h1>{copy.automationsTitle}</h1>
          <p>{copy.automationsBody}</p>
        </div>
        <div className="automation-head-actions">
          <Button size="sm" variant="subtle" className="icon-button" icon={<IconRefresh size={14} />} aria-label={copy.refresh} onClick={() => void load()} />
          <Button size="sm" variant="primary" icon={<IconPlus size={13} />} onClick={() => setDialogOpen(true)} disabled={!clientId}>
            {copy.automationsNew}
          </Button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="subtle" onClick={() => void load()}>{copy.retry}</Button>
        </div>
      )}

      <section className="home-section">
        <div className="home-section-head">
          <h2>{copy.automationNotifications}</h2>
          {unread > 0 && <Badge tone="accent" variant="soft">{interpolate(copy.automationUnread, { count: String(unread) })}</Badge>}
        </div>
        {notifications === null ? (
          <p className="workbench-quiet">{copy.loading}…</p>
        ) : notifications.length === 0 ? (
          <p className="workbench-quiet">{copy.automationNotificationsEmpty}</p>
        ) : (
          <ul className="home-list">
            {notifications.slice(0, 10).map((notification) => (
              <li key={notification.id} className="home-list-row" data-static>
                <span className={`home-list-title${notification.read ? " automation-read" : ""}`}>{notification.message}</span>
                <span className="home-list-meta">{formatTime(notification.createdAt, locale)}</span>
                {!notification.read && (
                  <Button size="sm" variant="subtle" onClick={() => void markRead(notification)}>{copy.notificationMarkRead}</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {automations === null ? (
        <p className="workbench-quiet">{copy.loading}…</p>
      ) : automations.length === 0 ? (
        <div className="empty-block">
          <strong>{copy.automationsEmpty}</strong>
          <p>{copy.automationsEmptyBody}</p>
          <Button size="sm" variant="primary" icon={<IconPlus size={13} />} onClick={() => setDialogOpen(true)}>{copy.automationsNew}</Button>
        </div>
      ) : (
        <section className="home-section">
          <div className="home-section-head">
            <h2>{copy.automationsTitle}</h2>
            <Badge tone="neutral" variant="outline">{automations.length}</Badge>
          </div>
          <ul className="automation-list">
            {automations.map((automation) => {
              const latest = latestRuns[automation.id];
              const expanded = expandedId === automation.id;
              const runs = runsByAutomation[automation.id];
              return (
                <li key={automation.id} className="automation-item">
                  <div className="automation-row">
                    <button
                      type="button"
                      className="automation-expand"
                      data-open={expanded || undefined}
                      aria-label={copy.automationRuns}
                      onClick={() => setExpandedId(expanded ? null : automation.id)}
                    >
                      <IconChevronDown size={13} />
                    </button>
                    <div className="automation-main">
                      <span className="home-list-title">{automation.title}</span>
                      <span className="home-list-meta">{automationTriggerText(automation.trigger, locale)}</span>
                    </div>
                    <span className="home-list-meta">
                      {automation.nextFireAt
                        ? interpolate(copy.automationNextFire, { time: formatTime(automation.nextFireAt, locale) })
                        : copy.automationNoFire}
                    </span>
                    <span className="home-list-meta">{interpolate(copy.automationRunCount, { count: String(automation.runCount) })}</span>
                    {latest && (
                      <Badge tone={automationRunStatusTone(latest.status)} variant="soft">
                        {automationRunStatusLabel(latest.status, locale)}
                      </Badge>
                    )}
                    <Badge tone={automationStateTone(automation.state)} variant="outline">
                      {automationStateLabel(automation.state, locale)}
                    </Badge>
                    <div className="automation-actions">
                      {automation.state === "active" ? (
                        <Button size="sm" variant="subtle" className="icon-button" icon={<IconPause size={13} />} aria-label={copy.automationPause} disabled={busy !== ""} onClick={() => void act(automation, "pause")} />
                      ) : (
                        <Button size="sm" variant="subtle" className="icon-button" icon={<IconPlay size={13} />} aria-label={copy.automationResume} disabled={busy !== ""} onClick={() => void act(automation, "resume")} />
                      )}
                      <Button size="sm" variant="subtle" className="icon-button" icon={<IconBolt size={13} />} aria-label={copy.automationRunNow} disabled={busy !== ""} onClick={() => void act(automation, "run-now")} />
                      <Button size="sm" variant="subtle" className="icon-button" icon={<IconArchive size={13} />} aria-label={copy.automationDelete} disabled={busy !== ""} onClick={() => setDeleteTarget(automation)} />
                    </div>
                  </div>
                  {expanded && (
                    <div className="automation-runs">
                      {!runs ? (
                        <p className="workbench-quiet">{copy.loading}…</p>
                      ) : runs.length === 0 ? (
                        <p className="workbench-quiet">{copy.automationRunsEmpty}</p>
                      ) : (
                        runs.map((run) => (
                          <div key={run.id} className="automation-run-row" data-waiting={run.status === "waiting-approval" || undefined}>
                            <Badge tone={automationRunStatusTone(run.status)} variant="soft">
                              {automationRunStatusLabel(run.status, locale)}
                            </Badge>
                            <span className="home-list-meta">{formatTime(run.startedAt, locale)}</span>
                            <span className="automation-run-summary">{automationRunSummary(run)}</span>
                            {run.approvalId && <span className="home-list-meta mono">{run.approvalId.slice(0, 20)}</span>}
                            {run.status === "waiting-approval" && (
                              <Button size="sm" variant="primary" disabled={busy !== ""} onClick={() => void approve(run)}>
                                {copy.automationApprove}
                              </Button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {dialogOpen && (
        <div className="plugin-confirm-overlay" role="presentation" onClick={() => setDialogOpen(false)}>
          <div className="plugin-confirm" role="dialog" aria-modal="true" aria-label={copy.automationCreateTitle} onClick={(event) => event.stopPropagation()}>
            <h2>{copy.automationCreateTitle}</h2>
            <label className="workspace-field">
              <span>{copy.automationTitleLabel}</span>
              <input value={draft.title} autoFocus placeholder={copy.automationTitlePlaceholder} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <label className="workspace-field">
              <span>{copy.automationTriggerLabel}</span>
              <select
                value={draft.triggerKind}
                onChange={(event) => setDraft({ ...draft, triggerKind: event.target.value as Draft["triggerKind"] })}
              >
                <option value="schedule">{copy.triggerSchedule}</option>
                <option value="event">{copy.triggerEvent}</option>
              </select>
            </label>
            {draft.triggerKind === "schedule" ? (
              <>
                <label className="workspace-field">
                  <span>{copy.automationPresetLabel}</span>
                  <select
                    value={draft.preset}
                    onChange={(event) => {
                      const preset = event.target.value as CronPreset;
                      setDraft({
                        ...draft,
                        preset,
                        ...(preset === "custom" ? {} : { cron: cronPresetFields(preset) })
                      });
                    }}
                  >
                    {CRON_PRESETS.map((preset) => (
                      <option key={preset} value={preset}>
                        {preset === "daily-morning" ? copy.presetDailyMorning
                          : preset === "hourly" ? copy.presetHourly
                            : preset === "weekly-monday" ? copy.presetWeeklyMonday
                              : copy.presetCustom}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="automation-cron-grid">
                  {(["minute", "hour", "dom", "month", "dow"] as const).map((field) => (
                    <label key={field} className="workspace-field">
                      <span>{field === "minute" ? copy.cronFieldMinute : field === "hour" ? copy.cronFieldHour : field === "dom" ? copy.cronFieldDom : field === "month" ? copy.cronFieldMonth : copy.cronFieldDow}</span>
                      <input
                        value={draft.cron[field]}
                        onChange={(event) => setDraft({ ...draft, preset: "custom", cron: { ...draft.cron, [field]: event.target.value } })}
                      />
                    </label>
                  ))}
                </div>
                <p className="workbench-quiet">{copy.automationCronHint}</p>
              </>
            ) : (
              <>
                <label className="workspace-field">
                  <span>{copy.automationEventNameLabel}</span>
                  <input value={draft.eventName} onChange={(event) => setDraft({ ...draft, eventName: event.target.value })} />
                </label>
                <label className="workspace-field">
                  <span>{copy.automationEventConditionLabel}</span>
                  <input value={draft.eventCondition} onChange={(event) => setDraft({ ...draft, eventCondition: event.target.value })} />
                </label>
              </>
            )}
            <label className="workspace-field">
              <span>{copy.automationActionLabel}</span>
              <select
                value={draft.actionKind}
                onChange={(event) => setDraft({ ...draft, actionKind: event.target.value as ActionKind })}
              >
                <option value="daily-brief">{copy.actionDailyBrief}</option>
                <option value="create-task">{copy.actionCreateTask}</option>
                <option value="notify">{copy.actionNotify}</option>
              </select>
            </label>
            {draft.actionKind === "create-task" && (
              <>
                <label className="workspace-field">
                  <span>{copy.automationTaskTitleLabel}</span>
                  <input value={draft.taskTitle} onChange={(event) => setDraft({ ...draft, taskTitle: event.target.value })} />
                </label>
                <label className="workspace-field">
                  <span>{copy.automationTaskDescriptionLabel}</span>
                  <textarea rows={2} value={draft.taskDescription} onChange={(event) => setDraft({ ...draft, taskDescription: event.target.value })} />
                </label>
              </>
            )}
            {draft.actionKind === "notify" && (
              <label className="workspace-field">
                <span>{copy.automationMessageLabel}</span>
                <input value={draft.message} onChange={(event) => setDraft({ ...draft, message: event.target.value })} />
              </label>
            )}
            <label className="workspace-field">
              <span>{copy.automationMaxRunsLabel}</span>
              <input value={draft.maxRunsPerDay} inputMode="numeric" onChange={(event) => setDraft({ ...draft, maxRunsPerDay: event.target.value })} />
            </label>
            <div className="plugin-confirm-actions">
              <Button size="sm" variant="subtle" onClick={() => setDialogOpen(false)}>{copy.cancel}</Button>
              <Button size="sm" variant="primary" disabled={saving || !draftValid(draft)} onClick={() => void createAutomation()}>{copy.automationCreate}</Button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="plugin-confirm-overlay" role="presentation" onClick={() => setDeleteTarget(null)}>
          <div className="plugin-confirm" role="alertdialog" aria-modal="true" aria-label={copy.automationDeleteTitle} onClick={(event) => event.stopPropagation()}>
            <h2>{copy.automationDeleteTitle}</h2>
            <p><strong>{deleteTarget.title}</strong></p>
            <p>{copy.automationDeleteBody}</p>
            <div className="plugin-confirm-actions">
              <Button size="sm" variant="subtle" onClick={() => setDeleteTarget(null)}>{copy.cancel}</Button>
              <Button size="sm" variant="primary" disabled={busy !== ""} onClick={() => void removeAutomation()}>{copy.automationDeleteConfirm}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
