/** Error with a stable machine-readable code; the lifecycle maps it into the result. */
export function toolError(code: string, message: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = code;
  return error;
}

export const NOT_FOUND = "NOT_FOUND";
export const INVALID = "INVALID";
