import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./ui.js";
import { IconDesktop, IconHistory, IconOpen, IconPlay, IconRefresh, IconShieldLock, IconStop } from "./icons.js";
import {
  auditPurposeLabel,
  browserStatusLabel,
  computerUseCopy,
  formatDateTime,
  localizeRuntimeRoute,
  localizeRuntimeValue,
  permissionLabel,
  platformLabel,
  runtimePlatformLabel,
  type AppLocale
} from "./labels.js";
import type { ModelStatus } from "./types.js";
import {
  DesktopApiError,
  closeBrowserSession,
  getBrowserSession,
  getScreenshotAudits,
  resumeBrowserSession,
  startBrowserSession,
  type BrowserProfileOption,
  type BrowserSession,
  type BrowserSessionView,
  type ScreenshotAudit
} from "./computerUseClient.js";

// Re-exported for existing consumers/tests that import them from this module.
export { computerUseCopy, localizeRuntimeRoute, localizeRuntimeValue };

type RuntimeModels = ModelStatus;

type Resource<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "empty" }
  | { status: "error"; error: unknown };

export function ComputerUseSettings({
  locale,
  clientId,
  runtime,
  privacyMode,
  onPrivacyMode
}: {
  locale: AppLocale;
  clientId?: string;
  runtime: RuntimeModels;
  privacyMode: string;
  onPrivacyMode: (value: "standard" | "local-only") => void;
}) {
  const copy = computerUseCopy(locale);
  const [browser, setBrowser] = useState<Resource<BrowserSessionView>>(clientId ? { status: "loading" } : { status: "empty" });
  const [audits, setAudits] = useState<Resource<ScreenshotAudit[]>>(clientId ? { status: "loading" } : { status: "empty" });
  const [browserProfile, setBrowserProfile] = useState("");
  const [browserAction, setBrowserAction] = useState<"start" | "resume" | "close" | undefined>();
  const [browserActionError, setBrowserActionError] = useState<unknown>();

  const loadBrowser = useCallback(async (signal?: AbortSignal) => {
    if (!clientId) { setBrowser({ status: "empty" }); return; }
    setBrowserActionError(undefined);
    setBrowser((current) => current.status === "ready" ? current : { status: "loading" });
    try {
      const value = await getBrowserSession(clientId, signal);
      setBrowser({ status: "ready", value });
      const suggested = value.session?.browserProfile ?? value.profiles[0]?.browserProfile;
      if (suggested) setBrowserProfile(suggested);
    } catch (error) {
      if (!isAbortError(error)) setBrowser({ status: "error", error });
    }
  }, [clientId]);

  const loadAudits = useCallback(async (signal?: AbortSignal) => {
    if (!clientId) { setAudits({ status: "empty" }); return; }
    setAudits((current) => current.status === "ready" ? current : { status: "loading" });
    try {
      const value = await getScreenshotAudits(clientId, signal);
      setAudits({ status: "ready", value });
    } catch (error) {
      if (!isAbortError(error)) setAudits({ status: "error", error });
    }
  }, [clientId]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([loadBrowser(controller.signal), loadAudits(controller.signal)]);
    return () => controller.abort();
  }, [loadBrowser, loadAudits]);

  const session = browser.status === "ready" ? browser.value.session : null;
  const profiles = browser.status === "ready" ? browser.value.profiles : [];
  const profileOption = profiles.find((item) => item.browserProfile === browserProfile);

  async function runBrowserAction(action: "start" | "resume" | "close") {
    if (!clientId || browserAction) return;
    setBrowserAction(action);
    setBrowserActionError(undefined);
    try {
      const input = { clientId, ...(browserProfile ? { browserProfile } : {}) };
      const updated = action === "start"
        ? await startBrowserSession({ ...input, platform: profileOption?.platform ?? session?.platform ?? "google_ads" })
        : action === "resume"
          ? await resumeBrowserSession(input)
          : await closeBrowserSession(input);
      if (updated) setBrowser({ status: "ready", value: { session: updated, profiles } });
      await loadBrowser();
    } catch (error) {
      setBrowserActionError(error);
    } finally {
      setBrowserAction(undefined);
    }
  }

  const activePrivacy = runtime.privacyMode ?? (privacyMode === "local-only" ? "local-only" : "standard");
  const route = localizeRuntimeRoute(runtime.route ?? runtime.gui, locale);
  const routeModels = useMemo(() => [
    { label: copy.dailyModel, value: runtime.fast, configured: runtime.chatConfigured },
    { label: copy.deepModel, value: runtime.strong, configured: Boolean(runtime.strong) },
    { label: copy.groundingModel, value: runtime.gui, configured: runtime.guiConfigured },
    { label: copy.verificationModel, value: runtime.guiStrong, configured: runtime.guiConfigured }
  ], [copy, runtime]);

  return <div className="computer-settings-stack">
    <section className="computer-readiness" data-ready={runtime.guiConfigured}>
      <div className="computer-readiness-icon"><IconDesktop size={18} /></div>
      <div>
        <span className="computer-state-label">{runtime.guiConfigured ? copy.ready : copy.needsSetup}</span>
        <h3>{runtime.guiConfigured ? copy.readyTitle : copy.setupTitle}</h3>
        <p>{route}</p>
      </div>
      <dl>
        <div><dt>{copy.permission}</dt><dd>{permissionLabel(runtime.permission ?? "OBSERVE", locale)}</dd></div>
        <div><dt>{copy.activePrivacy}</dt><dd>{activePrivacy === "local-only" ? copy.localOnly : copy.masked}</dd></div>
      </dl>
    </section>

    <section className="computer-subsection" aria-labelledby="runtime-route-title">
      <div className="computer-subsection-heading">
        <div><h3 id="runtime-route-title">{copy.modelRoute}</h3><p>{copy.modelRouteBody}</p></div>
        <span>{copy.automatic}</span>
      </div>
      <div className="runtime-route-grid">
        {routeModels.map((model) => <div className="runtime-route-item" key={model.label} data-ready={model.configured}>
          <span>{model.label}</span>
          <strong>{localizeRuntimeValue(model.value, locale)}</strong>
        </div>)}
      </div>
    </section>

    <section className="computer-subsection" aria-labelledby="privacy-mode-title">
      <div className="computer-subsection-heading">
        <div><h3 id="privacy-mode-title">{copy.privacyMode}</h3><p>{copy.privacyBody}</p></div>
        <IconShieldLock size={16} />
      </div>
      <div className="privacy-choice" role="radiogroup" aria-labelledby="privacy-mode-title">
        <button type="button" role="radio" aria-checked={privacyMode !== "local-only"} className={privacyMode !== "local-only" ? "active" : ""} onClick={() => onPrivacyMode("standard")}>
          <strong>{copy.masked}</strong><span>{copy.maskedBody}</span>
        </button>
        <button type="button" role="radio" aria-checked={privacyMode === "local-only"} className={privacyMode === "local-only" ? "active" : ""} onClick={() => onPrivacyMode("local-only")}>
          <strong>{copy.localOnly}</strong><span>{copy.localOnlyBody}</span>
        </button>
      </div>
      {activePrivacy !== privacyMode && <p className="computer-inline-note" role="status">{copy.restartPrivacy}</p>}
    </section>

    <section className="computer-subsection" aria-labelledby="browser-session-title">
      <div className="computer-subsection-heading">
        <div><h3 id="browser-session-title">{copy.managedBrowser}</h3><p>{copy.managedBrowserBody}</p></div>
        <Button variant="subtle" size="sm" icon={<IconRefresh size={13} />} disabled={!clientId || browser.status === "loading" || Boolean(browserAction)} onClick={() => void loadBrowser()} aria-label={copy.refreshBrowser}>{copy.refresh}</Button>
      </div>
      {!clientId ? <ComputerEmpty icon={<IconDesktop size={18} />} title={copy.noWorkspace} body={copy.noWorkspaceBody} />
        : browser.status === "loading" ? <ComputerSkeleton label={copy.loadingBrowser} />
          : browser.status === "error" ? <ComputerError message={resourceError(copy.browserLoadFailed, browser.error, locale)} retry={copy.retry} onRetry={() => void loadBrowser()} />
            : <BrowserSessionCard
                locale={locale}
                copy={copy}
                session={session}
                profiles={profiles}
                profile={browserProfile}
                action={browserAction}
                onProfile={setBrowserProfile}
                onStart={() => void runBrowserAction("start")}
                onResume={() => void runBrowserAction("resume")}
                onClose={() => void runBrowserAction("close")}
              />}
      {browserActionError !== undefined && <ComputerError message={resourceError(copy.browserActionFailed, browserActionError, locale)} retry={copy.retry} onRetry={() => session?.sessionStatus === "lost" ? void runBrowserAction("resume") : void loadBrowser()} />}
    </section>

    <section className="computer-subsection" aria-labelledby="screenshot-audits-title">
      <div className="computer-subsection-heading">
        <div><h3 id="screenshot-audits-title">{copy.screenshotAudits}</h3><p>{copy.screenshotAuditsBody}</p></div>
        <Button variant="subtle" size="sm" icon={<IconHistory size={13} />} disabled={!clientId || audits.status === "loading"} onClick={() => void loadAudits()} aria-label={copy.refreshAudits}>{copy.refresh}</Button>
      </div>
      {!clientId ? <ComputerEmpty icon={<IconHistory size={18} />} title={copy.noAuditWorkspace} body={copy.noWorkspaceBody} />
        : audits.status === "loading" ? <ComputerSkeleton label={copy.loadingAudits} />
          : audits.status === "error" ? <ComputerError message={resourceError(copy.auditLoadFailed, audits.error, locale)} retry={copy.retry} onRetry={() => void loadAudits()} />
            : audits.status === "ready" && audits.value.length ? <ol className="privacy-audit-list">{audits.value.slice().reverse().slice(0, 6).map((audit) => <ScreenshotAuditRow key={audit.auditId} audit={audit} locale={locale} copy={copy} />)}</ol>
              : <ComputerEmpty icon={<IconHistory size={18} />} title={copy.noAudits} body={copy.noAuditsBody} />}
    </section>
  </div>;
}

