import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AppLocale, ConsoleCopy } from "../labels.js";
import { isNoopCompletion, matchSlashCompletions, slashCommandSpecs, type SlashCompletion } from "../slashCommands.js";
import { composerKeyAction } from "../composerKeys.js";
import type { AutonomyMode } from "../autonomy.js";
import type { Client } from "../types.js";
import { Button, Textarea, Tooltip } from "../ui.js";
import { IconBolt, IconChevronDown, IconChip, IconPlan, IconPlus, IconSend, IconShieldCheck } from "../icons.js";

/** Auto-resize ceiling: eight 14px/1.55 lines ≈ 174px, rounded up. */
const MAX_TEXTAREA_HEIGHT = 176;

/**
 * Mission composer, Codex-skeleton edition: one rounded card pinned to the
 * bottom dock. The textarea grows with content (capped at ~8 lines, then
 * scrolls internally). Below it a chips row carries the context controls —
 * "+" command menu, workspace switcher, autonomy pill, plan-mode pill on
 * the left; model chip and the send button on the right.
 *
 * Keyboard: Enter submits, Shift+Enter inserts a newline. While slash
 * completions are visible they own Enter/Tab/arrows/Escape (see
 * composerKeys.ts, which is unit-tested).
 *
 * The autonomy and plan-mode pills mirror server-owned switches: they only
 * call their endpoints and render the state; enforcement always lives in
 * the runtime, never in these controls.
 */
