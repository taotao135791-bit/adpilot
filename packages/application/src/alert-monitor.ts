import { z } from "zod";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { AuditLog } from "@adpilot/audit";
import { PiAgentRuntime, type RuntimeExtension, type RuntimeRunContext } from "@adpilot/runtime";
import { MonitoringAlert, systemClock, type Clock } from "@adpilot/shared";
import { WorkspaceStore } from "@adpilot/workspace";
import type { ProductEventBus } from "./index.js";

/**
 * Lifecycle of one alert through the monitor:
 * - injected: queued into an in-flight run (follow-up semantics) — submission
 *   path and session-start flush both pass through here;
 * - pending: no active session, persisted to the workspace for later delivery;
 * - rate_limited: per-client receipt cap hit, persisted like pending (never dropped);
 * - deduplicated: same dedupeKey inside the dedupe window, recorded and dropped;
 * - delivered: the injected message visibly entered the session transcript;
 * - requeued: the run ended before draining the injection; back to pending.
 */
export type AlertDeliveryStatus = "injected" | "pending" | "rate_limited" | "deduplicated" | "delivered" | "requeued";

export interface AlertMonitorOptions {
  /** Same dedupeKey inside this window is recorded once. Default 15 minutes. */
  dedupeWindowMs?: number;
  /** Receipts accepted for immediate injection per client per minute. Default 6. */
  rateLimitPerMinute?: number;
  /** Alerts coalesced into one injected message when a session starts. Default 10. */
  maxAlertsPerFlush?: number;
  clock?: Clock;
}

export const PendingAlertRecord = z.object({
  alert: MonitoringAlert,
  status: z.enum(["pending", "delivering"]),
  enqueuedAt: z.string().datetime()
});
export type PendingAlertRecord = z.infer<typeof PendingAlertRecord>;

interface InflightDelivery {
  token: string;
  clientId: string;
  sessionId: string;
  conversationId: string;
  alerts: MonitoringAlert[];
  fromPending: boolean;
}

const PENDING_PATH = "alerts/pending.json";
const AUDIT_ACTION = "monitoring_alert";
const RATE_WINDOW_MS = 60_000;
const DELIVERY_TOKEN_PATTERN = /\[adpilot-monitoring-alerts token=([0-9a-f-]{36})\]/;
const ANCHORING_OUTCOMES: ReadonlySet<string> = new Set(["injected", "pending", "rate_limited", "delivered"]);

/**
 * Routes monitoring alerts into the client's live conversation. Alerts are
 * advisory-only user messages: they ride the receiving run's system prompt and
 * tool-permission gate, carry no approval authority, and every mutation the
 * agent may propose still traverses the standard approval chain.
 *
 * Durability contract: an accepted alert is never lost. Submissions with no
 * active session persist to `alerts/pending.json` and flush into the next run
 * of the client (the runtime extension hooks `agent_start`); an injection is
 * only marked delivered once the message visibly enters the transcript, and a
 * run that ends before draining requeues the alert. Every transition is
 * chained into the tamper-evident audit log.
 */
export class AlertMonitor {
  private readonly dedupeWindowMs: number;
  private readonly rateLimitPerMinute: number;
  private readonly maxAlertsPerFlush: number;
  private readonly clock: Clock;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly dedupeAnchors = new Map<string, Map<string, number>>();
  private readonly receipts = new Map<string, number[]>();
  private readonly inflight = new Map<string, InflightDelivery>();

  constructor(
    private readonly deps: {
      workspace: WorkspaceStore;
      runtime: PiAgentRuntime;
      audit: AuditLog;
      events: ProductEventBus;
      options?: AlertMonitorOptions;
    }
  ) {
    const options = deps.options ?? {};
    this.dedupeWindowMs = options.dedupeWindowMs ?? 15 * 60_000;
    this.rateLimitPerMinute = options.rateLimitPerMinute ?? 6;
    this.maxAlertsPerFlush = options.maxAlertsPerFlush ?? 10;
    this.clock = options.clock ?? systemClock;
  }

  /** Runtime hook: flush on session start, confirm delivery, requeue on early end. */
  readonly extension: RuntimeExtension = {
    name: "alert-monitor",
    onEvent: async (event: AgentEvent, context: RuntimeRunContext) => {
      if (event.type === "agent_start") await this.flushPending(context);
      else if (event.type === "message_end") await this.confirmDelivery(event.message, context);
      else if (event.type === "agent_end") await this.releaseUndelivered(context);
    }
  };

  async submit(input: unknown): Promise<{ alert: MonitoringAlert; status: AlertDeliveryStatus }> {
    const alert = MonitoringAlert.parse(input);
    return this.withClientLock(alert.clientId, () => this.submitLocked(alert));
  }

