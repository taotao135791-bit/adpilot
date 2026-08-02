/**
 * Pure keyboard contract for the mission composer. Desktop convention:
 * Enter submits, Shift+Enter inserts a newline. While slash-command
 * completions are visible they own the keyboard: Tab/Enter accept the
 * highlighted candidate, arrows move, Escape dismisses — Enter never
 * submits in that state, so accepting a completion can never fire a
 * half-typed command at the server.
 */
export type ComposerKeyAction =
  | "submit"
  | "accept-completion"
  | "next-completion"
  | "previous-completion"
  | "dismiss-completions"
  | "ignore";

export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** True between compositionstart and compositionend for CJK IMEs. */
  isComposing?: boolean;
  /** Chromium's legacy IME sentinel. Some composition-ending Enter events
   * report `isComposing=false` but still carry keyCode 229. */
  keyCode?: number;
}

export function composerKeyAction(event: ComposerKeyEvent, completionCount: number): ComposerKeyAction {
  // Enter confirms the current IME candidate. Treating it as submit (or as a
  // slash-completion accept) sends half-composed Chinese/Japanese text.
  if (event.isComposing || event.keyCode === 229) return "ignore";
  if (completionCount > 0) {
    if (event.key === "Tab") return "accept-completion";
    if (event.key === "Enter" && !event.shiftKey) return "accept-completion";
    if (event.key === "ArrowDown") return "next-completion";
    if (event.key === "ArrowUp") return "previous-completion";
    if (event.key === "Escape") return "dismiss-completions";
    return "ignore";
  }
  if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) return "submit";
  return "ignore";
}

/**
 * Short label for the composer model chip: the model id without its
 * provider prefix. Falls back to the localized "unassigned" copy when no
 * fast model is configured.
 */
export function modelChipLabel(fastModel: string, unassigned: string): string {
  const trimmed = fastModel.trim();
  if (!trimmed) return unassigned;
  const segment = trimmed.split("/").pop()?.trim();
  return segment || unassigned;
}
