/**
 * Plugin subsystem composition root (docs/rebuild/PLUGIN_SYSTEM.md).
 *
 * The plugin runtime (@adpilot/plugin-runtime) is wired into the product here:
 * the curated catalog (plugins/curated + trust anchors) and the installed
 * state (workspace .adpilot/plugin-runtime) are owned by PluginCatalogService;
 * this module adds the product-level contract around it:
 *
 * - Boot-time re-verification of every installed plugin. A bundle whose
 *   integrity/signature no longer matches its installed state pin is degraded
 *   to `disabled` before anything can load it, and the degradation is chained
 *   into the audit log (high risk) and broadcast once a client exists.
 * - A fail-closed trust posture: the catalog boots with the default
 *   reject-unsigned policy. If discovery fails only because an unsigned
 *   reviewed bundle is present, the catalog is re-created in explicit
 *   developer mode (visually persistent via status(), high-risk audit) and
 *   unsigned installs still require the per-request `allowUnsigned` flag.
 *   Any other curated verification failure (tamper, untrusted signer) leaves
 *   the plugin subsystem unavailable (503) without taking the product down.
 * - Permission-diff consent for updates: an update that adds permissions is
 *   staged by the runtime and only activated after the caller explicitly
 *   accepts the exact diff (409 otherwise). Activation consumes a
 *   single-use, process-local approval receipt minted by this service; the
 *   durable receipt ledger rejects replays across restarts.
 * - Capability wiring decision: plugin tools never enter AdPilotTools or
 *   SkillRegistry. A single run-scoped `plugin.invoke_readonly` agent bridge
 *   exposes only tools from installed, active, signed and reviewed bundles
 *   whose manifest grants no authority beyond optional filesystem.readText.
 *   Every invocation still runs through executeTool(), exact active-bundle
 *   verification, the child-process/VM supervisor and the confined
 *   <workspace>/plugin-data broker. Mutable, network, secret, browser,
 *   Computer Use, advertising and storage grants never enter the agent
 *   surface; over-permission capability calls are denied and audited. Plugin
 *   *skills* are manifest metadata
 *   (name + description, no body); they are exposed read-only in the catalog
 *   DTOs and deliberately not injected into the advisory knowledge layer or
 *   registered as executable skills — there is nothing executable to
 *   register, and advisory knowledge grants no authority by design.
 *
 * Every lifecycle transition is chained into the per-client audit log and
 * published as a `plugin` product event to every workspace client.
 */
import { createPublicKey } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AuditLog } from "@adpilot/audit";
import type { ToolContext } from "@adpilot/tools";
import type { WorkspaceStore } from "@adpilot/workspace";
import {
  CapabilityBroker,
  createReadOnlyFileBroker,
  DEFAULT_VERIFICATION_POLICY,
  loadPluginBundle,
  PluginRuntimeError,
  PluginSupervisor,
  StaticPluginTrustStore,
  StructuredPluginLogger,
  verifiedPluginBundleIdentity,
  type BundleVerificationPolicy,
  type InstalledPluginState,
  type PluginApprovalExpectation,
  type PluginApprovalReceipt,
  type PluginLogEvent,
  type PluginManifest,
  type PluginSupervisorStatus
} from "@adpilot/plugin-runtime";
import {
  PluginCatalogService,
  describePluginPermissions,
  type InstalledPluginDto,
  type PluginCatalogItemDto,
  type PluginDetailsDto,
  type PluginUpdateDto,
  type UninstalledPluginDto
} from "../../plugin-runtime/src/catalog-service.ts";
import { resolvePluginResourceLayout } from "./plugin-roots.js";
import type { ProductEventBus } from "./index.js";

const PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const DEVELOPER_POLICY: BundleVerificationPolicy = { unsigned: "allow-reviewed", developerMode: true };
const STARTUP_RECHECK_ACTOR = "plugin-startup-recheck";
const LOG_TAIL_LIMIT = 50;

/** Error carrying the exact update + permission diff the caller must accept (HTTP 409). */
export class PluginPermissionReviewError extends PluginRuntimeError {
  constructor(
    pluginId: string,
    readonly update: PluginUpdateDto
  ) {
    super(
      "PLUGIN_PERMISSION_REVIEW_REQUIRED",
      `Updating ${pluginId} to ${update.version} grants new permissions; re-submit with acceptPermissions:true to consent to the exact diff`
    );
    this.name = "PluginPermissionReviewError";
  }
}

export interface PluginServiceStatus {
  available: boolean;
  developerMode: boolean;
  catalogError: { code: string; message: string } | null;
  isolation: "child_process+vm";
  curatedRoot: string;
  trustRoot: string;
  pluginDataRoot: string;
}

export interface PluginVerificationDto {
  ok: boolean;
  checkedAt: string;
  integrity: string | null;
  signerKeyId: string | null;
  signerFingerprint: string | null;
  error: { code: string; message: string } | null;
}

export interface PluginCandidateDto {
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
}

export interface PluginDetailsResponse {
  plugin: PluginDetailsDto;
  installed: {
    status: InstalledPluginState["status"];
    version: string;
    installedVersions: string[];
    permissions: ReturnType<typeof describePluginPermissions>;
    pendingUpdate: InstalledPluginState["pendingUpdate"] | null;
    dataVersion: number;
    lifecycle: InstalledPluginState["lifecycle"];
    migrations: InstalledPluginState["migrations"];
  } | null;
  verification: PluginVerificationDto | null;
  supervisor: PluginSupervisorStatus;
  logs: PluginLogEvent[];
}