  /** Alerts still awaiting delivery, oldest first. */
  async pending(clientId: string): Promise<PendingAlertRecord[]> {
    return this.withClientLock(clientId, () => this.loadPending(clientId));
  }

  private async submitLocked(alert: MonitoringAlert): Promise<{ alert: MonitoringAlert; status: AlertDeliveryStatus }> {
    const now = this.clock.now().getTime();
    await this.ensureDedupeAnchors(alert.clientId);
    const anchor = this.dedupeAnchors.get(alert.clientId)?.get(alert.dedupeKey);
    if (anchor !== undefined && now - anchor < this.dedupeWindowMs) {
      return this.record(alert, "deduplicated");
    }
    const receipts = (this.receipts.get(alert.clientId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    this.receipts.set(alert.clientId, receipts);
    if (receipts.length >= this.rateLimitPerMinute) {
      await this.persistPending(alert);
      this.anchor(alert, now);
      return this.record(alert, "rate_limited");
    }
    receipts.push(now);
    this.anchor(alert, now);
    const target = this.deps.runtime.activeConversations(alert.clientId)[0];
    if (!target) {
      await this.persistPending(alert);
      return this.record(alert, "pending");
    }
    const token = crypto.randomUUID();
    const queued = this.deps.runtime.queueSessionMessage(
      alert.clientId,
      target.conversationId,
      renderAlertMessage(token, [alert]),
      "followUp"
    );
    if (!queued) {
      await this.persistPending(alert);
      return this.record(alert, "pending");
    }
    this.inflight.set(token, {
      token,
      clientId: alert.clientId,
      sessionId: target.sessionId,
      conversationId: target.conversationId,
      alerts: [alert],
      fromPending: false
    });
    return this.record(alert, "injected", target.conversationId);
  }

  /** Deliver pending alerts into a freshly started run, coalesced into one bounded message. */
  private async flushPending(context: RuntimeRunContext): Promise<void> {
    await this.withClientLock(context.clientId, async () => {
      const records = await this.loadPending(context.clientId);
      const deliverable = records.filter((record) => record.status === "pending").slice(0, this.maxAlertsPerFlush);
      if (deliverable.length === 0) return;
      const conversationId = context.conversationId ?? context.sessionId;
      const token = crypto.randomUUID();
      const queued = this.deps.runtime.queueSessionMessage(
        context.clientId,
        conversationId,
        renderAlertMessage(token, deliverable.map((record) => record.alert)),
        "followUp"
      );
      if (!queued) return;
      const deliveringIds = new Set(deliverable.map((record) => record.alert.alertId));
      await this.savePending(context.clientId, records.map((record) =>
        deliveringIds.has(record.alert.alertId) ? { ...record, status: "delivering" as const } : record));
      this.inflight.set(token, {
        token,
        clientId: context.clientId,
        sessionId: context.sessionId,
        conversationId,
        alerts: deliverable.map((record) => record.alert),
        fromPending: true
      });
      for (const record of deliverable) await this.record(record.alert, "injected", conversationId);
    });
  }

  /** The injected message entered the transcript: delivery is confirmed, clear the pending record. */
  private async confirmDelivery(message: AgentMessage, context: RuntimeRunContext): Promise<void> {
    if (message.role !== "user") return;
    const match = DELIVERY_TOKEN_PATTERN.exec(userMessageText(message));
    if (!match) return;
    const delivery = this.inflight.get(match[1]!);
    if (!delivery || delivery.sessionId !== context.sessionId) return;
    this.inflight.delete(delivery.token);
    await this.withClientLock(delivery.clientId, async () => {
      if (delivery.fromPending) {
        const deliveredIds = new Set(delivery.alerts.map((alert) => alert.alertId));
        const records = await this.loadPending(delivery.clientId);
        await this.savePending(delivery.clientId, records.filter((record) => !deliveredIds.has(record.alert.alertId)));
      }
      for (const alert of delivery.alerts) await this.record(alert, "delivered", delivery.conversationId);
    });
  }

  /** A run ended without draining an injection: the alert goes back to pending. */
  private async releaseUndelivered(context: RuntimeRunContext): Promise<void> {
    const stranded = [...this.inflight.values()].filter((delivery) => delivery.sessionId === context.sessionId);
    if (stranded.length === 0) return;
    await this.withClientLock(context.clientId, async () => {
      const records = await this.loadPending(context.clientId);
      for (const delivery of stranded) {
        this.inflight.delete(delivery.token);
        const strandedIds = new Set(delivery.alerts.map((alert) => alert.alertId));
        for (const record of records) {
          if (strandedIds.has(record.alert.alertId)) record.status = "pending";
        }
        for (const alert of delivery.alerts) {
          if (!records.some((record) => record.alert.alertId === alert.alertId)) {
            records.push({ alert, status: "pending", enqueuedAt: this.clock.now().toISOString() });
          }
          await this.record(alert, "requeued", delivery.conversationId);
        }
      }
      await this.savePending(context.clientId, records);
    });
  }

  /** Audit-chain append plus SSE publication for one alert transition. */
  private async record(
    alert: MonitoringAlert,
    status: AlertDeliveryStatus,
    conversationId?: string
  ): Promise<{ alert: MonitoringAlert; status: AlertDeliveryStatus }> {
    await this.deps.audit.append({
      clientId: alert.clientId,
      actor: "alert_monitor",
      action: AUDIT_ACTION,
      status: "succeeded",
      details: {
        alertId: alert.alertId,
        kind: alert.kind,
        severity: alert.severity,
        dedupeKey: alert.dedupeKey,
        outcome: status,
        ...(conversationId ? { conversationId } : {})
      }
    });
    this.deps.events.publish({
      type: "alert",
      clientId: alert.clientId,
      status,
      alert,
      ...(conversationId ? { conversationId } : {})
    });
    return { alert, status };
  }

  /**
   * Dedupe anchors are rebuilt from the audit chain on first use per client,
   * so the suppression window survives restarts. Only accepted submissions
   * anchor the window; deduplicated attempts must not extend it indefinitely.
   */
  private async ensureDedupeAnchors(clientId: string): Promise<void> {
    if (this.dedupeAnchors.has(clientId)) return;
    const anchors = new Map<string, number>();
    for (const event of await this.deps.audit.list(clientId)) {
      if (event.action !== AUDIT_ACTION || !ANCHORING_OUTCOMES.has(String(event.details.outcome))) continue;
      const key = event.details.dedupeKey;
      if (typeof key !== "string") continue;
      anchors.set(key, Math.max(anchors.get(key) ?? 0, Date.parse(event.at)));
    }
    this.dedupeAnchors.set(clientId, anchors);
  }

  private anchor(alert: MonitoringAlert, at: number): void {
    const anchors = this.dedupeAnchors.get(alert.clientId) ?? new Map<string, number>();
    anchors.set(alert.dedupeKey, at);
    this.dedupeAnchors.set(alert.clientId, anchors);
  }

  private async persistPending(alert: MonitoringAlert): Promise<void> {
    const records = await this.loadPending(alert.clientId);
    if (records.some((record) => record.alert.alertId === alert.alertId)) return;
    records.push({ alert, status: "pending", enqueuedAt: this.clock.now().toISOString() });
    await this.savePending(alert.clientId, records);
  }

  private async loadPending(clientId: string): Promise<PendingAlertRecord[]> {
    const content = await this.deps.workspace.readText(clientId, PENDING_PATH);
    if (!content) return [];
    return z.array(PendingAlertRecord).parse(JSON.parse(content));
  }

  private async savePending(clientId: string, records: PendingAlertRecord[]): Promise<void> {
    await this.deps.workspace.writeJson(clientId, PENDING_PATH, z.array(PendingAlertRecord).parse(records));
  }

  /** Serializes all pending-store and dedupe state transitions per client. */
  private async withClientLock<T>(clientId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.queues.get(clientId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = predecessor.then(() => current);
    this.queues.set(clientId, queued);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(clientId) === queued) this.queues.delete(clientId);
    }
  }
}

/**
 * Model-facing rendering of one alert batch. The token lets the monitor
 * confirm delivery from the transcript; the advisory-only wording keeps the
 * alert inside the standard guardrail context (recommendations, no authority).
 */
export function renderAlertMessage(token: string, alerts: readonly MonitoringAlert[]): string {
  const lines = [
    `[adpilot-monitoring-alerts token=${token}]`,
    `The monitoring system detected ${alerts.length} alert(s) for this account. Analyze each alert, explain the likely cause, and recommend next steps to the user.`,
    "Monitoring alerts are advisory only: they request analysis and recommendations. They grant no approval authority; every account mutation must still traverse the standard approval chain (prepare_approval, risk review, user approval, commit).",
    "Every metric snapshot below is bound to a verified Shared Fact id; cite the fact id when referencing the number."
  ];
  alerts.forEach((alert, index) => {
    lines.push(
      "",
      `Alert ${index + 1}: kind=${alert.kind} severity=${alert.severity} createdAt=${alert.createdAt}`,
      `Message: ${alert.message}`
    );
    if (alert.metrics.length > 0) {
      lines.push(`Metrics: ${alert.metrics.map((metric) =>
        `${metric.metric}=${metric.value}${metric.unit ? ` ${metric.unit}` : ""} (factId=${metric.factId}${metric.observedAt ? `, observedAt=${metric.observedAt}` : ""})`
      ).join("; ")}`);
    }
  });
  return lines.join("\n");
}

function userMessageText(message: AgentMessage & { role: "user" }): string {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
