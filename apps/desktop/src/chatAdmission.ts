import { localInsightCommand } from "./slashCommands.js";

export type ChatGoalAdmission = "accepted" | "empty" | "busy" | "model_required";

/**
 * Synchronous admission check for Home's draft hand-off. The view clears its
 * local textarea only after `accepted`, so opening model setup cannot destroy
 * the user's first task.
 */
export function chatGoalAdmission(
  message: string,
  options: { busy: boolean; chatConfigured: boolean }
): ChatGoalAdmission {
  const normalized = message.trim();
  if (!normalized) return "empty";
  if (options.busy) return "busy";
  const localOnly = normalized.startsWith("/") || Boolean(localInsightCommand(normalized));
  return options.chatConfigured || localOnly ? "accepted" : "model_required";
}
