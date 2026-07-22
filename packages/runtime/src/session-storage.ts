import { createHash, randomUUID } from "node:crypto";
import {
  SessionError,
  type SessionMetadata,
  type SessionStorage,
  type SessionTreeEntry
} from "@earendil-works/pi-agent-core";
import { assertSafeIdentifier } from "@adpilot/shared";
import { WorkspaceStore } from "@adpilot/workspace";

const SESSION_VERSION = 1;

interface AdPilotSessionHeader {
  type: "adpilot_session";
  version: typeof SESSION_VERSION;
  id: string;
  createdAt: string;
  clientId: string;
  conversationId: string;
}

export interface AdPilotSessionMetadata extends SessionMetadata {
  clientId: string;
  conversationId: string;
  relativePath: string;
}

export function resolvePiSessionId(clientId: string, conversationId: string): string {
  assertSafeIdentifier(clientId, "client id");
  const normalizedConversationId = conversationId.trim();
  if (!normalizedConversationId) throw new Error("conversation id must not be empty");
  const digest = createHash("sha256")
    .update("adpilot-pi-session\0", "utf8")
    .update(clientId, "utf8")
    .update("\0", "utf8")
    .update(normalizedConversationId, "utf8")
    .digest("hex");
  return `pi_${digest.slice(0, 40)}`;
}

export class AdPilotSessionStorage implements SessionStorage<AdPilotSessionMetadata> {
  private readonly byId = new Map<string, SessionTreeEntry>();
  private readonly labelsById = new Map<string, string>();
  private currentLeafId: string | null = null;

  private constructor(
    private readonly workspace: WorkspaceStore,
    private readonly metadata: AdPilotSessionMetadata,
    private readonly entries: SessionTreeEntry[]
  ) {
    for (const entry of entries) {
      if (this.byId.has(entry.id)) throw invalidSession(metadata.relativePath, `duplicate entry id ${entry.id}`);
      if (entry.parentId !== null && !this.byId.has(entry.parentId)) {
        throw invalidSession(metadata.relativePath, `entry ${entry.id} references missing parent ${entry.parentId}`);
      }
      if (entry.type === "leaf" && entry.targetId !== null && !this.byId.has(entry.targetId)) {
        throw invalidSession(metadata.relativePath, `leaf ${entry.id} references missing target ${entry.targetId}`);
      }
      this.byId.set(entry.id, entry);
      this.updateLabel(entry);
      this.currentLeafId = entry.type === "leaf" ? entry.targetId : entry.id;
    }
  }

  static async openOrCreate(
    workspace: WorkspaceStore,
    clientId: string,
    conversationId: string
  ): Promise<AdPilotSessionStorage> {
    const sessionId = resolvePiSessionId(clientId, conversationId);
    const relativePath = `sessions/${sessionId}.jsonl`;
    const header: AdPilotSessionHeader = {
      type: "adpilot_session",
      version: SESSION_VERSION,
      id: sessionId,
      createdAt: new Date().toISOString(),
      clientId,
      conversationId: conversationId.trim()
    };
    const created = await workspace.createText(clientId, relativePath, `${JSON.stringify(header)}\n`);
    const content = created ? `${JSON.stringify(header)}\n` : await workspace.readText(clientId, relativePath);
    if (!content) throw invalidSession(relativePath, "session file is empty");
    const parsed = parseSessionFile(content, relativePath);
    if (parsed.header.id !== sessionId || parsed.header.clientId !== clientId || parsed.header.conversationId !== conversationId.trim()) {
      throw invalidSession(relativePath, "session header does not match requested client and conversation");
    }
    return new AdPilotSessionStorage(workspace, {
      id: parsed.header.id,
      createdAt: parsed.header.createdAt,
      clientId: parsed.header.clientId,
      conversationId: parsed.header.conversationId,
      relativePath
    }, parsed.entries);
  }

  async getMetadata(): Promise<AdPilotSessionMetadata> {
    return { ...this.metadata };
  }

