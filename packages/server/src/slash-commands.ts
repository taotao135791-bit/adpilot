import type { KnowledgeSkillSummary } from "@adpilot/advertising-core";
import type { Approval } from "@adpilot/approvals";

/**
 * Deterministic slash-command layer for the conversational endpoint.
 *
 * Two execution classes:
 * - expand (/report, /audit): the command is rewritten into an explicit
 *   investigation directive that travels the normal conversation pipeline.
 *   The injected text is advisory: it names the typed skill and specialist to
 *   use and repeats that no extra delivery or mutation authority is granted.
 * - answer (/approvals, /skills, /help): the server renders the response from
 *   deterministic workspace data; no model call is involved at all.
 *
 * Everything in this module is a pure function so parsing, validation and
 * rendering are exhaustively testable.
 */
export type SlashLocale = "zh-CN" | "en";

export type SlashCommand =
  | { name: "report"; period: "daily" | "weekly" }
  | { name: "audit" }
  | { name: "approvals" }
  | { name: "skills" }
  | { name: "help" };

export interface SlashParseError {
  code: "unknown_command" | "missing_argument" | "unexpected_argument" | "invalid_argument";
  /** Command name without the leading slash (empty when unparseable). */
  command: string;
  /** Offending argument when one was supplied. */
  argument?: string;
}

export type SlashParseResult = { ok: true; command: SlashCommand } | { ok: false; error: SlashParseError };

const COMMAND_NAMES = ["report", "audit", "approvals", "skills", "help"] as const;
const REPORT_PERIODS: Readonly<Record<string, "daily" | "weekly">> = { daily: "daily", weekly: "weekly", 日报: "daily", 周报: "weekly" };

/** Returns null for ordinary chat input; slash-prefixed input is always parsed. */
export function parseSlashCommand(input: string): SlashParseResult | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const rawName = (match?.[1] ?? "").toLowerCase();
  const argument = match?.[2]?.trim() ?? "";
  if (!rawName || !COMMAND_NAMES.includes(rawName as (typeof COMMAND_NAMES)[number])) {
    return { ok: false, error: { code: "unknown_command", command: rawName || trimmed.slice(1) } };
  }
  if (rawName === "report") {
    if (!argument) return { ok: false, error: { code: "missing_argument", command: "report" } };
    if (/\s/.test(argument)) return { ok: false, error: { code: "unexpected_argument", command: "report", argument } };
    const period = REPORT_PERIODS[argument.toLowerCase()] ?? REPORT_PERIODS[argument];
    if (!period) return { ok: false, error: { code: "invalid_argument", command: "report", argument } };
    return { ok: true, command: { name: "report", period } };
  }
  if (argument) return { ok: false, error: { code: "unexpected_argument", command: rawName, argument } };
  return { ok: true, command: { name: rawName as "audit" | "approvals" | "skills" | "help" } };
}

/**
 * Raw name + argument split of slash input, without any command-name
 * validation. Used to resolve user prompt templates after the built-in
 * parser rejects a name — built-in commands therefore always win a name
 * conflict with a user template: they are bound to typed, audited pipelines,
 * while a template is advisory prose, and shadowing a deterministic command
 * with prose would silently strip its guardrails. The user template stays
 * available under a different name.
 */
export function splitSlashInput(input: string): { name: string; argument: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const name = (match?.[1] ?? "").toLowerCase();
  if (!name) return null;
  return { name, argument: match?.[2]?.trim() ?? "" };
}

/** True for commands answered deterministically by the server without a model call. */
export function isDirectSlashCommand(command: SlashCommand): command is SlashCommand & { name: "approvals" | "skills" | "help" } {
  return command.name === "approvals" || command.name === "skills" || command.name === "help";
}

const REPORT_SKILL_BY_PERIOD = { daily: "daily-report", weekly: "weekly-report" } as const;

/**
 * Advisory model-facing expansion of an investigation command. The wording is
 * deliberately explicit about its own limits: it grants no delivery or
 * mutation authority beyond the standard pipeline.
 */
