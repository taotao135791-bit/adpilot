import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { SessionError, Session } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditLog } from "@adpilot/audit";
import { ApprovalService } from "@adpilot/approvals";
import { ExperimentStore } from "@adpilot/experiments";
import { ModelRouter } from "@adpilot/model-router";
import { SkillRegistry } from "@adpilot/skills";
import { AdPilotTools } from "@adpilot/tools";
import { ConversationMessage } from "@adpilot/shared";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotSessionStorage, PiAgentRuntime, conversationMessageLabel, resolvePiSessionId } from "./index.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-fork-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
  const faux = fauxProvider({ provider: "test", models: [{ id: "fast" }, { id: "strong", reasoning: true }] });
  const models = createModels(); models.setProvider(faux.provider);
  const router = new ModelRouter({ fast: { provider: "test", model: "fast" }, strong: { provider: "test", model: "strong" }, gui: { provider: "test", model: "fast" } });
  const tools = new AdPilotTools(workspace, new AuditLog(workspace), new ApprovalService(workspace, "0123456789abcdef0123456789abcdef"), new ExperimentStore(workspace));
  const runtime = new PiAgentRuntime(models, router, workspace, new SkillRegistry(), tools);
  return { workspace, faux, runtime };
}

/** Runs one conversational turn and persists both sides to conversation.jsonl, mirroring the server pipeline. */
async function turn(
  workspace: WorkspaceStore,
  runtime: PiAgentRuntime,
  conversationId: string,
  userText: string,
  options: { systemPrompt?: string } = {}
): Promise<{ userId: string; assistantId: string; reply: string }> {
  const userId = crypto.randomUUID();
  await workspace.appendJsonl("client-a", "conversation.jsonl", ConversationMessage.parse({
    id: userId, clientId: "client-a", conversationId, role: "user", content: userText, at: new Date().toISOString()
  }));
  const result = await runtime.run({
    context: {
      clientId: "client-a", conversationId, taskId: crypto.randomUUID(), actor: "adpilot_agent",
      permission: "OBSERVE", sessionId: crypto.randomUUID(), role: "adpilot_agent", userMessageId: userId
    },
    systemPrompt: options.systemPrompt ?? "Be concise.",
    prompt: userText,
    signals: { task: "conversation" }
  });
  const assistantId = crypto.randomUUID();
  await workspace.appendJsonl("client-a", "conversation.jsonl", ConversationMessage.parse({
    id: assistantId, clientId: "client-a", conversationId, role: "assistant", content: result.text, at: new Date().toISOString()
  }));
  return { userId, assistantId, reply: result.text };
}

async function conversationMessages(workspace: WorkspaceStore, conversationId: string) {
  return (await workspace.readJsonl("client-a", "conversation.jsonl", ConversationMessage))
    .filter((message) => message.conversationId === conversationId);
}

async function branchOf(storage: AdPilotSessionStorage) {
  return new Session(storage).getBranch();
}

