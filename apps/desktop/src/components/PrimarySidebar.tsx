import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceCopy } from "../labels.js";
import { Tooltip } from "../ui.js";
import {
  IconAsterisk,
  IconBolt,
  IconDiamond,
  IconDocLines,
  IconMoon,
  IconPuzzle,
  IconSettings,
  IconStarFilled
} from "../icons.js";
import type { Client } from "../types.js";

export type PrimaryView = "home" | "chat" | "projects" | "project" | "automations" | "skills" | "plugins";

const MIN_WIDTH = 60;
const COLLAPSE_AT = 132;
const MAX_WIDTH = 340;
const DEFAULT_WIDTH = 236;
const STORAGE_KEY = "adpilot-primary-sidebar-width";

/**
 * The single primary sidebar. Drag its right edge to resize continuously;
 * below the collapse threshold it snaps into a pure icon strip, above it
 * becomes the text navigation column. Double-clicking the edge toggles the
 * two states. This replaces the old icon-rail + text-sidebar pair.
 */
export function PrimarySidebar({ copy, view, theme, clients, clientId, pluginsLabel, settingsLabel, themeLabel, onNewSession, onNavigate, onSelectClient, onShowPlugins, onOpenSettings, onToggleTheme }: {
  copy: WorkspaceCopy;
  view: PrimaryView;
  theme: "dark" | "light";
  clients: Client[];
  clientId: string;
  pluginsLabel: string;
  settingsLabel: string;
  themeLabel: string;
  onNewSession: () => void;
  onNavigate: (view: "home" | "chat" | "projects" | "automations" | "skills") => void;
  onSelectClient: (clientId: string) => void;
  onShowPlugins: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
}) {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH;
  });
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const collapsed = width < COLLAPSE_AT;

  const persist = useCallback((value: number) => {
    localStorage.setItem(STORAGE_KEY, String(value));
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [width]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.current.startWidth + event.clientX - drag.current.startX));
    setWidth(next);
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    setWidth((current) => {
      const snapped = current < COLLAPSE_AT ? MIN_WIDTH : current;
      persist(snapped);
      return snapped;
    });
  }, [persist]);

  const toggle = useCallback(() => {
    setWidth((current) => {
      const next = current < COLLAPSE_AT ? DEFAULT_WIDTH : MIN_WIDTH;
      persist(next);
      return next;
    });
  }, [persist]);

  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("sidebar-dragging");
    return () => document.body.classList.remove("sidebar-dragging");
  }, [dragging]);

  const items: Array<{ key: "home" | "chat" | "projects" | "automations" | "skills"; label: string; icon: React.ReactNode }> = [
    { key: "home", label: copy.navHome, icon: <IconStarFilled size={16} /> },
    { key: "chat", label: copy.navChat, icon: <IconDiamond size={16} /> },
    { key: "projects", label: copy.navProjects, icon: <IconDocLines size={16} /> },
    { key: "automations", label: copy.navAutomations, icon: <IconBolt size={16} /> },
    { key: "skills", label: copy.navSkills, icon: <IconAsterisk size={16} /> }
  ];
  const isActive = (key: string) => key === "projects" ? view === "projects" || view === "project" : view === key;

  return (
    <aside
      className="primary-sidebar"
      data-collapsed={collapsed || undefined}
      data-dragging={dragging || undefined}
      style={{ width }}
      aria-label="AdPilot"
    >
      <div className="primary-sidebar-body">
        <Tooltip content={copy.newChat} side="right">
          <button type="button" className="primary-new" data-icon={collapsed || undefined} onClick={onNewSession}>
            <span className="primary-new-plus" aria-hidden="true">+</span>
            {!collapsed && <span className="primary-new-label">{copy.newChat}</span>}
          </button>
        </Tooltip>

        <nav className="primary-nav">
          {items.map((item) => (
            <Tooltip key={item.key} content={item.label} side="right">
              <button
                type="button"
                className="primary-item"
                aria-label={item.label}
                aria-pressed={isActive(item.key)}
                data-active={isActive(item.key) || undefined}
                data-icon={collapsed || undefined}
                onClick={() => onNavigate(item.key)}
              >
                {item.icon}
                {!collapsed && <span>{item.label}</span>}
              </button>
            </Tooltip>
          ))}
        </nav>

        <div className="primary-workspaces">
          {!collapsed && <span className="primary-label">{copy.workspace}</span>}
          {clients.map((client) => {
            const active = client.id === clientId;
            return (
              <Tooltip key={client.id} content={client.name} side="right">
                <button
                  type="button"
                  className="primary-workspace"
                  aria-label={client.name}
                  data-active={active || undefined}
                  data-icon={collapsed || undefined}
                  onClick={() => onSelectClient(client.id)}
                >
                  <i aria-hidden="true" data-filled={active || undefined} />
                  {!collapsed && <span>{client.name}</span>}
                </button>
              </Tooltip>
            );
          })}
        </div>

        <div className="primary-foot">
          <Tooltip content={themeLabel} side="right">
            <button
              type="button"
              className="primary-item"
              aria-label={themeLabel}
              aria-pressed={theme === "dark"}
              data-icon={collapsed || undefined}
              onClick={onToggleTheme}
            >
              <IconMoon size={16} />
            </button>
          </Tooltip>
          <Tooltip content={pluginsLabel} side="right">
            <button
              type="button"
              className="primary-item"
              aria-label={pluginsLabel}
              aria-pressed={view === "plugins"}
              data-active={view === "plugins" || undefined}
              data-icon={collapsed || undefined}
              onClick={onShowPlugins}
            >
              <IconPuzzle size={16} />
            </button>
          </Tooltip>
          <Tooltip content={settingsLabel} side="right">
            <button type="button" className="primary-item" aria-label={settingsLabel} data-icon={collapsed || undefined} onClick={onOpenSettings}>
              <IconSettings size={16} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div
        className="primary-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="resize sidebar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={toggle}
      />
    </aside>
  );
}
