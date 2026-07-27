import type { ConsoleCopy } from "../labels.js";
import type { Client } from "../types.js";
import { Button, Tooltip } from "../ui.js";
import { IconChevronDown, IconMenu, IconPlus, IconSettings, IconShieldCheck } from "../icons.js";

/**
 * Codex-skeleton sidebar: product lockup and the primary "new conversation"
 * action on top, the conversation history (newest first, current
 * highlighted) in the middle, and the workspace switcher, pending-approval
 * badge, and settings entry at the bottom. Collapses to a 60px icon rail;
 * the collapsed state is persisted by the parent (localStorage).
 *
 * Conversation ids arrive in server order (first appearance in the message
 * log, oldest first) — the sidebar reverses them for display so the most
 * recent conversation leads the list.
 */
export function Sidebar({ copy, clients, clientId, conversations, conversationId, pendingApprovals, collapsed, onToggleCollapsed, onNewConversation, onSelectConversation, onSelectClient, onJumpToApprovals, onOpenSettings }: {
  copy: ConsoleCopy;
  clients: Client[];
  clientId: string;
  conversations: string[];
  conversationId: string;
  pendingApprovals: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNewConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onSelectClient: (clientId: string) => void;
  onJumpToApprovals: () => void;
  onOpenSettings: () => void;
}) {
  const ordered = [...conversations].reverse();
  const collapseLabel = collapsed ? copy.expandSidebar : copy.collapseSidebar;
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

      <Button variant="primary" className="new-chat" icon={<IconPlus size={14} />} onClick={onNewConversation}>
        <span className="new-chat-label">{copy.newChat}</span>
      </Button>

      {!collapsed && (
        <nav className="sidebar-nav" aria-label={copy.conversation}>
          <span className="sidebar-label">{copy.conversation}</span>
          <ul>
            {ordered.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  className={`conversation-item${id === conversationId ? " active" : ""}`}
                  aria-current={id === conversationId ? "true" : undefined}
                  onClick={() => onSelectConversation(id)}
                >
                  {id === "primary" ? copy.primaryConversation : id}
                </button>
              </li>
            ))}
          </ul>
        </nav>
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
              </select>
              <IconChevronDown size={12} />
            </div>
          </div>
        )}
        <Tooltip content={copy.settings} side={collapsed ? "right" : "top"}>
          <Button variant="subtle" className="icon-button" icon={<IconSettings size={17} />} aria-label={copy.settings} onClick={onOpenSettings} />
        </Tooltip>
      </div>
    </aside>
  );
}
