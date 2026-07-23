import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW, CUSTOM_PROVIDERS_ENV, CustomProviderConfig } from "@adpilot/shared";
import { z } from "zod";

export type Locale = "zh-CN" | "en";
export type Appearance = "dark" | "light" | "system";

export interface SettingsField {
  env: string;
  label: { zh: string; en: string };
  secret: boolean;
  required?: boolean;
  placeholder?: string;
}

const providerKeyEnv: Record<string, string> = {
  "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
  "ant-ling": "ANT_LING_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  google: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  groq: "GROQ_API_KEY",
  huggingface: "HF_TOKEN",
  "kimi-coding": "KIMI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  mistral: "MISTRAL_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  openai: "OPENAI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  radius: "RADIUS_API_KEY",
  together: "TOGETHER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  xai: "XAI_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY"
};

const specialFields: Record<string, SettingsField[]> = {
  "amazon-bedrock": [
    field("AWS_BEARER_TOKEN_BEDROCK", "Bedrock Bearer Token", "Bedrock bearer token", true),
    field("AWS_PROFILE", "AWS 配置档案", "AWS profile", false, false, "default"),
    field("AWS_REGION", "AWS 区域", "AWS region", false, false, "us-east-1"),
    field("AWS_ACCESS_KEY_ID", "AWS Access Key ID", "AWS access key ID", true),
    field("AWS_SECRET_ACCESS_KEY", "AWS Secret Access Key", "AWS secret access key", true)
  ],
  "azure-openai-responses": [
    field("AZURE_OPENAI_API_KEY", "API 密钥", "API key", true, true),
    field("AZURE_OPENAI_BASE_URL", "基础地址", "Base URL", false, true, "https://example.openai.azure.com/openai/v1"),
    field("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "部署映射", "Deployment map", false, false, "gpt-5=my-gpt-5"),
    field("AZURE_OPENAI_API_VERSION", "API 版本", "API version", false, false, "v1")
  ],
  "cloudflare-ai-gateway": [
    field("CLOUDFLARE_API_KEY", "Cloudflare API 密钥", "Cloudflare API key", true, true),
    field("CLOUDFLARE_ACCOUNT_ID", "账户 ID", "Account ID", false, true),
    field("CLOUDFLARE_GATEWAY_ID", "Gateway ID", "Gateway ID", false, true)
  ],
  "cloudflare-workers-ai": [
    field("CLOUDFLARE_API_KEY", "Cloudflare API 密钥", "Cloudflare API key", true, true),
    field("CLOUDFLARE_ACCOUNT_ID", "账户 ID", "Account ID", false, true)
  ],
  "google-vertex": [
    field("GOOGLE_CLOUD_API_KEY", "Google Cloud API 密钥", "Google Cloud API key", true),
    field("GOOGLE_CLOUD_PROJECT", "Google Cloud 项目", "Google Cloud project", false, true),
    field("GOOGLE_CLOUD_LOCATION", "区域", "Location", false, true, "us-central1"),
    field("GOOGLE_APPLICATION_CREDENTIALS", "服务账户文件", "Service account file", false, false, "/path/to/service-account.json")
  ]
};

// Dedicated GUI roles are optional. When absent, image-capable Pi code models remain the fallback.
const computerFields: SettingsField[] = [
  field("ADPILOT_PRIVACY_MODE", "隐私模式", "Privacy mode", false, false, "standard"),
  field("ADPILOT_GUI_BASE_URL", "GUI 定位服务地址", "GUI grounding endpoint", false, false, "http://127.0.0.1:8000/v1"),
  field("ADPILOT_GUI_API_KEY", "GUI 定位密钥", "GUI grounding API key", true),
  field("ADPILOT_GUI_MODEL", "GUI 定位模型", "GUI grounding model", false, false, "ui-tars-1.5"),
  field("ADPILOT_GUI_STRONG_MODEL", "GUI 强化模型", "GUI strong model", false, false, "ui-tars-1.5"),
  field("ADPILOT_GUI_PROTOCOL", "动作协议", "Action protocol", false, false, "ui-tars"),
  field("ADPILOT_GUI_IMAGE_INPUT", "支持图像输入", "Image input capability", false, false, "true"),
  field("ADPILOT_GUI_COORDINATE_FORMAT", "坐标格式", "Coordinate format", false, false, "ui-tars-1000"),
  field("ADPILOT_GUI_NORMALIZATION", "坐标归一化区域", "Coordinate normalization", false, false, "window"),
  field("ADPILOT_GUI_TIMEOUT_MS", "GUI 超时（毫秒）", "GUI timeout (ms)", false, false, "20000"),
  field("ADPILOT_GUI_MAX_RETRIES", "GUI 最大重试次数", "GUI maximum retries", false, false, "2"),
  field("ADPILOT_VERIFY_BASE_URL", "视觉复核服务地址", "Visual verification endpoint", false, false, "http://127.0.0.1:8000/v1"),
  field("ADPILOT_VERIFY_API_KEY", "视觉复核密钥", "Visual verification API key", true),
  field("ADPILOT_VERIFY_MODEL", "视觉复核模型", "Visual verification model", false),
  field("ADPILOT_VERIFY_MODE", "复核模式", "Verification mode", false, false, "auto"),
  field("ADPILOT_VERIFY_TIMEOUT_MS", "视觉复核超时（毫秒）", "Verification timeout (ms)", false, false, "20000")
];

function field(env: string, zh: string, en: string, secret: boolean, required = false, placeholder?: string): SettingsField {
  return { env, label: { zh, en }, secret, required, ...(placeholder ? { placeholder } : {}) };
}

function providerFields(providerId: string): SettingsField[] {
  if (specialFields[providerId]) return specialFields[providerId];
  const env = providerKeyEnv[providerId];
  return env ? [field(env, "API 密钥", "API key", true, true)] : [];
}

export const ModelSelection = z.object({ provider: z.string().min(1), model: z.string().min(1) });
export const SettingsUpdate = z.object({
  locale: z.enum(["zh-CN", "en"]),
  appearance: z.enum(["dark", "light", "system"]),
  models: z.object({ fast: ModelSelection, strong: ModelSelection }),
  env: z.record(z.string(), z.string().nullable()).default({}),
  /** Full replacement of the custom provider list when present; omitted keeps the stored list. */
  customProviders: z.array(CustomProviderConfig).optional()
});
export type SettingsUpdateInput = z.infer<typeof SettingsUpdate>;

const StoredSettings = z.object({
  version: z.literal(1),
  locale: z.enum(["zh-CN", "en"]).default("zh-CN"),
  appearance: z.enum(["dark", "light", "system"]).default("dark"),
  models: z.object({ fast: ModelSelection, strong: ModelSelection }).optional(),
  env: z.record(z.string(), z.string()).default({}),
  customProviders: z.array(CustomProviderConfig).default([])
});
type StoredSettingsData = z.infer<typeof StoredSettings>;

const PiCredential = z.discriminatedUnion("type", [
  z.object({ type: z.literal("api_key"), key: z.string().optional(), env: z.record(z.string(), z.string()).optional() }),
  z.object({ type: z.literal("oauth"), refresh: z.string(), access: z.string(), expires: z.number() }).passthrough()
]);
const StoredCredentials = z.object({ version: z.literal(1), credentials: z.record(z.string(), PiCredential).default({}) });

export interface ModelCatalog {
  providers: Array<{
    id: string;
    name: string;
    baseUrl?: string;
    auth: { apiKey: boolean; oauth: boolean };
    fields: SettingsField[];
    models: Array<{ id: string; name: string; reasoning: boolean; vision: boolean; contextWindow: number }>;
  }>;
  computerFields: SettingsField[];
}

export function getModelCatalog(customProviders: CustomProviderConfig[] = []): ModelCatalog {
  return {
    providers: builtinProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      auth: { apiKey: Boolean(provider.auth.apiKey), oauth: Boolean(provider.auth.oauth) },
      fields: providerFields(provider.id),
      models: provider.getModels().map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        vision: model.input.includes("image"),
        contextWindow: model.contextWindow
      }))
    })).concat(customProviders.map((custom) => ({
      id: custom.id,
      name: custom.name,
      baseUrl: custom.baseUrl,
      auth: { apiKey: true, oauth: false },
      fields: [],
      models: custom.models.map((model) => ({
        id: model.id,
        name: model.id,
        reasoning: false,
        vision: model.vision,
        contextWindow: CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW
      }))
    }))),
    computerFields
  };
}

