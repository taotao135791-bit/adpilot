import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@fluentui/react-components";
import { Dismiss24Regular } from "@fluentui/react-icons";
import type { AppLocale } from "./i18n.js";
import { ComputerUseSettings } from "./ComputerUseSettings.js";

type SettingsField = { env: string; label: { zh: string; en: string }; secret: boolean; required?: boolean; placeholder?: string };
type CatalogModel = { id: string; name: string; reasoning: boolean; vision: boolean; contextWindow: number };
type CatalogProvider = { id: string; name: string; baseUrl?: string; auth: { apiKey: boolean; oauth: boolean }; fields: SettingsField[]; models: CatalogModel[] };
export type SettingsData = {
  locale: AppLocale;
  appearance: "dark" | "light" | "system";
  models: { fast: { provider: string; model: string }; strong: { provider: string; model: string } };
  values: Record<string, string>;
  configured: Record<string, boolean>;
  catalog: { providers: CatalogProvider[]; computerFields: SettingsField[] };
  providerConfigured: Record<string, boolean>;
  providerCredentials: Record<string, "api_key" | "oauth">;
  runtimeModels: {
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
  restartAvailable: boolean;
};

type AuthSession = {
  id: string;
  providerId: string;
  status: "running" | "complete" | "failed";
  events: Array<{ type: string; message?: string; url?: string; instructions?: string; userCode?: string; verificationUri?: string }>;
  prompt?: { type: "text" | "secret" | "manual_code" | "select"; message: string; placeholder?: string; options?: Array<{ id: string; label: string; description?: string }> };
  error?: string;
};

export type SettingsTab = "general" | "models" | "computer" | "about";

export function SettingsPanel({ open, data, clientId, initialTab = "general", loadError, onReload, onClose, onSaved }: {
  open: boolean;
  data: SettingsData | undefined;
  clientId?: string;
  initialTab?: SettingsTab;
  loadError?: string;
  onReload: () => void;
  onClose: () => void;
  onSaved: (data: SettingsData) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [locale, setLocale] = useState<AppLocale>(data?.locale ?? "zh-CN");
  const [appearance, setAppearance] = useState<"dark" | "light" | "system">(data?.appearance ?? "dark");
  const [models, setModels] = useState(data?.models);
  const [credentialProvider, setCredentialProvider] = useState(data?.models.fast.provider ?? "openai");
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [message, setMessage] = useState("");
  const [authSession, setAuthSession] = useState<AuthSession>();
  const [authInput, setAuthInput] = useState("");
  const [advancedComputer, setAdvancedComputer] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const text = settingsCopy(locale);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!data) return;
    setLocale(data.locale);
    setAppearance(data.appearance);
    setModels(data.models);
    setCredentialProvider(data.models.fast.provider);
    setEnvDraft(data.values);
    setCleared(new Set());
  }, [data]);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleDialogKeys);
      previousFocus?.focus();
    };
  }, [open, initialTab]);

  useEffect(() => {
    if (!authSession || authSession.status !== "running") return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/settings/oauth/session/${authSession.id}`);
      if (!response.ok) return;
      const next = await response.json() as AuthSession;
      setAuthSession(next);
      if (next.status === "complete") {
        const refreshed = await fetch("/api/settings");
        if (refreshed.ok) onSaved(await refreshed.json() as SettingsData);
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [authSession?.id, authSession?.status, onSaved]);

  const selectedProvider = data?.catalog.providers.find((provider) => provider.id === credentialProvider);
  const configuredCount = useMemo(() => Object.values(data?.providerConfigured ?? {}).filter(Boolean).length, [data]);
  if (!open) return null;

  function providerModels(providerId: string): CatalogModel[] {
    return data?.catalog.providers.find((provider) => provider.id === providerId)?.models ?? [];
  }

  function changeProvider(tier: "fast" | "strong", provider: string) {
    const firstModel = providerModels(provider)[0]?.id ?? "";
    setModels((current) => current ? { ...current, [tier]: { provider, model: firstModel } } : current);
  }

  async function save() {
    if (!data || !models?.fast.model || !models.strong.model) return;
    setSaving(true); setMessage("");
    try {
      const fields = data.catalog.providers.flatMap((provider) => provider.fields).concat(data.catalog.computerFields);
      const env: Record<string, string | null> = {};
      for (const item of fields) {
        if (cleared.has(item.env)) env[item.env] = null;
        else if (item.secret) { if (envDraft[item.env]?.trim()) env[item.env] = envDraft[item.env]!.trim(); }
        else env[item.env] = envDraft[item.env] ?? "";
      }
      const response = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale, appearance, models, env }) });
      const body = await response.json();
      if (!response.ok) throw new Error(text.saveFailed);
      const refreshed = await fetch("/api/settings");
      if (!refreshed.ok) throw new Error(text.reloadFailed);
      onSaved(await refreshed.json() as SettingsData);
      setRestartRequired(Boolean(body.restartRequired));
      setMessage(text.saved);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  async function restart() {
    const response = await fetch("/api/settings/restart", { method: "POST" });
    if (!response.ok) setMessage(text.restartManual);
  }

  async function startOAuth() {
    if (!selectedProvider) return;
    setAuthSession(undefined); setAuthInput(""); setMessage("");
    const response = await fetch(`/api/settings/oauth/${encodeURIComponent(selectedProvider.id)}`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) { setMessage(text.oauthFailed); return; }
    setAuthSession({ id: body.id, providerId: selectedProvider.id, status: "running", events: [] });
  }

  async function respondOAuth(value: string) {
    if (!authSession) return;
    const response = await fetch(`/api/settings/oauth/session/${authSession.id}/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
    if (!response.ok) { setMessage(text.oauthFailed); return; }
    setAuthInput("");
  }

  async function disconnectOAuth() {
    if (!selectedProvider) return;
    const response = await fetch(`/api/settings/oauth/${encodeURIComponent(selectedProvider.id)}`, { method: "DELETE" });
    if (!response.ok) { setMessage(text.oauthFailed); return; }
    const refreshed = await fetch("/api/settings");
    if (refreshed.ok) onSaved(await refreshed.json() as SettingsData);
    setAuthSession(undefined);
  }

  return <div className="settings-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="settings-header">
        <div><span>ADPILOT</span><h2 id="settings-title">{text.title}</h2></div>
        <button ref={closeButtonRef} type="button" className="settings-close" onClick={onClose} aria-label={text.close}><Dismiss24Regular /></button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={text.navigation}>
          <SettingsNav active={tab === "general"} label={text.general} onClick={() => setTab("general")} />
          <SettingsNav active={tab === "models"} label={text.models} onClick={() => setTab("models")} />
          <SettingsNav active={tab === "computer"} label={text.computer} onClick={() => setTab("computer")} />
          <SettingsNav active={tab === "about"} label={text.about} onClick={() => setTab("about")} />
          <div className="settings-health"><span>{text.connections}</span><strong>{configuredCount.toString().padStart(2, "0")}</strong></div>
        </nav>
        <div className="settings-content">
          {!data && !loadError && <div className="settings-loading" aria-busy="true"><i /><span>{text.loading}</span></div>}
          {!data && loadError && <div className="settings-load-error" role="alert"><strong>{text.loadingFailed}</strong><p>{loadError}</p><Button onClick={onReload}>{text.retry}</Button></div>}

          {data && tab === "general" && <SettingsSection title={text.generalTitle} body={text.generalBody}>
            <SettingBlock label={text.language} hint={text.languageHint}>
              <Segmented value={locale} options={[{ value: "zh-CN", label: "中文" }, { value: "en", label: "English" }]} onChange={(value) => setLocale(value as AppLocale)} />
            </SettingBlock>
            <SettingBlock label={text.appearance} hint={text.appearanceHint}>
              <Segmented value={appearance} options={[{ value: "dark", label: text.dark }, { value: "light", label: text.light }, { value: "system", label: text.system }]} onChange={(value) => setAppearance(value as typeof appearance)} />
            </SettingBlock>
            <div className="settings-note"><i />{text.localeRule}</div>
          </SettingsSection>}

          {data && tab === "models" && models && <SettingsSection title={text.modelsTitle} body={text.modelsBody}>
            <div className="route-grid">
              <ModelRoute label={text.fastRoute} hint={text.fastHint} selection={models.fast} providers={data.catalog.providers} providerLabel={text.provider} modelLabel={text.model} visionLabel={text.visionCapability} onProvider={(provider) => changeProvider("fast", provider)} onModel={(model) => setModels({ ...models, fast: { ...models.fast, model } })} />
              <ModelRoute label={text.strongRoute} hint={text.strongHint} selection={models.strong} providers={data.catalog.providers} providerLabel={text.provider} modelLabel={text.model} visionLabel={text.visionCapability} onProvider={(provider) => changeProvider("strong", provider)} onModel={(model) => setModels({ ...models, strong: { ...models.strong, model } })} />
            </div>
            <div className="settings-divider" />
            <div className="subsection-heading"><div><span>{text.providerConnection}</span><h3>{text.credentials}</h3></div><small>{data.catalog.providers.length} {text.providers}</small></div>
            <label className="settings-field"><span>{text.provider}</span><select value={credentialProvider} onChange={(event) => setCredentialProvider(event.target.value)}>{data.catalog.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
            {selectedProvider && <div className="provider-summary"><div><strong>{selectedProvider.name}</strong><span>{selectedProvider.models.length} {text.modelsCount} · {selectedProvider.auth.apiKey ? text.apiKey : ""}{selectedProvider.auth.apiKey && selectedProvider.auth.oauth ? " · " : ""}{selectedProvider.auth.oauth ? "OAuth" : ""}</span></div><i data-ready={Boolean(data.providerConfigured[selectedProvider.id])} /></div>}
            {selectedProvider?.fields.length ? <div className="settings-fields">{selectedProvider.fields.map((field) => <CredentialField key={field.env} field={field} locale={locale} configured={Boolean(data.configured[field.env])} value={envDraft[field.env] ?? ""} cleared={cleared.has(field.env)} onChange={(value) => { setEnvDraft({ ...envDraft, [field.env]: value }); setCleared((items) => { const next = new Set(items); next.delete(field.env); return next; }); }} onClear={() => setCleared((items) => new Set(items).add(field.env))} />)}</div> : !selectedProvider?.auth.oauth && <div className="settings-note"><i />{text.noStaticModels}</div>}
            {selectedProvider?.auth.oauth && <OAuthConnection session={authSession?.providerId === selectedProvider.id ? authSession : undefined} connected={data.providerCredentials[selectedProvider.id] === "oauth"} input={authInput} text={text} onInput={setAuthInput} onStart={() => void startOAuth()} onRespond={(value) => void respondOAuth(value)} onDisconnect={() => void disconnectOAuth()} />}
          </SettingsSection>}

          {data && tab === "computer" && <SettingsSection title={text.computerTitle} body={text.computerBody}>
            <div className="settings-note important"><i />{text.computerNote}</div>
            <ComputerUseSettings locale={locale} {...(clientId ? { clientId } : {})} runtime={data.runtimeModels} privacyMode={envDraft.ADPILOT_PRIVACY_MODE || "standard"} onPrivacyMode={(value) => setEnvDraft({ ...envDraft, ADPILOT_PRIVACY_MODE: value })} />
            <button type="button" className="advanced-settings-toggle" aria-expanded={advancedComputer} onClick={() => setAdvancedComputer((value) => !value)}>{advancedComputer ? text.hideAdvanced : text.showAdvanced}</button>
            {advancedComputer && <div className="settings-fields">{data.catalog.computerFields.filter((field) => field.env !== "ADPILOT_PRIVACY_MODE").map((field) => <CredentialField key={field.env} field={field} locale={locale} configured={Boolean(data.configured[field.env])} value={envDraft[field.env] ?? ""} cleared={cleared.has(field.env)} onChange={(value) => { setEnvDraft({ ...envDraft, [field.env]: value }); setCleared((items) => { const next = new Set(items); next.delete(field.env); return next; }); }} onClear={() => setCleared((items) => new Set(items).add(field.env))} />)}</div>}
          </SettingsSection>}

          {data && tab === "about" && <SettingsSection title={text.aboutTitle} body={text.aboutBody}>
            <dl className="system-manifest"><div><dt>{text.runtime}</dt><dd>Pi 0.80.10 · MIT</dd></div><div><dt>{text.visualRuntime}</dt><dd>UI-TARS 1.2.3 · Apache-2.0</dd></div><div><dt>{text.strategyCore}</dt><dd>codex-ads 1.9.2 · MIT</dd></div><div><dt>{text.providersAvailable}</dt><dd>{data.catalog.providers.length}</dd></div></dl>
            <p className="settings-legal">{text.legal}</p>
          </SettingsSection>}
        </div>
      </div>
      <footer className="settings-footer">
        <span className={message && !restartRequired ? "settings-message" : ""}>{message || text.localStorage}</span>
        <div>
          {restartRequired && <Button appearance="subtle" onClick={() => void restart()}>{data?.restartAvailable ? text.restartNow : text.restartManual}</Button>}
          <Button className="settings-save" appearance="primary" disabled={!data || saving} onClick={() => void save()}>{saving ? text.saving : text.save}</Button>
        </div>
      </footer>
    </section>
  </div>;
}

function SettingsNav({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) { return <button type="button" className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={onClick}><strong>{label}</strong></button>; }
function SettingsSection({ title, body, children }: { title: string; body: string; children: React.ReactNode }) { return <section className="settings-section"><header><h2>{title}</h2><p>{body}</p></header>{children}</section>; }
function SettingBlock({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) { return <div className="setting-block"><div><strong>{label}</strong><span>{hint}</span></div>{children}</div>; }
function Segmented({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) { return <div className="segmented" role="radiogroup">{options.map((option) => <button type="button" role="radio" aria-checked={value === option.value} key={option.value} className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>; }

function ModelRoute({ label, hint, selection, providers, providerLabel, modelLabel, visionLabel, onProvider, onModel }: { label: string; hint: string; selection: { provider: string; model: string }; providers: CatalogProvider[]; providerLabel: string; modelLabel: string; visionLabel: string; onProvider: (provider: string) => void; onModel: (model: string) => void }) {
  const provider = providers.find((item) => item.id === selection.provider);
  return <article className="route-card"><header><span>{label}</span><small>{hint}</small></header><label><span>{providerLabel}</span><select value={selection.provider} onChange={(event) => onProvider(event.target.value)}>{providers.filter((item) => item.models.length).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>{modelLabel}</span><select value={selection.model} onChange={(event) => onModel(event.target.value)}>{provider?.models.map((model) => <option key={model.id} value={model.id}>{model.name} · {Math.round(model.contextWindow / 1000)}k{model.vision ? ` · ${visionLabel}` : ""}</option>)}</select></label></article>;
}

function OAuthConnection({ session, connected, input, text, onInput, onStart, onRespond, onDisconnect }: { session: AuthSession | undefined; connected: boolean; input: string; text: ReturnType<typeof settingsCopy>; onInput: (value: string) => void; onStart: () => void; onRespond: (value: string) => void; onDisconnect: () => void }) {
  return <div className="oauth-card">
    <div className="oauth-heading"><div><span>OAuth</span><strong>{connected ? text.oauthConnected : text.oauthTitle}</strong></div>{connected ? <button onClick={onDisconnect}>{text.disconnect}</button> : <button disabled={session?.status === "running"} onClick={onStart}>{session?.status === "running" ? text.connecting : text.connect}</button>}</div>
    {!connected && !session && <p>{text.oauthBody}</p>}
    {session?.events.map((event, index) => <div className="oauth-event" key={`${event.type}-${index}`}>
      {event.type === "auth_url" && event.url ? <><span>{text.openAuthorization}</span><a href={event.url} target="_blank" rel="noreferrer">{text.openBrowser} ↗</a></> : event.type === "device_code" && event.verificationUri ? <><span>{text.deviceCode}</span><strong>{event.userCode}</strong><a href={event.verificationUri} target="_blank" rel="noreferrer">{text.openBrowser} ↗</a></> : <span>{text.oauthWaiting}</span>}
    </div>)}
    {session?.prompt && <div className="oauth-prompt"><label><span>{session.prompt.type === "select" ? text.oauthSelectPrompt : session.prompt.type === "manual_code" ? text.oauthCodePrompt : session.prompt.type === "secret" ? text.oauthSecretPrompt : text.oauthInputPrompt}</span>{session.prompt.type === "select" ? <select value={input} onChange={(event) => onInput(event.target.value)}><option value="">{text.choose}</option>{session.prompt.options?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : <input type={session.prompt.type === "secret" ? "password" : "text"} value={input} placeholder={text.oauthInputPlaceholder} onChange={(event) => onInput(event.target.value)} />}</label><button disabled={!input} onClick={() => onRespond(input)}>{text.continue}</button></div>}
    {session?.status === "complete" && <div className="oauth-result success">{text.oauthComplete}</div>}
    {session?.status === "failed" && <div className="oauth-result error">{text.oauthFailed}</div>}
  </div>;
}

function CredentialField({ field, locale, configured, value, cleared, onChange, onClear }: { field: SettingsField; locale: AppLocale; configured?: boolean; value: string; cleared: boolean; onChange: (value: string) => void; onClear: () => void }) {
  const isZh = locale === "zh-CN";
  return <label className="settings-field"><span>{isZh ? field.label.zh : field.label.en}{field.required && <b>{isZh ? "必填" : "Required"}</b>}</span><div className="field-control"><input type={field.secret ? "password" : "text"} value={value} placeholder={field.secret && configured && !cleared ? (isZh ? "已安全保存；留空则保持不变" : "Saved securely; leave blank to keep") : field.placeholder ?? ""} onChange={(event) => onChange(event.target.value)} />{field.secret && configured && !cleared && <button type="button" onClick={onClear}>{isZh ? "清除" : "Clear"}</button>}</div><small>{field.env}{configured && !cleared ? ` · ${isZh ? "已配置" : "Configured"}` : ""}{cleared ? ` · ${isZh ? "保存后清除" : "Will be cleared"}` : ""}</small></label>;
}

function settingsCopy(locale: AppLocale) {
  const zh = locale === "zh-CN";
  return zh ? {
    title: "设置", close: "关闭设置", navigation: "设置导航", general: "通用", models: "模型", computer: "电脑控制", about: "关于", connections: "已配置连接", loading: "正在读取安全配置", loadingFailed: "无法读取设置", retry: "重试", generalTitle: "语言与外观", generalBody: "界面在任一时刻只使用一种语言。产品名和模型名保持原名。", language: "界面语言", languageHint: "应用到操作台和设置页", appearance: "显示模式", appearanceHint: "选择深色、浅色或跟随系统", dark: "深色", light: "浅色", system: "跟随系统", localeRule: "保存后界面会立即切换；模型配置需要重启运行时。", modelsTitle: "模型路由", modelsBody: "选择日常对话模型和高强度推理模型；支持看图的代码模型会自动作为电脑控制的视觉模型。", fastRoute: "日常模型", fastHint: "自然对话、分类、报告与普通任务", strongRoute: "深度模型", strongHint: "因果分析、风险复核与失败升级", providerConnection: "供应商连接", credentials: "凭据", providers: "个供应商", provider: "供应商", model: "模型", visionCapability: "视觉", apiKey: "API 密钥", modelsCount: "个模型", noStaticModels: "该供应商使用动态模型目录，首次认证后获取。", oauthTitle: "订阅账户登录", oauthBody: "通过 Pi 的原生授权流程连接订阅账户；访问令牌只保存在本机工作区。", oauthConnected: "OAuth 已连接", connect: "连接账户", connecting: "连接中", disconnect: "断开连接", openAuthorization: "请在浏览器中完成授权。", openBrowser: "打开浏览器", deviceCode: "在授权页面输入此代码", choose: "请选择", continue: "继续", oauthWaiting: "正在等待授权供应商响应。", oauthSelectPrompt: "请选择授权账户。", oauthCodePrompt: "请输入授权页面显示的代码。", oauthSecretPrompt: "请输入授权流程要求的安全值。", oauthInputPrompt: "请输入授权流程要求的信息。", oauthInputPlaceholder: "在此输入", oauthComplete: "授权完成，重启后即可使用。", oauthFailed: "OAuth 授权失败", computerTitle: "电脑控制", computerBody: "使用日常与深度代码模型完成看图、定位和复核。专用视觉端点属于可选的高级设置。", computerNote: "系统每次只执行一个可校验动作。账户修改仍需要实时窗口绑定、独立身份校验、风险复核和一次性批准。", showAdvanced: "显示高级开发者设置", hideAdvanced: "收起高级开发者设置", visualPrimary: "截图与动作", visualReview: "结果复核", chatStatus: "自然语言对话", visionStatus: "电脑控制", ready: "已就绪", needsCredential: "需要供应商凭据", needsVision: "请选择支持图像且已认证的代码模型", aboutTitle: "系统清单", aboutBody: "本地优先、证据驱动、审批后执行的广告优化智能体。", runtime: "主运行时", visualRuntime: "视觉执行", strategyCore: "广告策略核心", providersAvailable: "可用供应商", legal: "真实账户修改需要独立风险复核、用户批准和一次性执行令牌。完整许可证随应用分发。", localStorage: "配置保存在本机工作区，不会通过设置接口返回密钥明文。", save: "保存配置", saving: "正在保存", saved: "配置已保存；模型路由将在重启后生效。", saveFailed: "保存配置失败", reloadFailed: "无法重新读取配置", restartNow: "立即重启", restartManual: "请关闭并重新启动 AdPilot"
  } : {
    title: "Settings", close: "Close settings", navigation: "Settings navigation", general: "General", models: "Models", computer: "Computer use", about: "About", connections: "Configured connections", loading: "Loading secure settings", loadingFailed: "Could not load settings", retry: "Retry", generalTitle: "Language and appearance", generalBody: "The interface uses one language at a time. Product and model names retain their proper names.", language: "Interface language", languageHint: "Applies to the console and settings", appearance: "Appearance", appearanceHint: "Choose dark, light, or system mode", dark: "Dark", light: "Light", system: "System", localeRule: "The interface changes immediately after saving. Model settings require a runtime restart.", modelsTitle: "Model routing", modelsBody: "Choose daily and high-assurance reasoning models. Image-capable code models become the Computer Use vision models automatically.", fastRoute: "Daily model", fastHint: "Natural conversation, classification, reports, and routine work", strongRoute: "Deep model", strongHint: "Causal analysis, risk review, and failure escalation", providerConnection: "Provider connection", credentials: "Credentials", providers: "providers", provider: "Provider", model: "Model", visionCapability: "vision", apiKey: "API key", modelsCount: "models", noStaticModels: "This provider uses a dynamic model catalog fetched after authentication.", oauthTitle: "Subscription login", oauthBody: "Connect a subscription account through Pi's native authorization flow. Tokens remain in the local workspace.", oauthConnected: "OAuth connected", connect: "Connect account", connecting: "Connecting", disconnect: "Disconnect", openAuthorization: "Complete authorization in your browser.", openBrowser: "Open browser", deviceCode: "Enter this code on the authorization page", choose: "Choose an option", continue: "Continue", oauthWaiting: "Waiting for the provider to continue authorization.", oauthSelectPrompt: "Choose the account to authorize.", oauthCodePrompt: "Enter the code shown on the authorization page.", oauthSecretPrompt: "Enter the secure value requested by the authorization flow.", oauthInputPrompt: "Enter the information requested by the authorization flow.", oauthInputPlaceholder: "Enter here", oauthComplete: "Authorization complete. Restart to use this connection.", oauthFailed: "OAuth authorization failed", computerTitle: "Computer use", computerBody: "Daily and Deep code models handle screenshots, grounding, and verification. Dedicated vision endpoints are optional advanced settings.", computerNote: "AdPilot performs one verifiable action at a time. Account changes still require live-window binding, independent identity checks, risk review, and one-time approval.", showAdvanced: "Show advanced developer settings", hideAdvanced: "Hide advanced developer settings", visualPrimary: "Screenshot and action", visualReview: "Result verification", chatStatus: "Natural-language chat", visionStatus: "Computer use", ready: "Ready", needsCredential: "Provider credentials required", needsVision: "Select and authenticate an image-capable code model", aboutTitle: "System manifest", aboutBody: "A local-first, evidence-led advertising agent that acts only after approval.", runtime: "Primary runtime", visualRuntime: "Visual execution", strategyCore: "Advertising core", providersAvailable: "Available providers", legal: "Live account changes require independent risk review, user approval, and a one-time execution token. Complete license files ship with the application.", localStorage: "Settings stay in the local workspace. Secret values are never returned by the settings API.", save: "Save settings", saving: "Saving", saved: "Settings saved. Model routing takes effect after restart.", saveFailed: "Could not save settings", reloadFailed: "Could not reload settings", restartNow: "Restart now", restartManual: "Close and relaunch AdPilot"
  };
}
