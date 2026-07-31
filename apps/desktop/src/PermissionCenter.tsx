import { useCallback, useEffect, useState } from "react";
import {
  DesktopApiError,
  getDesktopPermissions,
  openDesktopPermissionSettings,
  requestDesktopPermissions,
  testDesktopPermission,
  type DesktopPermissionCenter,
  type DesktopPermissionId,
  type DesktopPermissionTestResult
} from "./computerUseClient.js";
import {
  desktopPermissionName,
  desktopPermissionFeatureLabel,
  desktopPermissionReason,
  desktopPermissionStatusLabel,
  formatDateTime,
  permissionCenterCopy,
  type AppLocale
} from "./labels.js";
import {
  IconDesktop,
  IconOpen,
  IconPlay,
  IconRefresh,
  IconShieldCheck,
  IconShieldLock
} from "./icons.js";
import { Button } from "./ui.js";

type Resource =
  | { status: "loading" }
  | { status: "ready"; value: DesktopPermissionCenter }
  | { status: "error"; error: unknown };

type PublicActionError = {
  summary: string;
  code?: string;
  detail?: string;
};

export function PermissionCenter({ locale, clientId, productSessionId, browserSessionId }: {
  locale: AppLocale;
  clientId?: string;
  productSessionId?: string;
  browserSessionId?: string;
}) {
  const copy = permissionCenterCopy(locale);
  const [resource, setResource] = useState<Resource>({ status: "loading" });
  const [busy, setBusy] = useState<DesktopPermissionId>();
  const [tests, setTests] = useState<Partial<Record<DesktopPermissionId, DesktopPermissionTestResult>>>({});
  const [actionError, setActionError] = useState<PublicActionError>();

  const load = useCallback(async (signal?: AbortSignal, quiet = false) => {
    if (!quiet) setResource((current) => current.status === "ready" ? current : { status: "loading" });
    try {
      const value = await getDesktopPermissions(clientId, productSessionId, browserSessionId, signal);
      setResource({ status: "ready", value });
      setActionError(undefined);
    } catch (error) {
      if (!isAbortError(error) && !quiet) setResource({ status: "error", error });
    }
  }, [browserSessionId, clientId, productSessionId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const refresh = window.setInterval(() => void load(undefined, true), 5_000);
    return () => {
      controller.abort();
      window.clearInterval(refresh);
    };
  }, [load]);

  async function request(permission: DesktopPermissionId) {
    if (permission !== "screen-recording" && permission !== "accessibility") return;
    setBusy(permission);
    setActionError(undefined);
    try {
      setResource({ status: "ready", value: await requestDesktopPermissions([permission], clientId, productSessionId, browserSessionId) });
    } catch (error) {
      setActionError(publicError(error, copy.loadFailed));
    } finally {
      setBusy(undefined);
    }
  }

  async function open(permission: DesktopPermissionId) {
    setBusy(permission);
    setActionError(undefined);
    try {
      await openDesktopPermissionSettings(permission);
    } catch (error) {
      setActionError(publicError(error, copy.loadFailed));
    } finally {
      setBusy(undefined);
    }
  }

  async function test(permission: DesktopPermissionId) {
    setBusy(permission);
    setActionError(undefined);
    try {
      const result = await testDesktopPermission(permission, clientId, productSessionId, browserSessionId);
      setTests((current) => ({ ...current, [permission]: result }));
      await load(undefined, true);
    } catch (error) {
      setActionError(publicError(error, copy.testFailed));
    } finally {
      setBusy(undefined);
    }
  }

  if (resource.status === "loading") {
    return <div className="permission-center-loading" aria-busy="true">
      <IconRefresh size={16} /><span>{copy.refreshing}</span>
    </div>;
  }
  if (resource.status === "error") {
    const unavailable = resource.error instanceof DesktopApiError
      && (resource.error.status === 403 || resource.error.status === 503);
    return <div className="permission-center-error" role="alert">
      <IconShieldLock size={20} />
      <strong>{unavailable ? copy.desktopOnly : copy.loadFailed}</strong>
      <Button variant="subtle" size="sm" onClick={() => void load()}>{copy.retry}</Button>
    </div>;
  }

  const center = resource.value;
  const needsOnboarding = center.permissions.some((item) =>
    (item.id === "screen-recording" || item.id === "accessibility") && item.status !== "granted"
  );
  return <div className="permission-center">
    {needsOnboarding && <section className="permission-onboarding">
      <div className="permission-onboarding-icon"><IconDesktop size={20} /></div>
      <div>
        <h3>{copy.welcome}</h3>
        <p>{copy.welcomeBody}</p>
        <ol>
          <li>{copy.welcomeScreen}</li>
          <li>{copy.welcomeAccessibility}</li>
          <li>{copy.welcomeBrowser}</li>
          <li>{copy.welcomeApproval}</li>
        </ol>
      </div>
    </section>}

    <header className="permission-center-heading">
      <div>
        <h3>{copy.title}</h3>
        <p>{copy.body}</p>
      </div>
      <div className="permission-center-health" data-ready={center.helperAvailable}>
        <i aria-hidden="true" />
        <span>{center.helperAvailable ? copy.helperReady : copy.helperUnavailable}</span>
        {center.helperVersion && <code>{center.helperVersion}</code>}
      </div>
      <Button
        variant="subtle"
        size="sm"
        icon={<IconRefresh size={13} />}
        disabled={Boolean(busy)}
        onClick={() => void load()}
      >
        {copy.refresh}
      </Button>
    </header>

    {actionError && <div className="permission-action-error" role="alert">
      <strong>{actionError.summary}</strong>
      {actionError.code && <code>{actionError.code}</code>}
      {actionError.detail && <details>
        <summary>{copy.technicalDetails}</summary>
        <p>{actionError.detail}</p>
      </details>}
    </div>}

    <div className="permission-list">
      {center.permissions.map((permission) => {
        const result = tests[permission.id];
        const active = busy === permission.id;
        return <article className="permission-item" data-status={permission.status} key={permission.id}>
          <div className="permission-item-icon">
            {permission.status === "granted" ? <IconShieldCheck size={17} /> : <IconShieldLock size={17} />}
          </div>
          <div className="permission-item-main">
            <header>
              <strong>{desktopPermissionName(permission.id, locale)}</strong>
              <span>{desktopPermissionStatusLabel(permission.status, locale)}</span>
            </header>
            <p>{desktopPermissionReason(permission.id, locale)}</p>
            <dl>
              <div><dt>{copy.process}</dt><dd>{permission.processName}</dd></div>
              <div><dt>{copy.bundle}</dt><dd>{permission.bundleId ?? "—"}</dd></div>
              <div><dt>{copy.checked}</dt><dd>{formatDateTime(permission.checkedAt, locale)}</dd></div>
              <div><dt>{copy.affected}</dt><dd>{permission.affectedFeatures.map((feature) => desktopPermissionFeatureLabel(feature, locale)).join(" · ")}</dd></div>
            </dl>
            {permission.requiresRestart && <p className="permission-restart">{copy.restart}</p>}
            {result && <div className="permission-test-result" data-ok={result.ok}>
              <strong>{result.ok ? copy.testPassed : copy.testFailed}</strong>
              {result.message && <details>
                <summary>{copy.technicalDetails}</summary>
                <span>{result.message}</span>
              </details>}
              {result.preview && <img
                src={result.preview.dataUrl}
                width={result.preview.width}
                height={result.preview.height}
                alt={copy.previewAlt}
              />}
            </div>}
            <small>{copy.revocation}</small>
          </div>
          <div className="permission-actions">
            {permission.canRequest && <Button
              variant="primary"
              size="sm"
              icon={<IconShieldCheck size={13} />}
              disabled={Boolean(busy)}
              onClick={() => void request(permission.id)}
            >{active ? copy.refreshing : copy.request}</Button>}
            {permission.canOpenSettings && <Button
              variant="outline"
              size="sm"
              icon={<IconOpen size={13} />}
              disabled={Boolean(busy)}
              onClick={() => void open(permission.id)}
            >{copy.openSettings}</Button>}
            {permission.canTest && <Button
              variant="subtle"
              size="sm"
              icon={<IconPlay size={13} />}
              disabled={Boolean(busy)}
              onClick={() => void test(permission.id)}
            >{active ? copy.testing : copy.runTest}</Button>}
          </div>
        </article>;
      })}
    </div>
  </div>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function publicError(error: unknown, fallback: string): PublicActionError {
  const code = error instanceof DesktopApiError ? error.code : undefined;
  const message = error instanceof Error ? error.message.trim().slice(0, 500) : "";
  return {
    summary: fallback,
    ...(code ? { code } : {}),
    ...(message && message !== fallback ? { detail: message } : {})
  };
}
