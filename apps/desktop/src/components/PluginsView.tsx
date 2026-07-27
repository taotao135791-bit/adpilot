import { useCallback, useEffect, useState } from "react";
import {
  pluginCategoryLabel,
  pluginReviewLabel,
  pluginRiskLabel,
  pluginStatusLabel,
  pluginsCopy,
  type AppLocale,
  type PluginsCopy
} from "../labels.js";
import {
  classifyPluginActionError,
  formatLogTime,
  groupPlugins,
  isAdvertisingMutation,
  isCatalogUnavailable,
  permissionDiffRows,
  pluginActionBody,
  pluginActionUrl,
  pluginDetailsUrl,
  pluginPrimaryCategory,
  pluginReviewTone,
  pluginRisk,
  pluginStatusTone,
  riskTone,
  sortPermissionsByRisk,
  truncateFingerprint,
  type PluginAction,
  type PluginActionBlock,
  type PluginCatalogItem,
  type PluginCatalogResponse,
  type PluginDetailsResponse,
  type PluginPermissionDto,
  type PluginUpdate
} from "../plugins.js";
import { Badge, Button } from "../ui.js";
import { IconArrowLeft, IconDismiss, IconError, IconPuzzle, IconShieldCheck } from "../icons.js";

/**
 * Plugins view: the curated catalog (installed group first), a detail page
 * with permissions/signature/logs, and the two consent flows — the 409
 * permission diff and the 403 unsigned bundle. All grouping, risk and
 * error-classification rules live in the React-free plugins.ts module; this
 * component only wires fetching and user intent. `pluginTick` is bumped by
 * the App-level SSE splitter whenever a plugin lifecycle event arrives.
 */
