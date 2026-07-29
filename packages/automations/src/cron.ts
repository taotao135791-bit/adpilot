import { z } from "zod";
import { AutomationsError } from "./errors.js";

/**
 * Controlled cron subset: five fields (minute hour day-of-month month
 * day-of-week), each supporting `*`, comma lists, `a-b` ranges, and `/` steps
 * (`*\/n`, `a-b\/n`, `a\/n` meaning a→max). No names, no macros, no seconds —
 * deliberately small so the scheduler owns the whole semantics. All matching
 * is done in UTC, so daylight-saving transitions cannot skip or double a slot.
 *
 * Day-of-week accepts 0–7 with both 0 and 7 meaning Sunday. When both dom and
 * dow are restricted (neither is `*`), a day matches when EITHER matches — the
 * classic Vixie cron OR rule.
 */

const FIELD_LIMITS = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 7 }
} as const;

export type CronFieldKind = keyof typeof FIELD_LIMITS;

const CronField = z.string().trim().min(1).max(64);

export const CronSpec = z.object({
  minute: CronField,
  hour: CronField,
  dom: CronField,
  month: CronField,
  dow: CronField
}).strict();
export type CronSpec = z.infer<typeof CronSpec>;

export interface ParsedCron {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  /** Normalized to 0–6 (7 folded into 0 = Sunday). */
  dow: number[];
  domAny: boolean;
  dowAny: boolean;
}

const ITEM_PATTERN = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

/** Parse one cron field into the sorted, de-duplicated set of allowed values. */
export function parseCronField(field: string, kind: CronFieldKind): number[] {
  const { min, max } = FIELD_LIMITS[kind];
  const values = new Set<number>();
  for (const rawItem of field.split(",")) {
    const item = rawItem.trim();
    const match = ITEM_PATTERN.exec(item);
    if (!match) throw invalid(kind, field, `unsupported syntax "${item}"`);
    const [, startToken, endToken, stepToken] = match;
    const step = stepToken !== undefined ? Number(stepToken) : 1;
    if (!Number.isInteger(step) || step < 1) throw invalid(kind, field, "step must be a positive integer");
    let lo: number;
    let hi: number;
    if (startToken === "*") {
      if (endToken !== undefined) throw invalid(kind, field, "`*` cannot be part of a range");
      lo = min;
      hi = max;
    } else {
      lo = Number(startToken);
      hi = endToken !== undefined ? Number(endToken) : stepToken !== undefined ? max : lo;
      if (lo < min || lo > max || hi < min || hi > max) {
        throw invalid(kind, field, `value out of range ${min}–${max}`);
      }
      if (lo > hi) throw invalid(kind, field, `range start ${lo} is above range end ${hi}`);
    }
    for (let value = lo; value <= hi; value += step) {
      values.add(kind === "dow" && value === 7 ? 0 : value);
    }
  }
  if (values.size === 0) throw invalid(kind, field, "field selects no values");
  return [...values].sort((left, right) => left - right);
}

/** Validate a full spec and return its parsed, match-ready form. */
export function parseCron(spec: CronSpec): ParsedCron {
  const domField = spec.dom.trim();
  const dowField = spec.dow.trim();
  return {
    minute: parseCronField(spec.minute, "minute"),
    hour: parseCronField(spec.hour, "hour"),
    dom: parseCronField(domField, "dom"),
    month: parseCronField(spec.month, "month"),
    dow: parseCronField(dowField, "dow"),
    domAny: domField === "*",
    dowAny: dowField === "*"
  };
}

function invalid(kind: CronFieldKind, field: string, reason: string): AutomationsError {
  return new AutomationsError(`invalid cron ${kind} field "${field}": ${reason}`, "CRON_INVALID");
}

/** Upper bound for the brute-force search, in days (a full leap year). */
const SEARCH_DAYS = 366;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function dayMatches(parsed: ParsedCron, dayStartMs: number): boolean {
  const day = new Date(dayStartMs);
  if (!parsed.month.includes(day.getUTCMonth() + 1)) return false;
  const domMatch = parsed.dom.includes(day.getUTCDate());
  const dowMatch = parsed.dow.includes(day.getUTCDay());
  // Vixie OR rule: when both fields are restricted, either one suffices.
  if (!parsed.domAny && !parsed.dowAny) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/**
 * Compute the first fire instant strictly after `after` (minute precision,
 * UTC). Returns undefined when the spec never fires within 366 days — e.g.
 * `0 0 31 2 *` — so callers can reject or surface an unschedulable spec.
 */
export function nextFireAt(spec: CronSpec, after: Date): Date | undefined {
  const parsed = parseCron(spec);
  // Candidate search starts at the beginning of the next minute.
  const startMs = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const startDayMs = Math.floor(startMs / DAY_MS) * DAY_MS;
  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    const dayStartMs = startDayMs + offset * DAY_MS;
    if (!dayMatches(parsed, dayStartMs)) continue;
    for (const hour of parsed.hour) {
      for (const minute of parsed.minute) {
        const candidate = dayStartMs + (hour * 60 + minute) * MINUTE_MS;
        if (candidate < startMs) continue;
        if (candidate < dayStartMs + DAY_MS) return new Date(candidate);
      }
    }
  }
  return undefined;
}