const allowedEnv = new Set(getModelCatalog().providers.flatMap((provider) => provider.fields.map((item) => item.env)).concat(computerFields.map((item) => item.env)));

export class SettingsStore {
  readonly path: string;
  private data: StoredSettingsData | undefined;

  constructor(readonly workspaceRoot: string, private readonly baseEnv: NodeJS.ProcessEnv = process.env) {
    this.path = resolve(workspaceRoot, ".adpilot", "settings.json");
  }

  async load(): Promise<StoredSettingsData> {
    if (this.data) return structuredClone(this.data);
    try { this.data = StoredSettings.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = StoredSettings.parse({ version: 1, env: {} });
    }
    return structuredClone(this.data);
  }

  async effectiveEnv(): Promise<NodeJS.ProcessEnv> {
    const data = await this.load();
    const env: NodeJS.ProcessEnv = { ...this.baseEnv, ...data.env };
    if (data.models) {
      env.ADPILOT_FAST_PROVIDER = data.models.fast.provider;
      env.ADPILOT_FAST_MODEL = data.models.fast.model;
      env.ADPILOT_STRONG_PROVIDER = data.models.strong.provider;
      env.ADPILOT_STRONG_MODEL = data.models.strong.model;
    }
    if (data.customProviders.length > 0) {
      env[CUSTOM_PROVIDERS_ENV] = JSON.stringify(data.customProviders);
    }
    return env;
  }

