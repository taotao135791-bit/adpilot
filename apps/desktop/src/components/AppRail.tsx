import type { ReactNode } from "react";
import type { WorkspaceCopy } from "../labels.js";
import { Tooltip } from "../ui.js";
import {
  IconBolt,
  IconBook,
  IconChat,
  IconHome,
  IconPuzzle,
  IconSettings,
  IconTarget
} from "../icons.js";

export type RailView = "home" | "chat" | "projects" | "project" | "automations" | "skills" | "plugins";

/**
 * Primary navigation rail: a fixed 56px icon strip on the far left of the
 * shell, always rendered regardless of the active view. Top group switches
 * the main view (Projects stays lit on the project workbench too); the bottom
 * group holds the plugins catalog and settings. Pure navigation — every
 * target is a real view.
 */
export function AppRail({ copy, view, pluginsLabel, settingsLabel, onNavigate, onShowPlugins, onOpenSettings }: {
  copy: WorkspaceCopy;
  view: RailView;
  pluginsLabel: string;
  settingsLabel: string;
  onNavigate: (view: "home" | "chat" | "projects" | "automations" | "skills") => void;
  onShowPlugins: () => void;
  onOpenSettings: () => void;
}) {
  const items: Array<{ key: "home" | "chat" | "projects" | "automations" | "skills"; label: string; icon: ReactNode }> = [
    { key: "home", label: copy.navHome, icon: <IconHome size={18} /> },
    { key: "chat", label: copy.navChat, icon: <IconChat size={18} /> },
    { key: "projects", label: copy.navProjects, icon: <IconTarget size={18} /> },
    { key: "automations", label: copy.navAutomations, icon: <IconBolt size={18} /> },
    { key: "skills", label: copy.navSkills, icon: <IconBook size={18} /> }
  ];
  return (
    <nav className="app-rail" aria-label="AdPilot">
      {items.map((item) => {
        const active = item.key === "projects" ? view === "projects" || view === "project" : view === item.key;
        return (
          <Tooltip key={item.key} content={item.label} side="right">
            <button
              type="button"
              className="app-rail-item"
              aria-label={item.label}
              aria-pressed={active}
              data-active={active || undefined}
              onClick={() => onNavigate(item.key)}
            >
              {item.icon}
            </button>
          </Tooltip>
        );
      })}
      <span className="app-rail-spacer" />
      <Tooltip content={pluginsLabel} side="right">
        <button
          type="button"
          className="app-rail-item"
          aria-label={pluginsLabel}
          aria-pressed={view === "plugins"}
          data-active={view === "plugins" || undefined}
          onClick={onShowPlugins}
        >
          <IconPuzzle size={18} />
        </button>
      </Tooltip>
      <Tooltip content={settingsLabel} side="right">
        <button type="button" className="app-rail-item" aria-label={settingsLabel} onClick={onOpenSettings}>
          <IconSettings size={18} />
        </button>
      </Tooltip>
    </nav>
  );
}