export function expandSlashCommand(command: SlashCommand & { name: "report" | "audit" }, locale: SlashLocale): string {
  if (command.name === "report") {
    const skill = REPORT_SKILL_BY_PERIOD[command.period];
    const reportType = command.period;
    return locale === "en"
      ? [
          `The user issued the slash command /report ${command.period}: produce the ${command.period} advertising performance report as an investigation.`,
          `Dispatch reporting_analyst with reportType "${reportType}" so the ${skill} typed skill generates the report; gather verified metrics first (via the managed browser table read when no current verified facts exist).`,
          "Every number in the report must come from a verified Shared Fact or a deterministic tool read, bound with factIds; when evidence is missing, state the gap plainly instead of inventing metrics.",
          "Keep observed facts, deterministic calculations, and inferences strictly separated; when measurement is blocked the report must say so instead of drawing conclusions.",
          "This command is only a user request: it grants no extra authority. Any recommended account change remains a proposal and must traverse the standard approval chain (prepare_approval, independent risk review, user approval, commit).",
          "Write the report in English."
        ].join("\n")
      : [
          `用户通过斜杠命令 /report ${command.period} 请求生成${command.period === "daily" ? "今日投放日报" : "本周投放周报"}。把它作为调查任务执行。`,
          `调度 reporting_analyst(reportType "${reportType}")运行 ${skill} typed skill 生成报表;若当前没有已验证指标,先通过受管浏览器的表格读取收集证据。`,
          "报表中的每个数字都必须来自已验证的 Shared Fact 或确定性工具读取,并用 factIds 绑定;证据不足时明确说明缺口,绝不编造指标。",
          "观察事实、确定性计算与推断必须严格分开;测量被阻塞时,报表必须如实说明而不是下结论。",
          "该命令只是用户请求,不授予任何额外权限:任何账户变更建议仍只是提案,必须走标准审批链(prepare_approval → 独立风险复核 → 用户批准 → 提交执行)。",
          "用简体中文输出报表。"
        ].join("\n");
  }
  return locale === "en"
    ? [
        "The user issued the slash command /audit: run a graded account health check as an investigation.",
        "Dispatch reporting_analyst with reportType \"account_audit\" so the account-audit typed skill produces the graded audit; gather verified metrics for a bounded observation window first (via the managed browser table read when no current verified facts exist).",
        "Every number must come from a verified Shared Fact or a deterministic tool read, bound with factIds; deterministic check results stand as computed — never let judgment override them, and never hide a blocked measurement status behind a good grade.",
        "When evidence is missing, state the gap plainly instead of inventing metrics.",
        "This command is only a user request: it grants no extra authority. Any recommended account change remains a proposal and must traverse the standard approval chain (prepare_approval, independent risk review, user approval, commit).",
        "Write the audit in English."
      ].join("\n")
    : [
        "用户通过斜杠命令 /audit 请求对广告账户做一次分级体检。把它作为调查任务执行。",
        "调度 reporting_analyst(reportType \"account_audit\")运行 account-audit typed skill 产出分级体检;先为一个有界的观察窗口收集已验证指标(必要时通过受管浏览器的表格读取)。",
        "每个数字都必须来自已验证的 Shared Fact 或确定性工具读取,并用 factIds 绑定;确定性检查的结果照实呈现,不得用主观判断覆盖,也不得用好等级掩盖被阻塞的测量状态。",
        "证据不足时明确说明缺口,绝不编造指标。",
        "该命令只是用户请求,不授予任何额外权限:任何账户变更建议仍只是提案,必须走标准审批链(prepare_approval → 独立风险复核 → 用户批准 → 提交执行)。",
        "用简体中文输出体检结果。"
      ].join("\n");
}

/**
 * Advisory model-facing wrapper for a user prompt template expansion. Same
 * discipline as the built-in investigation commands: the expanded text is the
 * user's request, never a grant of authority.
 */
