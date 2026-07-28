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
import type { ModelStatus, ProductSession } from "./types.js";
import {
  configureProductSessionComputerUse,
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
  productSession,
  runtime,
  privacyMode,
  onPrivacyMode,
  onProductSessionUpdated
}: {
  locale: AppLocale;
  clientId?: string;
  productSession?: ProductSession;
  runtime: RuntimeModels;
  privacyMode: string;
  onPrivacyMode: (value: "standard" | "local-only") => void;
  onProductSessionUpdated: (session: ProductSession) => void;
}) {
  const copy = computerUseCopy(locale);
  const [browser, setBrowser] = useState<Resource<BrowserSessionView>>(clientId ? { status: "loading" } : { status: "empty" });
  const [audits, setAudits] = useState<Resource<ScreenshotAudit[]>>(clientId ? { status: "loading" } : { status: "empty" });
  const [browserProfile, setBrowserProfile] = useState("");
  const [browserAction, setBrowserAction] = useState<"start" | "resume" | "close" | undefined>();
  const [browserActionError, setBrowserActionError] = useState<unknown>();
  const [permissionMode, setPermissionMode] = useState<ProductSessionComputerUse>(
    productSession?.permissionProfile?.computerUse ?? "disabled"
  );
  const [permissionBrowserProfile, setPermissionBrowserProfile] = useState(
    productSession?.permissionProfile?.browserProfile ?? ""
  );
  const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [permissionMessage, setPermissionMessage] = useState("");

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

  useEffect(() => {
    setPermissionMode(productSession?.permissionProfile?.computerUse ?? "disabled");
    setPermissionBrowserProfile(productSession?.permissionProfile?.browserProfile ?? "");
    setPermissionConfirmed(false);
    setPermissionMessage("");
  }, [productSession?.id, productSession?.revision]);

  const session = browser.status === "ready" ? browser.value.session : null;
  const profiles = browser.status === "ready" ? browser.value.profiles : [];
  const profileOption = profiles.find((item) => item.browserProfile === browserProfile);
  const permissionProfiles = useMemo(() => [...new Set([
    productSession?.permissionProfile?.browserProfile,
    session?.browserProfile,
    ...profiles.map((item) => item.browserProfile)
  ].filter((value): value is string => Boolean(value)))], [
    productSession?.permissionProfile?.browserProfile,
    profiles,
    session?.browserProfile
  ]);

  useEffect(() => {
    if (!permissionBrowserProfile && permissionProfiles[0]) {
      setPermissionBrowserProfile(permissionProfiles[0]);
    }
  }, [permissionBrowserProfile, permissionProfiles]);

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

  async function saveSessionComputerPermission() {
    if (!clientId || !productSession || !permissionBrowserProfile || !permissionConfirmed || permissionSaving) return;
    setPermissionSaving(true);
    setPermissionMessage("");
    try {
      const updated = await configureProductSessionComputerUse(clientId, productSession.id, {
        revision: productSession.revision,
        browserProfile: permissionBrowserProfile,
        computerUse: permissionMode,
        confirm: true
      });
      onProductSessionUpdated(updated);
      setPermissionConfirmed(false);
      setPermissionMessage(sessionComputerPermissionCopy(locale).saved);
    } catch (error) {
      setPermissionMessage(error instanceof DesktopApiError
        ? error.message
        : sessionComputerPermissionCopy(locale).saveFailed);
    } finally {
      setPermissionSaving(false);
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

    <SessionComputerPermission
      locale={locale}
      {...(productSession ? { productSession } : {})}
      profiles={permissionProfiles}
      profile={permissionBrowserProfile}
      mode={permissionMode}
      confirmed={permissionConfirmed}
      saving={permissionSaving}
      message={permissionMessage}
      onProfile={(value) => { setPermissionBrowserProfile(value); setPermissionConfirmed(false); }}
      onMode={(value) => { setPermissionMode(value); setPermissionConfirmed(false); }}
      onConfirmed={setPermissionConfirmed}
      onSave={() => void saveSessionComputerPermission()}
    />

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

type ProductSessionComputerUse = "disabled" | "observe" | "interactive" | "execute";

function SessionComputerPermission({ locale, productSession, profiles, profile, mode, confirmed, saving, message, onProfile, onMode, onConfirmed, onSave }: {
  locale: AppLocale;
  productSession?: ProductSession;
  profiles: string[];
  profile: string;
  mode: ProductSessionComputerUse;
  confirmed: boolean;
  saving: boolean;
  message: string;
  onProfile: (profile: string) => void;
  onMode: (mode: ProductSessionComputerUse) => void;
  onConfirmed: (confirmed: boolean) => void;
  onSave: () => void;
}) {
  const text = sessionComputerPermissionCopy(locale);
  return <section className="computer-subsection session-computer-permission" aria-labelledby="session-computer-permission-title">
    <div className="computer-subsection-heading">
      <div>
        <h3 id="session-computer-permission-title">{text.title}</h3>
        <p>{text.body}</p>
      </div>
      <IconShieldLock size={16} />
    </div>
    {!productSession
      ? <ComputerEmpty icon={<IconShieldLock size={18} />} title={text.noSession} body={text.noSessionBody} />
      : <>
          <div className="session-permission-binding">
            <label className="browser-profile-field">
              <span>{text.profile}</span>
              <select value={profile} disabled={!profiles.length || saving} onChange={(event) => onProfile(event.target.value)}>
                {!profiles.length && <option value="">{text.noProfiles}</option>}
                {profiles.map((item) => <option value={item} key={item}>{item}</option>)}
              </select>
              <small>{text.profileHint}</small>
            </label>
            <div className="computer-permission-grid" role="radiogroup" aria-label={text.mode}>
              {(["disabled", "observe", "interactive", "execute"] as const).map((value) => <button
                type="button"
                role="radio"
                aria-checked={mode === value}
                data-active={mode === value}
                disabled={saving}
                onClick={() => onMode(value)}
                key={value}
              >
                <strong>{text.modes[value].label}</strong>
                <span>{text.modes[value].body}</span>
              </button>)}
            </div>
          </div>
          <div className="session-permission-review" data-mode={mode}>
            <strong>{text.reviewTitle}</strong>
            <p>{text.review[mode]}</p>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={saving || !profile}
                onChange={(event) => onConfirmed(event.target.checked)}
              />
              <span>{text.confirm}</span>
            </label>
          </div>
          <div className="session-permission-actions">
            <div>
              <span>{text.current}</span>
              <strong>{text.modes[productSession.permissionProfile?.computerUse ?? "disabled"].label}</strong>
              <code>{productSession.permissionProfile?.browserProfile ?? "—"}</code>
            </div>
            <Button
              variant="primary"
              icon={<IconShieldLock size={13} />}
              disabled={!profile || !confirmed || saving}
              onClick={onSave}
            >
              {saving ? text.saving : text.save}
            </Button>
          </div>
          {message && <p className="computer-inline-note" role="status">{message}</p>}
        </>}
  </section>;
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

function sessionComputerPermissionCopy(locale: AppLocale) {
  if (locale === "zh-CN") {
    return {
      title: "产品会话的 Computer Use 权限",
      body: "权限只对当前产品会话和一个受管浏览器 Profile 生效。更换会话或 Profile 不会继承授权。",
      noSession: "未选择产品会话",
      noSessionBody: "请先从侧边栏选择一个产品会话。",
      profile: "绑定的浏览器 Profile",
      profileHint: "只能选择当前客户下已经存在的受管 Profile。",
      noProfiles: "没有可绑定的受管 Profile",
      mode: "Computer Use 模式",
      modes: {
        disabled: { label: "关闭", body: "不允许此会话使用屏幕或原生输入。" },
        observe: { label: "观察", body: "允许真实画面与只读视觉检查，不允许原生输入。" },
        interactive: { label: "交互", body: "允许受策略约束的导航和输入；广告变更仍不可直接执行。" },
        execute: { label: "执行", body: "允许执行已批准的工作；每次广告变更仍必须单独审批。" }
      },
      reviewTitle: "授权审查",
      review: {
        disabled: "这会立即降级当前会话，并保留 Profile 绑定以便审计。暂停、接管和停止仍可作为紧急控制。",
        observe: "AdPilot 可捕获绑定窗口并显示 Live View，但不会发送鼠标或键盘输入。",
        interactive: "AdPilot 可在绑定窗口内导航和输入。此授权映射为 PREPARE，不允许绕过变更审批。",
        execute: "此授权映射为 EXECUTE，但 approvalRequired 始终保持开启；任何广告 mutation 都必须再次确认。"
      },
      confirm: "我确认只为当前产品会话和上述 Profile 授权，并理解该选择会写入审计日志。",
      current: "当前",
      save: "确认并应用",
      saving: "正在应用…",
      saved: "Computer Use 权限已更新。",
      saveFailed: "无法更新 Computer Use 权限，请刷新会话后重试。"
    } as const;
  }
  return {
    title: "Product Session Computer Use",
    body: "Permission applies only to this Product Session and one managed browser Profile. It is not inherited by another Session or Profile.",
    noSession: "No Product Session selected",
    noSessionBody: "Select a Product Session from the sidebar first.",
    profile: "Bound browser Profile",
    profileHint: "Only an existing managed Profile for this client can be selected.",
    noProfiles: "No managed Profile is available",
    mode: "Computer Use mode",
    modes: {
      disabled: { label: "Disabled", body: "Do not allow screen or native input for this Session." },
      observe: { label: "Observe", body: "Allow the real frame and read-only visual checks, without native input." },
      interactive: { label: "Interactive", body: "Allow policy-bound navigation and input; ad mutations still cannot run directly." },
      execute: { label: "Execute", body: "Allow approved work to run; every ad mutation still needs separate approval." }
    },
    reviewTitle: "Permission review",
    review: {
      disabled: "This immediately downgrades the Session and retains the Profile binding for audit. Pause, Take Over, and Stop remain emergency controls.",
      observe: "AdPilot may capture the bound window and show Live View, but will not post mouse or keyboard input.",
      interactive: "AdPilot may navigate and type in the bound window. This maps to PREPARE and cannot bypass mutation approval.",
      execute: "This maps to EXECUTE, but approvalRequired always remains enabled; every ad mutation still requires confirmation."
    },
    confirm: "I confirm this grant is only for the current Product Session and Profile, and understand it is written to the audit log.",
    current: "Current",
    save: "Confirm and apply",
    saving: "Applying…",
    saved: "Computer Use permission updated.",
    saveFailed: "Computer Use permission could not be updated. Refresh the Session and try again."
  } as const;
}
