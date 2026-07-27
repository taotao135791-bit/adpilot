import { formatTime, visualActionLabel, type AppLocale, type ConsoleCopy } from "../labels.js";
import type { ComputerExecutionStatus } from "../types.js";
import type { TimelineComputer } from "../conversationTimeline.js";
import { Button } from "../ui.js";
import { IconDesktop, IconPause, IconPlay, IconTakeover } from "../icons.js";

export type ComputerControlAction = "pause" | "resume" | "takeover";

/**
 * Live computer-use session as an inline conversation-feed card. It only
 * exists while a session is active (running/paused) — the timeline merger
 * omits the entry when idle, so the card never occupies space in a quiet
 * feed. One status pill and a quiet viewport surface, no bezel chrome.
 */
export function ComputerUseCard({ copy, locale, mode, computer, guiConfigured, onControl }: {
  copy: ConsoleCopy;
  locale: AppLocale;
  mode: ComputerExecutionStatus;
  computer: TimelineComputer;
  guiConfigured: boolean;
  onControl: (action: ComputerControlAction) => void;
}) {
  const { latest, latestShot } = computer;
  const modeLabel = mode === "running"
    ? copy.live
    : mode === "paused"
      ? copy.paused
      : mode === "cancelled"
        ? copy.cancelled
        : copy.computerUnavailable;
  return (
    <article className="computer-card">
      <div className="message-avatar computer-avatar" aria-hidden="true"><IconDesktop size={14} /></div>
      <div className="message-main">
        <header className="message-meta">
          <strong>{copy.computer}</strong>
          <span className={`mode-pill ${mode}`}><i aria-hidden="true" />{modeLabel}</span>
          {latestShot && <time>{formatTime(latestShot.capturedAt, locale)}</time>}
        </header>
        <div className="screen-frame" data-active={mode === "running"}>
          <div className="screen-idle">
            <IconDesktop size={18} />
            <strong>{copy.visualChannel}</strong>
            <small>{latestShot ? formatTime(latestShot.capturedAt, locale) : guiConfigured ? copy.awaitingSignal : copy.modelNotConfigured}</small>
          </div>
          {latest?.type === "grounded" && latest.action && (
            <div className="action-overlay">
              <strong>{visualActionLabel(latest.action.action, locale)}</strong>
              <span>{latest.action.target}</span>
            </div>
          )}
        </div>
        <div className="micro-task">
          <span>{copy.currentMicroTask}</span>
          <strong>{latest?.action?.target ?? copy.standby}</strong>
          <small>{latest?.action?.reason ?? copy.oneAction}</small>
        </div>
        <div className="control-row">
          <Button variant="outline" size="sm" icon={<IconPause size={13} />} disabled={mode !== "running"} onClick={() => onControl("pause")}>{copy.pause}</Button>
          <Button variant="outline" size="sm" icon={<IconTakeover size={13} />} disabled={mode !== "running"} onClick={() => onControl("takeover")}>{copy.takeOver}</Button>
          <Button variant="primary" size="sm" icon={<IconPlay size={13} />} disabled={mode !== "paused"} onClick={() => onControl("resume")}>{copy.resume}</Button>
        </div>
      </div>
    </article>
  );
}