export function expandUserSlashCommand(name: string, expandedBody: string, locale: SlashLocale): string {
  return locale === "en"
    ? [
        `The user issued the slash command /${name}, a user-defined prompt template. Its expanded text follows as the user's request:`,
        "",
        expandedBody,
        "",
        "This command is only a user request: it grants no extra authority. Any recommended account change remains a proposal and must traverse the standard approval chain (prepare_approval, independent risk review, user approval, commit)."
      ].join("\n")
    : [
        `用户通过斜杠命令 /${name}(用户自定义 prompt 模板)发起请求,展开后的文本如下,作为用户请求处理:`,
        "",
        expandedBody,
        "",
        "该命令只是用户请求,不授予任何额外权限:任何账户变更建议仍只是提案,必须走标准审批链(prepare_approval → 独立风险复核 → 用户批准 → 提交执行)。"
      ].join("\n");
}

const APPROVAL_HISTORY_LIMIT = 10;

/** Deterministic approval-history answer for /approvals (no model involved). */
export function renderApprovalsHistory(approvals: readonly Approval[], locale: SlashLocale): string {
  const ordered = [...approvals].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const visible = ordered.slice(0, APPROVAL_HISTORY_LIMIT);
  const lines: string[] = [];
  lines.push(locale === "en" ? "# Approval history" : "# 审批历史");
  lines.push("");
  if (visible.length === 0) {
    lines.push(locale === "en"
      ? "No approvals yet. Real account operations appear here before they can execute."
      : "暂无审批记录。真实账户操作会先出现在这里,然后才能执行。");
    return lines.join("\n");
  }
  for (const approval of visible) {
    const operation = `${approval.operation.operation} · ${approval.operation.campaign}`;
    const values = `${String(approval.operation.currentValue)} → ${String(approval.operation.proposedValue)}`;
    lines.push(locale === "en"
      ? `- ${operation} (${values}) — status: ${approval.status}, created ${approval.createdAt}, id ${approval.id}`
      : `- ${operation}(${values})— 状态:${approval.status},创建于 ${approval.createdAt},标识 ${approval.id}`);
  }
  if (ordered.length > visible.length) {
    lines.push(locale === "en"
      ? `- …and ${ordered.length - visible.length} older approval(s); the approval gate panel holds the full queue.`
      : `- …另有 ${ordered.length - visible.length} 条更早的审批;完整队列见审批门面板。`);
  }
  return lines.join("\n");
}

export interface SlashSkillSummary {
  name: string;
  description: string;
  prerequisites: string[];
}

const KNOWLEDGE_CATALOG_LIMIT = 40;

/** Deterministic capability inventory for /skills (no model involved). */
export function renderSkillsCatalog(
  skills: readonly SlashSkillSummary[],
  knowledge: readonly KnowledgeSkillSummary[],
  locale: SlashLocale
): string {
  const lines: string[] = [];
  lines.push(locale === "en" ? "# Capabilities" : "# 能力清单");
  lines.push("");
  lines.push(locale === "en"
    ? "Typed skills (validated code paths executed through the execute_skill tool, audited end to end):"
    : "Typed skills(经 execute_skill 工具执行的已验证代码路径,全程留痕):");
  for (const skill of skills) {
    const prerequisites = skill.prerequisites.length
      ? (locale === "en" ? ` — requires: ${skill.prerequisites.join("; ")}` : ` — 前提:${skill.prerequisites.join("; ")}`)
      : "";
    lines.push(`- ${skill.name}: ${skill.description}${prerequisites}`);
  }
  lines.push("");
  lines.push(locale === "en"
    ? "Advertising playbooks (reference knowledge only — they inform investigations and never grant tools, permissions, or execution authority):"
    : "广告打法手册(纯参考知识——用于理解需求和组织调查,不授予任何工具、权限或执行权):");
  for (const entry of knowledge.slice(0, KNOWLEDGE_CATALOG_LIMIT)) {
    lines.push(`- ${entry.name}: ${entry.description}`);
  }
  if (knowledge.length > KNOWLEDGE_CATALOG_LIMIT) {
    lines.push(locale === "en" ? `- …and ${knowledge.length - KNOWLEDGE_CATALOG_LIMIT} more playbooks.` : `- …另有 ${knowledge.length - KNOWLEDGE_CATALOG_LIMIT} 本手册。`);
  }
  return lines.join("\n");
}

