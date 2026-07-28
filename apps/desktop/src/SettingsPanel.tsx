import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui.js";
import { IconDismiss } from "./icons.js";
import { computerUseCopy, localizeRuntimeValue, settingsCopy, type AppLocale } from "./labels.js";
import { ComputerUseSettings } from "./ComputerUseSettings.js";
import { PermissionCenter } from "./PermissionCenter.js";
import type { ProductSession } from "./types.js";

type SettingsField = { env: string; label: { zh: string; en: string }; secret: boolean; required?: boolean; placeholder?: string };
type CatalogModel = { id: string; name: string; reasoning: boolean; vision: boolean; contextWindow: number };
type CatalogProvider = { id: string; name: string; baseUrl?: string; auth: { apiKey: boolean; oauth: boolean }; fields: SettingsField[]; models: CatalogModel[] };
export type SettingsData = {
  locale: AppLocale;
  appearance: "dark" | "light" | "system";
  models: { fast: { provider: string; model: string }; strong: { provider: string; model: string }; strongConfigured?: boolean };
  reasoning?: { effort: "off" | "low" | "medium" | "high"; scope: "strong" | "all" };
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

export type SettingsTab = "general" | "models" | "permissions" | "computer" | "about";

export function SettingsPanel({ open, data, clientId, productSession, productSessionId, browserSessionId, initialTab = "general", loadError, onReload, onClose, onSaved, onProductSessionUpdated }: {
  open: boolean;
  data: SettingsData | undefined;
  clientId?: string;
  productSession?: ProductSession;
  productSessionId?: string;
  browserSessionId?: string;
  initialTab?: SettingsTab;
  loadError?: string;
  onReload: () => void;
  onClose: () => void;
  onSaved: (data: SettingsData) => void;
  onProductSessionUpdated: (session: ProductSession) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [locale, setLocale] = useState<AppLocale>(data?.locale ?? "zh-CN");
  const [appearance, setAppearance] = useState<"dark" | "light" | "system">(data?.appearance ?? "dark");
  const [models, setModels] = useState(data?.models);
  const [dualModel, setDualModel] = useState(data?.models.strongConfigured ?? true);
  const [reasoningEffort, setReasoningEffort] = useState<"off" | "low" | "medium" | "high">(data?.reasoning?.effort ?? "off");
  const [reasoningScope, setReasoningScope] = useState<"strong" | "all">(data?.reasoning?.scope ?? "strong");
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
    setDualModel(data.models.strongConfigured ?? true);
    setReasoningEffort(data.reasoning?.effort ?? "off");
    setReasoningScope(data.reasoning?.scope ?? "strong");
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
    if (!data || !models?.fast.model || (dualModel && !models.strong.model)) return;
    setSaving(true); setMessage("");
    try {
      const fields = data.catalog.providers.flatMap((provider) => provider.fields).concat(data.catalog.computerFields);
      const env: Record<string, string | null> = {};
      for (const item of fields) {
        if (cleared.has(item.env)) env[item.env] = null;
        else if (item.secret) { if (envDraft[item.env]?.trim()) env[item.env] = envDraft[item.env]!.trim(); }
        else env[item.env] = envDraft[item.env] ?? "";
      }
      // Single-model mode: omitting `strong` makes every role share `fast`.
      const modelPayload = { fast: models.fast, ...(dualModel ? { strong: models.strong } : {}) };
      const response = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale, appearance, models: modelPayload, reasoning: { effort: reasoningEffort, scope: reasoningScope }, env }) });
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
        <button ref={closeButtonRef} type="button" className="settings-close" onClick={onClose} aria-label={text.close}><IconDismiss size={15} /></button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={text.navigation}>
          <SettingsNav active={tab === "general"} label={text.general} onClick={() => setTab("general")} />
          <SettingsNav active={tab === "models"} label={text.models} onClick={() => setTab("models")} />
          <SettingsNav active={tab === "permissions"} label={text.permissions} onClick={() => setTab("permissions")} />
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
              {dualModel && <ModelRoute label={text.strongRoute} hint={text.strongHint} selection={models.strong} providers={data.catalog.providers} providerLabel={text.provider} modelLabel={text.model} visionLabel={text.visionCapability} onProvider={(provider) => changeProvider("strong", provider)} onModel={(model) => setModels({ ...models, strong: { ...models.strong, model } })} />}
            </div>
            <label className="settings-toggle"><input type="checkbox" checked={dualModel} onChange={(event) => setDualModel(event.target.checked)} /><div><strong>{text.dualModel}</strong><span>{text.dualModelHint}</span></div></label>
            <div className="settings-divider" />
            <div className="subsection-heading"><div><span>{text.reasoningTitle}</span><h3>{text.reasoningEffort}</h3></div></div>
            <p className="settings-note"><i />{text.reasoningBody}</p>
            <SettingBlock label={text.reasoningEffort} hint={text.reasoningScope}>
              <Segmented value={reasoningEffort} options={[{ value: "off", label: text.effortOff }, { value: "low", label: text.effortLow }, { value: "medium", label: text.effortMedium }, { value: "high", label: text.effortHigh }]} onChange={(value) => setReasoningEffort(value as typeof reasoningEffort)} />
            </SettingBlock>
            <SettingBlock label={text.reasoningScope} hint="">
              <Segmented value={reasoningScope} options={[{ value: "strong", label: text.scopeStrong }, { value: "all", label: text.scopeAll }]} onChange={(value) => setReasoningScope(value as typeof reasoningScope)} />
            </SettingBlock>
            {reasoningEffort !== "off" && !supportsReasoning(data, models, dualModel) && <div className="settings-note important"><i />{text.reasoningUnsupported}</div>}
            <div className="settings-divider" />
            <div className="subsection-heading"><div><span>{text.runtimeRoutes}</span><h3>{text.runtimeRoutesTitle}</h3></div></div>
            <RuntimeRoutes runtime={data.runtimeModels} locale={locale} />
            <div className="settings-divider" />
            <div className="subsection-heading"><div><span>{text.providerConnection}</span><h3>{text.credentials}</h3></div><small>{data.catalog.providers.length} {text.providers}</small></div>
            <label className="settings-field"><span>{text.provider}</span><select value={credentialProvider} onChange={(event) => setCredentialProvider(event.target.value)}>{data.catalog.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
            {selectedProvider && <div className="provider-summary"><div><strong>{selectedProvider.name}</strong><span>{selectedProvider.models.length} {text.modelsCount} · {selectedProvider.auth.apiKey ? text.apiKey : ""}{selectedProvider.auth.apiKey && selectedProvider.auth.oauth ? " · " : ""}{selectedProvider.auth.oauth ? "OAuth" : ""}</span></div><i data-ready={Boolean(data.providerConfigured[selectedProvider.id])} /></div>}
            {selectedProvider?.fields.length ? <div className="settings-fields">{selectedProvider.fields.map((field) => <CredentialField key={field.env} field={field} locale={locale} configured={Boolean(data.configured[field.env])} value={envDraft[field.env] ?? ""} cleared={cleared.has(field.env)} onChange={(value) => { setEnvDraft({ ...envDraft, [field.env]: value }); setCleared((items) => { const next = new Set(items); next.delete(field.env); return next; }); }} onClear={() => setCleared((items) => new Set(items).add(field.env))} />)}</div> : !selectedProvider?.auth.oauth && <div className="settings-note"><i />{text.noStaticModels}</div>}
            {selectedProvider?.auth.oauth && <OAuthConnection session={authSession?.providerId === selectedProvider.id ? authSession : undefined} connected={data.providerCredentials[selectedProvider.id] === "oauth"} input={authInput} text={text} onInput={setAuthInput} onStart={() => void startOAuth()} onRespond={(value) => void respondOAuth(value)} onDisconnect={() => void disconnectOAuth()} />}
          </SettingsSection>}

          {data && tab === "permissions" && <SettingsSection title={text.permissionsTitle} body={text.permissionsBody}>
            <PermissionCenter
              locale={locale}
              {...(clientId ? { clientId } : {})}
              {...(productSessionId ? { productSessionId } : {})}
              {...(browserSessionId ? { browserSessionId } : {})}
            />
          </SettingsSection>}

          {data && tab === "computer" && <SettingsSection title={text.computerTitle} body={text.computerBody}>
            <div className="settings-note important"><i />{text.computerNote}</div>
            <ComputerUseSettings
              locale={locale}
              {...(clientId ? { clientId } : {})}
              {...(productSession ? { productSession } : {})}
              runtime={data.runtimeModels}
              privacyMode={envDraft.ADPILOT_PRIVACY_MODE || "standard"}
              onPrivacyMode={(value) => setEnvDraft({ ...envDraft, ADPILOT_PRIVACY_MODE: value })}
              onProductSessionUpdated={onProductSessionUpdated}
            />
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
          {restartRequired && <Button variant="subtle" onClick={() => void restart()}>{data?.restartAvailable ? text.restartNow : text.restartManual}</Button>}
          <Button className="settings-save" variant="primary" disabled={!data || saving} onClick={() => void save()}>{saving ? text.saving : text.save}</Button>
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

/** Read-only view of the runtime's effective routing (the former rail model grid). */
function RuntimeRoutes({ runtime, locale }: { runtime: SettingsData["runtimeModels"]; locale: AppLocale }) {
  const computerText = computerUseCopy(locale);
  const routes = [
    { label: computerText.dailyModel, value: runtime.fast, configured: runtime.chatConfigured },
    { label: computerText.deepModel, value: runtime.strong, configured: Boolean(runtime.strong) },
    { label: computerText.groundingModel, value: runtime.gui, configured: runtime.guiConfigured },
    { label: computerText.verificationModel, value: runtime.guiStrong, configured: runtime.guiConfigured }
  ];
  return <div className="runtime-route-grid">
    {routes.map((route) => <div className="runtime-route-item" key={route.label} data-ready={route.configured}>
      <span>{route.label}</span>
      <strong>{localizeRuntimeValue(route.value, locale)}</strong>
    </div>)}
  </div>;
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

function CredentialField({ field, locale, configured, value, cleared, onChange, onClear }: { field: SettingsField; locale: AppLocale; configured?: boolean; value: string; cleared: boolean; onChange: (value: string) => void; onClear: () => void }) {  const isZh = locale === "zh-CN";
  return <label className="settings-field"><span>{isZh ? field.label.zh : field.label.en}{field.required && <b>{isZh ? "必填" : "Required"}</b>}</span><div className="field-control"><input type={field.secret ? "password" : "text"} value={value} placeholder={field.secret && configured && !cleared ? (isZh ? "已安全保存；留空则保持不变" : "Saved securely; leave blank to keep") : field.placeholder ?? ""} onChange={(event) => onChange(event.target.value)} />{field.secret && configured && !cleared && <button type="button" onClick={onClear}>{isZh ? "清除" : "Clear"}</button>}</div><small>{field.env}{configured && !cleared ? ` · ${isZh ? "已配置" : "Configured"}` : ""}{cleared ? ` · ${isZh ? "保存后清除" : "Will be cleared"}` : ""}</small></label>;
}


/** True when any model that would receive the reasoning effort supports it —
    the deep-role model when scope is "strong" (or dual-model), else the shared one. */
function supportsReasoning(data: SettingsData, models: SettingsData["models"], dualModel: boolean): boolean {
  const has = (selection: { provider: string; model: string }) =>
    data.catalog.providers.find((provider) => provider.id === selection.provider)?.models.some((model) => model.id === selection.model && model.reasoning) ?? false;
  return has(models.fast) || (dualModel && has(models.strong));
}