function BrowserSessionCard({ locale, copy, session, profiles, profile, action, onProfile, onStart, onResume, onClose }: {
  locale: AppLocale;
  copy: ReturnType<typeof computerUseCopy>;
  session: BrowserSession | null;
  profiles: BrowserProfileOption[];
  profile: string;
  action: "start" | "resume" | "close" | undefined;
  onProfile: (profile: string) => void;
  onStart: () => void;
  onResume: () => void;
  onClose: () => void;
}) {
  const busy = Boolean(action);
  if (!session || session.sessionStatus === "closed") return <div className="browser-session-card empty-session">
    <div className="browser-session-intro"><div className="browser-glyph"><IconOpen size={16} /></div><div><strong>{copy.browserClosed}</strong><p>{copy.browserLoginBody}</p></div></div>
    <label className="browser-profile-field"><span>{copy.browserProfile}</span>
      {profiles.length ? <select value={profile} onChange={(event) => onProfile(event.target.value)}><option value="">{copy.automaticProfile}</option>{profiles.map((item) => <option key={`${item.platform}-${item.browserProfile}`} value={item.browserProfile}>{item.browserProfile}{item.accountRef ? ` (${item.accountRef})` : ""}</option>)}</select>
        : <input value={profile} placeholder={copy.optionalProfile} onChange={(event) => onProfile(event.target.value)} />}
      <small>{copy.browserProfileHint}</small>
    </label>
    <Button className="browser-primary-action" variant="primary" icon={<IconPlay size={13} />} disabled={busy} onClick={onStart}>{action === "start" ? copy.startingBrowser : copy.startBrowser}</Button>
  </div>;

  const lost = session.sessionStatus === "lost";
  const starting = session.sessionStatus === "starting";
  return <div className="browser-session-card" data-status={session.sessionStatus}>
    <div className="browser-session-status">
      <span className="session-status-mark" aria-hidden="true" />
      <div><strong>{browserStatusLabel(session.sessionStatus, locale)}</strong><p>{lost ? copy.browserLostBody : starting ? copy.browserStartingBody : copy.browserConnectedBody}</p></div>
      <code>{session.sessionId.slice(0, 8)}</code>
    </div>
    {lost && session.lostReason && <p className="browser-lost-reason">{copy.browserLostReason}</p>}
    <dl className="browser-session-facts">
      <div><dt>{copy.application}</dt><dd>{session.browserApp}</dd></div>
      <div><dt>{copy.browserProfile}</dt><dd>{session.browserProfile}</dd></div>
      <div><dt>{copy.platform}</dt><dd>{platformLabel(session.platform)}</dd></div>
      <div><dt>{copy.process}</dt><dd>{session.processId ?? copy.notAvailable}</dd></div>
      <div><dt>{copy.window}</dt><dd>{session.windowId ?? copy.notAvailable}</dd></div>
      <div><dt>{copy.bounds}</dt><dd>{session.windowBounds ? `${session.windowBounds.width} × ${session.windowBounds.height}` : copy.notAvailable}</dd></div>
      <div><dt>{copy.lastChecked}</dt><dd>{formatDateTime(session.lastValidatedAt ?? session.updatedAt, locale)}</dd></div>
      <div><dt>{copy.runtime}</dt><dd>{runtimePlatformLabel(session.runtimePlatform)}</dd></div>
    </dl>
    <div className="browser-session-actions">
      {lost && <Button variant="primary" icon={<IconPlay size={13} />} disabled={busy} onClick={onResume}>{action === "resume" ? copy.resumingBrowser : copy.resumeBrowser}</Button>}
      <Button variant="outline" icon={<IconStop size={13} />} disabled={busy} onClick={onClose}>{action === "close" ? copy.closingBrowser : copy.closeBrowser}</Button>
    </div>
  </div>;
}

