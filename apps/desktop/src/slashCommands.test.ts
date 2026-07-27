import { describe, expect, it } from "vitest";
import { localInsightCommand, matchSlashCompletions, slashCommandSpecs } from "./slashCommands.js";

describe("slashCommandSpecs", () => {
  it("mirrors the five server commands plus two local insight commands in both locales", () => {
    const expected = ["/report", "/audit", "/approvals", "/skills", "/help", "/experiments", "/audit-trail"];
    expect(slashCommandSpecs("zh-CN").map((spec) => spec.name)).toEqual(expected);
    expect(slashCommandSpecs("en").map((spec) => spec.name)).toEqual(expected);
    expect(slashCommandSpecs("zh-CN")[0]?.args).toEqual(["daily", "weekly"]);
    expect(slashCommandSpecs("zh-CN")[0]?.description).toContain("日报");
    expect(slashCommandSpecs("en")[0]?.description).toContain("daily/weekly");
  });
});

describe("localInsightCommand", () => {
  it("maps exact insight commands to their card kind", () => {
    expect(localInsightCommand("/experiments")).toBe("experiments");
    expect(localInsightCommand("  /audit-trail  ")).toBe("audit");
  });

  it("ignores server commands, arguments, and ordinary input", () => {
    expect(localInsightCommand("/audit")).toBeNull();
    expect(localInsightCommand("/experiments all")).toBeNull();
    expect(localInsightCommand("hello")).toBeNull();
  });
});

describe("matchSlashCompletions", () => {
  it("offers no completions for ordinary or multiline input", () => {
    expect(matchSlashCompletions("hello", "en")).toEqual([]);
    expect(matchSlashCompletions(" report daily", "en")).toEqual([]);
    expect(matchSlashCompletions("/report\ndaily", "en")).toEqual([]);
  });

  it("completes command names by prefix and applies with a trailing space when arguments exist", () => {
    const all = matchSlashCompletions("/", "zh-CN");
    expect(all.map((item) => item.label)).toEqual(["/report", "/audit", "/approvals", "/skills", "/help", "/experiments", "/audit-trail"]);
    expect(all.every((item) => item.kind === "command")).toBe(true);

    const narrowed = matchSlashCompletions("/a", "en");
    expect(narrowed.map((item) => item.label)).toEqual(["/audit", "/approvals", "/audit-trail"]);

    const report = matchSlashCompletions("/rep", "en")[0];
    expect(report?.apply("/rep")).toBe("/report ");
    const audit = matchSlashCompletions("/aud", "en")[0];
    expect(audit?.apply("/aud")).toBe("/audit");
  });

  it("completes arguments after a complete command token", () => {
    const candidates = matchSlashCompletions("/report ", "en");
    expect(candidates.map((item) => item.value)).toEqual(["daily", "weekly"]);
    expect(candidates[0]?.kind).toBe("argument");
    expect(candidates[0]?.apply("/report ")).toBe("/report daily");

    expect(matchSlashCompletions("/report w", "en").map((item) => item.value)).toEqual(["weekly"]);
    expect(matchSlashCompletions("/report dai", "en").map((item) => item.value)).toEqual(["daily"]);
    expect(matchSlashCompletions("/report x", "en")).toEqual([]);
    expect(matchSlashCompletions("/report daily extra", "en")).toEqual([]);
  });

  it("offers nothing for unknown or argument-less commands", () => {
    expect(matchSlashCompletions("/bogus ", "en")).toEqual([]);
    expect(matchSlashCompletions("/audit ", "en")).toEqual([]);
    expect(matchSlashCompletions("/help anything", "en")).toEqual([]);
  });
});
