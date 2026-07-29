import { describe, expect, it } from "vitest";
import { AutomationsError } from "./errors.js";
import { nextFireAt, parseCronField } from "./cron.js";

const at = (iso: string) => new Date(iso);
const iso = (date: Date | undefined) => date?.toISOString();

describe("parseCronField", () => {
  it("parses wildcards, single values, lists, ranges, and steps", () => {
    expect(parseCronField("*", "minute")).toHaveLength(60);
    expect(parseCronField("5", "minute")).toEqual([5]);
    expect(parseCronField("5,10,20", "minute")).toEqual([5, 10, 20]);
    expect(parseCronField("1-5", "hour")).toEqual([1, 2, 3, 4, 5]);
    expect(parseCronField("*/15", "minute")).toEqual([0, 15, 30, 45]);
    expect(parseCronField("10-30/10", "minute")).toEqual([10, 20, 30]);
    expect(parseCronField("5/20", "minute")).toEqual([5, 25, 45]);
  });

  it("folds day-of-week 7 into 0 (Sunday) and de-duplicates", () => {
    expect(parseCronField("0", "dow")).toEqual([0]);
    expect(parseCronField("7", "dow")).toEqual([0]);
    expect(parseCronField("0,7", "dow")).toEqual([0]);
    expect(parseCronField("5-7", "dow")).toEqual([0, 5, 6]);
  });

  it("rejects out-of-range values, inverted ranges, bad steps, and junk with CRON_INVALID", () => {
    for (const field of ["60", "-1", "1-60"]) {
      expect(() => parseCronField(field, "minute")).toThrowError(AutomationsError);
    }
    expect(() => parseCronField("5-1", "hour")).toThrowError(/range start/);
    expect(() => parseCronField("*/0", "minute")).toThrowError(/step/);
    expect(() => parseCronField("abc", "minute")).toThrowError(/unsupported syntax/);
    expect(() => parseCronField("1,,2", "minute")).toThrowError(/unsupported syntax/);
    expect(() => parseCronField("*-5", "minute")).toThrowError(/cannot be part of a range/);
    for (const field of ["0", "32"]) {
      expect(() => parseCronField(field, "dom")).toThrowError(/out of range/);
    }
    try {
      parseCronField("99", "month");
      expect.unreachable();
    } catch (error) {
      expect((error as AutomationsError).code).toBe("CRON_INVALID");
    }
  });
});