export interface PluginCatalogResponse {
  plugins: PluginCatalogItemDto[];
  candidates: PluginCandidateDto[];
  runtime: PluginServiceStatus;
}

/**
 * Discovery-only integrations researched from publisher documentation.
 * These entries are deliberately not PluginManifest values, never enter the
 * signed registry, and expose no install or execute action. A candidate must
 * be packaged, pinned, permission-reviewed, signed, and tested before it can
 * move into plugins/curated.
 */
const PLUGIN_CANDIDATES: readonly PluginCandidateDto[] = [
  {
    id: "github-official-mcp",
    name: "GitHub MCP Server",
    publisher: "GitHub",
    description: {
      en: "Repository, issue, pull-request, Actions, and code-security context from GitHub's official MCP server.",
      zh: "通过 GitHub 官方 MCP Server 读取仓库、Issue、Pull Request、Actions 与代码安全上下文。"
    },
    sourceUrl: "https://github.com/github/github-mcp-server",
    transport: "local-or-remote",
    maturity: "stable",
    recommendedMode: "read-only",
    capabilities: ["repositories", "issues", "pull requests", "actions", "code security"],
    notes: {
      en: "Candidate only. Start with --read-only, a minimal toolset, lockdown mode, and a fine-grained short-lived credential.",
      zh: "仅为候选。接入时应默认启用 --read-only、最小工具集与 lockdown mode，并使用细粒度短期凭据。"
    },
    metadataReviewedAt: "2026-07-31",
    installable: false
  },
  {
    id: "google-drive-official-mcp",
    name: "Google Drive MCP",
    publisher: "Google",
    description: {
      en: "Search, metadata, and file-content access through Google's hosted Drive MCP endpoint.",
      zh: "通过 Google 托管的 Drive MCP 端点搜索文件、读取元数据与文件内容。"
    },
    sourceUrl: "https://developers.google.com/workspace/drive/api/reference/mcp",
    transport: "remote",
    maturity: "developer-preview",
    recommendedMode: "read-only",
    capabilities: ["file search", "metadata", "file content"],
    notes: {
      en: "Candidate only. Developer Preview requires project/OAuth setup; start with read tools and verify Workspace DLP and file-eligibility behavior.",
      zh: "仅为候选。该服务仍处开发者预览，需配置项目与 OAuth；应先开放只读工具，并核验 Workspace DLP 与文件可用性规则。"
    },
    metadataReviewedAt: "2026-07-31",
    installable: false
  },
  {
    id: "figma-official-mcp",
    name: "Figma MCP Server",
    publisher: "Figma",
    description: {
      en: "Structured design context, variables, components, and Code Connect data from Figma's official MCP server.",
      zh: "通过 Figma 官方 MCP Server 获取结构化设计上下文、变量、组件与 Code Connect 数据。"
    },
    sourceUrl: "https://developers.figma.com/docs/figma-mcp-server/",
    transport: "local-or-remote",
    maturity: "beta",
    recommendedMode: "read-only",
    capabilities: ["design context", "variables", "components", "Code Connect"],
    notes: {
      en: "Candidate only. Client access is restricted and write-to-canvas is broader authority; begin with context-reading tools only.",
      zh: "仅为候选。客户端接入仍受限制，写入画布属于更高权限；初次接入只应开放设计上下文读取工具。"
    },
    metadataReviewedAt: "2026-07-31",
    installable: false
  },
  {
    id: "google-ads-api-connector",
    name: "Google Ads API Connector",
    publisher: "Google",
    description: {
      en: "Account structure, performance reporting, recommendations, and change history through the official Google Ads API.",
      zh: "通过 Google Ads 官方 API 读取账户结构、效果报表、优化建议与变更历史。"
    },
    sourceUrl: "https://developers.google.com/google-ads/api/docs/get-started/introduction",
    transport: "remote",
    maturity: "stable",
    recommendedMode: "read-only",
    capabilities: ["account structure", "performance reporting", "recommendations", "change history"],
    notes: {
      en: "Candidate only. Begin with reporting scopes, an explicit manager-account binding, and a read-only query allowlist; keep every mutate operation behind a separate reviewed plugin and approval receipt.",
      zh: "仅为候选。首次接入应只开放报表范围，明确绑定经理账户并使用只读查询白名单；所有 mutate 操作必须拆分到独立审核插件并经过审批回执。"
    },
    metadataReviewedAt: "2026-07-31",
    installable: false
  },
  {
    id: "tiktok-business-api-connector",
    name: "TikTok API for Business Connector",
    publisher: "TikTok",
    description: {
      en: "Campaign structure, creative performance, reporting, and measurement context through TikTok API for Business.",
      zh: "通过 TikTok API for Business 读取广告结构、创意表现、效果报表与测量上下文。"
    },
    sourceUrl: "https://business-api.tiktok.com/portal",
    transport: "remote",
    maturity: "stable",
    recommendedMode: "read-only",
    capabilities: ["campaign reporting", "creative insights", "audience reporting", "measurement"],
    notes: {
      en: "Candidate only. Start with reporting endpoints and one explicitly bound advertiser ID; campaign, audience, creative, and catalog mutations remain out of scope until separately reviewed.",
      zh: "仅为候选。首次接入应只开放报表端点并绑定单一 advertiser ID；广告、受众、创意和商品目录写入需另行审核后再开放。"
    },
    metadataReviewedAt: "2026-07-31",
    installable: false
  }
];

