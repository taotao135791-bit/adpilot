/**
 * Autonomy-mode client helpers. The autonomy switch is a workspace-level
 * execution permission owned by the server: the desktop only renders the
 * mode carried by /api/state (`autonomy`) and changes it through the
 * autonomy endpoint. Everything here is pure so the wire shapes stay
 * testable. Unknown payloads fail closed to "guarded" — the safe default.
 */
export type AutonomyMode = "guarded" | "full_access";

/** Deterministic endpoint for one workspace's autonomy switch (ids may contain arbitrary UI input). */
export function autonomyEndpoint(clientId: string): string {
  return `/api/clients/${encodeURIComponent(clientId)}/autonomy`;
}

/** Body for setting the switch: the client sends the desired mode, never a toggle verb. */
export function autonomyRequestBody(mode: AutonomyMode): string {
  return JSON.stringify({ mode });
}

/**
 * Reads the autonomy mode from an endpoint response or the /api/state
 * payload. Anything malformed fails closed to "guarded", matching the
 * server's default and the approval-gated posture of the product.
 */
export function normalizeAutonomy(payload: unknown): AutonomyMode {
  if (isRecord(payload) && payload.mode === "full_access") return "full_access";
  return "guarded";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