describe("nextFireAt", () => {
  it("fires at the next matching minute, strictly after `after`", () => {
    const cron = { minute: "0", hour: "9", dom: "*", month: "*", dow: "*" };
    expect(iso(nextFireAt(cron, at("2026-07-28T08:30:00.000Z")))).toBe("2026-07-28T09:00:00.000Z");
    // The exact fire instant is not "after" — the next slot is tomorrow.
    expect(iso(nextFireAt(cron, at("2026-07-28T09:00:00.000Z")))).toBe("2026-07-29T09:00:00.000Z");
    // Seconds never leak into the slot.
    expect(iso(nextFireAt(cron, at("2026-07-28T08:59:59.999Z")))).toBe("2026-07-28T09:00:00.000Z");
  });

  it("handles every-minute and stepped schedules", () => {
    const everyMinute = { minute: "*", hour: "*", dom: "*", month: "*", dow: "*" };
    expect(iso(nextFireAt(everyMinute, at("2026-07-28T00:00:00.000Z")))).toBe("2026-07-28T00:01:00.000Z");
    const stepped = { minute: "*/15", hour: "*", dom: "*", month: "*", dow: "*" };
    expect(iso(nextFireAt(stepped, at("2026-07-28T00:07:00.000Z")))).toBe("2026-07-28T00:15:00.000Z");
    expect(iso(nextFireAt(stepped, at("2026-07-28T00:45:00.000Z")))).toBe("2026-07-28T01:00:00.000Z");
    const everySixHours = { minute: "0", hour: "*/6", dom: "*", month: "*", dow: "*" };
    expect(iso(nextFireAt(everySixHours, at("2026-07-28T05:00:00.000Z")))).toBe("2026-07-28T06:00:00.000Z");
  });

  it("honors ranges and weekday windows", () => {
    const workHours = { minute: "0", hour: "9-17", dom: "*", month: "*", dow: "1-5" };
    // Tuesday 2026-07-28, 16:30 → 17:00 same day.
    expect(iso(nextFireAt(workHours, at("2026-07-28T16:30:00.000Z")))).toBe("2026-07-28T17:00:00.000Z");
    // Friday 2026-07-31 after 17:00 → Monday 2026-08-03 09:00 (skips the weekend).
    expect(iso(nextFireAt(workHours, at("2026-07-31T17:00:00.000Z")))).toBe("2026-08-03T09:00:00.000Z");
  });

  it("treats day-of-week 0 and 7 identically (Sunday)", () => {
    const after = at("2026-07-28T00:00:00.000Z"); // Tuesday
    const sunday0 = { minute: "30", hour: "8", dom: "*", month: "*", dow: "0" };
    const sunday7 = { minute: "30", hour: "8", dom: "*", month: "*", dow: "7" };
    expect(iso(nextFireAt(sunday0, after))).toBe("2026-08-02T08:30:00.000Z");
    expect(iso(nextFireAt(sunday7, after))).toBe("2026-08-02T08:30:00.000Z");
  });

  it("applies the Vixie OR rule when both dom and dow are restricted", () => {
    // 13th of the month OR any Friday.
    const cron = { minute: "0", hour: "0", dom: "13", month: "*", dow: "5" };
    // Wednesday 2026-07-01 → next Friday is 2026-07-03.
    expect(iso(nextFireAt(cron, at("2026-07-01T00:00:00.000Z")))).toBe("2026-07-03T00:00:00.000Z");
    // Saturday 2026-07-04 → next hit is Friday the 10th, before the 13th.
    expect(iso(nextFireAt(cron, at("2026-07-04T00:00:00.000Z")))).toBe("2026-07-10T00:00:00.000Z");
    // After Friday the 10th → Monday the 13th wins.
    expect(iso(nextFireAt(cron, at("2026-07-10T00:00:00.000Z")))).toBe("2026-07-13T00:00:00.000Z");
  });

  it("skips months without the requested day-of-month", () => {
    const thirtyFirst = { minute: "0", hour: "0", dom: "31", month: "*", dow: "*" };
    // 2026-09-01 → September has 30 days; next 31st is October.
    expect(iso(nextFireAt(thirtyFirst, at("2026-09-01T00:00:00.000Z")))).toBe("2026-10-31T00:00:00.000Z");
    const leapDay = { minute: "0", hour: "0", dom: "29", month: "2", dow: "*" };
    expect(iso(nextFireAt(leapDay, at("2027-03-01T00:00:00.000Z")))).toBe("2028-02-29T00:00:00.000Z");
  });

  it("returns undefined for a schedule that can never fire (Feb 31st)", () => {
    const impossible = { minute: "0", hour: "0", dom: "31", month: "2", dow: "*" };
    expect(nextFireAt(impossible, at("2026-01-01T00:00:00.000Z"))).toBeUndefined();
  });

  it("resolves rare yearly schedules within the 366-day search bound", () => {
    const newYear = { minute: "30", hour: "4", dom: "1", month: "1", dow: "*" };
    expect(iso(nextFireAt(newYear, at("2026-01-01T04:30:00.000Z")))).toBe("2027-01-01T04:30:00.000Z");
  });

  it("throws CRON_INVALID for malformed specs", () => {
    const bad = { minute: "99", hour: "*", dom: "*", month: "*", dow: "*" };
    expect(() => nextFireAt(bad, at("2026-01-01T00:00:00.000Z"))).toThrowError(AutomationsError);
  });
});