export function listPluginCandidates(): PluginCandidateDto[] {
  return PLUGIN_CANDIDATES.map((candidate) => ({
    ...candidate,
    description: { ...candidate.description },
    capabilities: [...candidate.capabilities],
    notes: { ...candidate.notes }
  }));
}

export interface PluginMutationOptions {
  actor: string;
  clientId?: string | undefined;
  version?: string | undefined;
  allowUnsigned?: boolean | undefined;
  acceptPermissions?: boolean | undefined;
}

export interface PluginToolInvocation {
  pluginId: string;
  tool: string;
  input: unknown;
  actor: string;
  clientId?: string | undefined;
  taskId?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface AgentPluginToolDescriptor {
  pluginId: string;
  tool: string;
  description: string;
}

export interface PluginServiceDeps {
  workspace: WorkspaceStore;
  audit: AuditLog;
  events: ProductEventBus;
  env?: NodeJS.ProcessEnv;
  roots?: { repositoryRoot?: string; curatedRoot?: string; trustRoot?: string; hostPath?: string };
}

interface BufferedAudit {
  action: string;
  status: "attempted" | "succeeded" | "failed" | "denied";
  actor: string;
  details: Record<string, unknown>;
}

const AgentPluginInvocation = z
  .object({
    pluginId: z.string().regex(PLUGIN_ID),
    tool: z.string().min(3).max(160),
    input: z.unknown()
  })
  .strict();

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * V1 agent bridge permission ceiling. `filesystem.read.text` is the one
 * broker implemented here; every other manifest grant stays catalog-only.
 */
function isAgentSafeManifest(manifest: PluginManifest): boolean {
  const permissions = manifest.permissions;
  return Boolean(manifest.signature)
    && manifest.review.status === "approved"
    && permissions.capabilities.length === 0
    && permissions.filesystem.every((permission) => permission === "read.text")
    && permissions.network.length === 0
    && permissions.secrets.length === 0
    && permissions.browser === false
    && permissions.computerUse === false
    && permissions.advertisingRead === false
    && permissions.advertisingMutation === false
    && permissions.storage === false;
}

/** Mirrors the curated trust-anchor rules: regular, non-symlink Ed25519 .pem files with safe key ids. */
async function loadTrustAnchors(trustRoot: string): Promise<StaticPluginTrustStore> {
  const trustStore = new StaticPluginTrustStore();
  const entries = await readdir(trustRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith(".pem")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new PluginRuntimeError("TRUST_KEY_REJECTED", `Trust key must be a regular file: ${entry.name}`);
    }
    const keyId = entry.name.slice(0, -".pem".length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(keyId)) {
      throw new PluginRuntimeError("TRUST_KEY_REJECTED", `Unsafe trust key id: ${keyId}`);
    }
    const publicKey = createPublicKey(await readFile(path.join(trustRoot, entry.name)));
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new PluginRuntimeError("TRUST_KEY_REJECTED", `Trust key is not Ed25519: ${entry.name}`);
    }
    trustStore.add(keyId, publicKey);
  }
  return trustStore;
}

export class PluginService {
  readonly #workspace: WorkspaceStore;
  readonly #audit: AuditLog;
  readonly #events: ProductEventBus;
  readonly #status: PluginServiceStatus;
  readonly #catalog: PluginCatalogService | undefined;
  readonly #trustStore: StaticPluginTrustStore | undefined;
  readonly #policy: BundleVerificationPolicy;
  readonly #supervisor: PluginSupervisor;
  readonly #logPath: string;
  readonly #mintedReceipts: Set<string>;
  #pendingStartupAudit: BufferedAudit[];
  #pendingStartupEvents: Array<{ pluginId: string; status: string }>;

  private constructor(options: {
    deps: PluginServiceDeps;
    status: PluginServiceStatus;
    catalog?: PluginCatalogService;
    trustStore?: StaticPluginTrustStore;
    policy: BundleVerificationPolicy;
    supervisor: PluginSupervisor;
    logPath: string;
    mintedReceipts: Set<string>;
    pendingStartupAudit: BufferedAudit[];
    pendingStartupEvents: Array<{ pluginId: string; status: string }>;
  }) {
    this.#workspace = options.deps.workspace;
    this.#audit = options.deps.audit;
    this.#events = options.deps.events;
    this.#status = options.status;
    this.#catalog = options.catalog;
    this.#trustStore = options.trustStore;
    this.#policy = options.policy;
    this.#supervisor = options.supervisor;
    this.#logPath = options.logPath;
    this.#mintedReceipts = options.mintedReceipts;
    this.#pendingStartupAudit = options.pendingStartupAudit;
    this.#pendingStartupEvents = options.pendingStartupEvents;
  }

