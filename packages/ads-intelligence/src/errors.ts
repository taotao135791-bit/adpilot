/**
 * Domain error raised by the ads-intelligence layer. `code` is a stable,
 * machine-readable token so callers (routes, orchestrators, tests) can branch
 * on the failure kind without matching prose.
 */
export class AdsIntelligenceError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "AdsIntelligenceError";
    this.code = code;
  }
}
