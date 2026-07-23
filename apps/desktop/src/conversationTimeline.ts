/**
 * Conversation timeline assembly for the desktop conversation feed.
 *
 * The conversation transcript (conversation.jsonl) and monitoring-alert SSE
 * events live in separate state slices; this merges them into one
 * chronological feed. Alert events arrive as delivery lifecycle transitions
 * (pending → injected → delivered …) for the same alert, so they are folded
 * to the latest transition per alert id before merging. Alerts bound to a
 * different conversation stay out of the current feed.
 */
export interface AlertFeedEvent {
  type: string;
  status?: string;
  conversationId?: string;
  alert?: {
    alertId: string;
    kind: string;
    severity: string;
    message: string;
    createdAt: string;
    metrics?: unknown[];
  };
}

export interface TimelineAlert {
  alertId: string;
  kind: string;
  severity: string;
  message: string;
  /** Latest delivery transition seen for this alert. */
  status: string;
  createdAt: string;
  metricCount: number;
}

export type TimelineItem<M extends { id: string; at: string }> =
  | { kind: "message"; id: string; at: string; message: M }
  | { kind: "alert"; id: string; at: string; alert: TimelineAlert };

export function mergeConversationTimeline<M extends { id: string; at: string }>(
  messages: readonly M[],
  events: readonly AlertFeedEvent[],
  conversationId: string
): TimelineItem<M>[] {
  const latestByAlertId = new Map<string, NonNullable<AlertFeedEvent["alert"]> & { status: string }>();
  for (const event of events) {
    if (event.type !== "alert" || !event.alert?.alertId) continue;
    if (event.conversationId !== undefined && event.conversationId !== conversationId) continue;
    latestByAlertId.set(event.alert.alertId, { ...event.alert, status: event.status ?? "pending" });
  }
  const items: TimelineItem<M>[] = messages.map((message) => ({ kind: "message", id: message.id, at: message.at, message }));
  for (const alert of latestByAlertId.values()) {
    items.push({
      kind: "alert",
      id: `alert-${alert.alertId}`,
      at: alert.createdAt,
      alert: {
        alertId: alert.alertId,
        kind: alert.kind,
        severity: alert.severity,
        message: alert.message,
        status: alert.status,
        createdAt: alert.createdAt,
        metricCount: Array.isArray(alert.metrics) ? alert.metrics.length : 0
      }
    });
  }
  items.sort((left, right) => left.at.localeCompare(right.at) || (left.kind === right.kind ? 0 : left.kind === "message" ? -1 : 1));
  return items;
}
