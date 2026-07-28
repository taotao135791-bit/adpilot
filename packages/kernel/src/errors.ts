/**
 * Domain error raised by the kernel layer. `code` is a stable, machine-readable
 * token so callers (routes, orchestrators, tests) can branch on the failure
 * kind without matching prose.
 */
export class KernelError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "KernelError";
    this.code = code;
  }
}
