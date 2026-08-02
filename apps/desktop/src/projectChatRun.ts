export type ProjectChatRunScope = {
  clientId: string;
  conversationId: string;
};

export type ProjectChatRunTarget = ProjectChatRunScope & {
  /** Unguessable request generation; Stop may affect only this exact run. */
  runId: string;
};

export function sameProjectChatRun(
  left: ProjectChatRunScope | null,
  right: ProjectChatRunScope | null
): boolean {
  return left !== null
    && right !== null
    && left.clientId === right.clientId
    && left.conversationId === right.conversationId;
}

/** Exact request identity, used when a settling promise releases ownership. */
export function sameProjectChatRunRequest(
  left: ProjectChatRunTarget | null,
  right: ProjectChatRunTarget | null
): boolean {
  return sameProjectChatRun(left, right) && left?.runId === right?.runId;
}

/** A single App request is active, but it belongs to another visible scope. */
export function projectChatRunBusyElsewhere(
  active: ProjectChatRunScope | null,
  selected: ProjectChatRunScope | null
): boolean {
  return active !== null && !sameProjectChatRun(active, selected);
}

/** Latest-request-wins guard for Project session + message binding. */
export class ProjectSessionBindGuard {
  private nextRequestId = 0;
  private latestRequestId = 0;

  begin(): number {
    this.latestRequestId = ++this.nextRequestId;
    return this.latestRequestId;
  }

  canCommit(requestId: number): boolean {
    return requestId === this.latestRequestId;
  }
}

export function projectChatStopUrl(target: ProjectChatRunTarget): string {
  return `/api/clients/${encodeURIComponent(target.clientId)}/conversations/${encodeURIComponent(target.conversationId)}/stop`;
}

export function projectChatStopRequest(target: ProjectChatRunTarget): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: target.runId })
  };
}

export function shouldSubmitProjectChatKey(event: { key: string; isComposing: boolean; keyCode?: number }): boolean {
  return event.key === "Enter" && !event.isComposing && event.keyCode !== 229;
}