  static async create(deps: PluginServiceDeps): Promise<PluginService> {
    const env = deps.env ?? process.env;
    const workspaceRoot = deps.workspace.root;
    // Layout-aware resolution (source tree / CLI bundle / packaged asar); see plugin-roots.ts.
    const layout = resolvePluginResourceLayout({ env, ...(deps.roots ? { roots: deps.roots } : {}) });
    const curatedRoot = layout.curatedRoot;
    const trustRoot = layout.trustRoot;
    const runtimeRoot = path.join(workspaceRoot, ".adpilot", "plugin-runtime");
    const pluginDataRoot = path.join(workspaceRoot, "plugin-data");
    const logPath = path.join(runtimeRoot, "logs", "events.jsonl");
    await Promise.all([
      mkdir(pluginDataRoot, { recursive: true, mode: 0o700 }),
      mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 })
    ]);
    const logger = new StructuredPluginLogger({ logPath });
    const makeSupervisor = (developerMode: boolean) =>
      new PluginSupervisor({ logger, developerMode, hostPath: layout.hostPath });
    // Update activation consumes single-use, process-local receipts minted by
    // this service; the durable receipt ledger rejects replays after restart.
    const mintedReceipts = new Set<string>();
    const approvalVerifier = {
      verify: (receipt: PluginApprovalReceipt, _expectation: PluginApprovalExpectation) =>
        mintedReceipts.delete(receipt.receiptId)
    };
    const baseStatus: PluginServiceStatus = {
      available: false,
      developerMode: false,
      catalogError: null,
      isolation: "child_process+vm",
      curatedRoot,
      trustRoot,
      pluginDataRoot
    };
    const pendingStartupAudit: BufferedAudit[] = [];
    const pendingStartupEvents: Array<{ pluginId: string; status: string }> = [];

    let catalog: PluginCatalogService | undefined;
    let trustStore: StaticPluginTrustStore | undefined;
    let policy: BundleVerificationPolicy = DEFAULT_VERIFICATION_POLICY;
    let supervisor = makeSupervisor(false);
    try {
      trustStore = await loadTrustAnchors(trustRoot);
      catalog = await PluginCatalogService.create({
        workspaceRoot,
        curatedRoot,
        trustRoot,
        supervisor,
        approvalVerifier,
        policy
      });
    } catch (error) {
      const runtimeError = asPluginRuntimeError(error);
      if (runtimeError.code === "UNSIGNED_REJECTED") {
        // An unsigned but reviewed curated bundle is present. Re-create the
        // catalog in explicit developer mode; install still requires the
        // per-request allowUnsigned flag, and the mode is surfaced via
        // status() and every catalog response (visually persistent).
        policy = DEVELOPER_POLICY;
        supervisor = makeSupervisor(true);
        trustStore = await loadTrustAnchors(trustRoot);
        catalog = await PluginCatalogService.create({
          workspaceRoot,
          curatedRoot,
          trustRoot,
          supervisor,
          approvalVerifier,
          policy
        });
        baseStatus.developerMode = true;
        pendingStartupAudit.push({
          actor: "adpilot_system",
          action: "plugin_catalog_developer_mode",
          status: "denied",
          details: {
            highRisk: true,
            reason: runtimeError.message,
            developerMode: true,
            note: "unsigned curated bundle discovered; installs require explicit allowUnsigned consent"
          }
        });
      } else {
        // Tampered/invalid curated catalog or broken trust store: the plugin
        // subsystem fails closed (503) while the rest of the product boots.
        baseStatus.catalogError = { code: runtimeError.code, message: runtimeError.message };
        pendingStartupAudit.push({
          actor: "adpilot_system",
          action: "plugin_catalog_unavailable",
          status: "failed",
          details: { highRisk: true, code: runtimeError.code, reason: runtimeError.message }
        });
        return new PluginService({
          deps,
          status: baseStatus,
          policy,
          supervisor,
          logPath,
          mintedReceipts,
          pendingStartupAudit,
          pendingStartupEvents
        });
      }
    }

    const service = new PluginService({
      deps,
      status: { ...baseStatus, available: true },
      catalog,
      trustStore,
      policy,
      supervisor,
      logPath,
      mintedReceipts,
      pendingStartupAudit,
      pendingStartupEvents
    });
    await service.#recheckInstalled();
    return service;
  }

  status(): PluginServiceStatus {
    return { ...this.#status };
  }

  /** Drains boot-time audit/SSE findings once at least one client exists. Idempotent. */
  async flushStartup(): Promise<void> {
    if (this.#pendingStartupAudit.length === 0 && this.#pendingStartupEvents.length === 0) return;
    const clients = await this.#workspace.listClients();
    const clientId = clients[0]?.id;
    if (!clientId) return;
    const pendingAudit = this.#pendingStartupAudit;
    const pendingEvents = this.#pendingStartupEvents;
    this.#pendingStartupAudit = [];
    this.#pendingStartupEvents = [];
    for (const entry of pendingAudit) {
      await this.#audit.append({ clientId, ...entry });
    }
    for (const event of pendingEvents) {
      for (const client of clients) this.#publish(client.id, event.pluginId, event.status);
    }
    if (pendingAudit.some((entry) => entry.status === "failed" || (entry.status === "denied" && entry.details.highRisk === true))) {
      for (const client of clients) this.#publish(client.id, "adpilot.plugins", "degraded");
    }
  }

  async catalog(): Promise<PluginCatalogResponse> {
    return {
      plugins: await this.#requireCatalog().listCatalog(),
      candidates: listPluginCandidates(),
      runtime: this.status()
    };
  }

  async details(pluginId: string, version?: string): Promise<PluginDetailsResponse> {
    const catalog = this.#requireCatalog();
    const plugin = await catalog.getDetails(pluginId, version);
    const state = await catalog.store.getState(pluginId);
    return {
      plugin,
      installed: state
        ? {
            status: state.status,
            version: state.activeVersion,
            installedVersions: [...state.installedVersions],
            permissions: describePluginPermissions(state.permissions),
            pendingUpdate: state.pendingUpdate ? { ...state.pendingUpdate } : null,
            dataVersion: state.dataVersion,
            lifecycle: state.lifecycle.map((record) => ({ ...record })),
            migrations: state.migrations.map((record) => ({ ...record }))
          }
        : null,
      verification: state ? await this.#verifyInstalled(state) : null,
      supervisor: this.#supervisor.status(pluginId),
      logs: await this.logTail(pluginId)
    };
  }

  async install(pluginId: string, options: PluginMutationOptions): Promise<InstalledPluginDto> {
    const catalog = this.#requireCatalog();
    const details = await catalog.getDetails(pluginId, options.version);
    if (!details.signature.signed && !options.allowUnsigned) {
      await this.#auditMutation(options, "plugin_install", "denied", pluginId, {
        highRisk: true,
        code: "UNSIGNED_REJECTED"
      });
      throw new PluginRuntimeError(
        "UNSIGNED_REJECTED",
        `${pluginId} is unsigned; re-submit with allowUnsigned:true to accept an unsigned reviewed bundle`
      );
    }
    const installed = await catalog.install(pluginId, options.version, options.actor);
    await this.#auditMutation(
      options,
      "plugin_install",
      "succeeded",
      pluginId,
      details.signature.signed
        ? { version: installed.version, signer: details.signature.keyId }
        : { highRisk: true, allowUnsigned: true, version: installed.version }
    );
    await this.#publishAll(pluginId, "installed");
    return installed;
  }

  async uninstall(pluginId: string, options: PluginMutationOptions): Promise<UninstalledPluginDto> {
    const result = await this.#requireCatalog().uninstall(pluginId);
    await this.#auditMutation(options, "plugin_uninstall", "succeeded", pluginId, {});
    await this.#publishAll(pluginId, "uninstalled");
    return result;
  }

  async disable(pluginId: string, options: PluginMutationOptions): Promise<InstalledPluginDto> {
    const catalog = this.#requireCatalog();
    const before = await catalog.store.getState(pluginId);
    const result = await catalog.disable(pluginId, options.actor);
    if (before && result.lifecycle.length !== before.lifecycle.length) {
      await this.#auditMutation(options, "plugin_disable", "succeeded", pluginId, { version: result.version });
      await this.#publishAll(pluginId, "disabled");
    }
    return result;
  }

  async enable(pluginId: string, options: PluginMutationOptions): Promise<InstalledPluginDto> {
    const catalog = this.#requireCatalog();
    const before = await catalog.store.getState(pluginId);
    if (!before) throw new PluginRuntimeError("NOT_INSTALLED", `${pluginId} is not installed`);
    if (before.status !== "active") {
      // Fail closed before any state transition: a bundle that no longer
      // verifies must stay disabled instead of flipping active first.
      const verification = await this.#verifyInstalled(before);
      if (!verification.ok) {
        await this.#auditMutation(options, "plugin_enable", "denied", pluginId, {
          highRisk: true,
          code: verification.error?.code,
          reason: verification.error?.message
        });
        throw new PluginRuntimeError(
          verification.error?.code ?? "ACTIVE_BUNDLE_MISMATCH",
          `${pluginId} cannot be enabled: ${verification.error?.message ?? "verification failed"}`
        );
      }
    }
    try {
      const result = await catalog.enable(pluginId, options.actor);
      if (result.lifecycle.length !== before.lifecycle.length) {
        await this.#auditMutation(options, "plugin_enable", "succeeded", pluginId, { version: result.version });
        await this.#publishAll(pluginId, "enabled");
      }
      return result;
    } catch (error) {
      // The catalog DTO step re-verifies after the state commit; if a tamper
      // raced the transition, compensate back to disabled.
      await this.#compensateTamperedTransition(pluginId, error, options);
      throw error;
    }
  }

  async update(pluginId: string, options: PluginMutationOptions): Promise<InstalledPluginDto> {
    const catalog = this.#requireCatalog();
    const item = (await catalog.listCatalog()).find((plugin) => plugin.id === pluginId);
    if (!item) throw new PluginRuntimeError("PLUGIN_NOT_FOUND", `No curated plugin exists with id ${pluginId}`);
    const state = await catalog.store.getState(pluginId);
    if (state?.pendingUpdate) {
      if (!options.acceptPermissions) {
        throw new PluginPermissionReviewError(pluginId, item.update ?? pendingUpdateDto(state));
      }
      return this.#approvePendingUpdate(pluginId, options);
    }
    if (item.update?.requiresApproval && !options.acceptPermissions) {
      throw new PluginPermissionReviewError(pluginId, item.update);
    }
    const result = await catalog.update(pluginId, options.version, options.actor);
    if (result.status === "needs_review") {
      // Consent was given up front; the receipt binds it to the exact staged
      // grant (version, integrity, added permission keys).
      return this.#approvePendingUpdate(pluginId, options);
    }
    if (!state || result.lifecycle.length !== state.lifecycle.length) {
      await this.#auditMutation(options, "plugin_update", "succeeded", pluginId, {
        fromVersion: state?.activeVersion,
        toVersion: result.version
      });
      await this.#publishAll(pluginId, "updated");
    }
    return result;
  }

  /**
   * Builds the only plugin tool that can enter an agent run.
   *
   * The returned tool is bound to this exact client/task/actor context. Its
   * input deliberately has no clientId, taskId, permission, capability or
   * approval fields, so a model cannot retarget the invocation or ask the
   * bridge for broader authority. The advertised plugin/tool pairs are an
   * immutable snapshot for the run and are checked again by executeTool()
   * against the current active bundle before a child process starts.
   */
  async agentTools(context: ToolContext): Promise<AgentTool[]> {
    await this.#workspace.readClient(context.clientId);
    const declarations = await this.#agentToolDeclarations();
    if (declarations.length === 0) return [];
    const available = new Set(
      declarations.map((entry) => `${entry.pluginId}\u0000${entry.tool}`)
    );
    const description = [
      "Invoke one installed plugin tool through AdPilot's read-only plugin boundary.",
      "Only the exact plugin/tool pairs below are available in this run. The bundle is re-verified at execution; no network, secrets, browser, Computer Use, advertising, storage or mutable authority is brokered.",
      ...declarations.map(
        (entry) => `- ${entry.pluginId} / ${entry.tool}: ${singleLine(entry.description)}`
      )
    ].join("\n");
    const tool: AgentTool = {
      name: "plugin.invoke_readonly",
      label: "Invoke an installed read-only plugin tool",
      description,
      parameters: Type.Object(
        {
          pluginId: Type.String({ description: "Exact installed plugin id from the allowed pairs in this tool description" }),
          tool: Type.String({ description: "Exact declared tool name paired with pluginId" }),
          input: Type.Unknown({ description: "Input accepted by that reviewed plugin tool" })
        },
        { additionalProperties: false }
      ),
      executionMode: "sequential",
      execute: async (_toolCallId, raw, signal) => {
        const input = AgentPluginInvocation.parse(raw);
        if (!available.has(`${input.pluginId}\u0000${input.tool}`)) {
          throw new PluginRuntimeError(
            "PLUGIN_AGENT_TOOL_NOT_AVAILABLE",
            `${input.tool} is not an active read-only tool advertised for ${input.pluginId} in this run`
          );
        }
        const result = await this.executeTool({
          pluginId: input.pluginId,
          tool: input.tool,
          input: input.input,
          actor: context.actor,
          clientId: context.clientId,
          taskId: context.taskId,
          ...(signal ? { signal } : {})
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result ?? null) }],
          details: { pluginId: input.pluginId, tool: input.tool, result }
        };
      }
    };
    return [tool];
  }

  /**
   * Service-layer tool invocation path (the isolation boundary). Only
   * declared read-only tools run; the broker registers exactly the
   * capabilities justified by the manifest grant, so over-permission calls
   * are denied by the broker and audited.
   */
  async executeTool(invocation: PluginToolInvocation): Promise<unknown> {
    const catalog = this.#requireCatalog();
    const { pluginId, tool } = invocation;
    const state = await catalog.store.getState(pluginId);
    if (!state) throw new PluginRuntimeError("NOT_INSTALLED", `${pluginId} is not installed`);
    if (state.status !== "active") {
      throw new PluginRuntimeError("PLUGIN_INACTIVE", `${pluginId} is ${state.status}`);
    }
    const snapshot = await loadPluginBundle(catalog.store.bundlePath(pluginId, state.activeVersion));
    const declaration = snapshot.manifest.tools.find((candidate) => candidate.name === tool);
    if (!declaration) {
      throw new PluginRuntimeError("TOOL_NOT_DECLARED", `Plugin did not declare tool ${tool}`);
    }
    if (!declaration.readOnly) {
      await this.#auditMutation(invocation, "plugin_tool_execute", "denied", pluginId, {
        highRisk: true,
        tool,
        code: "PLUGIN_MUTABLE_TOOL_GATED"
      });
      throw new PluginRuntimeError(
        "PLUGIN_MUTABLE_TOOL_GATED",
        `${tool} is mutable; mutable plugin tools stay disabled until they are bridged into the official approval pipeline`
      );
    }
    const broker: CapabilityBroker = snapshot.manifest.permissions.filesystem.includes("read.text")
      ? createReadOnlyFileBroker([this.#status.pluginDataRoot])
      : new CapabilityBroker();
    const startedAt = Date.now();
    try {
      const result = await catalog.runtime.executeTool(pluginId, tool, invocation.input, broker, {
        timeoutMs: invocation.timeoutMs ?? 5_000,
        ...(invocation.signal ? { signal: invocation.signal } : {})
      });
      await this.#auditMutation(invocation, "plugin_tool_execute", "succeeded", pluginId, {
        tool,
        durationMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      const runtimeError = asPluginRuntimeError(error);
      await this.#auditMutation(
        invocation,
        "plugin_tool_execute",
        runtimeError.code.includes("DENIED") ? "denied" : "failed",
        pluginId,
        {
          tool,
          code: runtimeError.code,
          reason: runtimeError.message,
          durationMs: Date.now() - startedAt
        }
      );
      throw error;
    }
  }

  /** Last N structured (redacted) log events for one plugin, chronological. */
  async logTail(pluginId: string, limit = LOG_TAIL_LIMIT): Promise<PluginLogEvent[]> {
    if (!PLUGIN_ID.test(pluginId)) throw new PluginRuntimeError("INVALID_PLUGIN_ID", "Unsafe plugin id");
    const content = await readFile(this.#logPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const events: PluginLogEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as PluginLogEvent;
        if (event.pluginId === pluginId) events.push(event);
      } catch {
        // A partially written line must not break the log view.
      }
    }
    return events.slice(-Math.max(1, limit));
  }

  /**
   * Exact active-version declarations eligible for the agent bridge.
   *
   * Discovery is fail-closed per bundle: catalog unavailability, corrupt
   * state, failed signature/integrity verification, an unsafe permission
   * grant, or a mutable declaration simply removes that entry. Ordinary agent
   * work remains available when the plugin subsystem is degraded.
   */
  async #agentToolDeclarations(): Promise<AgentPluginToolDescriptor[]> {
    const catalog = this.#catalog;
    if (!catalog) return [];
    const pluginsRoot = path.join(catalog.store.root, "plugins");
    const entries = await readdir(pluginsRoot, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as import("node:fs").Dirent[];
        throw error;
      }
    );
    const declarations: AgentPluginToolDescriptor[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const state = await catalog.store.getState(entry.name);
        if (!state || state.status !== "active") continue;
        const verification = await this.#verifyInstalled(state);
        if (!verification.ok) continue;
        const snapshot = await loadPluginBundle(
          catalog.store.bundlePath(state.pluginId, state.activeVersion)
        );
        if (!isAgentSafeManifest(snapshot.manifest)) continue;
        for (const tool of snapshot.manifest.tools) {
          if (!tool.readOnly) continue;
          declarations.push({
            pluginId: state.pluginId,
            tool: tool.name,
            description: tool.description
          });
        }
      } catch {
        // One corrupt/tampered plugin must disappear from the agent surface
        // without taking down ordinary local or advertising work.
      }
    }
    return declarations.sort(
      (left, right) =>
        left.pluginId.localeCompare(right.pluginId) || left.tool.localeCompare(right.tool)
    );
  }

  /** Boot-time integrity/signature re-verification of every installed plugin. */
  async #recheckInstalled(): Promise<void> {
    const catalog = this.#requireCatalog();
    const pluginsRoot = path.join(catalog.store.root, "plugins");
    const entries = await readdir(pluginsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as import("node:fs").Dirent[];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        this.#pendingStartupAudit.push({
          actor: STARTUP_RECHECK_ACTOR,
          action: "plugin_startup_recheck",
          status: "denied",
          details: { highRisk: true, pluginId: entry.name, reason: "installed plugin directory is not a real directory" }
        });
        continue;
      }
      let state: InstalledPluginState | undefined;
      try {
        state = await catalog.store.getState(entry.name);
      } catch (error) {
        const runtimeError = asPluginRuntimeError(error);
        this.#pendingStartupAudit.push({
          actor: STARTUP_RECHECK_ACTOR,
          action: "plugin_startup_recheck",
          status: "failed",
          details: { highRisk: true, pluginId: entry.name, code: runtimeError.code, reason: runtimeError.message }
        });
        continue;
      }
      if (!state || state.status === "disabled") continue;
      const verification = await this.#verifyInstalled(state);
      if (verification.ok) continue;
      // Degrade fail-closed: disabled keeps the data on disk but nothing loads.
      await catalog.runtime.disable(state.pluginId, STARTUP_RECHECK_ACTOR).catch(() => undefined);
      this.#pendingStartupAudit.push({
        actor: STARTUP_RECHECK_ACTOR,
        action: "plugin_startup_recheck",
        status: "denied",
        details: {
          highRisk: true,
          pluginId: state.pluginId,
          version: state.activeVersion,
          code: verification.error?.code,
          reason: verification.error?.message,
          degradedTo: "disabled"
        }
      });
      this.#pendingStartupEvents.push({ pluginId: state.pluginId, status: "disabled" });
    }
  }

  async #verifyInstalled(state: InstalledPluginState): Promise<PluginVerificationDto> {
    const checkedAt = new Date().toISOString();
    const base = {
      checkedAt,
      integrity: state.activeIntegrity,
      signerKeyId: state.signerKeyId,
      signerFingerprint: state.signerFingerprint
    };
    if (!this.#catalog || !this.#trustStore) {
      return { ...base, ok: false, error: { code: "PLUGIN_CATALOG_UNAVAILABLE", message: "plugin catalog is unavailable" } };
    }
    try {
      const snapshot = await loadPluginBundle(this.#catalog.store.bundlePath(state.pluginId, state.activeVersion));
      const identity = await verifiedPluginBundleIdentity(snapshot, this.#trustStore, this.#policy);
      if (identity.integrity !== state.activeIntegrity || identity.signerFingerprint !== state.signerFingerprint) {
        throw new PluginRuntimeError(
          "ACTIVE_BUNDLE_MISMATCH",
          `${state.pluginId} active bundle signer or integrity pin changed`
        );
      }
      return { ...base, ok: true, error: null };
    } catch (error) {
      const runtimeError = asPluginRuntimeError(error);
      return { ...base, ok: false, error: { code: runtimeError.code, message: runtimeError.message } };
    }
  }

  async #approvePendingUpdate(pluginId: string, options: PluginMutationOptions): Promise<InstalledPluginDto> {
    const catalog = this.#requireCatalog();
    const state = await catalog.store.getState(pluginId);
    if (!state?.pendingUpdate) {
      throw new PluginRuntimeError("NO_PENDING_UPDATE", `${pluginId} has no pending permission review`);
    }
    const expectation: PluginApprovalExpectation = {
      installationId: state.installationId,
      stateRevision: state.revision,
      pluginId,
      version: state.pendingUpdate.version,
      targetIntegrity: state.pendingUpdate.targetIntegrity,
      addedPermissionKeys: [...state.pendingUpdate.permissionDiff.added].sort()
    };
    const receipt: PluginApprovalReceipt = {
      receiptId: crypto.randomUUID(),
      installationId: expectation.installationId,
      stateRevision: expectation.stateRevision,
      pluginId: expectation.pluginId,
      version: expectation.version,
      targetIntegrity: expectation.targetIntegrity,
      approvedPermissionKeys: [...expectation.addedPermissionKeys],
      actor: options.actor,
      approvedAt: new Date().toISOString(),
      decision: "approved"
    };
    this.#mintedReceipts.add(receipt.receiptId);
    const approved = await catalog.approveUpdate(pluginId, receipt);
    await this.#auditMutation(options, "plugin_update", "succeeded", pluginId, {
      fromVersion: state.activeVersion,
      toVersion: approved.version,
      approvedPermissions: expectation.addedPermissionKeys
    });
    await this.#publishAll(pluginId, "updated");
    return approved;
  }

  async #compensateTamperedTransition(pluginId: string, error: unknown, options: PluginMutationOptions): Promise<void> {
    const runtimeError = asPluginRuntimeError(error);
    if (
      runtimeError.code !== "INTEGRITY_MISMATCH" &&
      runtimeError.code !== "SIGNATURE_INVALID" &&
      runtimeError.code !== "ACTIVE_BUNDLE_MISMATCH"
    ) {
      return;
    }
    await this.#requireCatalog().runtime.disable(pluginId, "plugin-integrity-compensation").catch(() => undefined);
    await this.#auditMutation(options, "plugin_enable", "denied", pluginId, {
      highRisk: true,
      code: runtimeError.code,
      reason: `${runtimeError.message}; compensated back to disabled`
    });
  }

  #requireCatalog(): PluginCatalogService {
    if (!this.#catalog) {
      throw new PluginRuntimeError(
        "PLUGIN_CATALOG_UNAVAILABLE",
        this.#status.catalogError
          ? `Plugin catalog is unavailable: ${this.#status.catalogError.message}`
          : "Plugin catalog is unavailable"
      );
    }
    return this.#catalog;
  }

  async #auditMutation(
    options: { actor: string; clientId?: string | undefined; taskId?: string | undefined },
    action: string,
    status: BufferedAudit["status"],
    pluginId: string,
    details: Record<string, unknown>
  ): Promise<void> {
    const clientId = options.clientId ?? (await this.#workspace.listClients())[0]?.id;
    if (!clientId) {
      this.#pendingStartupAudit.push({ actor: options.actor, action, status, details: { pluginId, ...details } });
      return;
    }
    await this.#audit.append({
      clientId,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      actor: options.actor,
      action,
      status,
      details: { pluginId, ...details }
    });
  }

  #publish(clientId: string, pluginId: string, status: string): void {
    this.#events.publish({ type: "plugin", clientId, pluginId, status });
  }

  async #publishAll(pluginId: string, status: string): Promise<void> {
    for (const client of await this.#workspace.listClients()) {
      this.#publish(client.id, pluginId, status);
    }
  }
}

function pendingUpdateDto(state: InstalledPluginState): PluginUpdateDto {
  if (!state.pendingUpdate) throw new PluginRuntimeError("NO_PENDING_UPDATE", `${state.pluginId} has no pending update`);
  return {
    version: state.pendingUpdate.version,
    permissionDiff: {
      added: state.pendingUpdate.permissionDiff.added.map((key) => ({
        key,
        category: "capability" as const,
        title: key,
        description: "Newly requested permission; see the manifest for the exact scope.",
        risk: "high" as const,
        requiresReviewWhenAdded: true as const
      })),
      removed: [],
      hasNewPermissions: state.pendingUpdate.permissionDiff.added.length > 0
    },
    requiresApproval: true
  };
}

function asPluginRuntimeError(error: unknown): PluginRuntimeError {
  if (error instanceof PluginRuntimeError) return error;
  return new PluginRuntimeError("PLUGIN_RUNTIME_FAILURE", error instanceof Error ? error.message : String(error));
}

export async function createPluginService(deps: PluginServiceDeps): Promise<PluginService> {
  return PluginService.create(deps);
}
