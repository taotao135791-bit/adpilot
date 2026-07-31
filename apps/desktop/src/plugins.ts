/**
 * Desktop plugins view logic, kept React-free so every rule is unit-testable:
 * the wire DTO mirrors (packages/server /api/plugins + packages/application
 * PluginService), catalog grouping/ordering, permission-risk mapping, the
 * permission-diff render data for the consent dialog, fingerprint truncation,
 * and the mutation error classification that drives the 409/403 confirm flows.
 */

/* ------------------------------------------------------------------ */
/* Wire DTO mirrors                                                    */
/* ------------------------------------------------------------------ */

export type PluginPermissionRisk = "low" | "medium" | "high" | "critical";

export type PluginPermissionCategory =
  | "capability"
  | "filesystem"
  | "network"
  | "secret"
  | "browser"
  | "computer-use"
  | "advertising"
  | "storage";

export type PluginPermissionDto = {
  key: string;
  category: PluginPermissionCategory | string;
  title: string;
  description: string;
  risk: PluginPermissionRisk | string;
  requiresReviewWhenAdded: boolean;
};

export type PluginPermissionDiff = {
  added: PluginPermissionDto[];
  removed: PluginPermissionDto[];
  hasNewPermissions: boolean;
};

export type PluginUpdate = {
  version: string;
  permissionDiff: PluginPermissionDiff;
  requiresApproval: boolean;
};

export type PluginCatalogItem = {
  id: string;
  name: string;
  description: string;
  developer: string;
  latestVersion: string;
  availableVersions?: string[];
  tools: Array<{ name: string; description: string; readOnly: boolean }>;
  permissions: PluginPermissionDto[];
  signature: { signed: boolean; keyId: string | null };
  review: { status: string; reviewedAt?: string; reviewer?: string; notes?: string };
  installed: { status: string; version: string } | null;
  update: PluginUpdate | null;
};

export type PluginRuntimeStatus = {
  available: boolean;
  developerMode: boolean;
  catalogError: { code: string; message: string } | null;
  isolation?: string;
};

export type PluginCatalogResponse = {
  plugins: PluginCatalogItem[];
  candidates: PluginCandidate[];
  runtime: PluginRuntimeStatus;
};

export type PluginCandidate = {
  id: string;
  name: string;
  publisher: string;
  description: { en: string; zh: string };
  sourceUrl: string;
  transport: "local" | "remote" | "local-or-remote";
  maturity: "stable" | "beta" | "developer-preview";
  recommendedMode: "read-only";
  capabilities: string[];
  notes: { en: string; zh: string };
  metadataReviewedAt: string;
  installable: false;
};

export type PluginLogEvent = {
  timestamp: string;
  pluginId: string;
  level: string;
  event: string;
  data?: unknown;
};

export type PluginDetailsResponse = {
  plugin: PluginCatalogItem & {
    selectedVersion?: string;
    skills?: Array<{ name: string; description: string }>;
    integrity?: string;
  };
  installed: {
    status: string;
    version: string;
    installedVersions: string[];
    permissions: PluginPermissionDto[];
    pendingUpdate: unknown;
    dataVersion: number;
    lifecycle: unknown[];
    migrations: unknown[];
  } | null;
  verification: {
    ok: boolean;
    checkedAt?: string;
    integrity: string | null;
    signerKeyId: string | null;
    signerFingerprint: string | null;
    error: { code: string; message: string } | null;
  } | null;
  supervisor: {
    pluginId: string;
    state: string;
    developerMode?: boolean;
    lastError?: string;
    updatedAt?: string;
  };
  logs: PluginLogEvent[];
};

/* ------------------------------------------------------------------ */
/* Grouping and ordering                                               */
/* ------------------------------------------------------------------ */

export type PluginGroups = {
  installed: PluginCatalogItem[];
  curated: PluginCatalogItem[];
};

const byName = (left: PluginCatalogItem, right: PluginCatalogItem) =>
  left.name.localeCompare(right.name) || left.id.localeCompare(right.id);

/**
 * Splits the flat catalog into the two page sections. Installed plugins lead,
 * update-available ones first so an actionable update never drowns in the
 * list; the curated (not-yet-installed) remainder follows alphabetically.
 */
export function groupPlugins(items: readonly PluginCatalogItem[]): PluginGroups {
  const installed: PluginCatalogItem[] = [];
  const curated: PluginCatalogItem[] = [];
  for (const item of items) {
    if (item.installed) installed.push(item);
    else curated.push(item);
  }
  installed.sort((left, right) => Number(Boolean(right.update)) - Number(Boolean(left.update)) || byName(left, right));
  curated.sort(byName);
  return { installed, curated };
}

/* ------------------------------------------------------------------ */
/* Permission risk                                                     */
/* ------------------------------------------------------------------ */

const RISK_RANK: Record<PluginPermissionRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function riskRank(risk: string): number {
  return RISK_RANK[risk as PluginPermissionRisk] ?? 0;
}

/** The card-level badge: the single highest risk across the declared grant. */
export function pluginRisk(permissions: readonly PluginPermissionDto[]): PluginPermissionRisk {
  let highest: PluginPermissionRisk = "low";
  for (const permission of permissions) {
    if (riskRank(permission.risk) > riskRank(highest)) highest = permission.risk as PluginPermissionRisk;
  }
  return highest;
}

