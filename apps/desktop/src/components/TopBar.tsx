import type { ConsoleCopy } from "../labels.js";
import type { Client } from "../types.js";
import { Button, Tooltip } from "../ui.js";
import { IconChat, IconChevronDown, IconHelp, IconLedger, IconSettings, IconShieldCheck, IconTarget } from "../icons.js";

export type NavTarget = "mission" | "tests" | "review" | "ledger";

export function TopBar({ copy, clients, clientId, chatConfigured, onSelectClient, onOpenSettings }: {
  copy: ConsoleCopy;
  clients: Client[];
  clientId: string;
  chatConfigured: boolean;
  onSelectClient: (clientId: string) => void;
  onOpenSettings: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-glyph" aria-hidden="true">AP</span>
        <div className="brand-text">
          <strong>AdPilot</strong>
          <small>{copy.brandLine}</small>
        </div>
      </div>
      <div className="workspace-switcher">
        <span className="status-dot" data-live={Boolean(clientId)} aria-hidden="true" />
        <label htmlFor="client-select">{copy.workspace}</label>
        {clients.length ? (
          <div className="select-wrap">
            <select id="client-select" value={clientId} onChange={(event) => onSelectClient(event.target.value)}>
              {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
            </select>
            <IconChevronDown size={12} />
          </div>
        ) : <strong>{copy.noWorkspace}</strong>}
      </div>
      <div className="top-status">
        <span className="live-label"><i data-ready={chatConfigured} aria-hidden="true" />{chatConfigured ? copy.conversationReady : copy.modelRequired}</span>
        <Tooltip content={copy.settings} side="bottom">
          <Button variant="subtle" className="icon-button" icon={<IconSettings size={17} />} aria-label={copy.settings} onClick={onOpenSettings} />
        </Tooltip>
      </div>
    </header>
  );
}

export function NavRail({ copy, testsCount, reviewCount, ledgerCount, onNavigate, onOpenAbout }: {
  copy: ConsoleCopy;
  testsCount: number;
  reviewCount: number;
  ledgerCount: number;
  onNavigate: (target: NavTarget) => void;
  onOpenAbout: () => void;
}) {
  return (
    <aside className="sidebar">
      <nav aria-label={copy.navigation}>
        <NavItem icon={<IconChat size={17} />} label={copy.mission} active onClick={() => onNavigate("mission")} />
        <NavItem icon={<IconTarget size={17} />} label={copy.tests} count={testsCount} onClick={() => onNavigate("tests")} />
        <NavItem icon={<IconShieldCheck size={17} />} label={copy.review} count={reviewCount} onClick={() => onNavigate("review")} />
        <NavItem icon={<IconLedger size={17} />} label={copy.ledger} count={ledgerCount} onClick={() => onNavigate("ledger")} />
      </nav>
      <Tooltip content={copy.settings} side="right">
        <button className="dock-help" onClick={onOpenAbout} aria-label={copy.settings}>
          <IconHelp size={14} />
        </button>
      </Tooltip>
    </aside>
  );
}

function NavItem({ icon, label, count, active = false, onClick }: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`nav-item${active ? " active" : ""}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {count !== undefined && count > 0 && <b>{count}</b>}
    </button>
  );
}
