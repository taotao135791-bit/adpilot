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

/**
 * Product Session as served by the Session Service (see
 * packages/session-service schemas). The desktop app only consumes the
 * identity/listing fields; model binding and permission profiles stay
 * server-side concerns.
 */
export type SessionStatus = "idle" | "queued" | "running" | "waiting_for_approval" | "paused" | "failed" | "completed" | "deleted";

export type ProductSession = {
  id: string;
  clientId: string;
  projectId?: string;
  runtimeConversationId: string;
  title: string;
  status: SessionStatus;
  permissionProfile?: {
    level: "OBSERVE" | "PREPARE" | "EXECUTE";
    browserProfile?: string;
    computerUse: "disabled" | "observe" | "interactive" | "execute";
    approvalRequired: boolean;
  };
  pinnedAt?: string;
  archivedAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  lastOpenedAt: string;
  revision: number;
};

export type ComputerVisualEvent = {
  type: string;
  phase?: string;
  attempt?: number;
  screenshot?: { width: number; height: number; scaleFactor?: number; capturedAt: string; sha256: string };
  action?: {
    action: string;
    target: string;
    reason: string;
    confidence?: number;
    expectedResult?: string;
    riskLevel?: string;
  };
  overlay?: {
    coordinateSpace: "screenshot_pixels";
    targetBox?: { x: number; y: number; width: number; height: number };
    pointer?: { x: number; y: number };
    dragTo?: { x: number; y: number };
  };
  matched?: boolean;
  confidence?: number;
  code?: string;
  reason?: string;
};

/** Wire shape of server-sent product events (see packages/application ProductEvent). */
export type ProductEvent = {
  type: string;
  status?: string;
  message?: string;
  approvalId?: string;
  conversationId?: string;
  /** `type: "session"` events carry the full mutated session snapshot. */
  sessionId?: string;
  session?: ProductSession;
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
  /** Legacy conversation ids, retained for backward compatibility only. */
  conversations?: string[];
  /** Product Sessions for the selected client (deleted excluded, archived included). */
  sessions?: ProductSession[];
  /** Session whose runtimeConversationId matches the requested conversationId; null when none maps. */
  selectedSessionId?: string | null;
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
  computerUse?: {
    executionStatus?: ComputerExecutionStatus;
    controlState?: string;
    productSessionId?: string;
    computerSessionId?: string;
    computerRevision?: number;
    currentBrowser?: {
      sessionId: string;
      clientId: string;
      browserProfile: string;
      processId?: number | null;
      windowId?: string | null;
      browserApplicationId: string;
      browserApp: string;
      sessionStatus: string;
      pageIdentity?: {
        status: "available" | "unavailable";
        observedAt: string;
        url?: string;
        origin?: string;
        title?: string;
        code?: string;
        reason?: string;
      } | null;
    } | null;
  };
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
