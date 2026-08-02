export type StateLoadScope = {
  clientId: string;
  conversationId: string;
};

export type StateLoadTicket = StateLoadScope & {
  requestId: number;
};

/** Exact scope equality for any async UI mutation, not only `/api/state`. */
export function sameStateLoadScope(left: StateLoadScope, right: StateLoadScope): boolean {
  return left.clientId === right.clientId
    && left.conversationId === right.conversationId;
}

/** True only while the EventSource that was opened for a workspace still
 * owns the selected screen. Old connections can deliver one final queued
 * message/error between a React selection update and effect cleanup. */
export function sourceOwnsSelectedClient(sourceClientId: string, selected: StateLoadScope): boolean {
  return sourceClientId === selected.clientId;
}

/** Drop a queued SSE event when its workspace no longer owns the screen. */
export function eventBelongsToSelectedClient(
  eventClientId: string | undefined,
  selected: StateLoadScope,
  sourceClientId = selected.clientId
): boolean {
  return eventClientId !== undefined
    && eventClientId === sourceClientId
    && sourceOwnsSelectedClient(sourceClientId, selected);
}

/**
 * Keeps asynchronous `/api/state` responses scoped to the workspace and
 * conversation that requested them. Requests are ordered per scope: a
 * background refresh for an old scope cannot supersede the current scope,
 * while an older response for the same scope cannot roll back a newer one.
 */
export class StateLoadGuard {
  private selected: StateLoadScope;
  private nextRequestId = 0;
  private readonly latestByScope = new Map<string, number>();

  constructor(initial: StateLoadScope) {
    this.selected = initial;
  }

  select(scope: StateLoadScope): void {
    this.selected = scope;
  }

  selection(): StateLoadScope {
    return this.selected;
  }

  begin(clientId?: string, conversationId?: string): StateLoadTicket {
    const ticket = {
      clientId: clientId ?? this.selected.clientId,
      conversationId: conversationId ?? this.selected.conversationId,
      requestId: ++this.nextRequestId
    };
    this.latestByScope.set(scopeKey(ticket), ticket.requestId);
    return ticket;
  }

  /**
   * `resolvedClientId` covers initial startup, where the request intentionally
   * omits a client and the server selects the first available workspace.
   */
  canCommit(
    ticket: StateLoadTicket,
    resolvedClientId = ticket.clientId,
    resolvedConversationId = ticket.conversationId
  ): boolean {
    if (this.latestByScope.get(scopeKey(ticket)) !== ticket.requestId) return false;
    if (resolvedConversationId !== ticket.conversationId) return false;
    if (this.selected.conversationId !== ticket.conversationId) return false;
    return this.selected.clientId === ""
      ? ticket.clientId === ""
      : this.selected.clientId === resolvedClientId;
  }
}

function scopeKey(scope: StateLoadScope): string {
  return `${scope.clientId}\u0000${scope.conversationId}`;
}