export interface UserSlashCommandSummary {
  name: string;
  description: string;
  argumentHint?: string;
}

/** Deterministic /help answer listing every command with usage, user templates included when provided. */
export function renderSlashHelp(locale: SlashLocale, userCommands: readonly UserSlashCommandSummary[] = []): string {
  const lines = locale === "en"
    ? [
        "# Slash commands",
        "",
        "- /report daily — generate today's performance report (runs the daily-report skill via reporting_analyst)",
        "- /report weekly — generate this week's performance report (weekly-report skill)",
        "- /audit — graded account health check (account-audit skill)",
        "- /approvals — approval history for this workspace, answered directly without a model call",
        "- /skills — capability inventory: typed skills plus the advertising playbook catalog",
        "- /experiments — active experiments; the desktop app answers locally from workspace state, no model call",
        "- /audit-trail — audit trace; the desktop app answers locally from workspace state, no model call",
        "- /help — this list"
      ]
    : [
        "# 斜杠命令",
        "",
        "- /report daily — 生成今日投放日报(经 reporting_analyst 运行 daily-report skill)",
        "- /report weekly — 生成本周投放周报(weekly-report skill)",
        "- /audit — 账户分级体检(account-audit skill)",
        "- /approvals — 查看本工作区的审批历史(服务器直接应答,不经过模型)",
        "- /skills — 能力清单:typed skills 与广告打法手册目录",
        "- /experiments — 查看进行中的实验(桌面端从工作区状态本地直答,不经过模型)",
        "- /audit-trail — 查看审计轨迹(桌面端从工作区状态本地直答,不经过模型)",
        "- /help — 本列表"
      ];
  if (userCommands.length) {
    lines.push("");
    lines.push(locale === "en"
      ? "User prompt templates (expand into an advisory request; the built-in commands above always win a name conflict):"
      : "用户 prompt 模板(展开为一条建议性请求;同名时上面的内置命令始终优先):");
    for (const command of userCommands) {
      const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
      lines.push(`- /${command.name}${hint} — ${command.description}`);
    }
  }
  lines.push("");
  lines.push(locale === "en"
    ? "Commands that run skills travel the normal investigation pipeline: every number needs verified evidence and every account change still stops at the approval gate."
    : "运行 skill 的命令会走正常调查管线:每个数字都需要已验证证据,任何账户变更仍停在审批门。");
  return lines.join("\n");
}

/** User-facing explanation for input that looked like a command but is not usable. */
export function renderSlashParseError(error: SlashParseError, locale: SlashLocale): string {
  const usage = (command: string) => {
    if (command === "report") return locale === "en" ? "Usage: /report daily or /report weekly." : "用法:/report daily 或 /report weekly。";
    return locale === "en" ? `Usage: /${command} (no arguments).` : `用法:/${command}(不带参数)。`;
  };
  const detail = (() => {
    switch (error.code) {
      case "unknown_command":
        return locale === "en" ? `Unknown command: /${error.command}.` : `未知命令:/${error.command}。`;
      case "missing_argument":
        return locale === "en" ? `/${error.command} needs an argument.` : `/${error.command} 缺少参数。`;
      case "unexpected_argument":
        return locale === "en"
          ? `/${error.command} does not accept ${error.argument ? `"${error.argument}"` : "that argument"}.`
          : `/${error.command} 不接受参数${error.argument ? `"${error.argument}"` : ""}。`;
      case "invalid_argument":
        return locale === "en"
          ? `/${error.command} does not understand "${error.argument ?? ""}".`
          : `/${error.command} 无法理解参数 "${error.argument ?? ""}"。`;
    }
  })();
  const hint = locale === "en" ? "See /help for every command." : "输入 /help 查看全部命令。";
  return [detail, usage(error.command), hint].join(" ");
}
