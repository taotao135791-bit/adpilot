import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@fluentui/react-components";
import {
  ArrowClockwise20Regular,
  Desktop20Regular,
  History20Regular,
  Open20Regular,
  Play20Regular,
  ShieldLock20Regular,
  Stop20Regular
} from "@fluentui/react-icons";
import type { AppLocale } from "./i18n.js";
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

type RuntimeModels = {
  fast: string;
  strong: string;
  gui: string;
  guiStrong: string;
  chatConfigured: boolean;
  guiConfigured: boolean;
  browserSession?: string;
  route?: string;
  privacyMode?: "standard" | "local-only";
  permission?: "OBSERVE" | "INTERACT" | "MUTATE" | "DESTRUCTIVE";
};

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
      <div className="computer-readiness-icon"><Desktop20Regular /></div>
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
        <ShieldLock20Regular aria-hidden="true" />
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
        <Button appearance="subtle" size="small" icon={<ArrowClockwise20Regular />} disabled={!clientId || browser.status === "loading" || Boolean(browserAction)} onClick={() => void loadBrowser()} aria-label={copy.refreshBrowser}>{copy.refresh}</Button>
      </div>
      {!clientId ? <ComputerEmpty icon={<Desktop20Regular />} title={copy.noWorkspace} body={copy.noWorkspaceBody} />
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
        <Button appearance="subtle" size="small" icon={<History20Regular />} disabled={!clientId || audits.status === "loading"} onClick={() => void loadAudits()} aria-label={copy.refreshAudits}>{copy.refresh}</Button>
      </div>
      {!clientId ? <ComputerEmpty icon={<History20Regular />} title={copy.noAuditWorkspace} body={copy.noWorkspaceBody} />
        : audits.status === "loading" ? <ComputerSkeleton label={copy.loadingAudits} />
          : audits.status === "error" ? <ComputerError message={resourceError(copy.auditLoadFailed, audits.error, locale)} retry={copy.retry} onRetry={() => void loadAudits()} />
            : audits.status === "ready" && audits.value.length ? <ol className="privacy-audit-list">{audits.value.slice().reverse().slice(0, 6).map((audit) => <ScreenshotAuditRow key={audit.auditId} audit={audit} locale={locale} copy={copy} />)}</ol>
              : <ComputerEmpty icon={<History20Regular />} title={copy.noAudits} body={copy.noAuditsBody} />}
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
    <div className="browser-session-intro"><div className="browser-glyph"><Open20Regular /></div><div><strong>{copy.browserClosed}</strong><p>{copy.browserLoginBody}</p></div></div>
    <label className="browser-profile-field"><span>{copy.browserProfile}</span>
      {profiles.length ? <select value={profile} onChange={(event) => onProfile(event.target.value)}><option value="">{copy.automaticProfile}</option>{profiles.map((item) => <option key={`${item.platform}-${item.browserProfile}`} value={item.browserProfile}>{item.browserProfile}{item.accountRef ? ` (${item.accountRef})` : ""}</option>)}</select>
        : <input value={profile} placeholder={copy.optionalProfile} onChange={(event) => onProfile(event.target.value)} />}
      <small>{copy.browserProfileHint}</small>
    </label>
    <Button className="browser-primary-action" appearance="primary" icon={<Play20Regular />} disabled={busy} onClick={onStart}>{action === "start" ? copy.startingBrowser : copy.startBrowser}</Button>
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
      <div><dt>{copy.lastChecked}</dt><dd>{formatDate(session.lastValidatedAt ?? session.updatedAt, locale)}</dd></div>
      <div><dt>{copy.runtime}</dt><dd>{runtimePlatformLabel(session.runtimePlatform)}</dd></div>
    </dl>
    <div className="browser-session-actions">
      {lost && <Button appearance="primary" icon={<Play20Regular />} disabled={busy} onClick={onResume}>{action === "resume" ? copy.resumingBrowser : copy.resumeBrowser}</Button>}
      <Button appearance="secondary" icon={<Stop20Regular />} disabled={busy} onClick={onClose}>{action === "close" ? copy.closingBrowser : copy.closeBrowser}</Button>
    </div>
  </div>;
}

function ScreenshotAuditRow({ audit, locale, copy }: { audit: ScreenshotAudit; locale: AppLocale; copy: ReturnType<typeof computerUseCopy> }) {
  return <li className="privacy-audit-row" data-outcome={audit.outcome}>
    <div className="privacy-audit-main">
      <span>{auditPurposeLabel(audit.purpose, locale)}</span>
      <strong>{audit.modelProvider}/{audit.modelId}</strong>
      <time dateTime={audit.createdAt}>{formatDate(audit.createdAt, locale)}</time>
    </div>
    <dl>
      <div><dt>{copy.roi}</dt><dd>{audit.sentRoi.width} × {audit.sentRoi.height}</dd></div>
      <div><dt>{copy.masks}</dt><dd>{audit.masks.length}</dd></div>
      <div><dt>{copy.disclosure}</dt><dd>{audit.leftLocal ? copy.sentMinimized : copy.stayedLocal}</dd></div>
      <div><dt>{copy.outcome}</dt><dd>{audit.outcome === "blocked" ? copy.blocked : copy.prepared}</dd></div>
    </dl>
    <p><ShieldLock20Regular />{copy.fullScreenshotLocal}</p>
  </li>;
}