export function PluginsView({ locale, clientId, pluginTick }: {
  locale: AppLocale;
  clientId: string;
  pluginTick: number;
}) {
  const copy = pluginsCopy(locale);
  const [catalog, setCatalog] = useState<PluginCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [detail, setDetail] = useState<PluginDetailsResponse | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ action: PluginAction; block: PluginActionBlock } | null>(null);
  const [actionError, setActionError] = useState("");
  const [acting, setActing] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  const loadCatalog = useCallback(async () => {
    try {
      const response = await fetch("/api/plugins");
      const body = await response.json().catch(() => undefined) as (PluginCatalogResponse & { error?: string }) | undefined;
      if (!response.ok || !body) {
        if (isCatalogUnavailable(response.status, body)) setCatalog({ plugins: [], runtime: { available: false, developerMode: false, catalogError: { code: "PLUGIN_CATALOG_UNAVAILABLE", message: body?.error ?? "" } } });
        else setLoadError(body?.error ?? copy.loadFailed);
      } else {
        setCatalog(body);
        setLoadError("");
      }
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : copy.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [copy]);

  const loadDetail = useCallback(async (pluginId: string) => {
    try {
      const response = await fetch(pluginDetailsUrl(pluginId));
      const body = await response.json().catch(() => undefined) as PluginDetailsResponse | undefined;
      if (response.ok && body) setDetail(body);
    } catch { /* the list stays usable when one detail call fails */ }
  }, []);

  useEffect(() => { setLoading(true); void loadCatalog(); }, [loadCatalog, pluginTick]);
  useEffect(() => { if (detailId) void loadDetail(detailId); }, [detailId, loadDetail, pluginTick]);

  async function runAction(pluginId: string, action: PluginAction, flags: { allowUnsigned?: true; acceptPermissions?: true } = {}) {
    setActing(true);
    setActionError("");
    try {
      const response = await fetch(pluginActionUrl(pluginId, action), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: pluginActionBody({ ...(clientId ? { clientId } : {}), ...flags })
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) {
        const block = classifyPluginActionError(response.status, body, copy.actionFailed);
        if (block.kind === "failed") setActionError(block.message);
        else setConfirm({ action, block });
        return;
      }
      await loadCatalog();
      if (detailId === pluginId) await loadDetail(pluginId);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : copy.actionFailed);
    } finally {
      setActing(false);
    }
  }

  async function confirmAndRetry() {
    if (!confirm || !detailId) return;
    const { action, block } = confirm;
    setConfirm(null);
    await runAction(detailId, action, block.kind === "unsigned" ? { allowUnsigned: true } : { acceptPermissions: true });
  }

  if (loading && !catalog) {
    return <div className="plugins-view"><p className="plugins-loading">{copy.loading}…</p></div>;
  }

  const runtime = catalog?.runtime;
  const groups = groupPlugins(catalog?.plugins ?? []);

  return (
    <div className="plugins-view">
      <header className="plugins-head">
        {detailId && detail ? (
          <Button size="sm" variant="subtle" icon={<IconArrowLeft size={14} />} onClick={() => { setDetailId(null); setDetail(null); setActionError(""); }}>
            {copy.backToList}
          </Button>
        ) : (
          <div>
            <h1>{copy.title}</h1>
            <p>{copy.body}</p>
          </div>
        )}
      </header>

      {runtime?.developerMode && (
        <div className="plugins-banner" role="status">
          <IconPuzzle size={14} />
          <div><strong>{copy.developerModeTitle}</strong><p>{copy.developerModeBody}</p></div>
        </div>
      )}
      {runtime?.catalogError && (
        <div className="plugins-banner" data-tone="warning" role="status">
          <IconError size={14} />
          <div><strong>{copy.catalogErrorTitle}</strong><p>{copy.catalogErrorBody}</p></div>
        </div>
      )}
      {loadError && (
        <div className="plugins-banner" data-tone="danger" role="alert">
          <IconError size={14} />
          <div><strong>{copy.loadFailed}</strong><p>{loadError}</p></div>
          <Button size="sm" variant="subtle" onClick={() => void loadCatalog()}>{copy.retry}</Button>
        </div>
      )}
      {actionError && (
        <div className="plugins-banner" data-tone="danger" role="alert">
          <IconError size={14} />
          <div><strong>{copy.actionFailed}</strong><p>{actionError}</p></div>
          <Button size="sm" variant="subtle" aria-label={copy.cancel} onClick={() => setActionError("")}><IconDismiss size={12} /></Button>
        </div>
      )}

      {detailId && detail ? (
        <PluginDetail
          copy={copy}
          locale={locale}
          detail={detail}
          acting={acting}
          logsOpen={logsOpen}
          onToggleLogs={() => setLogsOpen((open) => !open)}
          onAction={(action) => void runAction(detailId, action)}
        />
      ) : (
        <>
          {!runtime?.catalogError && groups.installed.length === 0 && groups.curated.length === 0 && !loadError && (
            <div className="plugins-empty">
              <strong>{copy.empty}</strong>
              <p>{copy.emptyBody}</p>
            </div>
          )}
          {groups.installed.length > 0 && (
            <section className="plugin-group">
              <span className="section-kicker">{copy.installedGroup}</span>
              <div className="plugin-grid">{groups.installed.map((item) => (
                <PluginCard key={item.id} copy={copy} locale={locale} item={item} onOpen={() => { setDetailId(item.id); setDetail(null); setActionError(""); }} />
              ))}</div>
            </section>
          )}
          {groups.curated.length > 0 && (
            <section className="plugin-group">
              <span className="section-kicker">{copy.curatedGroup}</span>
              <div className="plugin-grid">{groups.curated.map((item) => (
                <PluginCard key={item.id} copy={copy} locale={locale} item={item} onOpen={() => { setDetailId(item.id); setDetail(null); setActionError(""); }} />
              ))}</div>
            </section>
          )}
        </>
      )}

      {confirm && detailId && (
        <div className="plugin-confirm-overlay" role="presentation" onClick={() => setConfirm(null)}>
          <div className="plugin-confirm" role="alertdialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            {confirm.block.kind === "permission-review" ? (
              <PermissionReview copy={copy} locale={locale} update={confirm.block.update} />
            ) : (
              <>
                <h2>{copy.unsignedTitle}</h2>
                <p>{copy.unsignedBody}</p>
                <p className="plugin-confirm-reason">{copy.unsignedReason}: {confirm.block.message}</p>
              </>
            )}
            <div className="plugin-confirm-actions">
              <Button size="sm" variant="subtle" onClick={() => setConfirm(null)}>{copy.cancel}</Button>
              <Button size="sm" variant={confirm.block.kind === "unsigned" ? "outline" : "primary"} disabled={acting} onClick={() => void confirmAndRetry()}>
                {confirm.block.kind === "unsigned" ? copy.unsignedConfirm : copy.permReviewConfirm}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PluginCard({ copy, locale, item, onOpen }: {
  copy: PluginsCopy;
  locale: AppLocale;
  item: PluginCatalogItem;
  onOpen: () => void;
}) {
  const risk = pluginRisk(item.permissions);
  const category = pluginPrimaryCategory(item.permissions);
  const status = item.installed?.status;
  return (
    <button type="button" className="plugin-card" onClick={onOpen}>
      <div className="plugin-card-head">
        <strong>{item.name}</strong>
        {status && <Badge tone={pluginStatusTone(status)} variant="soft">{pluginStatusLabel(status, locale)}</Badge>}
      </div>
      <p>{item.description}</p>
      <div className="plugin-card-meta">
        {category && <Badge tone="neutral" variant="outline">{pluginCategoryLabel(category, locale)}</Badge>}
        {item.permissions.length > 0 && <Badge tone={riskTone(risk)} variant="soft">{pluginRiskLabel(risk, locale)}</Badge>}
        {item.update && <Badge tone="accent" variant="soft">{copy.updateAvailable} · {item.update.version}</Badge>}
      </div>
    </button>
  );
}

function PluginDetail({ copy, locale, detail, acting, logsOpen, onToggleLogs, onAction }: {
  copy: PluginsCopy;
  locale: AppLocale;
  detail: PluginDetailsResponse;
  acting: boolean;
  logsOpen: boolean;
  onToggleLogs: () => void;
  onAction: (action: PluginAction) => void;
}) {
  const item = detail.plugin;
  const installed = detail.installed;
  const status = installed?.status;
  const permissions = sortPermissionsByRisk(item.permissions);
  return (
    <div className="plugin-detail">
      <div className="plugin-detail-head">
        <div>
          <h1>{item.name}</h1>
          <p>{item.description}</p>
          <div className="plugin-card-meta">
            <Badge tone="neutral" variant="outline">{copy.version} {installed?.version ?? item.latestVersion}</Badge>
            <Badge tone="neutral" variant="outline">{copy.developerLabel} · {item.developer}</Badge>
            <Badge tone={pluginReviewTone(item.review.status)} variant="soft">{pluginReviewLabel(item.review.status, locale)}</Badge>
            {status && <Badge tone={pluginStatusTone(status)} variant="soft">{pluginStatusLabel(status, locale)}</Badge>}
          </div>
        </div>
        <div className="plugin-detail-actions">
          {!installed && <Button size="sm" variant="primary" disabled={acting} onClick={() => onAction("install")}>{copy.install}</Button>}
          {installed && status !== "active" && <Button size="sm" variant="primary" disabled={acting} onClick={() => onAction("enable")}>{copy.enable}</Button>}
          {installed && status === "active" && <Button size="sm" variant="outline" disabled={acting} onClick={() => onAction("disable")}>{copy.disable}</Button>}
          {installed && item.update && <Button size="sm" variant="outline" disabled={acting} onClick={() => onAction("update")}>{copy.updateAction} · {item.update.version}</Button>}
          {installed && <Button size="sm" variant="subtle" disabled={acting} onClick={() => onAction("uninstall")}>{copy.uninstall}</Button>}
        </div>
      </div>

      <section className="plugin-section">
        <span className="section-kicker">{copy.permissions}</span>
        {permissions.length === 0 ? <p className="plugin-quiet">{copy.noPermissions}</p> : (
          <ul className="plugin-perm-list">
            {permissions.map((permission) => <PermissionRow key={permission.key} copy={copy} locale={locale} permission={permission} />)}
          </ul>
        )}
      </section>

      <section className="plugin-section">
        <span className="section-kicker">{copy.tools}</span>
        {item.tools.length === 0 ? <p className="plugin-quiet">{copy.noTools}</p> : (
          <ul className="plugin-tool-list">
            {item.tools.map((tool) => (
              <li key={tool.name}>
                <code>{tool.name}</code>
                <span>{tool.description}</span>
                <Badge tone={tool.readOnly ? "neutral" : "warning"} variant="outline">{tool.readOnly ? copy.toolReadOnly : copy.toolMutable}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="plugin-section">
        <span className="section-kicker">{copy.signature} · {copy.verification}</span>
        <div className="plugin-facts">
          <div><span>{copy.signature}</span><strong>{item.signature.signed ? copy.signed : copy.unsigned}</strong></div>
          {detail.verification && (
            <div>
              <span>{copy.verification}</span>
              <strong data-ok={detail.verification.ok}>{detail.verification.ok ? copy.verificationOk : (detail.verification.error?.message ?? copy.verificationFailed)}</strong>
            </div>
          )}
          {detail.verification?.signerFingerprint && (
            <div>
              <span>{copy.signerFingerprint}</span>
              <strong className="mono" title={detail.verification.signerFingerprint}>{truncateFingerprint(detail.verification.signerFingerprint)}</strong>
            </div>
          )}
        </div>
      </section>

      <section className="plugin-section">
        <button type="button" className="plugin-logs-toggle" aria-expanded={logsOpen} onClick={onToggleLogs}>
          <span className="section-kicker">{copy.logs}</span>
          <span>{logsOpen ? copy.logsHide : copy.logsShow}</span>
        </button>
        {logsOpen && (
          detail.logs.length === 0 ? <p className="plugin-quiet">{copy.logsEmpty}</p> : (
            <ul className="plugin-logs">
              {detail.logs.map((entry, index) => (
                <li key={`${entry.timestamp}-${index}`}>
                  <span className="mono">{formatLogTime(entry.timestamp)}</span>
                  <Badge tone={entry.level === "error" ? "danger" : entry.level === "warn" ? "warning" : "neutral"} variant="outline">{entry.level}</Badge>
                  <span>{entry.event}</span>
                </li>
              ))}
            </ul>
          )
        )}
      </section>
    </div>
  );
}

function PermissionRow({ copy, locale, permission }: {
  copy: PluginsCopy;
  locale: AppLocale;
  permission: PluginPermissionDto;
}) {
  const adsMutation = isAdvertisingMutation(permission);
  return (
    <li className="plugin-perm-row" data-ads={adsMutation || undefined}>
      <div>
        <strong>{permission.title}</strong>
        <p>{permission.description}</p>
      </div>
      <div className="plugin-card-meta">
        <Badge tone="neutral" variant="outline">{pluginCategoryLabel(permission.category, locale)}</Badge>
        <Badge tone={riskTone(permission.risk)} variant="soft">{pluginRiskLabel(permission.risk, locale)}</Badge>
        {adsMutation && <Badge tone="danger" variant="filled"><IconShieldCheck size={11} /> {copy.adsMutation}</Badge>}
      </div>
    </li>
  );
}

function PermissionReview({ copy, locale, update }: {
  copy: PluginsCopy;
  locale: AppLocale;
  update: PluginUpdate;
}) {
  const rows = permissionDiffRows(update);
  return (
    <>
      <h2>{copy.permReviewTitle}</h2>
      <p>{copy.permReviewBody.replace("{version}", update.version)}</p>
      <ul className="plugin-perm-list compact">
        {rows.added.map((permission) => <PermissionRow key={permission.key} copy={copy} locale={locale} permission={permission} />)}
      </ul>
      {rows.removedCount > 0 && <p className="plugin-quiet">{copy.permReviewRemoved.replace("{count}", String(rows.removedCount))}</p>}
    </>
  );
}
