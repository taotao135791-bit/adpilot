import { useEffect, useMemo, useState } from "react";
import type { AppLocale, ConsoleCopy } from "../labels.js";
import { matchSlashCompletions, type SlashCompletion } from "../slashCommands.js";
import { Button, Textarea } from "../ui.js";
import { IconSend } from "../icons.js";

/**
 * Mission composer with slash-command completion. The input value is owned
 * by the parent (MissionZero starter picks write into it); completion list
 * state is local. Keyboard: ⌘/Ctrl+Enter submits, Tab/Enter accepts the
 * highlighted completion, arrows move, Escape dismisses.
 */
export function Composer({ copy, locale, goal, onGoalChange, chatConfigured, submitting, onSubmit }: {
  copy: ConsoleCopy;
  locale: AppLocale;
  goal: string;
  onGoalChange: (value: string) => void;
  chatConfigured: boolean;
  submitting: boolean;
  onSubmit: () => void;
}) {
  const [completionIndex, setCompletionIndex] = useState(0);
  const [completionsDismissed, setCompletionsDismissed] = useState(false);

  const slashCompletions = useMemo(() => matchSlashCompletions(goal, locale), [goal, locale]);
  const visibleCompletions = completionsDismissed ? [] : slashCompletions;

  useEffect(() => { setCompletionIndex(0); setCompletionsDismissed(false); }, [goal]);

  function applyCompletion(item: SlashCompletion) {
    onGoalChange(item.apply(goal));
    setCompletionIndex(0);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { onSubmit(); return; }
    if (visibleCompletions.length === 0) return;
    if (event.key === "Tab" || (event.key === "Enter" && visibleCompletions[completionIndex])) {
      event.preventDefault();
      applyCompletion(visibleCompletions[Math.min(completionIndex, visibleCompletions.length - 1)]!);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setCompletionIndex((index) => (index + 1) % visibleCompletions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCompletionIndex((index) => (index - 1 + visibleCompletions.length) % visibleCompletions.length);
    } else if (event.key === "Escape") {
      setCompletionsDismissed(true);
    }
  }

  const sendLabel = !chatConfigured ? copy.configureModel : submitting ? copy.investigatingShort : copy.send;

  return (
    <div className="composer-shell">
      {visibleCompletions.length > 0 && (
        <div className="slash-suggestions" role="listbox" aria-label={copy.commands}>
          {visibleCompletions.map((item, index) => (
            <button
              key={item.label}
              role="option"
              aria-selected={index === completionIndex}
              className={index === completionIndex ? "active" : ""}
              onMouseDown={(event) => { event.preventDefault(); applyCompletion(item); }}
            >
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        <Textarea
          value={goal}
          onChange={(event) => onGoalChange(event.target.value)}
          placeholder={copy.goalPlaceholder}
          aria-label={copy.goalLabel}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-footer">
          <small>{copy.launchHint}</small>
          <Button
            variant="primary"
            className="launch-button"
            icon={<IconSend size={13} />}
            disabled={chatConfigured && (!goal.trim() || submitting)}
            onClick={onSubmit}
          >
            {sendLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
