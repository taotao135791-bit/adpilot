import { describe, expect, it } from "vitest";
import {
  eventBelongsToSelectedClient,
  sameStateLoadScope,
  sourceOwnsSelectedClient,
  StateLoadGuard
} from "../apps/desktop/src/stateLoadGuard.js";

describe("desktop state load guard", () => {
  it("rejects an old conversation response after the user switches conversations", () => {
    const guard = new StateLoadGuard({ clientId: "client-a", conversationId: "old" });
    const oldRequest = guard.begin();
    guard.select({ clientId: "client-a", conversationId: "new" });
    const newRequest = guard.begin();

    expect(guard.canCommit(newRequest)).toBe(true);
    expect(guard.canCommit(oldRequest)).toBe(false);
  });

  it("rejects an old workspace response even when it resolves after the new workspace", () => {
    const guard = new StateLoadGuard({ clientId: "client-a", conversationId: "primary" });
    const oldRequest = guard.begin();
    guard.select({ clientId: "client-b", conversationId: "primary" });
    const newRequest = guard.begin();

    expect(guard.canCommit(newRequest)).toBe(true);
    expect(guard.canCommit(oldRequest)).toBe(false);
  });

  it("only accepts the newest response within one scope", () => {
    const guard = new StateLoadGuard({ clientId: "client-a", conversationId: "primary" });
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.canCommit(first)).toBe(false);
    expect(guard.canCommit(second)).toBe(true);
  });

  it("rejects a response whose server conversation identity does not match the request", () => {
    const guard = new StateLoadGuard({ clientId: "client-a", conversationId: "expected" });
    const request = guard.begin();
    expect(guard.canCommit(request, "client-a", "other")).toBe(false);
  });

  it("allows startup to adopt the server-selected workspace without weakening later checks", () => {
    const guard = new StateLoadGuard({ clientId: "", conversationId: "primary" });
    const startup = guard.begin();
    expect(guard.canCommit(startup, "client-a")).toBe(true);

    guard.select({ clientId: "client-a", conversationId: "primary" });
    expect(guard.canCommit(startup, "client-a")).toBe(true);
    expect(guard.canCommit(startup, "client-b")).toBe(false);
  });

  it("drops a queued SSE event after the selected workspace changes", () => {
    const selected = { clientId: "client-b", conversationId: "primary" };
    expect(eventBelongsToSelectedClient("client-a", selected)).toBe(false);
    expect(eventBelongsToSelectedClient(undefined, selected)).toBe(false);
    expect(eventBelongsToSelectedClient("client-b", selected)).toBe(true);
  });

  it("requires both the event and its source connection to own the selected workspace", () => {
    const selected = { clientId: "client-b", conversationId: "primary" };
    expect(sourceOwnsSelectedClient("client-a", selected)).toBe(false);
    expect(sourceOwnsSelectedClient("client-b", selected)).toBe(true);
    expect(eventBelongsToSelectedClient("client-b", selected, "client-a")).toBe(false);
    expect(eventBelongsToSelectedClient("client-b", selected, "client-b")).toBe(true);
  });

  it("compares async mutation ownership by exact client and conversation", () => {
    const launched = { clientId: "client-a", conversationId: "conversation-a" };
    expect(sameStateLoadScope(launched, launched)).toBe(true);
    expect(sameStateLoadScope(launched, { clientId: "client-a", conversationId: "conversation-b" })).toBe(false);
    expect(sameStateLoadScope(launched, { clientId: "client-b", conversationId: "conversation-a" })).toBe(false);
  });
});
