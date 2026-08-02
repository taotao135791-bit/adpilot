import { describe, expect, it } from "vitest";
import {
  projectChatRunBusyElsewhere,
  projectChatStopRequest,
  projectChatStopUrl,
  ProjectSessionBindGuard,
  sameProjectChatRun,
  sameProjectChatRunRequest,
  shouldSubmitProjectChatKey
} from "../apps/desktop/src/projectChatRun.js";
import { buildProjectMessageRequest } from "../apps/desktop/src/workspace.js";

describe("project chat run targeting", () => {
  it("matches running state only to its launch workspace and conversation", () => {
    const launched = { clientId: "client-a", conversationId: "conversation-a", runId: crypto.randomUUID() };
    expect(sameProjectChatRun(launched, launched)).toBe(true);
    expect(sameProjectChatRun(launched, { clientId: "client-a", conversationId: "conversation-b" })).toBe(false);
    expect(sameProjectChatRun(launched, { clientId: "client-b", conversationId: "conversation-a" })).toBe(false);
    expect(sameProjectChatRunRequest(launched, { ...launched, runId: crypto.randomUUID() })).toBe(false);
    expect(sameProjectChatRunRequest(launched, { ...launched })).toBe(true);
  });

  it("builds Stop from the captured launch target, including encoded identifiers", () => {
    const target = { clientId: "client/a", conversationId: "conversation b", runId: crypto.randomUUID() };
    expect(projectChatStopUrl(target))
      .toBe("/api/clients/client%2Fa/conversations/conversation%20b/stop");
    expect(projectChatStopRequest(target)).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: target.runId })
    });
  });

  it("carries the exact run scope in a project message request", () => {
    const runId = crypto.randomUUID();
    expect(buildProjectMessageRequest({
      clientId: "client-a",
      conversationId: "conversation-a",
      runId,
      sessionId: "session-a",
      projectId: "project-a",
      message: "Review this project",
      locale: "en"
    })).toEqual({
      clientId: "client-a",
      conversationId: "conversation-a",
      runId,
      sessionId: "session-a",
      projectId: "project-a",
      message: "Review this project",
      locale: "en"
    });
  });

  it("does not submit Enter while a CJK IME composition is active", () => {
    expect(shouldSubmitProjectChatKey({ key: "Enter", isComposing: true })).toBe(false);
    expect(shouldSubmitProjectChatKey({ key: "Enter", isComposing: false })).toBe(true);
    expect(shouldSubmitProjectChatKey({ key: "Enter", isComposing: false, keyCode: 229 })).toBe(false);
  });

  it("reports a run as busy elsewhere without claiming the selected chat is running", () => {
    const launched = { clientId: "client-a", conversationId: "conversation-a", runId: crypto.randomUUID() };
    expect(projectChatRunBusyElsewhere(launched, launched)).toBe(false);
    expect(projectChatRunBusyElsewhere(launched, { clientId: "client-a", conversationId: "conversation-b" })).toBe(true);
    expect(projectChatRunBusyElsewhere(null, launched)).toBe(false);
  });

  it("lets only the newest Project session binding commit", () => {
    const guard = new ProjectSessionBindGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(guard.canCommit(first)).toBe(false);
    expect(guard.canCommit(second)).toBe(true);
  });
});