  async publicView() {
    const data = await this.load();
    const env = await this.effectiveEnv();
    const catalog = getModelCatalog(data.customProviders);
    const fields = catalog.providers.flatMap((provider) => provider.fields).concat(catalog.computerFields);
    return {
      locale: data.locale,
      appearance: data.appearance,
      models: {
        fast: { provider: env.ADPILOT_FAST_PROVIDER ?? "openai", model: env.ADPILOT_FAST_MODEL ?? "gpt-5-mini" },
        strong: { provider: env.ADPILOT_STRONG_PROVIDER ?? env.ADPILOT_FAST_PROVIDER ?? "openai", model: env.ADPILOT_STRONG_MODEL ?? "gpt-5.2" }
      },
      values: Object.fromEntries(fields.filter((item) => !item.secret).map((item) => [item.env, env[item.env] ?? ""])),
      configured: Object.fromEntries(fields.map((item) => [item.env, Boolean(env[item.env])])),
      customProviders: data.customProviders.map((custom) => ({
        id: custom.id,
        name: custom.name,
        baseUrl: custom.baseUrl,
        api: custom.api,
        hasApiKey: Boolean(custom.apiKey),
        models: custom.models
      })),
      catalog
    };
  }

  async save(input: z.input<typeof SettingsUpdate>): Promise<void> {
    const update = SettingsUpdate.parse(input);
    const current = await this.load();
    const customProviders = update.customProviders ?? current.customProviders;
    validateCustomProviders(customProviders);
    validateSelection(update.models.fast, customProviders);
    validateSelection(update.models.strong, customProviders);
    const nextEnv = Object.fromEntries(Object.entries(current.env).filter(([name]) => allowedEnv.has(name)));
    for (const [name, value] of Object.entries(update.env)) {
      if (!allowedEnv.has(name)) throw new Error(`unsupported setting: ${name}`);
      if (value === null || value.trim() === "") delete nextEnv[name];
      else nextEnv[name] = value.trim();
    }
    validateComputerSettings(nextEnv);
    this.data = StoredSettings.parse({ version: 1, locale: update.locale, appearance: update.appearance, models: update.models, env: nextEnv, customProviders });
    await mkdir(resolve(this.workspaceRoot, ".adpilot"), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function validateComputerSettings(env: Record<string, string>): void {
  const enums: Record<string, string[]> = {
    ADPILOT_GUI_PROTOCOL: ["ui-tars", "adpilot-json"],
    ADPILOT_GUI_IMAGE_INPUT: ["true", "false"],
    ADPILOT_GUI_COORDINATE_FORMAT: ["pixels", "normalized", "ui-tars-1000"],
    ADPILOT_GUI_NORMALIZATION: ["screenshot", "window"],
    ADPILOT_VERIFY_MODE: ["auto", "independent", "gui", "strong"],
    ADPILOT_PRIVACY_MODE: ["standard", "local-only"]
  };
  for (const [name, values] of Object.entries(enums)) {
    if (env[name] && !values.includes(env[name])) throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
  for (const name of ["ADPILOT_GUI_TIMEOUT_MS", "ADPILOT_VERIFY_TIMEOUT_MS"]) {
    if (env[name] && (!Number.isInteger(Number(env[name])) || Number(env[name]) < 1000 || Number(env[name]) > 120_000)) {
      throw new Error(`${name} must be an integer between 1000 and 120000`);
    }
  }
  if (env.ADPILOT_GUI_MAX_RETRIES && (!Number.isInteger(Number(env.ADPILOT_GUI_MAX_RETRIES)) || Number(env.ADPILOT_GUI_MAX_RETRIES) < 0 || Number(env.ADPILOT_GUI_MAX_RETRIES) > 2)) {
    throw new Error("ADPILOT_GUI_MAX_RETRIES must be an integer between 0 and 2");
  }
}

/** Persistent Pi credentials shared by the CLI and native desktop runtime. */
export class WorkspaceCredentialStore implements CredentialStore {
  readonly path: string;
  private data: Record<string, Credential> | undefined;
  private readonly chains = new Map<string, Promise<unknown>>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly workspaceRoot: string) {
    this.path = resolve(workspaceRoot, ".adpilot", "pi-auth.json");
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const credential = (await this.load())[providerId];
    return credential ? structuredClone(credential) : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const credentials = await this.load();
      const current = credentials[providerId];
      const next = await fn(current ? structuredClone(current) : undefined);
      if (next === undefined) return current ? structuredClone(current) : undefined;
      credentials[providerId] = PiCredential.parse(next) as Credential;
      await this.persist();
      return structuredClone(credentials[providerId]);
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      const credentials = await this.load();
      if (!(providerId in credentials)) return;
      delete credentials[providerId];
      await this.persist();
    });
  }

  private async load(): Promise<Record<string, Credential>> {
    if (this.data) return this.data;
    try { this.data = StoredCredentials.parse(JSON.parse(await readFile(this.path, "utf8"))).credentials as Record<string, Credential>; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = {};
    }
    return this.data;
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(resolve(this.workspaceRoot, ".adpilot"), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, credentials: this.data }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writeChain;
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const next = (async () => { await previous.catch(() => undefined); return task(); })();
    this.chains.set(providerId, next.catch(() => undefined));
    return next;
  }
}

function validateCustomProviders(customProviders: CustomProviderConfig[]): void {
  const builtinIds = new Set(builtinProviders().map((provider) => provider.id));
  const seen = new Set<string>();
  for (const custom of customProviders) {
    if (builtinIds.has(custom.id)) throw new Error(`custom provider id collides with built-in provider: ${custom.id}`);
    if (seen.has(custom.id)) throw new Error(`duplicate custom provider id: ${custom.id}`);
    seen.add(custom.id);
    if (new Set(custom.models.map((model) => model.id)).size !== custom.models.length) {
      throw new Error(`duplicate model id in custom provider: ${custom.id}`);
    }
  }
}

function validateSelection(selection: { provider: string; model: string }, customProviders: CustomProviderConfig[]): void {
  const provider = getModelCatalog(customProviders).providers.find((item) => item.id === selection.provider);
  if (!provider) throw new Error(`provider not found: ${selection.provider}`);
  if (!provider.models.some((model) => model.id === selection.model)) throw new Error(`model not found: ${selection.provider}/${selection.model}`);
}
