import { useEffect, useMemo, useState } from "react";
import { formatTime, visualActionLabel, type AppLocale, type ConsoleCopy } from "../labels.js";
import type { ComputerExecutionStatus, ComputerVisualEvent } from "../types.js";
import type { TimelineComputer } from "../conversationTimeline.js";
import { DesktopApiError, getDesktopLiveFrame, type DesktopLiveFrame } from "../computerUseClient.js";
import { Button } from "../ui.js";
import {
  IconDesktop,
  IconDismiss,
  IconHistory,
  IconOpen,
  IconPause,
  IconPlay,
  IconStop,
  IconTakeover
} from "../icons.js";

export type ComputerControlAction =
  | "pause"
  | "resume"
  | "takeover"
  | "return-control"
  | "stop"
  | "step";

/**
 * A real, window-bound native preview. Frames are fetched only for the
 * authoritative client/browser-session tuple and kept in a six-frame
 * in-memory ring; changing Sessions aborts the old poll and clears it.
 */
export function ComputerUseCard({ copy, locale, mode, controlState, computer, computerPermission, guiConfigured, clientId, productSessionId, browserSessionId, browserBindingKey, onControl }: {
  copy: ConsoleCopy;
  locale: AppLocale;
  mode: ComputerExecutionStatus;
  controlState?: string;
  computer: TimelineComputer;
  computerPermission?: "disabled" | "observe" | "interactive" | "execute";
  guiConfigured: boolean;
  clientId?: string;
  productSessionId?: string;
  browserSessionId?: string;
  browserBindingKey?: string;
  onControl: (action: ComputerControlAction) => void;
}) {
  const { latest, latestShot, latestAction, latestVerification } = computer;
  const actionEvent = latestAction ?? (latest?.action ? latest : undefined);
  const [frames, setFrames] = useState<DesktopLiveFrame[]>([]);
  const [frameError, setFrameError] = useState(false);
  const [fullView, setFullView] = useState(false);
  const [replayOffset, setReplayOffset] = useState(0);
  const userControl = controlState === "user_control" || controlState === "user";
  const canInteract = computerPermission === "interactive" || computerPermission === "execute";
  const modeLabel = userControl
    ? copy.takeover
    : mode === "running"
      ? copy.live
      : mode === "paused"
        ? copy.paused
        : mode === "cancelled"
          ? copy.cancelled
          : copy.computerUnavailable;

  useEffect(() => {
    setFrames([]);
    setFrameError(false);
    setReplayOffset(0);
    if (!clientId || !productSessionId || !browserSessionId) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let staleTimer: number | undefined;
    const poll = async () => {
      try {
        const frame = await getDesktopLiveFrame(clientId, productSessionId, browserSessionId, controller.signal);
        if (controller.signal.aborted) return;
        setFrames((current) => {
          if (current.at(-1)?.frameId === frame.frameId) return current;
          return [...current, frame].slice(-6);
        });
        setFrameError(false);
        window.clearTimeout(staleTimer);
        staleTimer = window.setTimeout(() => setFrameError(true), 2_500);
      } catch (error) {
        if (!controller.signal.aborted) {
          setFrameError(true);
          if (error instanceof DesktopApiError && error.status === 409) setFrames([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          const activeCadence = mode === "running" || mode === "paused" || userControl;
          timer = window.setTimeout(() => void poll(), activeCadence ? 850 : 1_500);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      window.clearTimeout(staleTimer);
    };
  }, [browserBindingKey, browserSessionId, clientId, mode, productSessionId, userControl]);

  useEffect(() => {
    if (!fullView) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullView(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [fullView]);

  const visibleFrame = frames.at(-(Math.min(replayOffset, Math.max(0, frames.length - 1)) + 1));
  const replaying = replayOffset > 0;
  const viewport = <ComputerViewport
    copy={copy}
    locale={locale}
    frame={visibleFrame}
    latest={actionEvent}
    latestShot={latestShot}
    verification={latestVerification?.matched}
    active={mode === "running" && !userControl}
    frameError={frameError}
    guiConfigured={guiConfigured}
    hasBrowser={Boolean(browserSessionId)}
  />;

  return (
    <article className="computer-card" data-control={userControl ? "user" : "agent"}>
      <div className="message-avatar computer-avatar" aria-hidden="true"><IconDesktop size={14} /></div>
      <div className="message-main">
        <header className="message-meta">
          <strong>{copy.computer}</strong>
          <span className={`mode-pill ${userControl ? "user-control" : mode}`}><i aria-hidden="true" />{modeLabel}</span>
          {visibleFrame && <time>{formatTime(visibleFrame.capturedAt, locale)}</time>}
        </header>
        {viewport}
        <div className="computer-live-meta">
          <div><span>{copy.currentApplication}</span><strong>{visibleFrame?.application.name ?? "—"}</strong></div>
          <div><span>{copy.currentWindow}</span><strong>{visibleFrame?.window.title || visibleFrame?.window.id || "—"}</strong></div>
          <div><span>{copy.currentProfile}</span><strong>{visibleFrame?.browser.profile ?? "—"}</strong></div>
          <div><span>{copy.currentUrl}</span><strong>{
            visibleFrame?.browser.pageIdentity.status === "unavailable"
              ? `Unavailable · ${visibleFrame.browser.pageIdentity.reason}`
              : visibleFrame?.browser.url ?? "—"
          }</strong></div>
          <div><span>{copy.controlOwner}</span><strong>{userControl ? copy.userControl : copy.agentControl}</strong></div>
          <div
            title={visibleFrame
              ? `${visibleFrame.application.bundleId} · PID ${visibleFrame.application.pid} · Window ${visibleFrame.window.id}`
              : undefined}
          >
            <span>{copy.actionIsolation}</span>
            <strong>{visibleFrame ? copy.exactWindowBound : "—"}</strong>
          </div>
        </div>
        <div className="micro-task">
          <span>{copy.currentMicroTask}</span>
          <strong>{actionEvent?.action?.target ?? copy.standby}</strong>
          <small>{actionEvent?.action?.reason ?? copy.oneAction}</small>
        </div>
        <div className="control-row computer-control-row">
          <Button variant="outline" size="sm" icon={<IconPause size={13} />} disabled={mode !== "running" || userControl} onClick={() => onControl("pause")}>{copy.pause}</Button>
          <Button variant="outline" size="sm" icon={<IconTakeover size={13} />} disabled={mode !== "running" || userControl} onClick={() => onControl("takeover")}>{copy.takeOver}</Button>
          {userControl
            ? <Button variant="primary" size="sm" icon={<IconPlay size={13} />} disabled={!canInteract} onClick={() => onControl("return-control")}>{copy.returnControl}</Button>
            : <Button variant="primary" size="sm" icon={<IconPlay size={13} />} disabled={mode !== "paused" || !canInteract} onClick={() => onControl("resume")}>{copy.resume}</Button>}
          <Button variant="subtle" size="sm" icon={<IconStop size={13} />} disabled={mode === "cancelled" || mode === "unavailable"} onClick={() => onControl("stop")}>{copy.stopComputer}</Button>
          <Button
            variant="subtle"
            size="sm"
            icon={<IconPlay size={13} />}
            disabled={mode !== "paused" || userControl || !canInteract}
            title={copy.stepUnavailable}
            onClick={() => onControl("step")}
          >{copy.stepComputer}</Button>
          <Button variant="subtle" size="sm" icon={<IconOpen size={13} />} disabled={!visibleFrame} onClick={() => setFullView(true)}>{copy.openFullView}</Button>
          <Button
            variant="subtle"
            size="sm"
            icon={<IconHistory size={13} />}
            disabled={frames.length < 2}
            onClick={() => setReplayOffset((current) => current > 0 ? 0 : 1)}
          >{replaying ? copy.returnLive : copy.replayFrame}</Button>
        </div>
        <small className="computer-frame-privacy">{copy.framePrivacy}</small>
      </div>

      {fullView && <div className="computer-full-view" role="dialog" aria-modal="true" aria-label={copy.openFullView}>
        <header>
          <div><strong>{copy.openFullView}</strong><span>{modeLabel} · {visibleFrame?.application.name ?? "—"}</span></div>
          <button type="button" onClick={() => setFullView(false)} aria-label={copy.closeFullView}><IconDismiss size={16} /></button>
        </header>
        {viewport}
        <footer>
          <span>{visibleFrame ? `${visibleFrame.width} × ${visibleFrame.height} · ${formatTime(visibleFrame.capturedAt, locale)}` : copy.awaitingSignal}</span>
          <strong>{userControl ? copy.userControl : copy.agentControl}</strong>
        </footer>
      </div>}
    </article>
  );
}

function ComputerViewport({ copy, locale, frame, latest, latestShot, verification, active, frameError, guiConfigured, hasBrowser }: {
  copy: ConsoleCopy;
  locale: AppLocale;
  frame: DesktopLiveFrame | undefined;
  latest: ComputerVisualEvent | undefined;
  latestShot: ComputerVisualEvent["screenshot"] | undefined;
  verification: boolean | undefined;
  active: boolean;
  frameError: boolean;
  guiConfigured: boolean;
  hasBrowser: boolean;
}) {
  const overlay = useMemo(() => overlayGeometry(latest?.overlay, latestShot), [latest?.overlay, latestShot]);
  return <div
    className="screen-frame computer-live-frame"
    data-active={active}
    data-stale={frameError}
    aria-live="polite"
    style={frame ? { aspectRatio: `${frame.width} / ${frame.height}` } : undefined}
  >
    {frame
      ? <img src={frame.dataUrl} width={frame.width} height={frame.height} alt={copy.screenshotAlt} draggable={false} />
      : <div className="screen-idle">
          <IconDesktop size={18} />
          <strong>{copy.visualChannel}</strong>
          <small>{!hasBrowser ? copy.noManagedBrowser : frameError ? copy.liveFrameUnavailable : guiConfigured ? copy.awaitingSignal : copy.modelNotConfigured}</small>
        </div>}
    {frame && frameError && <div className="live-frame-stale"><IconDesktop size={15} /><span>{copy.liveFrameUnavailable}</span></div>}
    {frame && overlay?.targetBox && <i
      className={`grounding-target${verification !== undefined ? " verification-region" : ""}`}
      data-risk={latest?.action?.riskLevel}
      data-verified={verification}
      style={overlay.targetBox}
      aria-hidden="true"
    />}
    {frame && overlay?.pointer && <i className="grounding-pointer" style={overlay.pointer} aria-hidden="true" />}
    {frame && overlay?.dragPath && <svg className="grounding-drag-path" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line x1={overlay.dragPath.x1} y1={overlay.dragPath.y1} x2={overlay.dragPath.x2} y2={overlay.dragPath.y2} />
    </svg>}
    {frame?.cursor && <i
      className="live-cursor"
      style={{ left: `${(frame.cursor.x / frame.source.width) * 100}%`, top: `${(frame.cursor.y / frame.source.height) * 100}%` }}
      aria-hidden="true"
    />}
    {latest?.action && (
      <div className="action-overlay">
        <strong>{visualActionLabel(latest.action.action, locale)}</strong>
        <span>{latest.action.target}</span>
      </div>
    )}
  </div>;
}

export function overlayGeometry(
  overlay: ComputerVisualEvent["overlay"] | undefined,
  screenshot: ComputerVisualEvent["screenshot"] | undefined
): {
  targetBox?: React.CSSProperties;
  pointer?: React.CSSProperties;
  dragPath?: { x1: string; y1: string; x2: string; y2: string };
} | undefined {
  if (!overlay || !screenshot) return undefined;
  const x = (value: number) => `${Math.max(0, Math.min(100, value / screenshot.width * 100))}%`;
  const y = (value: number) => `${Math.max(0, Math.min(100, value / screenshot.height * 100))}%`;
  return {
    ...(overlay.targetBox ? {
      targetBox: {
        left: x(overlay.targetBox.x),
        top: y(overlay.targetBox.y),
        width: x(overlay.targetBox.width),
        height: y(overlay.targetBox.height)
      }
    } : {}),
    ...(overlay.pointer ? {
      pointer: {
        left: x(overlay.pointer.x),
        top: y(overlay.pointer.y)
      }
    } : {}),
    ...(overlay.pointer && overlay.dragTo ? {
      dragPath: {
        x1: x(overlay.pointer.x),
        y1: y(overlay.pointer.y),
        x2: x(overlay.dragTo.x),
        y2: y(overlay.dragTo.y)
      }
    } : {})
  };
}
