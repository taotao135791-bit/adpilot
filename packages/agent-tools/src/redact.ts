const SENSITIVE_KEY = /(text|password|token|command|content|body|query)/i;
const MAX_DEPTH = 6;
const MAX_STRING = 500;
const MAX_ARRAY = 50;

/**
 * Parameter summary for the audit trail: recursively replaces the values of
 * sensitive keys (free-form text/commands/content and credentials must never
 * land in an audit record) and caps depth/size so a chatty parameter cannot
 * bloat the audit log.
 */
export function redactParams(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => redactParams(item, depth + 1));
    return value.length > MAX_ARRAY ? [...items, `[+${value.length - MAX_ARRAY} more]`] : items;
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : redactParams(item, depth + 1)
      ])
    );
  }
  if (typeof value === "string" && value.length > MAX_STRING) {
    return `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING} chars]`;
  }
  return value;
}
