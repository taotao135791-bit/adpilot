import { useCallback, useRef, useState } from "react";
import { workspaceCopy, type AppLocale } from "../labels.js";
import type { KernelProject } from "../workspace.js";
import { Button } from "../ui.js";
import { IconChevronDown, IconDocLines, IconPlus, IconSend } from "../icons.js";

/**
 * Home: a centered hero — display heading, workspace context, the project
 * scope picker, and the ask/code composer. Sessions live in the sidebar;
 * there is intentionally no second feed here.
 */
export function HomeView({ locale, workspaceName, projects, onSubmitGoal, onSubmitCode, onSubmitProjectGoal }: {
  locale: AppLocale;
  workspaceName: string;
  projects: KernelProject[];
  onSubmitGoal: (message: string) => void;
  onSubmitCode: (message: string) => void;
  onSubmitProjectGoal: (projectId: string, message: string) => void;
}) {
  const copy = workspaceCopy(locale);
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [scopeProjectId, setScopeProjectId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scopeProject = projects.find((project) => project.id === scopeProjectId);

  const submit = useCallback(async () => {
    const text = goal.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      if (scopeProjectId) onSubmitProjectGoal(scopeProjectId, text);
      else onSubmitGoal(text);
      setGoal("");
      setPickerOpen(false);
    } finally {
      setSubmitting(false);
    }
  }, [goal, submitting, scopeProjectId, onSubmitGoal, onSubmitProjectGoal]);

  return (
    <div className="home">
      <div className="home-body">
        <h1 className="home-heading">{copy.homeHeading}</h1>
        <p className="home-context">
          {copy.workspace.toLowerCase()} · {workspaceName}
          {scopeProject ? ` / ${scopeProject.name}` : ""}
        </p>

        <div className="home-scope">
          <button
            type="button"
            className="home-scope-pill"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            <IconDocLines size={13} />
            <span>{scopeProject ? scopeProject.name : copy.selectProject}</span>
            <IconChevronDown size={11} {...(pickerOpen ? { className: "open" } : {})} />
          </button>
          {pickerOpen && (
            <div className="home-scope-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="home-scope-option"
                data-active={scopeProjectId === null || undefined}
                onClick={() => { setScopeProjectId(null); setPickerOpen(false); inputRef.current?.focus(); }}
              >
                {copy.justChat}
              </button>
              {projects.filter((project) => project.status !== "archived").map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="menuitem"
                  className="home-scope-option"
                  data-active={project.id === scopeProjectId || undefined}
                  onClick={() => { setScopeProjectId(project.id); setPickerOpen(false); inputRef.current?.focus(); }}
                >
                  {project.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="home-composer" data-submitting={submitting || undefined}>
          <textarea
            ref={inputRef}
            value={goal}
            rows={2}
            placeholder={copy.homeComposerPlaceholder}
            aria-label={copy.homeComposerPlaceholder}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="home-composer-row">
            <Button size="sm" variant="subtle" className="icon-button" icon={<IconPlus size={14} />} aria-label={copy.homeAttach} disabled />
            <div className="home-mode" role="group" aria-label="mode">
              <button type="button" className="home-mode-item" data-active="true" onClick={() => void submit()}>Ask</button>
              <button
                type="button"
                className="home-mode-item"
                onClick={() => {
                  const text = goal.trim();
                  if (!text || submitting) return;
                  onSubmitCode(text);
                  setGoal("");
                }}
              >{copy.homeCodeMode}</button>
            </div>
            <kbd className="home-kbd" title={copy.homeSlashHint}>⌘K</kbd>
            <span className="home-send-hint">{copy.homeSendHint}</span>
            <button
              type="button"
              className="home-send"
              aria-label={copy.homeQuickSubmit}
              disabled={!goal.trim() || submitting}
              onClick={() => void submit()}
            >
              <IconSend size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