describe("PiAgentRuntime conversation fork", () => {
  it("labels every conversational user message entry as an exact fork anchor", async () => {
    const { workspace, faux, runtime } = await setup();
    faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
    const first = await turn(workspace, runtime, "primary", "question one");
    const second = await turn(workspace, runtime, "primary", "question two");

    const storage = await AdPilotSessionStorage.openOrCreate(workspace, "client-a", "primary");
    const labels = await storage.findEntries("label");
    const byLabel = new Map(labels.map((entry) => [entry.label, entry.targetId]));
    const firstEntry = await storage.getEntry(byLabel.get(conversationMessageLabel(first.userId)) ?? "");
    const secondEntry = await storage.getEntry(byLabel.get(conversationMessageLabel(second.userId)) ?? "");
    expect(firstEntry?.type).toBe("message");
    expect(secondEntry?.type).toBe("message");
    if (firstEntry?.type !== "message" || secondEntry?.type !== "message") throw new Error("unreachable");
    expect(firstEntry.message.role).toBe("user");
    expect(JSON.stringify(firstEntry.message)).toContain("question one");
    expect(JSON.stringify(secondEntry.message)).toContain("question two");
  });

  it("forks at a user message, then both conversations evolve independently", async () => {
    const { workspace, faux, runtime } = await setup();
    faux.setResponses([fauxAssistantMessage("reply one"), fauxAssistantMessage("reply two")]);
    const first = await turn(workspace, runtime, "primary", "question one");
    await turn(workspace, runtime, "primary", "question two");

    const fork = await runtime.forkConversation("client-a", "primary", first.userId, { actor: "workspace-owner" });
    expect(fork.conversationId).toMatch(/^fork-[0-9a-f]{8}$/);
    expect(fork.copiedMessages).toBe(1);
    expect(fork.sourceEntryId).not.toBeNull();

    // The transcript copy stops at the fork message, ids preserved for provenance.
    await expect(conversationMessages(workspace, fork.conversationId)).resolves.toMatchObject([
      { id: first.userId, role: "user", content: "question one" }
    ]);
    await expect(conversationMessages(workspace, "primary")).resolves.toHaveLength(4);

    // The forked session branch holds the history up to and including the user
    // message, plus the fork provenance custom entry; the reply is not shared.
    const forkStorage = await AdPilotSessionStorage.openOrCreate(workspace, "client-a", fork.conversationId);
    const branch = await branchOf(forkStorage);
    const branchMessages = branch.filter((entry) => entry.type === "message");
    expect(branchMessages).toHaveLength(1);
    expect(JSON.stringify(branchMessages[0])).toContain("question one");
    expect(branch.at(-1)?.type).toBe("custom");

    // Fork writes a recovery checkpoint and a chained audit record.
    const checkpoint = await workspace.readJson("client-a", `sessions/${fork.sessionId}.recovery.json`, z.object({
      phase: z.string(), sessionId: z.string(), conversationId: z.string()
    }));
    expect(checkpoint).toMatchObject({ phase: "idle", sessionId: fork.sessionId, conversationId: fork.conversationId });
    const audit = new AuditLog(workspace);
    const forkEvents = (await audit.list("client-a")).filter((event) => event.action === "fork_conversation");
    expect(forkEvents).toHaveLength(1);
    expect(forkEvents[0]).toMatchObject({
      actor: "workspace-owner", status: "succeeded",
      details: { sourceConversationId: "primary", newConversationId: fork.conversationId, copiedEntries: fork.copiedEntries }
    });
    await expect(audit.verify("client-a")).resolves.toBe(true);

    // Both conversations continue independently: the fork sees the shared
    // prefix but neither the source reply nor the source's later turns.
    let forkContext = "";
    faux.setResponses([(context) => {
      forkContext = JSON.stringify(context.messages);
      return fauxAssistantMessage("fork answer");
    }]);
    await turn(workspace, runtime, fork.conversationId, "fork question");
    expect(forkContext).toContain("question one");
    expect(forkContext).toContain("fork question");
    expect(forkContext).not.toContain("reply one");
    expect(forkContext).not.toContain("question two");

    faux.setResponses([fauxAssistantMessage("primary answer three")]);
    await turn(workspace, runtime, "primary", "question three");
    const sourceMessages = (await (await AdPilotSessionStorage.openOrCreate(workspace, "client-a", "primary")).getEntries())
      .filter((entry) => entry.type === "message");
    const forkMessagesAfter = (await (await AdPilotSessionStorage.openOrCreate(workspace, "client-a", fork.conversationId)).getEntries())
      .filter((entry) => entry.type === "message");
    expect(sourceMessages).toHaveLength(6);
    expect(forkMessagesAfter).toHaveLength(3);
    expect(JSON.stringify(forkMessagesAfter)).not.toContain("question three");
  });

  it("forks at an assistant message keeping the whole producing turn", async () => {
    const { workspace, faux, runtime } = await setup();
    faux.setResponses([fauxAssistantMessage("reply one"), fauxAssistantMessage("reply two")]);
    const first = await turn(workspace, runtime, "primary", "question one");
    const second = await turn(workspace, runtime, "primary", "question two");

    const fork = await runtime.forkConversation("client-a", "primary", first.assistantId);
    expect(fork.copiedMessages).toBe(2);
    const forkStorage = await AdPilotSessionStorage.openOrCreate(workspace, "client-a", fork.conversationId);
    const branchMessages = (await branchOf(forkStorage)).filter((entry) => entry.type === "message");
    expect(branchMessages.map((entry) => entry.type === "message" ? entry.message.role : "")).toEqual(["user", "assistant"]);
    expect(JSON.stringify(branchMessages.at(-1))).toContain("reply one");

    // Forking at the latest message clones the conversation in full.
    const head = await runtime.forkConversation("client-a", "primary", second.assistantId);
    expect(head.copiedMessages).toBe(4);
    const headMessages = (await branchOf(await AdPilotSessionStorage.openOrCreate(workspace, "client-a", head.conversationId)))
      .filter((entry) => entry.type === "message");
    expect(headMessages.map((entry) => entry.type === "message" ? entry.message.role : "")).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("rejects unknown, unlinked, or session-less fork points", async () => {
    const { workspace, faux, runtime } = await setup();
    faux.setResponses([fauxAssistantMessage("reply one")]);
    await turn(workspace, runtime, "primary", "question one");

    const unknown = await runtime.forkConversation("client-a", "primary", crypto.randomUUID()).then(() => null, (error) => error);
    expect(unknown).toBeInstanceOf(SessionError);
    expect((unknown as SessionError).code).toBe("not_found");

    // A message written before fork support (no linked session entry) fails closed.
    const legacyId = crypto.randomUUID();
    await workspace.appendJsonl("client-a", "conversation.jsonl", ConversationMessage.parse({
      id: legacyId, clientId: "client-a", conversationId: "primary", role: "user", content: "legacy question", at: new Date().toISOString()
    }));
    const legacy = await runtime.forkConversation("client-a", "primary", legacyId).then(() => null, (error) => error);
    expect(legacy).toBeInstanceOf(SessionError);
    expect((legacy as SessionError).code).toBe("invalid_fork_target");

    // A conversation with transcript rows but no Pi session cannot fork.
    const ghostId = crypto.randomUUID();
    await workspace.appendJsonl("client-a", "conversation.jsonl", ConversationMessage.parse({
      id: ghostId, clientId: "client-a", conversationId: "ghost", role: "user", content: "direct answer only", at: new Date().toISOString()
    }));
    const ghost = await runtime.forkConversation("client-a", "ghost", ghostId).then(() => null, (error) => error);
    expect(ghost).toBeInstanceOf(SessionError);
    expect((ghost as SessionError).code).toBe("not_found");
  });

  it("keeps a fork usable when the source history was compacted", async () => {
    const { workspace, faux, runtime } = await setup();
    // Seed the source session directly: one labeled user message, one reply,
    // and a real compaction entry dropping the pre-compaction history.
    const sourceStorage = await AdPilotSessionStorage.openOrCreate(workspace, "client-a", "primary");
    const sourceSession = new Session(sourceStorage);
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const userEntryId = await sourceSession.appendMessage({ role: "user", content: [{ type: "text", text: "Analyze campaign-42 without changing it." }], timestamp: Date.now() });
    const assistantEntryId = await sourceSession.appendMessage(fauxAssistantMessage("campaign-42 analysis completed"));
    await sourceSession.appendLabel(userEntryId, conversationMessageLabel(userId));
    await sourceSession.appendCompaction("Compacted campaign-42 history with its budget and approval state.", assistantEntryId, 450, { reason: "test" });
    await workspace.appendJsonl("client-a", "conversation.jsonl", ConversationMessage.parse({
      id: userId, clientId: "client-a", conversationId: "primary", role: "user", content: "Analyze campaign-42 without changing it.", at: new Date().toISOString()
    }));
    await workspace.appendJsonl("client-a", "conversation.jsonl", ConversationMessage.parse({
      id: assistantId, clientId: "client-a", conversationId: "primary", role: "assistant", content: "campaign-42 analysis completed", at: new Date().toISOString()
    }));

    // Forking at the latest message carries the compaction entry onto the new
    // branch, so the fork rebuilds the same compacted context instead of
    // resurrecting history the source already dropped.
    const fork = await runtime.forkConversation("client-a", "primary", assistantId);
    expect(fork.copiedMessages).toBe(2);
    const forkStorage = await AdPilotSessionStorage.openOrCreate(workspace, "client-a", fork.conversationId);
    expect((await forkStorage.findEntries("compaction")).length).toBeGreaterThanOrEqual(1);

    let forkContext = "";
    faux.setResponses([
      (context) => {
        forkContext = JSON.stringify(context.messages);
        return fauxAssistantMessage("fork reply");
      },
      // Spare in case the post-run threshold check compacts the fork session.
      fauxAssistantMessage("post-fork compaction summary")
    ]);
    await turn(workspace, runtime, fork.conversationId, "Fork follow-up.");
    expect(forkContext).toContain("Compacted campaign-42 history");
    expect(forkContext).toContain("Fork follow-up.");
    expect(forkContext).not.toContain("Analyze campaign-42");
    expect(resolvePiSessionId("client-a", fork.conversationId)).toBe(fork.sessionId);
  });
});