  async getLeafId(): Promise<string | null> {
    if (this.currentLeafId !== null && !this.byId.has(this.currentLeafId)) {
      throw new SessionError("invalid_session", `Entry ${this.currentLeafId} not found`);
    }
    return this.currentLeafId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.byId.has(leafId)) throw new SessionError("not_found", `Entry ${leafId} not found`);
    await this.appendEntry({
      type: "leaf",
      id: await this.createEntryId(),
      parentId: this.currentLeafId,
      timestamp: new Date().toISOString(),
      targetId: leafId
    });
  }

  async createEntryId(): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = randomUUID();
      if (!this.byId.has(id)) return id;
    }
    throw new SessionError("storage", "Failed to allocate a unique session entry id");
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    validateEntry(entry, this.metadata.relativePath);
    if (this.byId.has(entry.id)) throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
    if (entry.parentId !== null && !this.byId.has(entry.parentId)) {
      throw new SessionError("not_found", `Parent entry ${entry.parentId} not found`);
    }
    if (entry.type === "leaf" && entry.targetId !== null && !this.byId.has(entry.targetId)) {
      throw new SessionError("not_found", `Entry ${entry.targetId} not found`);
    }
    const persisted = structuredClone(entry);
    await this.workspace.appendText(this.metadata.clientId, this.metadata.relativePath, `${JSON.stringify(persisted)}\n`);
    this.entries.push(persisted);
    this.byId.set(persisted.id, persisted);
    this.updateLabel(persisted);
    this.currentLeafId = persisted.type === "leaf" ? persisted.targetId : persisted.id;
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    const entry = this.byId.get(id);
    return entry ? structuredClone(entry) : undefined;
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    return this.entries
      .filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type)
      .map((entry) => structuredClone(entry));
  }

  async getLabel(id: string): Promise<string | undefined> {
    return this.labelsById.get(id);
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const path: SessionTreeEntry[] = [];
    const visited = new Set<string>();
    let current = this.byId.get(leafId);
    if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
    while (current) {
      if (visited.has(current.id)) throw new SessionError("invalid_session", `Cycle detected at entry ${current.id}`);
      visited.add(current.id);
      path.unshift(structuredClone(current));
      if (current.parentId === null) break;
      const parent: SessionTreeEntry | undefined = this.byId.get(current.parentId);
      if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
      current = parent;
    }
    return path;
  }

  async getEntries(): Promise<SessionTreeEntry[]> {
    return structuredClone(this.entries);
  }

  private updateLabel(entry: SessionTreeEntry): void {
    if (entry.type !== "label") return;
    const label = entry.label?.trim();
    if (label) this.labelsById.set(entry.targetId, label);
    else this.labelsById.delete(entry.targetId);
  }
}

function parseSessionFile(content: string, relativePath: string): { header: AdPilotSessionHeader; entries: SessionTreeEntry[] } {
  const lines = content.split("\n").filter((line) => line.trim());
  if (lines.length === 0) throw invalidSession(relativePath, "missing session header");
  const header = parseJsonLine(lines[0]!, relativePath, 1);
  if (!isSessionHeader(header)) throw invalidSession(relativePath, "invalid or unsupported session header");
  const entries = lines.slice(1).map((line, index) => {
    const entry = parseJsonLine(line, relativePath, index + 2);
    validateEntry(entry, relativePath, index + 2);
    return entry;
  });
  return { header, entries };
}

function parseJsonLine(line: string, relativePath: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new SessionError("invalid_entry", `Invalid session ${relativePath}: line ${lineNumber} is not valid JSON`, asError(error));
  }
}

function isSessionHeader(value: unknown): value is AdPilotSessionHeader {
  if (!isRecord(value)) return false;
  return value.type === "adpilot_session" && value.version === SESSION_VERSION && typeof value.id === "string" && value.id.length > 0
    && typeof value.createdAt === "string" && value.createdAt.length > 0 && typeof value.clientId === "string" && value.clientId.length > 0
    && typeof value.conversationId === "string" && value.conversationId.length > 0;
}

function validateEntry(value: unknown, relativePath: string, lineNumber?: number): asserts value is SessionTreeEntry {
  const location = lineNumber ? `line ${lineNumber}` : "entry";
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string" || value.id.length === 0
    || (value.parentId !== null && typeof value.parentId !== "string") || typeof value.timestamp !== "string" || value.timestamp.length === 0) {
    throw new SessionError("invalid_entry", `Invalid session ${relativePath}: ${location} has an invalid Pi session entry envelope`);
  }
  if (value.type === "leaf" && value.targetId !== null && typeof value.targetId !== "string") {
    throw new SessionError("invalid_entry", `Invalid session ${relativePath}: ${location} has an invalid leaf target`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSession(relativePath: string, message: string): SessionError {
  return new SessionError("invalid_session", `Invalid session ${relativePath}: ${message}`);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
