import { describe, expect, it } from "vitest";
import {
  projectChatCleanupStopRequest,
  projectChatRunBusyElsewhere,
  projectChatStopRequest,
  projectChatStopUrl,
  ProjectChatRunLifecycle,
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

  it("builds a strict keepalive cleanup Stop for the exact Project run", () => {
    const target = {
      clientId: "workspace-a",
      projectId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      conversationId: "conversation-a",
      runId: crypto.randomUUID()
    };
    expect(projectChatStopUrl(target)).toBe(`/api/clients/workspace-a/conversations/conversation-a/stop`);
    expect(projectChatCleanupStopRequest(target)).toEqual({
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: target.runId })
    });
  });

  it("claims only the exact exiting scope and rejects its stale completion", () => {
    const lifecycle = new ProjectChatRunLifecycle();
    const target = {
      clientId: "workspace-a",
      projectId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      conversationId: "conversation-a",
      runId: crypto.randomUUID()
    };

    // React StrictMode's empty probe cleanup has no run to stop.
    expect(lifecycle.claimForScopeExit(target)).toBeNull();
    lifecycle.start(target);
    for (const otherScope of [
      { ...target, clientId: "workspace-b" },
      { ...target, projectId: crypto.randomUUID() },
      { ...target, sessionId: crypto.randomUUID() },
      { ...target, conversationId: "conversation-b" }
    ]) {
      expect(lifecycle.claimForScopeExit(otherScope)).toBeNull();
    }
    expect(lifecycle.owns(target)).toBe(true);

    expect(lifecycle.claimForScopeExit(target)).toEqual(target);
    expect(lifecycle.owns(target)).toBe(false);
    expect(lifecycle.complete(target)).toBe(false);
  });

  it("does not let an older completion clear or pollute a replacement run", () => {
    const lifecycle = new ProjectChatRunLifecycle();
    const first = {
      clientId: "workspace-a",
      projectId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      conversationId: "conversation-a",
      runId: crypto.randomUUID()
    };
    const replacement = { ...first, runId: crypto.randomUUID() };
    lifecycle.start(first);
    lifecycle.start(replacement);

    expect(lifecycle.complete(first)).toBe(false);
    expect(lifecycle.current()).toEqual(replacement);
    expect(lifecycle.complete(replacement)).toBe(true);
    expect(lifecycle.current()).toBeNull();
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
