import { useMemo, useRef, useState } from "react";
import { sessionStatusLabel, type AppLocale, type ConsoleCopy } from "../labels.js";
import type { Client, ProductSession } from "../types.js";
import { groupSessions, isSessionPinned, sessionStatusTone } from "../sessionList.js";
import { Button, Tooltip } from "../ui.js";
import {
  IconArchive,
  IconChevronDown,
  IconDismiss,
  IconMenu,
  IconPencil,
  IconPin,
  IconPlus,
  IconPuzzle,
  IconRestore,
  IconSearch,
  IconSettings,
  IconShieldCheck
} from "../icons.js";

/**
 * Codex-skeleton sidebar driven by real product Sessions: product lockup and
 * the primary "new conversation" action on top, a debounced search field,
 * then the session list — pinned first, the rest by recent activity, an
 * expandable archived group at the bottom — and the workspace switcher,
 * pending-approval badge, and settings entry in the footer. Collapses to a
 * 60px icon rail; the collapsed state is persisted by the parent.
 *
 * Row hover reveals the restrained per-session actions (pin, rename inline,
 * archive); the archived group offers restore only. Run status shows as a
 * single dot: breathing accent while running, warning while waiting for
 * approval, danger on failure — everything else stays quiet.
 */
export function Sidebar({ copy, locale, clients, clientId, sessions, searching, selectedSessionId, search, pendingApprovals, collapsed, onToggleCollapsed, onNewSession, onSelectSession, onTogglePin, onRename, onArchive, onRestore, onSearchChange, onSelectClient, onJumpToApprovals, onOpenSettings, pluginsLabel, pluginsActive, onShowPlugins }: {
  copy: ConsoleCopy;
  locale: AppLocale;
  clients: Client[];
  clientId: string;
  /** Visible sessions — the full list, or the server-side search result while searching. */
  sessions: ProductSession[];
  /** True while the visible list is a search result (drives the empty-state copy). */
  searching: boolean;
  selectedSessionId: string | null;
  search: string;
  pendingApprovals: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNewSession: () => void;
  onSelectSession: (session: ProductSession) => void;
  onTogglePin: (session: ProductSession) => void;
  onRename: (session: ProductSession, title: string) => void;
  onArchive: (session: ProductSession) => void;
  onRestore: (session: ProductSession) => void;
  onSearchChange: (query: string) => void;
  onSelectClient: (clientId: string) => void;
  onJumpToApprovals: () => void;
  onOpenSettings: () => void;
  pluginsLabel: string;
  pluginsActive: boolean;
  onShowPlugins: () => void;
}) {
  const groups = useMemo(() => groupSessions(sessions), [sessions]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  /** Inline rename: at most one row edits at a time; Escape cancels, Enter commits. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameCancelled = useRef(false);
  const collapseLabel = collapsed ? copy.expandSidebar : copy.collapseSidebar;

  function startRename(session: ProductSession) {
    setRenamingId(session.id);
    setRenameDraft(session.title);
  }

  function commitRename(session: ProductSession) {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (title && title !== session.title) onRename(session, title);
  }

  function renderRow(session: ProductSession, archived: boolean) {
    const tone = sessionStatusTone(session.status);
    const selected = session.id === selectedSessionId;
    const pinned = isSessionPinned(session);
    if (renamingId === session.id) {
      return (
        <li key={session.id} className={`session-item${selected ? " active" : ""}`}>
          <input
            className="session-rename"
            value={renameDraft}
            maxLength={200}
            aria-label={copy.renameSession}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); renameCancelled.current = true; commitRename(session); }
              if (event.key === "Escape") { event.preventDefault(); renameCancelled.current = true; setRenamingId(null); }
            }}
            onBlur={() => {
              if (renameCancelled.current) { renameCancelled.current = false; return; }
              commitRename(session);
            }}
          />
        </li>
      );
    }
    return (
      <li key={session.id} className={`session-item${selected ? " active" : ""}${archived ? " archived" : ""}`}>
        <button
          type="button"
          className="session-open"
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelectSession(session)}
        >
          {tone !== "quiet" && (
            <span className="session-status" data-tone={tone} role="img" aria-label={sessionStatusLabel(session.status, locale)} />
          )}
          <span className="session-title">{session.title || copy.untitledSession}</span>
          {pinned && !archived && <IconPin size={12} className="session-pinned-mark" />}
        </button>
        <span className="session-actions">
          {archived ? (
            <Tooltip content={copy.restoreSession} side="top">
              <button type="button" aria-label={`${copy.restoreSession}: ${session.title}`} onClick={() => onRestore(session)}>
                <IconRestore size={13} />
              </button>
            </Tooltip>
          ) : (
            <>
              <Tooltip content={pinned ? copy.unpinSession : copy.pinSession} side="top">
                <button type="button" aria-label={`${pinned ? copy.unpinSession : copy.pinSession}: ${session.title}`} data-on={pinned || undefined} onClick={() => onTogglePin(session)}>
                  <IconPin size={13} />
                </button>
              </Tooltip>
              <Tooltip content={copy.renameSession} side="top">
                <button type="button" aria-label={`${copy.renameSession}: ${session.title}`} onClick={() => startRename(session)}>
                  <IconPencil size={13} />
                </button>
              </Tooltip>
              <Tooltip content={copy.archiveSession} side="top">
                <button type="button" aria-label={`${copy.archiveSession}: ${session.title}`} onClick={() => onArchive(session)}>
                  <IconArchive size={13} />
                </button>
              </Tooltip>
            </>
          )}
        </span>
      </li>
    );
  }

  return (
    <aside className="sidebar" data-collapsed={collapsed || undefined}>
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-glyph" aria-hidden="true">AP</span>
          <div className="brand-text"><strong>AdPilot</strong></div>
        </div>
        <Tooltip content={collapseLabel} side="right">
          <button type="button" className="sidebar-toggle" aria-label={collapseLabel} onClick={onToggleCollapsed}>
            <IconMenu size={16} />
          </button>
        </Tooltip>
      </div>

      <Button variant="primary" className="new-chat" icon={<IconPlus size={14} />} onClick={onNewSession}>
        <span className="new-chat-label">{copy.newChat}</span>
      </Button>

      {!collapsed && (
        <>
          <div className="sidebar-search">
            <IconSearch size={13} />
            <input
              type="search"
              value={search}
              placeholder={copy.searchSessions}
              aria-label={copy.searchSessions}
              onChange={(event) => onSearchChange(event.target.value)}
            />
            {search && (
              <button type="button" className="sidebar-search-clear" aria-label={copy.clearSearch} onClick={() => onSearchChange("")}>
                <IconDismiss size={11} />
              </button>
            )}
          </div>

          <nav className="sidebar-nav" aria-label={copy.conversation}>
            {groups.pinned.length > 0 && (
              <>
                <span className="sidebar-label">{copy.pinnedGroup}</span>
                <ul>{groups.pinned.map((session) => renderRow(session, false))}</ul>
              </>
            )}

            <span className="sidebar-label">{copy.conversation}</span>
            <ul>
              {groups.active.map((session) => renderRow(session, false))}
              {groups.active.length === 0 && groups.pinned.length === 0 && (
                <li className="sidebar-empty">{searching ? copy.noSessionMatches : copy.emptySessions}</li>
              )}
            </ul>

            {groups.archived.length > 0 && (
              <>
                <button
                  type="button"
                  className="sidebar-label archived-toggle"
                  aria-expanded={archivedOpen}
                  onClick={() => setArchivedOpen((open) => !open)}
                >
                  <IconChevronDown size={11} {...(archivedOpen ? { className: "open" } : {})} />
                  {copy.archivedGroup}
                  <span className="archived-count">{groups.archived.length}</span>
                </button>
                {archivedOpen && <ul>{groups.archived.map((session) => renderRow(session, true))}</ul>}
              </>
            )}
          </nav>
        </>
      )}
      {collapsed && <div className="sidebar-spacer" />}

      <div className="sidebar-foot">
        {pendingApprovals > 0 && (
          <Tooltip content={copy.jumpToApproval} side={collapsed ? "right" : "top"}>
            <button
              type="button"
              className="approval-badge"
              aria-label={`${copy.pendingApprovals} ${pendingApprovals}`}
              onClick={onJumpToApprovals}
            >
              <IconShieldCheck size={14} />
              <b>{pendingApprovals}</b>
            </button>
          </Tooltip>
        )}
        {!collapsed && clients.length > 0 && (
          <div className="workspace-switcher">
            <span className="status-dot" data-live={Boolean(clientId)} aria-hidden="true" />
            <label htmlFor="sidebar-client-select">{copy.workspace}</label>
            <div className="select-wrap">
              <select id="sidebar-client-select" value={clientId} onChange={(event) => onSelectClient(event.target.value)}>
                {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
                <option value="__new_workspace__">{copy.newWorkspace}</option>
              </select>
              <IconChevronDown size={12} />
            </div>
          </div>
        )}
        <Tooltip content={pluginsLabel} side={collapsed ? "right" : "top"}>
          <Button variant="subtle" className="icon-button" icon={<IconPuzzle size={17} />} aria-label={pluginsLabel} aria-pressed={pluginsActive} data-active={pluginsActive || undefined} onClick={onShowPlugins} />
        </Tooltip>
        <Tooltip content={copy.settings} side={collapsed ? "right" : "top"}>
          <Button variant="subtle" className="icon-button" icon={<IconSettings size={17} />} aria-label={copy.settings} onClick={onOpenSettings} />
        </Tooltip>
      </div>
    </aside>
  );
}
