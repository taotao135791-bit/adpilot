import type { ReactNode } from "react";
import type { WorkspaceCopy } from "../labels.js";
import { Tooltip } from "../ui.js";
import {
  IconAsterisk,
  IconBolt,
  IconDiamond,
  IconDiamondFilled,
  IconDocLines,
  IconMoon,
  IconPuzzle,
  IconSettings,
  IconStarFilled
} from "../icons.js";

export type RailView = "home" | "chat" | "projects" | "project" | "automations" | "skills" | "plugins";

/**
 * Primary navigation rail: a fixed 56px icon strip on the far left of the
 * shell, always rendered regardless of the active view. The diamond pair is
 * the brand mark; the group below switches views; the bottom cluster holds
 * the theme toggle, plugins catalog and settings.
 */
export function AppRail({ copy, view, theme, pluginsLabel, settingsLabel, themeLabel, onNavigate, onShowPlugins, onOpenSettings, onToggleTheme }: {
  copy: WorkspaceCopy;
  view: RailView;
  theme: "dark" | "light";
  pluginsLabel: string;
  settingsLabel: string;
  themeLabel: string;
  onNavigate: (view: "home" | "chat" | "projects" | "automations" | "skills") => void;
  onShowPlugins: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
}) {
  const items: Array<{ key: "home" | "chat" | "projects" | "automations" | "skills"; label: string; icon: ReactNode }> = [
    { key: "home", label: copy.navHome, icon: <IconDiamond size={17} /> },
    { key: "chat", label: copy.navChat, icon: <IconStarFilled size={16} /> },
    { key: "projects", label: copy.navProjects, icon: <IconDocLines size={16} /> },
    { key: "automations", label: copy.navAutomations, icon: <IconBolt size={17} /> },
    { key: "skills", label: copy.navSkills, icon: <IconAsterisk size={16} /> }
  ];
  return (
    <nav className="app-rail" aria-label="AdPilot">
      <span className="app-rail-brand" aria-hidden="true">
        <IconDiamond size={12} />
        <IconDiamondFilled size={12} />
      </span>
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
      <Tooltip content={themeLabel} side="right">
        <button
          type="button"
          className="app-rail-item"
          aria-label={themeLabel}
          aria-pressed={theme === "dark"}
          onClick={onToggleTheme}
        >
          <IconMoon size={17} />
        </button>
      </Tooltip>
      <Tooltip content={pluginsLabel} side="right">
        <button
          type="button"
          className="app-rail-item"
          aria-label={pluginsLabel}
          aria-pressed={view === "plugins"}
          data-active={view === "plugins" || undefined}
          onClick={onShowPlugins}
        >
          <IconPuzzle size={17} />
        </button>
      </Tooltip>
      <Tooltip content={settingsLabel} side="right">
        <button type="button" className="app-rail-item" aria-label={settingsLabel} onClick={onOpenSettings}>
          <IconSettings size={17} />
        </button>
      </Tooltip>
    </nav>
  );
}
