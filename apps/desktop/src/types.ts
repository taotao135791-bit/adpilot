import type { Approval } from "./approvalDisclosure.js";
import type { PlanModeState } from "./planMode.js";

export type Client = { id: string; name: string; industry: string; timezone: string };

export type Task = {
  id: string;
  goal: string;
  phase: string;
  completedSteps: string[];
  blockers: string[];
  nextStep: string | null;
  owner: string | null;
  reviewAt: string | null;
  updatedAt: string;
};

export type Experiment = { id: string; hypothesis: string; variable: string; status: string; reviewAt: string };

export type Audit = { id: string; actor: string; action: string; status: string; at: string };

export type ConversationMessage = {
  id: string;
  clientId: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "complete" | "error";
  taskId?: string;
  at: string;
};

export type ComputerVisualEvent = {
  type: string;
  phase?: string;
  attempt?: number;
  screenshot?: { width: number; height: number; capturedAt: string; sha256: string };
  action?: { action: string; target: string; reason: string };
  reason?: string;
};

/** Wire shape of server-sent product events (see packages/application ProductEvent). */
export type ProductEvent = {
  type: string;
  status?: string;
  message?: string;
  approvalId?: string;
  conversationId?: string;
  alert?: { alertId: string; kind: string; severity: string; message: string; createdAt: string; metrics?: unknown[] };
  event?: ComputerVisualEvent;
};

export type ComputerExecutionStatus = "running" | "paused" | "cancelled" | "unavailable";

export type ModelStatus = {
  fast: string;
  strong: string;
  gui: string;
  guiStrong: string;
  chatConfigured: boolean;
  guiConfigured: boolean;
  browserSession?: string;
  route?: string;
  privacyMode?: "standard" | "local-only";
  permission?: "OBSERVE" | "INTERACT" | "MUTATE" | "DESTRUCTIVE";
};

export type State = {
  clients: Client[];
  selectedClientId?: string;
  selectedConversationId?: string;
  conversations?: string[];
  tasks: Task[];
  approvals: Approval[];
  experiments: Experiment[];
  audit: Audit[];
  messages: ConversationMessage[];
  events: ProductEvent[];
  /** Present only when a client is selected (see the server /api/state handler). */
  planMode?: PlanModeState;
  /** Workspace autonomy switch, carried by /api/state (see autonomy.ts). */
  autonomy?: { mode?: string };
  computerUse?: { executionStatus?: ComputerExecutionStatus };
  models: ModelStatus;
};

export const emptyState: State = {
  clients: [],
  tasks: [],
  approvals: [],
  experiments: [],
  audit: [],
  messages: [],
  events: [],
  models: { fast: "", strong: "", gui: "", guiStrong: "", chatConfigured: false, guiConfigured: false }
};

/**
 * Cap for the client-side SSE event buffer. The server keeps the last 100
 * events per client; keeping a slightly larger local window lets live
 * computer-use bursts survive between state refetches without unbounded
 * growth that would degrade timeline merging.
 */
export const EVENT_BUFFER_LIMIT = 200;

export function appendProductEvent(events: readonly ProductEvent[], event: ProductEvent): ProductEvent[] {
  return [...events.slice(-(EVENT_BUFFER_LIMIT - 1)), event];
}
