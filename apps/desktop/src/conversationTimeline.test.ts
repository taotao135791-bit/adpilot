import { describe, expect, it } from "vitest";
import {
  mergeConversationTimeline,
  type TimelineFeedEvent,
  type TimelineInsight
} from "./conversationTimeline.js";

interface TestMessage { id: string; role: "user" | "assistant" | "system"; content: string; at: string }
interface TestApproval { id: string; status: string; createdAt?: string }

function message(id: string, role: TestMessage["role"], at: string): TestMessage {
  return { id, role, content: `${role}-${id}`, at };
}

function alertEvent(alertId: string, status: string, createdAt: string, options: { conversationId?: string; severity?: string; kind?: string; metricCount?: number } = {}): TimelineFeedEvent {
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

function computerEvent(event: NonNullable<TimelineFeedEvent["event"]>, taskId?: string): TimelineFeedEvent {
  return { type: "computer", event, ...(taskId ? { taskId } : {}) };
}

function approval(id: string, status: string, createdAt?: string): TestApproval {
  return { id, status, ...(createdAt ? { createdAt } : {}) };
}

function insight(id: string, kind: TimelineInsight["kind"], at: string): TimelineInsight {
  return { id, kind, at };
}

const approvalAt = (item: TestApproval) => item.createdAt;

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

  it("inserts approvals by creation time between messages and alerts", () => {
    const timeline = mergeConversationTimeline(
      [message("m1", "user", "2026-07-22T08:00:00.000Z"), message("m2", "assistant", "2026-07-22T09:00:00.000Z")],
      [alertEvent("a1", "delivered", "2026-07-22T08:45:00.000Z")],
      "primary",
      {
        approvals: [approval("ap1", "pending_user", "2026-07-22T08:30:00.000Z")],
        approvalAt
      }
    );
    expect(timeline.map((item) => item.id)).toEqual(["m1", "approval-ap1", "alert-a1", "m2"]);
    expect(timeline[1]).toMatchObject({ kind: "approval", approval: { id: "ap1", status: "pending_user" } });
  });

  it("folds duplicate approval records to the latest status", () => {
    const timeline = mergeConversationTimeline(
      [],
      [],
      "primary",
      {
        approvals: [
          approval("ap1", "pending_user", "2026-07-22T08:30:00.000Z"),
          approval("ap1", "executed", "2026-07-22T08:30:00.000Z")
        ],
        approvalAt
      }
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "approval", id: "approval-ap1", approval: { status: "executed" } });
  });

  it("orders message, approval and alert deterministically on timestamp ties", () => {
    const at = "2026-07-22T08:00:00.000Z";
    const timeline = mergeConversationTimeline(
      [message("m1", "assistant", at)],
      [alertEvent("a1", "delivered", at)],
      "primary",
      { approvals: [approval("ap1", "pending_user", at)], approvalAt }
    );
    expect(timeline.map((item) => item.id)).toEqual(["m1", "approval-ap1", "alert-a1"]);
  });

  it("sorts approvals without a timestamp before dated entries but after the computer card", () => {
    const timeline = mergeConversationTimeline(
      [message("m1", "user", "2026-07-22T08:00:00.000Z")],
      [],
      "primary",
      { approvals: [approval("ap1", "pending_user")], approvalAt, computerActive: true }
    );
    expect(timeline.map((item) => item.id)).toEqual(["computer-session", "approval-ap1", "m1"]);
  });

  it("omits the computer card while the session is idle", () => {
    const timeline = mergeConversationTimeline(
      [message("m1", "user", "2026-07-22T08:00:00.000Z")],
      [computerEvent({ type: "grounded", action: { action: "click", target: "预算输入框", reason: "定位控件" } })],
      "primary"
    );
    expect(timeline.map((item) => item.id)).toEqual(["m1"]);
  });

  it("folds computer-use bursts into one pinned card with the latest event and screenshot", () => {
    const timeline = mergeConversationTimeline(
      [message("m1", "user", "2026-07-22T08:00:00.000Z")],
      [
        computerEvent({ type: "grounded", action: { action: "click", target: "旧目标", reason: "第一步" } }),
        computerEvent({ type: "screenshot", screenshot: { width: 1440, height: 900, capturedAt: "2026-07-22T08:01:00.000Z", sha256: "a" } }),
        computerEvent({ type: "grounded", action: { action: "type", target: "新目标", reason: "第二步" } })
      ],
      "primary",
      { computerActive: true }
    );
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({
      kind: "computer",
      id: "computer-session",
      at: "",
      computer: {
        latest: { type: "grounded", action: { action: "type", target: "新目标" } },
        latestShot: { width: 1440, capturedAt: "2026-07-22T08:01:00.000Z" }
      }
    });
    expect(timeline[1]).toMatchObject({ kind: "message", id: "m1" });
  });

  it("keeps the pinned computer card even before any visual event arrives", () => {
    const timeline = mergeConversationTimeline([], [], "primary", { computerActive: true });
    expect(timeline).toEqual([{ kind: "computer", id: "computer-session", at: "", computer: {} }]);
  });

  it("does not overlay another Product Session's Computer task on the bound Live View", () => {
    const timeline = mergeConversationTimeline(
      [],
      [
        computerEvent({ type: "grounded", action: { action: "click", target: "other Session", reason: "wrong surface" } }, "task-other"),
        computerEvent({ type: "grounded", action: { action: "click", target: "selected Session", reason: "right surface" } }, "task-selected")
      ],
      "primary",
      { computerActive: true, computerTaskIds: ["task-selected"] }
    );
    expect(timeline[0]).toMatchObject({
      kind: "computer",
      computer: { latest: { action: { target: "selected Session" } } }
    });
  });

  it("merges on-demand insight cards chronologically", () => {
    const timeline = mergeConversationTimeline(
      [message("m1", "user", "2026-07-22T08:00:00.000Z"), message("m2", "assistant", "2026-07-22T09:00:00.000Z")],
      [],
      "primary",
      { insights: [insight("insight-1", "experiments", "2026-07-22T08:30:00.000Z"), insight("insight-2", "audit", "2026-07-22T09:30:00.000Z")] }
    );
    expect(timeline.map((item) => item.id)).toEqual(["m1", "insight-1", "m2", "insight-2"]);
    expect(timeline[1]).toMatchObject({ kind: "insight", insight: { kind: "experiments" } });
  });
});
