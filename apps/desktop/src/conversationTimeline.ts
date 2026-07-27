import type { ComputerVisualEvent } from "./types.js";

/**
 * Conversation timeline assembly for the desktop conversation feed.
 *
 * The conversation transcript (conversation.jsonl), approval queue,
 * monitoring-alert SSE events, computer-use SSE events, and locally
 * requested insight cards live in separate state slices; this merges them
 * into one chronological feed.
 *
 * Folding rules keep the feed idempotent under SSE bursts:
 * - Alert events arrive as delivery lifecycle transitions (pending →
 *   injected → delivered …) for the same alert, so they fold to the latest
 *   transition per alert id. Alerts bound to a different conversation stay
 *   out of the current feed.
 * - Approvals arrive as one record per approval; folding by id is
 *   defensive, last write wins, so the card always shows the latest status.
 * - Computer-use events are high-frequency visual transitions; when a
 *   session is active they fold into a single live card pinned to the top
 *   of the feed (empty timestamp sorts first).
 */
export interface TimelineFeedEvent {
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
  event?: ComputerVisualEvent;
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

/** Folded view of the live computer-use session for the pinned feed card. */
export interface TimelineComputer {
  /** Latest computer-use event seen (grounded action, screenshot, phase…). */
  latest?: ComputerVisualEvent;
  /** Latest screenshot metadata, if any screenshot event was seen. */
  latestShot?: ComputerVisualEvent["screenshot"];
}

/** A locally answered on-demand card (e.g. /experiments, /audit-trail). */
export interface TimelineInsight {
  id: string;
  kind: "experiments" | "audit";
  at: string;
}

export type TimelineItem<M extends { id: string; at: string }, A extends { id: string } = { id: string }> =
  | { kind: "message"; id: string; at: string; message: M }
  | { kind: "alert"; id: string; at: string; alert: TimelineAlert }
  | { kind: "approval"; id: string; at: string; approval: A }
  | { kind: "computer"; id: string; at: string; computer: TimelineComputer }
  | { kind: "insight"; id: string; at: string; insight: TimelineInsight };

export interface MergeTimelineOptions<A extends { id: string }> {
  approvals?: readonly A[];
  /**
   * Places an approval on the timeline. Return undefined for records with
   * no trustworthy timestamp; they sort before all dated entries (but
   * after the pinned computer card).
   */
  approvalAt?: (approval: A) => string | undefined;
  /** When true, computer-use events fold into one pinned live card. */
  computerActive?: boolean;
  insights?: readonly TimelineInsight[];
}

/** Tie-break order for entries sharing one timestamp. */
const KIND_RANK: Record<TimelineItem<never>["kind"], number> = {
  computer: 0,
  message: 1,
  approval: 2,
  alert: 3,
  insight: 4
};

export function mergeConversationTimeline<M extends { id: string; at: string }, A extends { id: string } = { id: string }>(
  messages: readonly M[],
  events: readonly TimelineFeedEvent[],
  conversationId: string,
  options: MergeTimelineOptions<A> = {}
): TimelineItem<M, A>[] {
  const latestByAlertId = new Map<string, NonNullable<TimelineFeedEvent["alert"]> & { status: string }>();
  let latestComputer: ComputerVisualEvent | undefined;
  let latestShot: ComputerVisualEvent["screenshot"];
  for (const event of events) {
    if (event.type === "alert" && event.alert?.alertId) {
      if (event.conversationId !== undefined && event.conversationId !== conversationId) continue;
      latestByAlertId.set(event.alert.alertId, { ...event.alert, status: event.status ?? "pending" });
    } else if (event.type === "computer" && event.event) {
      latestComputer = event.event;
      if (event.event.type === "screenshot" && event.event.screenshot) latestShot = event.event.screenshot;
    }
  }

  const items: TimelineItem<M, A>[] = messages.map((message) => ({ kind: "message", id: message.id, at: message.at, message }));
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

  const latestByApprovalId = new Map<string, A>();
  for (const approval of options.approvals ?? []) latestByApprovalId.set(approval.id, approval);
  for (const approval of latestByApprovalId.values()) {
    items.push({
      kind: "approval",
      id: `approval-${approval.id}`,
      at: options.approvalAt?.(approval) ?? "",
      approval
    });
  }

  if (options.computerActive) {
    items.push({
      kind: "computer",
      id: "computer-session",
      at: "",
      computer: { ...(latestComputer ? { latest: latestComputer } : {}), ...(latestShot ? { latestShot } : {}) }
    });
  }

  for (const insight of options.insights ?? []) {
    items.push({ kind: "insight", id: insight.id, at: insight.at, insight });
  }

  items.sort((left, right) => left.at.localeCompare(right.at) || KIND_RANK[left.kind] - KIND_RANK[right.kind]);
  return items;
}
