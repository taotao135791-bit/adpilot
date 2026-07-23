import { formatTime, visualActionLabel, type AppLocale, type ConsoleCopy } from "../labels.js";
import type { ComputerExecutionStatus, ComputerVisualEvent } from "../types.js";
import { Button } from "../ui.js";
import { IconDesktop, IconPause, IconPlay, IconTakeover } from "../icons.js";

export type ComputerControlAction = "pause" | "resume" | "takeover";

/**
 * Computer-use status panel in the operations rail. State is expressed
 * through one status pill and a quiet viewport surface — no bezel chrome,
 * scanlines, or idle animation.
 */
export function ComputerUsePanel({ copy, locale, mode, latest, latestShot, guiConfigured, onControl }: {
  copy: ConsoleCopy;
  locale: AppLocale;
  mode: ComputerExecutionStatus;
  latest: ComputerVisualEvent | undefined;
  latestShot: { width: number; height: number; capturedAt: string; sha256: string } | undefined;
  guiConfigured: boolean;
  onControl: (action: ComputerControlAction) => void;
}) {
  const modeLabel = mode === "running"
    ? copy.live
    : mode === "paused"
      ? copy.paused
      : mode === "cancelled"
        ? copy.cancelled
        : copy.computerUnavailable;
  return (
    <section className="computer-panel panel" aria-label={copy.computer}>
      <header className="panel-heading">
        <div className="panel-title"><IconDesktop size={15} /><h2>{copy.computer}</h2></div>
        <span className={`mode-pill ${mode}`}><i aria-hidden="true" />{modeLabel}</span>
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
    </section>
  );
}
