import { describe, expect, it } from "vitest";
import type { Approval } from "@adpilot/approvals";
import {
  expandSlashCommand,
  expandUserSlashCommand,
  isDirectSlashCommand,
  parseSlashCommand,
  renderApprovalsHistory,
  renderSkillsCatalog,
  renderSlashHelp,
  renderSlashParseError,
  splitSlashInput
} from "./slash-commands.js";

function approval(overrides: { id: string; status: Approval["status"]; createdAt: string; campaign?: string }): Approval {
  return {
    schemaVersion: 2,
    id: overrides.id,
    clientId: "client-a",
    taskId: crypto.randomUUID(),
    operation: {
      platform: "google_ads", account: "acct", campaign: overrides.campaign ?? "campaign-a", operation: "set_daily_budget",
      currentValue: 100, proposedValue: 110, changePercentage: 10,
      reason: "controlled increase", evidence: ["workspace:baseline"], expectedImpact: "more volume",
      observationWindow: "7 days", rollbackCondition: "CPA exceeds 12", riskLevel: "mutate"
    },
    guardrail: null, guardrailFingerprint: null,
    executionPlan: null, executionPlanFingerprint: null,
    fingerprint: "f".repeat(64),
    status: overrides.status,
    riskReview: null, userApproval: null,
    tokenNonceHash: null, tokenExpiresAt: null, tokenBinding: null, tokenAttempts: 0,
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt
  };
}

describe("parseSlashCommand", () => {
  it("returns null for ordinary chat input", () => {
    expect(parseSlashCommand("how is my account doing?")).toBeNull();
    expect(parseSlashCommand("  帮我看看账户  ")).toBeNull();
    expect(parseSlashCommand("a / report")).toBeNull();
  });

  it("parses investigation and direct commands with validated arguments", () => {
    expect(parseSlashCommand("/report daily")).toEqual({ ok: true, command: { name: "report", period: "daily" } });
    expect(parseSlashCommand("/report weekly")).toEqual({ ok: true, command: { name: "report", period: "weekly" } });
    expect(parseSlashCommand("/REPORT   Daily")).toEqual({ ok: true, command: { name: "report", period: "daily" } });
    expect(parseSlashCommand("/report 日报")).toEqual({ ok: true, command: { name: "report", period: "daily" } });
    expect(parseSlashCommand("/report 周报")).toEqual({ ok: true, command: { name: "report", period: "weekly" } });
    expect(parseSlashCommand("/audit")).toEqual({ ok: true, command: { name: "audit" } });
    expect(parseSlashCommand("/approvals")).toEqual({ ok: true, command: { name: "approvals" } });
    expect(parseSlashCommand("/skills")).toEqual({ ok: true, command: { name: "skills" } });
    expect(parseSlashCommand("/help")).toEqual({ ok: true, command: { name: "help" } });
  });

  it("rejects unknown commands and malformed arguments with structured errors", () => {
    expect(parseSlashCommand("/bogus")).toEqual({ ok: false, error: { code: "unknown_command", command: "bogus" } });
    expect(parseSlashCommand("/")).toEqual({ ok: false, error: { code: "unknown_command", command: "" } });
    expect(parseSlashCommand("/report")).toEqual({ ok: false, error: { code: "missing_argument", command: "report" } });
    expect(parseSlashCommand("/report monthly")).toEqual({ ok: false, error: { code: "invalid_argument", command: "report", argument: "monthly" } });
    expect(parseSlashCommand("/report daily extra")).toEqual({ ok: false, error: { code: "unexpected_argument", command: "report", argument: "daily extra" } });
    expect(parseSlashCommand("/audit now")).toEqual({ ok: false, error: { code: "unexpected_argument", command: "audit", argument: "now" } });
    expect(parseSlashCommand("/skills please")).toEqual({ ok: false, error: { code: "unexpected_argument", command: "skills", argument: "please" } });
  });
});

describe("expandSlashCommand", () => {
  it("rewrites /report into an explicit advisory reporting directive", () => {
    const daily = expandSlashCommand({ name: "report", period: "daily" }, "zh-CN");
    expect(daily).toContain("reporting_analyst");
    expect(daily).toContain("daily-report");
    expect(daily).toContain("/report daily");
    expect(daily).toContain("不授予任何额外权限");
    expect(daily).toContain("审批链");
    const weekly = expandSlashCommand({ name: "report", period: "weekly" }, "en");
    expect(weekly).toContain("weekly-report");
    expect(weekly).toContain('reportType "weekly"');
    expect(weekly).toContain("grants no extra authority");
  });

  it("rewrites /audit into an explicit advisory account-audit directive", () => {
    const zh = expandSlashCommand({ name: "audit" }, "zh-CN");
    expect(zh).toContain("account-audit");
    expect(zh).toContain("reporting_analyst");
    expect(zh).toContain("不授予任何额外权限");
    const en = expandSlashCommand({ name: "audit" }, "en");
    expect(en).toContain("/audit");
    expect(en).toContain("account-audit");
    expect(en).toContain("grants no extra authority");
  });
});

