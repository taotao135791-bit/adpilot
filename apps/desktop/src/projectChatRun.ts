export type ProjectChatRunScope = {
  clientId: string;
  conversationId: string;
};

export type ProjectChatRunTarget = ProjectChatRunScope & {
  /** Unguessable request generation; Stop may affect only this exact run. */
  runId: string;
};

export type ProjectChatProjectScope = ProjectChatRunScope & {
  projectId: string;
  sessionId: string;
};

export type ProjectChatProjectRunTarget = ProjectChatRunTarget & {
  projectId: string;
  sessionId: string;
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

export function sameProjectChatProjectRunRequest(
  left: ProjectChatProjectRunTarget | null,
  right: ProjectChatProjectRunTarget | null
): boolean {
  return sameProjectChatRunRequest(left, right)
    && left?.projectId === right?.projectId
    && left?.sessionId === right?.sessionId;
}

function projectRunBelongsToScope(
  target: ProjectChatProjectRunTarget,
  scope: ProjectChatProjectScope
): boolean {
  return target.clientId === scope.clientId
    && target.projectId === scope.projectId
    && target.sessionId === scope.sessionId
    && target.conversationId === scope.conversationId;
}

/**
 * Exact lifecycle ownership for a Project chat request. A scope cleanup may
 * claim only its own workspace + project + session + conversation + run
 * generation. Once claimed, a late `/api/messages` completion is stale and
 * cannot commit.
 */
export class ProjectChatRunLifecycle {
  private active: ProjectChatProjectRunTarget | null = null;

  start(target: ProjectChatProjectRunTarget): void {
    this.active = target;
  }

  current(): ProjectChatProjectRunTarget | null {
    return this.active;
  }

  owns(target: ProjectChatProjectRunTarget): boolean {
    return sameProjectChatProjectRunRequest(this.active, target);
  }

  complete(target: ProjectChatProjectRunTarget): boolean {
    if (!this.owns(target)) return false;
    this.active = null;
    return true;
  }

  claimForScopeExit(scope: ProjectChatProjectScope): ProjectChatProjectRunTarget | null {
    const target = this.active;
    if (!target || !projectRunBelongsToScope(target, scope)) return null;
    this.active = null;
    return target;
  }
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

export function projectChatCleanupStopRequest(target: ProjectChatProjectRunTarget): RequestInit {
  return {
    ...projectChatStopRequest(target),
    keepalive: true
  };
}

export function shouldSubmitProjectChatKey(event: { key: string; isComposing: boolean; keyCode?: number }): boolean {
  return event.key === "Enter" && !event.isComposing && event.keyCode !== 229;
}
