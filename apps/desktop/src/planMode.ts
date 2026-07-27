/**
 * Plan-mode client helpers. Plan mode is a conversation-level read-only
 * switch owned by the server (`PlanModeStore` in runtime): the desktop only
 * renders the state carried by /api/state and flips it through the plan-mode
 * endpoint. Everything here is pure so the wire shapes stay testable.
 */
export type PlanModeState = {
  enabled: boolean;
  updatedAt: string;
  actor: string;
};

/** Deterministic endpoint for one conversation's plan-mode switch (ids may contain arbitrary UI input). */
export function planModeEndpoint(clientId: string, conversationId: string): string {
  return `/api/clients/${encodeURIComponent(clientId)}/conversations/${encodeURIComponent(conversationId)}/plan-mode`;
}

/** Body for setting the switch: the client posts the desired state, never a toggle verb. */
export function planModeRequestBody(enabled: boolean): string {
  return JSON.stringify({ enabled });
}

/**
 * Reads the plan-mode payload from a plan-mode endpoint response. Anything
 * malformed fails closed to "off", matching the runtime store's default.
 */
export function normalizePlanMode(payload: unknown): PlanModeState {
  if (isRecord(payload) && payload.enabled === true) {
    return {
      enabled: true,
      updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : "",
      actor: typeof payload.actor === "string" ? payload.actor : ""
    };
  }
  return { enabled: false, updatedAt: "", actor: "" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
