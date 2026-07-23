import { describe, expect, it } from "vitest";
import { mergeConversationTimeline, type AlertFeedEvent } from "./conversationTimeline.js";

interface TestMessage { id: string; role: "user" | "assistant" | "system"; content: string; at: string }

function message(id: string, role: TestMessage["role"], at: string): TestMessage {
  return { id, role, content: `${role}-${id}`, at };
}

function alertEvent(alertId: string, status: string, createdAt: string, options: { conversationId?: string; severity?: string; kind?: string; metricCount?: number } = {}): AlertFeedEvent {
  return {
    type: "alert",
    status,
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    alert: {
      alertId,
      kind: options.kind ?? "budget_overspend",
      severity: options.severity ?? "warning",
      message: `alert ${alertId}`,
      createdAt,
      metrics: Array.from({ length: options.metricCount ?? 0 }, () => ({}))
    }
  };
}

describe("mergeConversationTimeline", () => {
  it("merges messages and alerts chronologically with messages first on ties", () => {
    const timeline = mergeConversationTimeline(
      [message("m1", "user", "2026-07-22T08:00:00.000Z"), message("m3", "assistant", "2026-07-22T09:00:00.000Z")],
      [alertEvent("a2", "pending", "2026-07-22T08:30:00.000Z"), alertEvent("a1", "pending", "2026-07-22T09:00:00.000Z")],
      "primary"
    );
    expect(timeline.map((item) => item.id)).toEqual(["m1", "alert-a2", "m3", "alert-a1"]);
    expect(timeline[1]).toMatchObject({ kind: "alert", alert: { alertId: "a2", status: "pending", severity: "warning", kind: "budget_overspend" } });
  });

  it("folds repeated lifecycle events for the same alert into the latest transition", () => {
    const timeline = mergeConversationTimeline(
      [],
      [
        alertEvent("a1", "pending", "2026-07-22T08:00:00.000Z"),
        alertEvent("a1", "injected", "2026-07-22T08:00:00.000Z"),
        alertEvent("a1", "delivered", "2026-07-22T08:00:00.000Z")
      ],
      "primary"
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "alert", id: "alert-a1", alert: { status: "delivered", metricCount: 0 } });
  });

  it("keeps alerts addressed to another conversation out of the current feed", () => {
    const timeline = mergeConversationTimeline(
      [message("m1", "user", "2026-07-22T08:00:00.000Z")],
      [
        alertEvent("a1", "delivered", "2026-07-22T08:01:00.000Z", { conversationId: "fork-12345678" }),
        alertEvent("a2", "delivered", "2026-07-22T08:02:00.000Z", { conversationId: "primary" }),
        alertEvent("a3", "pending", "2026-07-22T08:03:00.000Z")
      ],
      "primary"
    );
    expect(timeline.map((item) => item.id)).toEqual(["m1", "alert-a2", "alert-a3"]);
  });

  it("ignores non-alert events and alert events without a payload", () => {
    const timeline = mergeConversationTimeline(
      [],
      [{ type: "task", status: "running" }, { type: "alert", status: "pending" }, { type: "computer" }],
      "primary"
    );
    expect(timeline).toEqual([]);
  });

  it("counts attached metric snapshots", () => {
    const timeline = mergeConversationTimeline([], [alertEvent("a1", "pending", "2026-07-22T08:00:00.000Z", { metricCount: 3 })], "primary");
    expect(timeline[0]).toMatchObject({ kind: "alert", alert: { metricCount: 3 } });
  });
});