function ScreenshotAuditRow({ audit, locale, copy }: { audit: ScreenshotAudit; locale: AppLocale; copy: ReturnType<typeof computerUseCopy> }) {
  return <li className="privacy-audit-row" data-outcome={audit.outcome}>
    <div className="privacy-audit-main">
      <span>{auditPurposeLabel(audit.purpose, locale)}</span>
      <strong>{audit.modelProvider}/{audit.modelId}</strong>
      <time dateTime={audit.createdAt}>{formatDateTime(audit.createdAt, locale)}</time>
    </div>
    <dl>
      <div><dt>{copy.roi}</dt><dd>{audit.sentRoi.width} × {audit.sentRoi.height}</dd></div>
      <div><dt>{copy.masks}</dt><dd>{audit.masks.length}</dd></div>
      <div><dt>{copy.disclosure}</dt><dd>{audit.leftLocal ? copy.sentMinimized : copy.stayedLocal}</dd></div>
      <div><dt>{copy.outcome}</dt><dd>{audit.outcome === "blocked" ? copy.blocked : copy.prepared}</dd></div>
    </dl>
    <p><IconShieldLock size={12} />{copy.fullScreenshotLocal}</p>
  </li>;
}

function ComputerSkeleton({ label }: { label: string }) {
  return <div className="computer-skeleton" aria-busy="true" aria-label={label}><span /><span /><span /></div>;
}

function ComputerEmpty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return <div className="computer-empty">{icon}<strong>{title}</strong><p>{body}</p></div>;
}

function ComputerError({ message, retry, onRetry }: { message: string; retry: string; onRetry: () => void }) {
  return <div className="computer-error" role="alert"><div><strong>{message}</strong></div><Button variant="subtle" size="sm" onClick={onRetry}>{retry}</Button></div>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function resourceError(fallback: string, error: unknown, locale: AppLocale): string {
  if (!(error instanceof DesktopApiError)) return fallback;
  if (error.status === 404) return locale === "zh-CN" ? "当前版本尚未提供此功能，请更新或重启 AdPilot。" : "This feature is not available in the current runtime. Update or restart AdPilot.";
  if (error.status === 409) return locale === "zh-CN" ? "当前状态不允许此操作，请刷新后重试。" : "The current state does not allow this action. Refresh and try again.";
  if (error.status === 422 || error.status === 400) return locale === "zh-CN" ? "浏览器配置无效，请检查客户工作区中的配置档案。" : "The browser configuration is invalid. Check the Profile bound in the client workspace.";
  return fallback;
}

