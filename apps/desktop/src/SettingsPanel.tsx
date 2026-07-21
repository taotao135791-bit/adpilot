import { useEffect, useMemo, useState } from "react";
import { Button } from "@fluentui/react-components";
import type { AppLocale } from "./i18n.js";

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
  runtimeModels: { fast: string; strong: string; gui: string; guiStrong: string; chatConfigured: boolean; guiConfigured: boolean };
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

export function SettingsPanel({ open, data, initialTab = "general", onClose, onSaved }: { open: boolean; data: SettingsData | undefined; initialTab?: SettingsTab; onClose: () => void; onSaved: (data: SettingsData) => void }) {
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
  const text = settingsCopy(locale);

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
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, initialTab, onClose]);

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
      if (!response.ok) throw new Error(body.error ?? text.saveFailed);
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
    if (!response.ok) { setMessage(body.error ?? text.oauthFailed); return; }
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
    <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="settings-header">
        <div><span>ADPILOT / 0.1.0</span><h2 id="settings-title">{text.title}</h2></div>
        <button className="settings-close" onClick={onClose} aria-label={text.close}>×</button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={text.navigation}>
          <SettingsNav active={tab === "general"} label={text.general} meta="01" onClick={() => setTab("general")} />
          <SettingsNav active={tab === "models"} label={text.models} meta="02" onClick={() => setTab("models")} />
          <SettingsNav active={tab === "computer"} label={text.computer} meta="03" onClick={() => setTab("computer")} />
          <SettingsNav active={tab === "about"} label={text.about} meta="04" onClick={() => setTab("about")} />
          <div className="settings-health"><span>{text.connections}</span><strong>{configuredCount.toString().padStart(2, "0")}</strong></div>
        </nav>
        <div className="settings-content">
          {!data && <div className="settings-loading"><i /><span>{text.loading}</span></div>}

          {data && tab === "general" && <SettingsSection eyebrow="01" title={text.generalTitle} body={text.generalBody}>
            <SettingBlock label={text.language} hint={text.languageHint}>
              <Segmented value={locale} options={[{ value: "zh-CN", label: "中文" }, { value: "en", label: "English" }]} onChange={(value) => setLocale(value as AppLocale)} />
            </SettingBlock>
            <SettingBlock label={text.appearance} hint={text.appearanceHint}>
              <Segmented value={appearance} options={[{ value: "dark", label: text.dark }, { value: "light", label: text.light }, { value: "system", label: text.system }]} onChange={(value) => setAppearance(value as typeof appearance)} />
            </SettingBlock>
            <div className="settings-note"><i />{text.localeRule}</div>
          </SettingsSection>}

          {data && tab === "models" && models && <SettingsSection eyebrow="02" title={text.modelsTitle} body={text.modelsBody}>
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

          {data && tab === "computer" && <SettingsSection eyebrow="03" title={text.computerTitle} body={text.computerBody}>
            <div className="settings-note important"><i />{text.computerNote}</div>
            <dl className="system-manifest"><div><dt>{text.visualPrimary}</dt><dd>{data.runtimeModels.gui}</dd></div><div><dt>{text.visualReview}</dt><dd>{data.runtimeModels.guiStrong}</dd></div><div><dt>{text.chatStatus}</dt><dd>{data.runtimeModels.chatConfigured ? text.ready : text.needsCredential}</dd></div><div><dt>{text.visionStatus}</dt><dd>{data.runtimeModels.guiConfigured ? text.ready : text.needsVision}</dd></div></dl>
          </SettingsSection>}

          {data && tab === "about" && <SettingsSection eyebrow="04" title={text.aboutTitle} body={text.aboutBody}>
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

function SettingsNav({ active, label, meta, onClick }: { active: boolean; label: string; meta: string; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}><span>{meta}</span><strong>{label}</strong></button>; }
function SettingsSection({ eyebrow, title, body, children }: { eyebrow: string; title: string; body: string; children: React.ReactNode }) { return <section className="settings-section"><header><span>{eyebrow}</span><h2>{title}</h2><p>{body}</p></header>{children}</section>; }
function SettingBlock({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) { return <div className="setting-block"><div><strong>{label}</strong><span>{hint}</span></div>{children}</div>; }
function Segmented({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) { return <div className="segmented">{options.map((option) => <button key={option.value} className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>; }

function ModelRoute({ label, hint, selection, providers, providerLabel, modelLabel, visionLabel, onProvider, onModel }: { label: string; hint: string; selection: { provider: string; model: string }; providers: CatalogProvider[]; providerLabel: string; modelLabel: string; visionLabel: string; onProvider: (provider: string) => void; onModel: (model: string) => void }) {
  const provider = providers.find((item) => item.id === selection.provider);
  return <article className="route-card"><header><span>{label}</span><small>{hint}</small></header><label><span>{providerLabel}</span><select value={selection.provider} onChange={(event) => onProvider(event.target.value)}>{providers.filter((item) => item.models.length).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>{modelLabel}</span><select value={selection.model} onChange={(event) => onModel(event.target.value)}>{provider?.models.map((model) => <option key={model.id} value={model.id}>{model.name} · {Math.round(model.contextWindow / 1000)}k{model.vision ? ` · ${visionLabel}` : ""}</option>)}</select></label></article>;
}

function OAuthConnection({ session, connected, input, text, onInput, onStart, onRespond, onDisconnect }: { session: AuthSession | undefined; connected: boolean; input: string; text: ReturnType<typeof settingsCopy>; onInput: (value: string) => void; onStart: () => void; onRespond: (value: string) => void; onDisconnect: () => void }) {
  return <div className="oauth-card">
    <div className="oauth-heading"><div><span>OAuth</span><strong>{connected ? text.oauthConnected : text.oauthTitle}</strong></div>{connected ? <button onClick={onDisconnect}>{text.disconnect}</button> : <button disabled={session?.status === "running"} onClick={onStart}>{session?.status === "running" ? text.connecting : text.connect}</button>}</div>
    {!connected && !session && <p>{text.oauthBody}</p>}
    {session?.events.map((event, index) => <div className="oauth-event" key={`${event.type}-${index}`}>
      {event.type === "auth_url" && event.url ? <><span>{event.instructions ?? text.openAuthorization}</span><a href={event.url} target="_blank" rel="noreferrer">{text.openBrowser} ↗</a></> : event.type === "device_code" && event.verificationUri ? <><span>{text.deviceCode}</span><strong>{event.userCode}</strong><a href={event.verificationUri} target="_blank" rel="noreferrer">{text.openBrowser} ↗</a></> : <span>{event.message}</span>}
    </div>)}
    {session?.prompt && <div className="oauth-prompt"><label><span>{session.prompt.message}</span>{session.prompt.type === "select" ? <select value={input} onChange={(event) => onInput(event.target.value)}><option value="">{text.choose}</option>{session.prompt.options?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : <input type={session.prompt.type === "secret" ? "password" : "text"} value={input} placeholder={session.prompt.placeholder} onChange={(event) => onInput(event.target.value)} />}</label><button disabled={!input} onClick={() => onRespond(input)}>{text.continue}</button></div>}
    {session?.status === "complete" && <div className="oauth-result success">{text.oauthComplete}</div>}
    {session?.status === "failed" && <div className="oauth-result error">{session.error ?? text.oauthFailed}</div>}
  </div>;
}

function CredentialField({ field, locale, configured, value, cleared, onChange, onClear }: { field: SettingsField; locale: AppLocale; configured?: boolean; value: string; cleared: boolean; onChange: (value: string) => void; onClear: () => void }) {
  const isZh = locale === "zh-CN";
  return <label className="settings-field"><span>{isZh ? field.label.zh : field.label.en}{field.required && <b>{isZh ? "必填" : "Required"}</b>}</span><div className="field-control"><input type={field.secret ? "password" : "text"} value={value} placeholder={field.secret && configured && !cleared ? (isZh ? "已安全保存；留空则保持不变" : "Saved securely; leave blank to keep") : field.placeholder ?? ""} onChange={(event) => onChange(event.target.value)} />{field.secret && configured && !cleared && <button type="button" onClick={onClear}>{isZh ? "清除" : "Clear"}</button>}</div><small>{field.env}{configured && !cleared ? ` · ${isZh ? "已配置" : "Configured"}` : ""}{cleared ? ` · ${isZh ? "保存后清除" : "Will be cleared"}` : ""}</small></label>;
}

function settingsCopy(locale: AppLocale) {
  const zh = locale === "zh-CN";
  return zh ? {
    title: "设置", close: "关闭设置", navigation: "设置导航", general: "通用", models: "模型", computer: "电脑控制", about: "关于", connections: "已配置连接", loading: "正在读取安全配置", generalTitle: "语言与外观", generalBody: "界面在任一时刻只使用一种语言。产品名和模型名保持原名。", language: "界面语言", languageHint: "应用到操作台和设置页", appearance: "显示模式", appearanceHint: "选择深色、浅色或跟随系统", dark: "深色", light: "浅色", system: "跟随系统", localeRule: "保存后界面会立即切换；模型配置需要重启运行时。", modelsTitle: "模型路由", modelsBody: "选择日常对话模型和高强度推理模型；支持看图的代码模型会自动接管电脑控制。", fastRoute: "日常模型", fastHint: "自然对话、分类、报告与普通任务", strongRoute: "深度模型", strongHint: "因果分析、风险复核与失败升级", providerConnection: "供应商连接", credentials: "凭据", providers: "个供应商", provider: "供应商", model: "模型", visionCapability: "视觉", apiKey: "API 密钥", modelsCount: "个模型", noStaticModels: "该供应商使用动态模型目录，首次认证后获取。", oauthTitle: "订阅账户登录", oauthBody: "通过 Pi 的原生授权流程连接订阅账户；访问令牌只保存在本机工作区。", oauthConnected: "OAuth 已连接", connect: "连接账户", connecting: "连接中", disconnect: "断开连接", openAuthorization: "请在浏览器中完成授权。", openBrowser: "打开浏览器", deviceCode: "在授权页面输入此代码", choose: "请选择", continue: "继续", oauthComplete: "授权完成，重启后即可使用。", oauthFailed: "OAuth 授权失败", computerTitle: "电脑控制模型", computerBody: "无需单独配置视觉模型。AdPilot 直接复用已选择且支持图像输入的代码模型完成截图理解、坐标动作和结果复核。", computerNote: "如果日常模型不支持图像，系统会自动使用深度模型；两者都不支持时仅关闭电脑控制，对话与分析仍可使用。所有真实修改仍受风险复核和一次性批准约束。", visualPrimary: "截图与动作", visualReview: "结果复核", chatStatus: "自然语言对话", visionStatus: "电脑控制", ready: "已就绪", needsCredential: "需要供应商凭据", needsVision: "所选模型不支持图像或缺少凭据", aboutTitle: "系统清单", aboutBody: "本地优先、证据驱动、审批后执行的广告优化智能体。", runtime: "主运行时", visualRuntime: "视觉执行", strategyCore: "广告策略核心", providersAvailable: "可用供应商", legal: "真实账户修改需要独立风险复核、用户批准和一次性执行令牌。完整许可证位于 THIRD_PARTY_NOTICES.md。", localStorage: "配置保存在本机工作区，不会通过设置接口返回密钥明文。", save: "保存配置", saving: "正在保存", saved: "配置已保存；模型路由将在重启后生效。", saveFailed: "保存配置失败", reloadFailed: "无法重新读取配置", restartNow: "立即重启", restartManual: "请关闭并重新启动 AdPilot"
  } : {
    title: "Settings", close: "Close settings", navigation: "Settings navigation", general: "General", models: "Models", computer: "Computer use", about: "About", connections: "Configured connections", loading: "Loading secure settings", generalTitle: "Language and appearance", generalBody: "The interface uses one language at a time. Product and model names retain their proper names.", language: "Interface language", languageHint: "Applies to the console and settings", appearance: "Appearance", appearanceHint: "Choose dark, light, or system mode", dark: "Dark", light: "Light", system: "System", localeRule: "The interface changes immediately after saving. Model settings require a runtime restart.", modelsTitle: "Model routing", modelsBody: "Choose a daily conversation model and a high-assurance reasoning model. Vision-capable code models automatically power computer use.", fastRoute: "Daily model", fastHint: "Natural conversation, classification, reports, and routine work", strongRoute: "Deep model", strongHint: "Causal analysis, risk review, and failure escalation", providerConnection: "Provider connection", credentials: "Credentials", providers: "providers", provider: "Provider", model: "Model", visionCapability: "vision", apiKey: "API key", modelsCount: "models", noStaticModels: "This provider uses a dynamic model catalog fetched after authentication.", oauthTitle: "Subscription login", oauthBody: "Connect a subscription account through Pi's native authorization flow. Tokens remain in the local workspace.", oauthConnected: "OAuth connected", connect: "Connect account", connecting: "Connecting", disconnect: "Disconnect", openAuthorization: "Complete authorization in your browser.", openBrowser: "Open browser", deviceCode: "Enter this code on the authorization page", choose: "Choose an option", continue: "Continue", oauthComplete: "Authorization complete. Restart to use this connection.", oauthFailed: "OAuth authorization failed", computerTitle: "Computer-use models", computerBody: "No separate vision model is required. AdPilot reuses the selected image-capable code models for screenshot understanding, coordinate actions, and visual verification.", computerNote: "If the daily model cannot see images, the deep model is used automatically. If neither supports images, only computer use is disabled; conversation and analysis remain available. Live changes still require risk review and one-time approval.", visualPrimary: "Screenshot and action", visualReview: "Result verification", chatStatus: "Natural-language chat", visionStatus: "Computer use", ready: "Ready", needsCredential: "Provider credentials required", needsVision: "Selected models lack vision or credentials", aboutTitle: "System manifest", aboutBody: "A local-first, evidence-led advertising agent that acts only after approval.", runtime: "Primary runtime", visualRuntime: "Visual execution", strategyCore: "Advertising core", providersAvailable: "Available providers", legal: "Live account changes require independent risk review, user approval, and a one-time execution token. See THIRD_PARTY_NOTICES.md for complete licensing.", localStorage: "Settings stay in the local workspace. Secret values are never returned by the settings API.", save: "Save settings", saving: "Saving", saved: "Settings saved. Model routing takes effect after restart.", saveFailed: "Could not save settings", reloadFailed: "Could not reload settings", restartNow: "Restart now", restartManual: "Close and relaunch AdPilot"
  };
}
