/**
 * Domain error raised by the automations layer. `code` is a stable,
 * machine-readable token so callers (routes, orchestrators, tests) can branch
 * on the failure kind without matching prose.
 */
export class AutomationsError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "AutomationsError";
    this.code = code;
  }
}