export function Composer({ copy, locale, goal, onGoalChange, chatConfigured, submitting, onSubmit, onConfigureModel, planMode = false, planModeDisabled = false, onTogglePlanMode, clients, clientId, onSelectClient, autonomy = "guarded", autonomyDisabled = false, onToggleAutonomy, modelLabel, onOpenModelSettings }: {
  copy: ConsoleCopy;
  locale: AppLocale;
  goal: string;
  onGoalChange: (value: string) => void;
  chatConfigured: boolean;
  submitting: boolean;
  onSubmit: () => void;
  /** Invoked when the user hits send with no chat model configured: opens the models settings tab. */
  onConfigureModel: () => void;
  planMode?: boolean;
  planModeDisabled?: boolean;
  onTogglePlanMode?: () => void;
  clients: Client[];
  clientId: string;
  onSelectClient: (clientId: string) => void;
  autonomy?: AutonomyMode;
  autonomyDisabled?: boolean;
  onToggleAutonomy?: () => void;
  modelLabel: string;
  onOpenModelSettings: () => void;
}) {
  const [completionIndex, setCompletionIndex] = useState(0);
  const [completionsDismissed, setCompletionsDismissed] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const slashCompletions = useMemo(() => matchSlashCompletions(goal, locale), [goal, locale]);
  const visibleCompletions = completionsDismissed ? [] : slashCompletions;
  const commandSpecs = useMemo(() => slashCommandSpecs(locale), [locale]);

  useEffect(() => { setCompletionIndex(0); setCompletionsDismissed(false); }, [goal]);

  /* Grow the textarea with its content; cap and hand over to internal
     scrolling beyond MAX_TEXTAREA_HEIGHT. Runs on every value change,
     including programmatic writes (empty-state cards, command picks). */
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [goal]);

  function applyCompletion(item: SlashCompletion) {
    onGoalChange(item.apply(goal));
    setCompletionIndex(0);
  }

  function insertCommand(name: string, hasArgs: boolean) {
    onGoalChange(hasArgs ? `${name} ` : name);
    setCommandMenuOpen(false);
    inputRef.current?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (commandMenuOpen && event.key === "Escape") { setCommandMenuOpen(false); return; }
    const action = composerKeyAction(event, visibleCompletions.length);
    if (action === "submit") {
      event.preventDefault();
      handleSend();
      return;
    }
    if (action === "accept-completion") {
      event.preventDefault();
      const item = visibleCompletions[Math.min(completionIndex, visibleCompletions.length - 1)];
      /* Exact command already typed ("/experiments"): the highlighted
         completion is a no-op, so Enter submits instead of accepting. */
      if (item) { if (isNoopCompletion(item, goal)) handleSend(); else applyCompletion(item); }
    } else if (action === "next-completion") {
      event.preventDefault();
      setCompletionIndex((index) => (index + 1) % visibleCompletions.length);
    } else if (action === "previous-completion") {
      event.preventDefault();
      setCompletionIndex((index) => (index - 1 + visibleCompletions.length) % visibleCompletions.length);
    } else if (action === "dismiss-completions") {
      setCompletionsDismissed(true);
    }
  }

  const empty = !goal.trim();

  /**
   * Send-path decision: with no chat model, an empty box means the button
   * reads "Configure model" and opens the models tab; a slash command still
   * runs (the App submit path answers local commands without a model).
   */
  function handleSend() {
    if (!chatConfigured && empty) { onConfigureModel(); return; }
    onSubmit();
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
      {commandMenuOpen && (
        <div className="slash-suggestions" role="menu" aria-label={copy.insertCommand}>
          {commandSpecs.map((spec) => (
            <button key={spec.name} role="menuitem" onMouseDown={(event) => { event.preventDefault(); insertCommand(spec.name, spec.args.length > 0); }}>
              <strong>{spec.name}</strong>
              <span>{spec.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer" data-plan-mode={planMode || undefined}>
        <Textarea
          ref={inputRef}
          rows={1}
          value={goal}
          onChange={(event) => onGoalChange(event.target.value)}
          placeholder={planMode ? copy.planModePlaceholder : copy.goalPlaceholder}
          aria-label={copy.goalLabel}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-chips">
          <div className="composer-tools">
            <Tooltip content={copy.insertCommand} side="top">
              <button
                type="button"
                className="composer-plus"
                aria-label={copy.insertCommand}
                aria-expanded={commandMenuOpen}
                onClick={() => setCommandMenuOpen((open) => !open)}
              >
                <IconPlus size={15} />
              </button>
            </Tooltip>
            {clients.length > 0 && (
              <span className="chip chip-select" data-live={Boolean(clientId)}>
                <span className="status-dot" data-live={Boolean(clientId)} aria-hidden="true" />
                <select value={clientId} aria-label={copy.workspace} onChange={(event) => onSelectClient(event.target.value)}>
                  {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
                </select>
                <IconChevronDown size={11} />
              </span>
            )}
            {onToggleAutonomy && (
              <Tooltip content={copy.autonomyHint} side="top">
                <button
                  type="button"
                  className="composer-pill"
                  data-active={autonomy === "full_access" || undefined}
                  aria-pressed={autonomy === "full_access"}
                  disabled={autonomyDisabled}
                  onClick={onToggleAutonomy}
                >
                  {autonomy === "full_access" ? <IconBolt size={12} /> : <IconShieldCheck size={12} />}
                  <span>{autonomy === "full_access" ? copy.autonomyFull : copy.autonomyGuarded}</span>
                </button>
              </Tooltip>
            )}
            {onTogglePlanMode && (
              <Tooltip content={copy.planModeHint} side="top">
                <button
                  type="button"
                  className="composer-pill"
                  data-active={planMode || undefined}
                  aria-pressed={planMode}
                  disabled={planModeDisabled}
                  onClick={onTogglePlanMode}
                >
                  <IconPlan size={12} />
                  <span>{planMode ? copy.planModeReadOnly : copy.planMode}</span>
                </button>
              </Tooltip>
            )}
          </div>
          <div className="composer-actions">
            <Tooltip content={copy.modelChipHint} side="top">
              <button type="button" className="chip chip-button" onClick={onOpenModelSettings}>
                <IconChip size={12} />
                <span>{modelLabel}</span>
              </button>
            </Tooltip>
            <Button
              variant="primary"
              className="launch-button"
              icon={<IconSend size={13} />}
              disabled={chatConfigured && (empty || submitting)}
              onClick={handleSend}
            >
              {sendLabel}
            </Button>
          </div>
        </div>
      </div>
      <p className="composer-hint">{copy.launchHint}</p>
    </div>
  );
}
