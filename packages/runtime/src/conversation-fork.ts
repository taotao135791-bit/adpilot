import { randomUUID } from "node:crypto";
import { Session, SessionError } from "@earendil-works/pi-agent-core";
import { ConversationMessage } from "@adpilot/shared";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotSessionStorage, resolvePiSessionId } from "./session-storage.js";

/**
 * Conversation forking on top of the tree-shaped Pi session storage.
 *
 * Linkage: every conversational run labels its user-message session entry with
 * `conversation-message:<conversationMessageId>` (see PiAgentRuntime). A fork
 * point is resolved through those labels, so it survives compaction — labels
 * and entries are never deleted from the JSONL file, and getPathToRoot walks
 * the parent chain even for entries that are no longer on the current branch.
 *
 * Copy semantics: the fork replays the source entry path (root → fork point)
 * into a brand-new session file, preserving entry ids, parent links and
 * timestamps. Entry ids therefore exist in both files; each file stays an
 * independent, self-consistent tree and the two conversations evolve
 * independently after the fork. The fork provenance is recorded as a
 * `custom` entry (excluded from model context by pi-agent-core) so it rides
 * the existing persistence without a schema change.
 */
export const FORK_CUSTOM_ENTRY_TYPE = "adpilot_fork";

const MESSAGE_LABEL_PREFIX = "conversation-message:";
const FORK_ID_ATTEMPTS = 100;

/** Label value binding a session entry to its conversation.jsonl message id. */
export function conversationMessageLabel(messageId: string): string {
  return `${MESSAGE_LABEL_PREFIX}${messageId}`;
}

export interface ConversationForkResult {
  clientId: string;
  /** Newly created conversation id. */
  conversationId: string;
  /** Pi session id backing the new conversation. */
  sessionId: string;
  sourceConversationId: string;
  sourceMessageId: string;
  /** Session entry the new branch starts from; null means an empty history. */
  sourceEntryId: string | null;
  copiedEntries: number;
  copiedMessages: number;
}

/**
 * Resolves the session entry a fork should branch from.
 * - Forking at a user message keeps everything up to and including that user
 *   message, so the new conversation can be steered with a different strategy.
 * - Forking at an assistant or system message keeps the whole turn that
 *   produced it: the branch starts at the entry the next labeled user message
 *   hangs off, or at the current leaf when the turn is the latest one.
 */
export async function resolveForkLeafId(
  storage: AdPilotSessionStorage,
  conversationMessages: ConversationMessage[],
  atMessageId: string
): Promise<string | null> {
  const targetIndex = conversationMessages.findIndex((message) => message.id === atMessageId);
  if (targetIndex < 0) throw new SessionError("not_found", `Conversation message ${atMessageId} not found`);
  const target = conversationMessages[targetIndex]!;
  const entryFor = async (messageId: string) => {
    const label = conversationMessageLabel(messageId);
    const labelEntry = (await storage.findEntries("label")).filter((entry) => entry.label === label).at(-1);
    if (!labelEntry) return undefined;
    const entry = await storage.getEntry(labelEntry.targetId);
    return entry?.type === "message" ? entry : undefined;
  };
  if (target.role === "user") {
    const entry = await entryFor(target.id);
    if (!entry) {
      throw new SessionError(
        "invalid_fork_target",
        `Message ${atMessageId} has no linked session entry; it predates fork support or was answered directly without a model run`
      );
    }
    return entry.id;
  }
  const nextUser = conversationMessages.slice(targetIndex + 1).find((message) => message.role === "user");
  if (!nextUser) return storage.getLeafId();
  const nextEntry = await entryFor(nextUser.id);
  if (!nextEntry) {
    throw new SessionError(
      "invalid_fork_target",
      `The turn following message ${atMessageId} has no linked session entry; fork at a later message instead`
    );
  }
  return nextEntry.parentId;
}

/**
 * Copies the conversation transcript and the session tree path up to the fork
 * point into a fresh conversation. Callers serialize against in-flight runs
 * (PiAgentRuntime wraps this in the source session lock) and append the audit
 * record; this function performs no locking of its own.
 */
export async function forkConversationStorage(
  workspace: WorkspaceStore,
  clientId: string,
  sourceConversationId: string,
  atMessageId: string
): Promise<ConversationForkResult> {
  const sourceSessionId = resolvePiSessionId(clientId, sourceConversationId);
  const persisted = await workspace.readText(clientId, `sessions/${sourceSessionId}.jsonl`);
  if (!persisted) throw new SessionError("not_found", `Conversation ${sourceConversationId} has no persisted session to fork`);
  const allMessages = await workspace.readJsonl(clientId, "conversation.jsonl", ConversationMessage);
  const conversationMessages = allMessages.filter((message) => message.conversationId === sourceConversationId);
  if (conversationMessages.length === 0) {
    throw new SessionError("not_found", `Conversation ${sourceConversationId} has no messages to fork`);
  }
  const sourceStorage = await AdPilotSessionStorage.openOrCreate(workspace, clientId, sourceConversationId);
  const leafId = await resolveForkLeafId(sourceStorage, conversationMessages, atMessageId);
  const path = await sourceStorage.getPathToRoot(leafId);

  const usedConversationIds = new Set(allMessages.map((message) => message.conversationId));
  const newConversationId = await allocateForkConversationId(workspace, clientId, usedConversationIds);
  const targetStorage = await AdPilotSessionStorage.openOrCreate(workspace, clientId, newConversationId);
  for (const entry of path) await targetStorage.appendEntry(entry);
  const targetSession = new Session(targetStorage);
  await targetSession.appendCustomEntry(FORK_CUSTOM_ENTRY_TYPE, {
    sourceConversationId,
    sourceMessageId: atMessageId,
    sourceEntryId: leafId,
    copiedEntries: path.length,
    forkedAt: new Date().toISOString()
  });

  const cutoff = conversationMessages.findIndex((message) => message.id === atMessageId);
  const copied = conversationMessages.slice(0, cutoff + 1);
  for (const message of copied) {
    await workspace.appendJsonl(clientId, "conversation.jsonl", { ...message, conversationId: newConversationId });
  }

  return {
    clientId,
    conversationId: newConversationId,
    sessionId: resolvePiSessionId(clientId, newConversationId),
    sourceConversationId,
    sourceMessageId: atMessageId,
    sourceEntryId: leafId,
    copiedEntries: path.length,
    copiedMessages: copied.length
  };
}

async function allocateForkConversationId(
  workspace: WorkspaceStore,
  clientId: string,
  usedConversationIds: ReadonlySet<string>
): Promise<string> {
  for (let attempt = 0; attempt < FORK_ID_ATTEMPTS; attempt += 1) {
    const candidate = `fork-${randomUUID().slice(0, 8)}`;
    if (usedConversationIds.has(candidate)) continue;
    const occupied = await workspace.readText(clientId, `sessions/${resolvePiSessionId(clientId, candidate)}.jsonl`);
    if (!occupied) return candidate;
  }
  throw new SessionError("storage", "Failed to allocate a unique fork conversation id");
}
