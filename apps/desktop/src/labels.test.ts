import { describe, expect, it } from "vitest";
import {
  automationTriggerText,
  formatUtcTime,
  workspaceCopy
} from "./labels.js";

describe("automation schedule copy", () => {
  const dailyAtNine = {
    kind: "schedule" as const,
    cron: { minute: "0", hour: "9", dom: "*", month: "*", dow: "*" }
  };

  it("labels cron summaries and presets explicitly as UTC", () => {
    expect(automationTriggerText(dailyAtNine, "zh-CN")).toBe("每天 09:00 UTC");
    expect(automationTriggerText(dailyAtNine, "en")).toBe("daily at 09:00 UTC");
    expect(workspaceCopy("zh-CN").presetDailyMorning).toContain("UTC");
    expect(workspaceCopy("zh-CN").presetHourly).toContain("UTC");
    expect(workspaceCopy("en").presetWeeklyMonday).toContain("UTC");
  });

  it("formats the next fire time in UTC independently of the machine timezone", () => {
    expect(formatUtcTime("2026-07-31T09:00:00.000Z", "en")).toMatch(/09:00 UTC$/);
    expect(formatUtcTime("not-a-date", "en")).toBe("not-a-date");
  });

  it("describes new automations as schedule-only", () => {
    expect(workspaceCopy("zh-CN").automationScheduleOnly).toContain("仅支持 UTC 定时计划");
    expect(workspaceCopy("en").automationScheduleOnly).toContain("UTC schedules only");
  });
});
