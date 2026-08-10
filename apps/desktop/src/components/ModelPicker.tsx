import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceCopy, type AppLocale } from "../labels.js";
import type { SettingsData } from "../SettingsPanel.js";
import { IconChevronDown, IconSettings } from "../icons.js";

/**
 * Shared model picker chip for the composers. Shows the current fast model,
 * opens a grouped dropdown (providers → models, vision-capable models
 * flagged), and persists every switch through the real settings endpoint so
 * it survives restarts. The chip is honest: models whose provider has no
 * credential are disabled, and a vision flag marks image-capable choices
 * (the computer-use chain needs one).
 */
export function ModelPicker({ locale, settingsLabel, onSaved, onOpenSettings }: {
  locale: AppLocale;
  settingsLabel: string;
  onSaved: (data: SettingsData) => void;
  onOpenSettings: () => void;
}) {
  const copy = workspaceCopy(locale);
  const [data, setData] = useState<SettingsData | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restartPending, setRestartPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/settings");
      if (!response.ok) throw new Error(String(response.status));
      setData(await response.json() as SettingsData);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  async function choose(providerId: string, modelId: string) {
    if (!data || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          locale: data.locale,
          appearance: data.appearance,
          models: {
            fast: { provider: providerId, model: modelId },
            ...(data.models.strongConfigured && data.models.strong ? { strong: data.models.strong } : {})
          }
        })
      });
      if (!response.ok) throw new Error(String(response.status));
      const refreshed = await fetch("/api/settings");
      if (!refreshed.ok) throw new Error(String(refreshed.status));
      const next = await refreshed.json() as SettingsData;
      setData(next);
      onSaved(next);
      // Model routing is built at runtime boot; a saved switch only takes
      // effect after restart. Surface that honestly instead of pretending
      // the chip's label change already swapped the live model.
      setRestartPending(next.restartAvailable === true);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const current = data ? `${data.models.fast.provider}/${data.models.fast.model}` : "…";
  const currentProviderConfigured = data?.providerConfigured[data.models.fast.provider] === true;

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="chip chip-button model-picker-chip"
        aria-expanded={open}
        aria-label={`${copy.modelPickerLabel}: ${current}${currentProviderConfigured ? "" : ` (${copy.modelProviderNeedsKey})`}`}
        onClick={() => setOpen((value) => !value)}
      >
        <i className="model-picker-dot" data-configured={currentProviderConfigured || undefined} aria-hidden="true" />
        <span>{current}</span>
        <IconChevronDown size={11} {...(open ? { className: "open" } : {})} />
      </button>
      {restartPending && (
        <button
          type="button"
          className="chip model-picker-restart"
          onClick={() => void fetch("/api/settings/restart", { method: "POST" })}
        >
          {copy.modelRestartHint}
        </button>
      )}
      {open && (
        <div className="model-picker-menu" role="menu">
          {error && <p className="model-picker-error">{error}</p>}
          {data?.catalog.providers.filter((provider) => provider.models.length > 0).map((provider) => {
            const configured = data.providerConfigured[provider.id] === true;
            return (
              <section key={provider.id} className="model-picker-group">
                <span className="model-picker-provider">
                  {provider.name}
                  {!configured && <em>{copy.modelProviderNeedsKey}</em>}
                </span>
                {provider.models.map((model) => {
                  const active = provider.id === data.models.fast.provider && model.id === data.models.fast.model;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      role="menuitem"
                      className="model-picker-option"
                      data-active={active || undefined}
                      disabled={!configured || busy}
                      onClick={() => void choose(provider.id, model.id)}
                    >
                      <span className="model-picker-option-name">{model.name}</span>
                      {model.vision && <i className="model-picker-vision" title={copy.modelVisionCapable}>{copy.modelVisionCapable}</i>}
                    </button>
                  );
                })}
              </section>
            );
          })}
          <button type="button" className="model-picker-manage" onClick={() => { setOpen(false); onOpenSettings(); }}>
            <IconSettings size={12} />
            <span>{settingsLabel}</span>
          </button>
        </div>
      )}
    </div>
  );
}
