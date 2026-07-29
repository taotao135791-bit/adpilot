import { useCallback, useRef, useState } from "react";
import type { WorkspaceCopy, ConsoleCopy, AppLocale } from "../labels.js";
import { sessionStatusTone } from "../sessionList.js";
import { sessionStatusLabel } from "../labels.js";
import { Tooltip } from "../ui.js";
import {
  IconAsterisk,
  IconArchive,
  IconBolt,
  IconChevronDown,
  IconDismiss,
  IconDocLines,
  IconMenu,
  IconMoon,
  IconPencil,
  IconPin,
  IconPlus,
  IconPuzzle,
  IconRestore,
  IconSearch,
  IconSettings,
  IconStarFilled
} from "../icons.js";
import { LogoMark } from "./LogoMark.js";
import type { Client, ProductSession } from "../types.js";

export type PrimaryView = "home" | "chat" | "projects" | "project" | "automations" | "skills" | "plugins";

const MIN_WIDTH = 200;
const HIDE_BELOW = 168;
const MAX_WIDTH = 340;
const DEFAULT_WIDTH = 248;
const STORAGE_KEY = "adpilot-primary-sidebar-width";

/**
 * The single primary sidebar, Codex-style: logo row under the traffic
 * lights, new-session, search, a fixed nav menu, an independently scrolling
 * session list (with pin/rename/archive), and a footer with workspaces and
 * app toggles. The parent hides the whole column below the resize
 * threshold instead of shrinking it into an icon strip.
 */
