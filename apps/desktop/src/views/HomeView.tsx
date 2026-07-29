import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { operationLabel, workspaceCopy, type AppLocale } from "../labels.js";
import type { Approval } from "../approvalDisclosure.js";
import type { ProductSession } from "../types.js";
import {
  kernelProjectsUrl,
  type KernelProject
} from "../workspace.js";
import { Badge, Button } from "../ui.js";
import { IconArrowUpRight, IconPlus, IconSend } from "../icons.js";
import { TopBar } from "../components/TopBar.js";

type FeedRow = {
  id: string;
  kind: "session" | "approval";
  tone: "live" | "attention" | "success" | "quiet" | "danger";
  title: string;
  path: string;
  time: string;
  onOpen: () => void;
};

function relativeTime(iso: string, locale: AppLocale): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return locale === "zh-CN" ? "刚刚" : "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return locale === "zh-CN" ? "昨天" : "yesterday";
  return `${days}d`;
}

/**
 * Home: breadcrumb top bar, a display heading with the workspace context,
 * the ask/code composer, and a unified Recent/Archive feed of approvals and
 * sessions. No fabricated numbers — rows only show what exists.
 */
export function HomeView({ locale, clientId, workspaceName, openApprovals, recentSessions, archivedSessions, onSubmitGoal, onSubmitCode, onOpenProjects, onOpenApprovals, onOpenSession, onOpenSettings }: {
  locale: AppLocale;
  clientId: string;
  workspaceName: string;
  openApprovals: Approval[];
  recentSessions: ProductSession[];
  archivedSessions: ProductSession[];
  onSubmitGoal: (message: string) => void;
  onSubmitCode: (message: string) => void;
  onOpenProjects: () => void;
  onOpenApprovals: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenSettings: () => void;
}) {
  const copy = workspaceCopy(locale);
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [tab, setTab] = useState<"recent" | "archive">("recent");
  const [activeProject, setActiveProject] = useState<KernelProject | undefined>();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(kernelProjectsUrl(clientId))
      .then((response) => response.ok ? response.json() as Promise<{ projects?: KernelProject[] }> : { projects: [] })
      .then((body) => {
        if (!cancelled) setActiveProject((body.projects ?? []).find((project) => project.status !== "archived"));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [clientId]);

  const submit = useCallback(async () => {
    const text = goal.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      onSubmitGoal(text);
      setGoal("");
    } finally {
      setSubmitting(false);
    }
  }, [goal, submitting, onSubmitGoal]);

  const rows = useMemo<FeedRow[]>(() => {
    if (tab === "archive") {
      return archivedSessions.slice(0, 8).map((session) => ({
        id: session.id,
        kind: "session",
        tone: "quiet",
        title: session.title,
        path: workspaceName,
        time: relativeTime(session.lastActivityAt, locale),
        onOpen: () => onOpenSession(session.id)
      }));
    }
    const approvalRows: FeedRow[] = openApprovals.slice(0, 5).map((approval) => ({
      id: approval.id,
      kind: "approval",
      tone: "attention",
      title: `${operationLabel(approval.operation.operation, locale)} · ${approval.operation.campaign || approval.operation.account}`,
      path: workspaceName,
      time: approval.createdAt ? relativeTime(approval.createdAt, locale) : "",
      onOpen: onOpenApprovals
    }));
    const sessionRows: FeedRow[] = recentSessions.slice(0, 8).map((session) => ({
      id: session.id,
      kind: "session",
      tone: session.status === "failed" ? "danger" : session.status === "running" ? "live" : session.status === "completed" ? "success" : "quiet",
      title: session.title,
      path: workspaceName,
      time: relativeTime(session.lastActivityAt, locale),
      onOpen: () => onOpenSession(session.id)
    }));
    return [...approvalRows, ...sessionRows];
  }, [tab, archivedSessions, openApprovals, recentSessions, workspaceName, locale, onOpenApprovals, onOpenSession]);

  return (
    <div className="home">
      <TopBar
        crumbs={["adpilot", copy.workspace, workspaceName]}
        settingsLabel={copy.settings}
        onOpenSettings={onOpenSettings}
      />
      <div className="home-body">
        <h1 className="home-heading">{copy.homeHeading}</h1>
        <p className="home-context">
          {copy.workspace.toLowerCase()} · {workspaceName}
          {activeProject ? ` / ${activeProject.name}` : ""}
        </p>

        <div className="home-composer" data-submitting={submitting || undefined}>
          <textarea
            ref={inputRef}
            value={goal}
            rows={2}
            placeholder={copy.homeComposerPlaceholder}
            aria-label={copy.homeComposerPlaceholder}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="home-composer-row">
            <Button size="sm" variant="subtle" className="icon-button" icon={<IconPlus size={14} />} aria-label={copy.homeAttach} disabled />
            <div className="home-mode" role="group" aria-label="mode">
              <button type="button" className="home-mode-item" data-active="true" onClick={() => void submit()}>Ask</button>
              <button
                type="button"
                className="home-mode-item"
                onClick={() => {
                  const text = goal.trim();
                  if (!text || submitting) return;
                  onSubmitCode(text);
                  setGoal("");
                }}
              >{copy.homeCodeMode}</button>
            </div>
            <kbd className="home-kbd" title={copy.homeSlashHint}>⌘K</kbd>
            <span className="home-send-hint">{copy.homeSendHint}</span>
            <button
              type="button"
              className="home-send"
              aria-label={copy.homeQuickSubmit}
              disabled={!goal.trim() || submitting}
              onClick={() => void submit()}
            >
              <IconSend size={14} />
            </button>
          </div>
        </div>

        <div className="home-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "recent"}
            className="home-tab"
            data-active={tab === "recent" || undefined}
            onClick={() => setTab("recent")}
          >{copy.homeRecent}</button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "archive"}
            className="home-tab"
            data-active={tab === "archive" || undefined}
            onClick={() => setTab("archive")}
          >{copy.homeArchive}</button>
        </div>

        {rows.length === 0 ? (
          <div className="empty-block">
            <strong>{tab === "recent" ? copy.homeFeedEmpty : copy.homeArchiveEmpty}</strong>
            <p>{copy.homeFeedEmptyBody}</p>
            <Button size="sm" variant="subtle" icon={<IconArrowUpRight size={12} />} onClick={onOpenProjects}>{copy.viewAll}</Button>
          </div>
        ) : (
          <ul className="home-feed">
            {rows.map((row) => (
              <li key={`${row.kind}-${row.id}`}>
                <button type="button" className="home-feed-row" onClick={row.onOpen}>
                  <i className="home-feed-dot" data-tone={row.tone} aria-hidden="true" />
                  <span className="home-feed-main">
                    <span className="home-feed-title">{row.title}</span>
                    <span className="home-feed-path">{row.path}</span>
                  </span>
                  {row.kind === "approval" && <Badge tone="warning" variant="soft">{copy.homeApprovals}</Badge>}
                  <span className="home-feed-time">{row.time}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
