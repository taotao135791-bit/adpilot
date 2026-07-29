import type { WorkspaceCopy } from "../labels.js";
import {
  IconAsterisk,
  IconDiamond,
  IconDiamondFilled,
  IconDocLines,
  IconStarFilled
} from "../icons.js";
import type { Client } from "../types.js";

export type NavView = "home" | "projects" | "automations" | "skills" | "plugins";

/**
 * Secondary navigation column: a text-forward counterpart to the icon rail.
 * Text nav targets mirror the rail, and the bottom block lists every
 * workspace with a filled-dot marker on the active one — switching workspace
 * is one click, no dropdown.
 */
export function NavSidebar({ copy, view, clients, clientId, onNewSession, onNavigate, onSelectClient }: {
  copy: WorkspaceCopy;
  view: NavView | "chat";
  clients: Client[];
  clientId: string;
  onNewSession: () => void;
  onNavigate: (view: "home" | "chat" | "projects" | "automations" | "skills") => void;
  onSelectClient: (clientId: string) => void;
}) {
  const items: Array<{ key: "home" | "chat" | "projects" | "skills" | "automations"; label: string; icon: React.ReactNode }> = [
    { key: "home", label: copy.navHome, icon: <IconStarFilled size={13} /> },
    { key: "chat", label: copy.navChat, icon: <IconDiamond size={13} /> },
    { key: "projects", label: copy.navProjects, icon: <IconDocLines size={13} /> },
    { key: "skills", label: copy.navSkills, icon: <IconAsterisk size={13} /> },
    { key: "automations", label: copy.navAutomations, icon: <IconAsterisk size={13} /> }
  ];
  return (
    <aside className="nav-sidebar" aria-label={copy.navHome}>
      <div className="nav-sidebar-brand">
        <IconDiamondFilled size={11} />
        <strong>adpilot</strong>
      </div>
      <button type="button" className="nav-sidebar-new" onClick={onNewSession}>
        <span aria-hidden="true">+</span> {copy.newChat}
      </button>
      <nav className="nav-sidebar-nav">
        {items.map((item) => {
          const active = item.key === "projects" ? view === "projects" : view === item.key;
          return (
            <button
              key={item.key}
              type="button"
              className="nav-sidebar-item"
              data-active={active || undefined}
              onClick={() => onNavigate(item.key)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="nav-sidebar-workspaces">
        <span className="nav-sidebar-label">{copy.workspace}</span>
        {clients.map((client) => {
          const active = client.id === clientId;
          return (
            <button
              key={client.id}
              type="button"
              className="nav-sidebar-workspace"
              data-active={active || undefined}
              onClick={() => onSelectClient(client.id)}
            >
              <i aria-hidden="true" data-filled={active || undefined} />
              <span>{client.name}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
