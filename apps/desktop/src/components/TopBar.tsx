import type { ConsoleCopy } from "../labels.js";
import type { Client } from "../types.js";
import { Button, Tooltip } from "../ui.js";
import { IconChevronDown, IconSettings, IconShieldCheck } from "../icons.js";

/**
 * Product chrome, kept to three jobs: workspace switching, the pending-
 * approval badge (scrolls to the oldest open approval card in the feed),
 * and the settings entry. Model readiness is intentionally not reported
 * here — it appears as an in-feed banner only when chat is unconfigured.
 */
export function TopBar({ copy, clients, clientId, pendingApprovals, onSelectClient, onJumpToApprovals, onOpenSettings }: {
  copy: ConsoleCopy;
  clients: Client[];
  clientId: string;
  pendingApprovals: number;
  onSelectClient: (clientId: string) => void;
  onJumpToApprovals: () => void;
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
        {pendingApprovals > 0 && (
          <Tooltip content={copy.jumpToApproval} side="bottom">
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
        <Tooltip content={copy.settings} side="bottom">
          <Button variant="subtle" className="icon-button" icon={<IconSettings size={17} />} aria-label={copy.settings} onClick={onOpenSettings} />
        </Tooltip>
      </div>
    </header>
  );
}