describe("direct-answer renderers", () => {
  it("classifies direct commands", () => {
    expect(isDirectSlashCommand({ name: "approvals" })).toBe(true);
    expect(isDirectSlashCommand({ name: "skills" })).toBe(true);
    expect(isDirectSlashCommand({ name: "help" })).toBe(true);
    expect(isDirectSlashCommand({ name: "report", period: "daily" })).toBe(false);
    expect(isDirectSlashCommand({ name: "audit" })).toBe(false);
  });

  it("renders an empty approval history and a bounded newest-first list", () => {
    expect(renderApprovalsHistory([], "zh-CN")).toContain("暂无审批记录");
    expect(renderApprovalsHistory([], "en")).toContain("No approvals yet");
    const approvals = Array.from({ length: 12 }, (_, index) => approval({
      id: crypto.randomUUID(),
      status: index === 11 ? "pending_user" : "executed",
      createdAt: new Date(Date.UTC(2026, 6, 22, index)).toISOString(),
      campaign: `campaign-${index}`
    }));
    const rendered = renderApprovalsHistory(approvals, "en");
    const lines = rendered.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(11);
    expect(lines[0]).toContain("campaign-11");
    expect(lines[0]).toContain("pending_user");
    expect(lines[0]).toContain("100 → 110");
    expect(lines.at(-1)).toContain("2 older approval(s)");
  });

  it("renders typed skills with prerequisites and the knowledge playbook catalog", () => {
    const rendered = renderSkillsCatalog(
      [
        { name: "daily-report", description: "Generate a daily performance report.", prerequisites: ["Verified metrics", "Account timezone"] },
        { name: "account-audit", description: "Graded account health audit.", prerequisites: [] }
      ],
      [{ name: "ads-google", description: "Google Ads deep analysis.", triggers: ["google ads"] }],
      "en"
    );
    expect(rendered).toContain("# Capabilities");
    expect(rendered).toContain("- daily-report: Generate a daily performance report. — requires: Verified metrics; Account timezone");
    expect(rendered).toContain("- account-audit: Graded account health audit.");
    expect(rendered).toContain("never grant tools, permissions, or execution authority");
    expect(rendered).toContain("- ads-google: Google Ads deep analysis.");
    const zh = renderSkillsCatalog([], [], "zh-CN");
    expect(zh).toContain("# 能力清单");
  });

  it("renders the help catalog with every command", () => {
    const help = renderSlashHelp("zh-CN");
    for (const command of ["/report daily", "/report weekly", "/audit", "/approvals", "/skills", "/help"]) {
      expect(help).toContain(command);
    }
    expect(renderSlashHelp("en")).toContain("Slash commands");
  });

  it("explains parse failures with usage and a /help hint in both locales", () => {
    const unknown = renderSlashParseError({ code: "unknown_command", command: "bogus" }, "zh-CN");
    expect(unknown).toContain("未知命令:/bogus");
    expect(unknown).toContain("/help");
    const missing = renderSlashParseError({ code: "missing_argument", command: "report" }, "en");
    expect(missing).toContain("/report needs an argument");
    expect(missing).toContain("Usage: /report daily or /report weekly.");
    const invalid = renderSlashParseError({ code: "invalid_argument", command: "report", argument: "monthly" }, "en");
    expect(invalid).toContain('"monthly"');
    const unexpected = renderSlashParseError({ code: "unexpected_argument", command: "audit", argument: "now" }, "zh-CN");
    expect(unexpected).toContain("/audit 不接受参数");
    expect(unexpected).toContain("/help");
  });
});

describe("user prompt template commands", () => {
  it("splitSlashInput extracts the lowercased name and raw argument string", () => {
    expect(splitSlashInput("/review weekly report")).toEqual({ name: "review", argument: "weekly report" });
    expect(splitSlashInput("/REVIEW")).toEqual({ name: "review", argument: "" });
    expect(splitSlashInput('  /note "quoted arg"  ')).toEqual({ name: "note", argument: '"quoted arg"' });
    expect(splitSlashInput("plain chat")).toBeNull();
    expect(splitSlashInput("/")).toBeNull();
  });

  it("renderSlashHelp merges user templates after the built-ins with conflict precedence noted", () => {
    const en = renderSlashHelp("en", [
      { name: "review", description: "Review a client report", argumentHint: "<name>" },
      { name: "note", description: "Jot an observation" }
    ]);
    expect(en).toContain("User prompt templates");
    expect(en).toContain("- /review <name> — Review a client report");
    expect(en).toContain("- /note — Jot an observation");
    expect(en).toContain("always win a name conflict");
    const zh = renderSlashHelp("zh-CN", [{ name: "review", description: "复核甲方报表" }]);
    expect(zh).toContain("用户 prompt 模板");
    expect(zh).toContain("内置命令始终优先");
    // Without user commands the catalog is byte-identical to the built-in-only form.
    expect(renderSlashHelp("en", [])).toBe(renderSlashHelp("en"));
  });

  it("expandUserSlashCommand frames the expansion as an advisory request in both locales", () => {
    const en = expandUserSlashCommand("review", "Review the weekly report.", "en");
    expect(en).toContain("/review");
    expect(en).toContain("user-defined prompt template");
    expect(en).toContain("Review the weekly report.");
    expect(en).toContain("grants no extra authority");
    expect(en).toContain("prepare_approval");
    const zh = expandUserSlashCommand("review", "复核本周报表。", "zh-CN");
    expect(zh).toContain("用户自定义 prompt 模板");
    expect(zh).toContain("复核本周报表。");
    expect(zh).toContain("不授予任何额外权限");
  });

  it("built-in parsing still owns builtin names, so user templates never shadow them", () => {
    // A user template named "report" exists or not, /report daily parses as the built-in.
    expect(parseSlashCommand("/report daily")).toEqual({ ok: true, command: { name: "report", period: "daily" } });
    expect(parseSlashCommand("/help")).toEqual({ ok: true, command: { name: "help" } });
    // And unknown names fall through to template resolution with a clean error otherwise.
    expect(parseSlashCommand("/review x")).toEqual({ ok: false, error: { code: "unknown_command", command: "review" } });
  });
});