function ComputerSkeleton({ label }: { label: string }) {
  return <div className="computer-skeleton" aria-busy="true" aria-label={label}><span /><span /><span /></div>;
}

function ComputerEmpty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return <div className="computer-empty">{icon}<strong>{title}</strong><p>{body}</p></div>;
}

function ComputerError({ message, retry, onRetry }: { message: string; retry: string; onRetry: () => void }) {
  return <div className="computer-error" role="alert"><div><strong>{message}</strong></div><Button appearance="subtle" size="small" onClick={onRetry}>{retry}</Button></div>;
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

export function localizeRuntimeRoute(route: string, locale: AppLocale): string {
  if (!route || route === "not configured") return locale === "zh-CN" ? "尚未配置自动视觉路由" : "Automatic visual routing is not configured";
  if (locale === "en") return route;
  const labels: Record<string, string> = {
    "Built-in GUI": "内置 GUI 定位",
    "Fast Vision": "快速视觉模型",
    "Deep Vision": "深度视觉模型"
  };
  return route.split(/\s*→\s*/).map((item) => labels[item] ?? item).join(" → ");
}

export function localizeRuntimeValue(value: string, locale: AppLocale): string {
  if (!value || value === "not configured") return locale === "zh-CN" ? "未配置" : "Not configured";
  if (value === "not supported") return locale === "zh-CN" ? "不支持" : "Not supported";
  return value;
}

function browserStatusLabel(status: BrowserSession["sessionStatus"], locale: AppLocale): string {
  const zh = { starting: "正在启动", connected: "已连接", lost: "连接已丢失", closed: "已关闭" };
  const en = { starting: "Starting", connected: "Connected", lost: "Connection lost", closed: "Closed" };
  return (locale === "zh-CN" ? zh : en)[status];
}

function permissionLabel(permission: NonNullable<RuntimeModels["permission"]>, locale: AppLocale): string {
  const zh = { OBSERVE: "仅观察", INTERACT: "可交互", MUTATE: "可修改", DESTRUCTIVE: "可执行破坏性操作" };
  const en = { OBSERVE: "Observe only", INTERACT: "Interaction allowed", MUTATE: "Mutation allowed", DESTRUCTIVE: "Destructive actions allowed" };
  return (locale === "zh-CN" ? zh : en)[permission];
}

function auditPurposeLabel(purpose: ScreenshotAudit["purpose"], locale: AppLocale): string {
  const zh = { grounding: "界面定位", verification: "结果校验", table_read: "表格读取", account_identity: "账户识别", other: "其他视觉任务" };
  const en = { grounding: "GUI grounding", verification: "Result verification", table_read: "Table reading", account_identity: "Account identity", other: "Other visual task" };
  return (locale === "zh-CN" ? zh : en)[purpose];
}

function platformLabel(platform: string): string {
  return platform === "google_ads" ? "Google Ads" : platform;
}

function runtimePlatformLabel(platform: BrowserSession["runtimePlatform"]): string {
  return platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";
}

function formatDate(value: string, locale: AppLocale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

export function computerUseCopy(locale: AppLocale) {
  return locale === "zh-CN" ? {
    ready: "系统就绪", needsSetup: "需要配置", readyTitle: "电脑控制已就绪", setupTitle: "电脑控制尚未就绪",
    permission: "当前权限", activePrivacy: "生效中的隐私模式", localOnly: "仅本机", masked: "最小化传输",
    modelRoute: "自动模型路由", modelRouteBody: "系统按任务难度与失败次数自动选择模型。", automatic: "自动",
    dailyModel: "日常对话模型", deepModel: "深度推理模型", groundingModel: "界面定位模型", verificationModel: "独立校验模型",
    privacyMode: "截图隐私", privacyBody: "完整截图始终保存在本机；模型只能接收经过裁剪和遮挡的区域。",
    maskedBody: "允许向远程模型发送经过裁剪和遮挡的必要区域。", localOnlyBody: "禁止截图离开本机；远程视觉请求会被阻止。", restartPrivacy: "保存并重启后，新的隐私模式才会应用到运行时。",
    managedBrowser: "受管浏览器", managedBrowserBody: "AdPilot 使用隔离的浏览器配置档案。登录由你在浏览器中手动完成。", refreshBrowser: "刷新浏览器会话", refresh: "刷新",
    noWorkspace: "尚未选择工作区", noWorkspaceBody: "选择一个客户工作区后才能管理浏览器会话和查看截图审计。", loadingBrowser: "正在读取浏览器会话", browserLoadFailed: "无法读取浏览器会话。", browserActionFailed: "浏览器操作失败。", retry: "重试",
    browserClosed: "浏览器会话尚未启动", browserLoginBody: "启动后请在新浏览器窗口中手动登录。AdPilot 不读取密码或登录存储。", browserProfile: "浏览器配置档案", automaticProfile: "使用工作区绑定配置", optionalProfile: "可选：指定配置档案名称", browserProfileHint: "留空时使用客户工作区中唯一的账户绑定。",
    startBrowser: "启动浏览器", startingBrowser: "正在启动", resumeBrowser: "恢复原会话", resumingBrowser: "正在恢复", closeBrowser: "关闭会话", closingBrowser: "正在关闭",
    browserLostBody: "原进程或窗口绑定不再可信。系统不会自动接管其他窗口。", browserStartingBody: "正在等待受管浏览器窗口完成绑定。", browserConnectedBody: "进程、窗口和配置档案已绑定。每次操作前都会重新检查。", browserLostReason: "浏览器身份校验失败。请将原窗口置于前台后恢复，或关闭会话后重新启动。",
    application: "应用", platform: "广告平台", process: "进程号", window: "窗口号", bounds: "窗口尺寸", lastChecked: "最近校验", runtime: "运行平台", notAvailable: "不可用",
    screenshotAudits: "最近模型截图审计", screenshotAuditsBody: "仅显示元数据，不显示或上传本机保存的完整截图。", refreshAudits: "刷新截图审计", loadingAudits: "正在读取截图审计", auditLoadFailed: "无法读取截图审计。", noAuditWorkspace: "尚无审计范围", noAudits: "暂无模型截图记录", noAuditsBody: "当电脑控制模型首次接收安全区域后，审计记录会显示在这里。",
    roi: "发送区域", masks: "遮挡数量", disclosure: "数据去向", outcome: "处理结果", sentMinimized: "已发送安全区域", stayedLocal: "未离开本机", blocked: "已阻止", prepared: "已准备", fullScreenshotLocal: "完整截图仅保存在本机工作区"
  } : {
    ready: "System ready", needsSetup: "Setup required", readyTitle: "Computer use is ready", setupTitle: "Computer use is not ready",
    permission: "Current permission", activePrivacy: "Active privacy mode", localOnly: "Local only", masked: "Minimized transfer",
    modelRoute: "Automatic model routing", modelRouteBody: "AdPilot selects a model from task complexity and previous failures.", automatic: "Automatic",
    dailyModel: "Daily conversation model", deepModel: "Deep reasoning model", groundingModel: "GUI grounding model", verificationModel: "Independent verifier",
    privacyMode: "Screenshot privacy", privacyBody: "Full screenshots always stay local. Models receive only cropped and masked regions.",
    maskedBody: "Remote models may receive only the necessary cropped and masked region.", localOnlyBody: "Screenshots cannot leave this Mac. Remote visual requests are blocked.", restartPrivacy: "Save and restart before the new privacy mode takes effect in the runtime.",
    managedBrowser: "Managed browser", managedBrowserBody: "AdPilot uses an isolated browser Profile. You complete sign-in manually in the browser.", refreshBrowser: "Refresh browser session", refresh: "Refresh",
    noWorkspace: "No workspace selected", noWorkspaceBody: "Select a client workspace to manage its browser session and screenshot audits.", loadingBrowser: "Loading browser session", browserLoadFailed: "Could not load the browser session.", browserActionFailed: "The browser action failed.", retry: "Retry",
    browserClosed: "No browser session is running", browserLoginBody: "After launch, sign in manually in the new browser window. AdPilot never reads passwords or login storage.", browserProfile: "Browser Profile", automaticProfile: "Use workspace binding", optionalProfile: "Optional Profile name", browserProfileHint: "Leave blank to use the only account binding in the client workspace.",
    startBrowser: "Start browser", startingBrowser: "Starting", resumeBrowser: "Resume original session", resumingBrowser: "Resuming", closeBrowser: "Close session", closingBrowser: "Closing",
    browserLostBody: "The original process or window binding is no longer trusted. AdPilot never adopts another window automatically.", browserStartingBody: "Waiting for the managed browser window to finish binding.", browserConnectedBody: "Process, window, and Profile are bound and rechecked before every action.", browserLostReason: "Browser identity validation failed. Bring the original window to the foreground and resume, or close the session and start again.",
    application: "Application", platform: "Advertising platform", process: "Process ID", window: "Window ID", bounds: "Window size", lastChecked: "Last validated", runtime: "Runtime platform", notAvailable: "Unavailable",
    screenshotAudits: "Recent model screenshot audits", screenshotAuditsBody: "Metadata only. Full local screenshots are neither displayed nor uploaded.", refreshAudits: "Refresh screenshot audits", loadingAudits: "Loading screenshot audits", auditLoadFailed: "Could not load screenshot audits.", noAuditWorkspace: "No audit scope", noAudits: "No model screenshot records", noAuditsBody: "Records appear here after a Computer Use model receives its first safe region.",
    roi: "Sent region", masks: "Masks", disclosure: "Data destination", outcome: "Outcome", sentMinimized: "Safe region sent", stayedLocal: "Stayed local", blocked: "Blocked", prepared: "Prepared", fullScreenshotLocal: "The full screenshot stays in the local workspace"
  };
}
