import type { AppLocale } from "./i18n.js";

/**
 * Client-side mirror of the server's slash-command grammar, used only for
 * composer autocompletion. The server remains the authority: it parses,
 * validates and executes every command; these hints never decide behavior.
 */
export interface SlashCommandSpec {
  name: string;
  args: readonly string[];
  description: string;
  argumentHint?: string;
}

export function slashCommandSpecs(locale: AppLocale): SlashCommandSpec[] {
  const zh = locale === "zh-CN";
  return [
    {
      name: "/report",
      args: ["daily", "weekly"],
      description: zh ? "生成投放日报/周报(经 reporting_analyst)" : "Generate the daily/weekly performance report",
      argumentHint: "daily | weekly"
    },
    { name: "/audit", args: [], description: zh ? "账户分级体检(account-audit)" : "Graded account health check (account-audit)" },
    { name: "/approvals", args: [], description: zh ? "查看审批历史(直接应答)" : "Approval history (answered directly)" },
    { name: "/skills", args: [], description: zh ? "能力清单与打法手册目录" : "Capability inventory and playbook catalog" },
    { name: "/help", args: [], description: zh ? "命令列表与用法" : "List every command with usage" }
  ];
}

export interface SlashCompletion {
  kind: "command" | "argument";
  /** Text shown in the suggestion row. */
  label: string;
  /** Token the suggestion completes to. */
  value: string;
  hint: string;
  /** Produces the full composer value after accepting the suggestion. */
  apply: (current: string) => string;
}

/**
 * Completion candidates for the current composer value. Only single-line
 * input starting with "/" completes; anything else returns no candidates.
 * After a complete command token, argument candidates complete by prefix.
 */
export function matchSlashCompletions(input: string, locale: AppLocale): SlashCompletion[] {
  if (!input.startsWith("/") || input.includes("\n")) return [];
  const specs = slashCommandSpecs(locale);
  const firstSpace = input.search(/\s/);
  if (firstSpace < 0) {
    return specs
      .filter((spec) => spec.name.startsWith(input))
      .map((spec) => ({
        kind: "command" as const,
        label: spec.name,
        value: spec.name,
        hint: spec.argumentHint && spec.name === input ? `${spec.description} — ${spec.argumentHint}` : spec.description,
        apply: () => (spec.args.length ? `${spec.name} ` : spec.name)
      }));
  }
  const commandToken = input.slice(0, firstSpace);
  const spec = specs.find((candidate) => candidate.name === commandToken);
  if (!spec || spec.args.length === 0) return [];
  const rest = input.slice(firstSpace).trimStart();
  if (/\s/.test(rest)) return [];
  return spec.args
    .filter((argument) => argument.startsWith(rest))
    .map((argument) => ({
      kind: "argument" as const,
      label: `${spec.name} ${argument}`,
      value: argument,
      hint: spec.description,
      apply: () => `${spec.name} ${argument}`
    }));
}
