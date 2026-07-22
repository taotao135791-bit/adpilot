import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, type AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotSessionStorage, resolvePiSessionId } from "./session-storage.js";

async function createWorkspace(): Promise<WorkspaceStore> {
  const root = await mkdtemp(join(tmpdir(), "adpilot-session-storage-"));
  const workspace = new WorkspaceStore(root);
  await workspace.initializeClient({ profile: { id: "client-a", name: "A" }, kpi: { primary: "CPA", target: 10 } });
  return workspace;
}

describe("AdPilotSessionStorage", () => {
  it("maps a client and conversation to one stable, client-isolated Pi session id", () => {
    expect(resolvePiSessionId("client-a", "conversation-1")).toBe(resolvePiSessionId("client-a", "conversation-1"));
    expect(resolvePiSessionId("client-a", "conversation-1")).not.toBe(resolvePiSessionId("client-a", "conversation-2"));
    expect(resolvePiSessionId("client-a", "conversation-1")).not.toBe(resolvePiSessionId("client-b", "conversation-1"));
    expect(() => resolvePiSessionId("client-a", "   ")).toThrow("conversation id must not be empty");
  });

  it("implements Pi SessionStorage and restores messages, tool results, labels, and compaction from disk", async () => {
    const workspace = await createWorkspace();
    const storage = await AdPilotSessionStorage.openOrCreate(workspace, "client-a", "conversation-1");
    const session = new Session(storage);
    const userId = await session.appendMessage({ role: "user", content: [{ type: "text", text: "inspect campaign" }], timestamp: 1 });
    await session.appendMessage(fauxAssistantMessage({ type: "toolCall", id: "tool-1", name: "inspect", arguments: {} }, { stopReason: "toolUse", timestamp: 2 }));
    const toolResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "inspect",
      content: [{ type: "text", text: "campaign is healthy" }],
      details: { campaignId: "campaign-1" },
      isError: false,
      timestamp: 3
    };
    await session.appendMessage(toolResult);
    await session.appendLabel(userId, "start");
    await session.appendCompaction("Preserve campaign-1.", userId, 123, { campaignIds: ["campaign-1"] });

    const reopenedStorage = await AdPilotSessionStorage.openOrCreate(workspace, "client-a", "conversation-1");
    const reopened = new Session(reopenedStorage);
    const entries = await reopened.getEntries();
    expect((await reopened.getMetadata()).id).toBe(resolvePiSessionId("client-a", "conversation-1"));
    expect(entries.filter((entry) => entry.type === "message")).toHaveLength(3);
    expect(entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult")).toBe(true);
    expect(entries.some((entry) => entry.type === "compaction" && entry.summary === "Preserve campaign-1.")).toBe(true);
    expect(await reopened.getLabel(userId)).toBe("start");
    expect((await reopened.getBranch()).at(-1)?.type).toBe("compaction");
  });
});
