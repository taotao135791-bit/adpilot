import { describe, expect, it } from "vitest";
import { matchSlashCompletions, slashCommandSpecs } from "./slashCommands.js";

describe("slashCommandSpecs", () => {
  it("mirrors the five server commands in both locales", () => {
    expect(slashCommandSpecs("zh-CN").map((spec) => spec.name)).toEqual(["/report", "/audit", "/approvals", "/skills", "/help"]);
    expect(slashCommandSpecs("en").map((spec) => spec.name)).toEqual(["/report", "/audit", "/approvals", "/skills", "/help"]);
    expect(slashCommandSpecs("zh-CN")[0]?.args).toEqual(["daily", "weekly"]);
    expect(slashCommandSpecs("zh-CN")[0]?.description).toContain("日报");
    expect(slashCommandSpecs("en")[0]?.description).toContain("daily/weekly");
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
    expect(all.map((item) => item.label)).toEqual(["/report", "/audit", "/approvals", "/skills", "/help"]);
    expect(all.every((item) => item.kind === "command")).toBe(true);

    const narrowed = matchSlashCompletions("/a", "en");
    expect(narrowed.map((item) => item.label)).toEqual(["/audit", "/approvals"]);

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