export function PrimarySidebar({ copy, consoleCopy, locale, view, theme, clients, clientId, sessions, selectedSessionId, search, pinnedSessions, archivedSessions, archivedOpen, renamingId, renameDraft, pluginsLabel, settingsLabel, themeLabel, onNewSession, onNavigate, onSelectClient, onSelectSession, onTogglePin, onStartRename, onRenameDraft, onCommitRename, onCancelRename, onArchive, onRestore, onToggleArchivedOpen, onSearchChange, onShowPlugins, onOpenSettings, onToggleTheme, onHideSidebar }: {
  copy: WorkspaceCopy;
  consoleCopy: ConsoleCopy;
  locale: AppLocale;
  view: PrimaryView;
  theme: "dark" | "light";
  clients: Client[];
  clientId: string;
  sessions: ProductSession[];
  selectedSessionId: string | null;
  search: string;
  pinnedSessions: ProductSession[];
  archivedSessions: ProductSession[];
  archivedOpen: boolean;
  renamingId: string | null;
  renameDraft: string;
  pluginsLabel: string;
  settingsLabel: string;
  themeLabel: string;
  onNewSession: () => void;
  onNavigate: (view: "home" | "chat" | "projects" | "automations" | "skills") => void;
  onSelectClient: (clientId: string) => void;
  onSelectSession: (session: ProductSession) => void;
  onTogglePin: (session: ProductSession) => void;
  onStartRename: (session: ProductSession) => void;
  onRenameDraft: (value: string) => void;
  onCommitRename: (session: ProductSession) => void;
  onCancelRename: () => void;
  onArchive: (session: ProductSession) => void;
  onRestore: (session: ProductSession) => void;
  onToggleArchivedOpen: () => void;
  onSearchChange: (value: string) => void;
  onShowPlugins: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onHideSidebar: () => void;
}) {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH;
  });
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [width]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = Math.min(MAX_WIDTH, Math.max(0, drag.current.startWidth + event.clientX - drag.current.startX));
    setWidth(next);
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (width < HIDE_BELOW) {
      setWidth(DEFAULT_WIDTH);
      onHideSidebar();
      return;
    }
    const clamped = Math.max(MIN_WIDTH, width);
    setWidth(clamped);
    localStorage.setItem(STORAGE_KEY, String(clamped));
  }, [width, onHideSidebar]);

  const navItems: Array<{ key: "home" | "projects" | "automations" | "skills"; label: string; icon: React.ReactNode }> = [
    { key: "home", label: copy.navHome, icon: <IconStarFilled size={15} /> },
    { key: "projects", label: copy.navProjects, icon: <IconDocLines size={15} /> },
    { key: "automations", label: copy.navAutomations, icon: <IconBolt size={15} /> },
    { key: "skills", label: copy.navSkills, icon: <IconAsterisk size={15} /> }
  ];
  const isActive = (key: string) => key === "projects" ? view === "projects" || view === "project" : view === key;

  const renderRow = (session: ProductSession, archived: boolean) => {
    const tone = sessionStatusTone(session.status);
    const selected = session.id === selectedSessionId;
    const pinned = Boolean(session.pinnedAt);
    if (renamingId === session.id) {
      return (
        <li key={session.id} className="session-item active">
          <input
            className="session-rename"
            value={renameDraft}
            maxLength={200}
            aria-label={consoleCopy.renameSession}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => onRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); onCommitRename(session); }
              if (event.key === "Escape") { event.preventDefault(); onCancelRename(); }
            }}
            onBlur={() => onCommitRename(session)}
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
          <span className="session-title">{session.title || consoleCopy.untitledSession}</span>
          {pinned && !archived && <IconPin size={11} className="session-pinned-mark" />}
        </button>
        <span className="session-actions">
          {archived ? (
            <Tooltip content={consoleCopy.restoreSession} side="top">
              <button type="button" aria-label={`${consoleCopy.restoreSession}: ${session.title}`} onClick={() => onRestore(session)}>
                <IconRestore size={13} />
              </button>
            </Tooltip>
          ) : (
            <>
              <Tooltip content={pinned ? consoleCopy.unpinSession : consoleCopy.pinSession} side="top">
                <button type="button" aria-label={`${pinned ? consoleCopy.unpinSession : consoleCopy.pinSession}: ${session.title}`} data-on={pinned || undefined} onClick={() => onTogglePin(session)}>
                  <IconPin size={13} />
                </button>
              </Tooltip>
              <Tooltip content={consoleCopy.renameSession} side="top">
                <button type="button" aria-label={`${consoleCopy.renameSession}: ${session.title}`} onClick={() => onStartRename(session)}>
                  <IconPencil size={13} />
                </button>
              </Tooltip>
              <Tooltip content={consoleCopy.archiveSession} side="top">
                <button type="button" aria-label={`${consoleCopy.archiveSession}: ${session.title}`} onClick={() => onArchive(session)}>
                  <IconArchive size={13} />
                </button>
              </Tooltip>
            </>
          )}
        </span>
      </li>
    );
  };

  return (
    <aside
      className="primary-sidebar"
      data-dragging={dragging || undefined}
      style={{ width }}
      aria-label="AdPilot"
    >
      <div className="primary-head">
        <span className="primary-logo"><LogoMark size={22} /></span>
        <strong className="primary-wordmark">AdPilot</strong>
        <Tooltip content={consoleCopy.collapseSidebar} side="right">
          <button type="button" className="primary-head-toggle" aria-label={consoleCopy.collapseSidebar} onClick={onHideSidebar}>
            <IconMenu size={15} />
          </button>
        </Tooltip>
      </div>

      <button type="button" className="primary-new" onClick={onNewSession}>
        <IconPlus size={14} />
        <span>{copy.newChat}</span>
      </button>

      <div className="sidebar-search">
        <IconSearch size={13} />
        <input
          type="search"
          value={search}
          placeholder={consoleCopy.searchSessions}
          aria-label={consoleCopy.searchSessions}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        {search && (
          <button type="button" className="sidebar-search-clear" aria-label={consoleCopy.clearSearch} onClick={() => onSearchChange("")}>
            <IconDismiss size={11} />
          </button>
        )}
      </div>

      <nav className="primary-nav">
        {navItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className="primary-item"
            aria-pressed={isActive(item.key)}
            data-active={isActive(item.key) || undefined}
            onClick={() => onNavigate(item.key)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="primary-sessions">
        {pinnedSessions.length > 0 && (
          <>
            <span className="sidebar-label">{consoleCopy.pinnedGroup}</span>
            <ul>{pinnedSessions.map((session) => renderRow(session, false))}</ul>
          </>
        )}
        <span className="sidebar-label">{consoleCopy.conversation}</span>
        <ul>
          {sessions.map((session) => renderRow(session, false))}
          {sessions.length === 0 && pinnedSessions.length === 0 && (
            <li className="sidebar-empty">{search ? consoleCopy.noSessionMatches : consoleCopy.emptySessions}</li>
          )}
        </ul>
        {archivedSessions.length > 0 && (
          <>
            <button
              type="button"
              className="sidebar-label archived-toggle"
              aria-expanded={archivedOpen}
              onClick={onToggleArchivedOpen}
            >
              <IconChevronDown size={11} {...(archivedOpen ? { className: "open" } : {})} />
              {consoleCopy.archivedGroup}
              <span className="archived-count">{archivedSessions.length}</span>
            </button>
            {archivedOpen && <ul>{archivedSessions.map((session) => renderRow(session, true))}</ul>}
          </>
        )}
      </div>

      <div className="primary-workspaces">
        <span className="primary-label">{copy.workspace}</span>
        {clients.map((client) => {
          const active = client.id === clientId;
          return (
            <button
              key={client.id}
              type="button"
              className="primary-workspace"
              data-active={active || undefined}
              onClick={() => onSelectClient(client.id)}
            >
              <i aria-hidden="true" data-filled={active || undefined} />
              <span>{client.name}</span>
            </button>
          );
        })}
      </div>

      <div className="primary-foot">
        <Tooltip content={themeLabel} side="top">
          <button type="button" className="primary-foot-item" aria-label={themeLabel} aria-pressed={theme === "dark"} onClick={onToggleTheme}>
            <IconMoon size={15} />
          </button>
        </Tooltip>
        <Tooltip content={pluginsLabel} side="top">
          <button type="button" className="primary-foot-item" aria-label={pluginsLabel} aria-pressed={view === "plugins"} data-active={view === "plugins" || undefined} onClick={onShowPlugins}>
            <IconPuzzle size={15} />
          </button>
        </Tooltip>
        <Tooltip content={settingsLabel} side="top">
          <button type="button" className="primary-foot-item" aria-label={settingsLabel} onClick={onOpenSettings}>
            <IconSettings size={15} />
          </button>
        </Tooltip>
      </div>

      <div
        className="primary-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="resize sidebar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </aside>
  );
}