/** Badge tone per risk level — the design system's only risk language. */
export function riskTone(risk: string): "neutral" | "accent" | "warning" | "danger" {
  if (risk === "critical") return "danger";
  if (risk === "high") return "warning";
  if (risk === "medium") return "accent";
  return "neutral";
}

/**
 * Permissions render most-dangerous-first so an advertising mutation grant
 * is never buried below a storage row; ties break by title for stability.
 */
export function sortPermissionsByRisk(permissions: readonly PluginPermissionDto[]): PluginPermissionDto[] {
  return [...permissions].sort(
    (left, right) => riskRank(right.risk) - riskRank(left.risk) || left.title.localeCompare(right.title)
  );
}

/** Advertising-mutation grants get the explicit "广告修改" flag everywhere they appear. */
export function isAdvertisingMutation(permission: Pick<PluginPermissionDto, "category" | "risk">): boolean {
  return permission.category === "advertising" && permission.risk === "critical";
}

/**
 * The card's "类别" slot: the category of the single highest-risk permission
 * (risk-first, then title — the same order the detail list renders).
 */
export function pluginPrimaryCategory(permissions: readonly PluginPermissionDto[]): PluginPermissionCategory | string | null {
  return sortPermissionsByRisk(permissions)[0]?.category ?? null;
}

/* ------------------------------------------------------------------ */
/* Status and review tones                                             */
/* ------------------------------------------------------------------ */

export function pluginStatusTone(status: string): "success" | "neutral" | "warning" {
  if (status === "active") return "success";
  if (status === "needs_review") return "warning";
  return "neutral";
}

export function pluginReviewTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "approved") return "success";
  if (status === "pending") return "warning";
  if (status === "rejected") return "danger";
  return "neutral";
}

/* ------------------------------------------------------------------ */
/* Update consent render data                                          */
/* ------------------------------------------------------------------ */

export type PermissionDiffRows = {
  added: PluginPermissionDto[];
  removedCount: number;
  hasNewPermissions: boolean;
};

/** The 409 consent dialog's data: added grants risk-sorted, removals as a quiet count. */
export function permissionDiffRows(update: PluginUpdate): PermissionDiffRows {
  return {
    added: sortPermissionsByRisk(update.permissionDiff.added),
    removedCount: update.permissionDiff.removed.length,
    hasNewPermissions: update.permissionDiff.hasNewPermissions
  };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** Mono fingerprint display: head…tail, full value only on hover (title). */
export function truncateFingerprint(value: string, head = 10, tail = 8): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Log-tail timestamps render as HH:MM:SS; malformed input passes through. */
export function formatLogTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export type PluginAction = "install" | "uninstall" | "disable" | "enable" | "update";

export function pluginDetailsUrl(pluginId: string): string {
  return `/api/plugins/${encodeURIComponent(pluginId)}`;
}

export function pluginActionUrl(pluginId: string, action: PluginAction): string {
  return `/api/plugins/${encodeURIComponent(pluginId)}/${action}`;
}

/**
 * Mutation body: workspace context plus the two consent flags. The flags are
 * only ever set from an explicit user confirmation, never by default.
 */
export function pluginActionBody(options: {
  clientId?: string;
  allowUnsigned?: true;
  acceptPermissions?: true;
}): string {
  return JSON.stringify({
    ...(options.clientId ? { clientId: options.clientId } : {}),
    actor: "workspace-owner",
    ...(options.allowUnsigned ? { allowUnsigned: true } : {}),
    ...(options.acceptPermissions ? { acceptPermissions: true } : {})
  });
}

/* ------------------------------------------------------------------ */
/* Mutation error classification (the 409 / 403 confirm flows)         */
/* ------------------------------------------------------------------ */

export type PluginActionBlock =
  | { kind: "permission-review"; update: PluginUpdate; message: string }
  | { kind: "unsigned"; message: string }
  | { kind: "failed"; message: string };

function isPluginUpdate(value: unknown): value is PluginUpdate {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PluginUpdate>;
  return (
    typeof candidate.version === "string" &&
    typeof candidate.permissionDiff === "object" &&
    candidate.permissionDiff !== null &&
    Array.isArray(candidate.permissionDiff.added) &&
    Array.isArray(candidate.permissionDiff.removed)
  );
}

/**
 * Maps a failed mutation onto the UI's three outcomes: a consent dialog for
 * the 409 permission diff, a high-risk dialog for the 403 unsigned bundle,
 * or a plain error line for everything else (other 403 trust violations are
 * not retryable and never get a confirm path).
 */
export function classifyPluginActionError(status: number, body: unknown, fallback: string): PluginActionBlock {
  const record = (typeof body === "object" && body !== null ? body : {}) as {
    code?: unknown;
    error?: unknown;
    update?: unknown;
  };
  const message = typeof record.error === "string" && record.error ? record.error : fallback;
  if (status === 409 && record.code === "PLUGIN_PERMISSION_REVIEW_REQUIRED" && isPluginUpdate(record.update)) {
    return { kind: "permission-review", update: record.update, message };
  }
  if (status === 403 && record.code === "UNSIGNED_REJECTED") {
    return { kind: "unsigned", message };
  }
  return { kind: "failed", message };
}

/** Catalog fetch failure: 503 PLUGIN_CATALOG_UNAVAILABLE means the subsystem degraded fail-closed. */
export function isCatalogUnavailable(status: number, body: unknown): boolean {
  const code = (body as { code?: unknown } | undefined)?.code;
  return status === 503 && typeof code === "string";
}
