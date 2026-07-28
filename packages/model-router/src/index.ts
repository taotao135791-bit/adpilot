import { access } from "node:fs/promises";
import {
  createModels,
  createProvider,
  type Api,
  type Context,
  type CredentialStore,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type Provider
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW,
  CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS,
  CUSTOM_PROVIDERS_ENV,
  CustomProviderConfig,
  isLocalModelEndpoint,
  ModelTier
} from "@adpilot/shared";
import { z } from "zod";

export interface ModelRef {
  provider: string;
  model: string;
}

export interface ModelRouterConfig {
  fast: ModelRef;
  strong: ModelRef;
  gui: ModelRef;
  guiStrong?: ModelRef;
  guiDedicated?: ModelRef;
  guiDedicatedStrong?: ModelRef;
  guiFallback?: ModelRef;
  confidenceThreshold?: number;
  computerFailureThreshold?: number;
}

export interface RoutingSignals {
  task: "conversation" | "planning" | "report" | "classification" | "screenshot" | "grounding" | "causal_analysis" | "risk_review";
  confidence?: number;
  conflictingSources?: boolean;
  computerFailures?: number;
  mutationRisk?: "observe" | "interact" | "mutate" | "destructive";
  reviewerEscalated?: boolean;
}

export interface RouteDecision {
  tier: ModelTier;
  ref: ModelRef;
  reasons: string[];
  guiCandidates?: GuiRouteCandidate[];
}

export interface GuiRouteCandidate {
  kind: "dedicated" | "pi-vision";
  ref: ModelRef;
}

export class ModelRouter {
  private readonly confidenceThreshold: number;
  private readonly computerFailureThreshold: number;

  constructor(private readonly config: ModelRouterConfig) {
    this.confidenceThreshold = config.confidenceThreshold ?? 0.65;
    this.computerFailureThreshold = config.computerFailureThreshold ?? 2;
  }

  route(signals: RoutingSignals): RouteDecision {
    if (signals.task === "grounding") return this.routeGui(signals);
    const reasons: string[] = [];
    if (signals.conflictingSources) reasons.push("multiple data sources conflict");
    if (signals.confidence !== undefined && signals.confidence < this.confidenceThreshold) reasons.push("fast-model confidence is below threshold");
    if ((signals.computerFailures ?? 0) >= this.computerFailureThreshold) reasons.push("computer use failed repeatedly");
    if (signals.task === "causal_analysis" || signals.task === "risk_review") reasons.push("task requires high-assurance reasoning");
    if (signals.mutationRisk === "destructive") reasons.push("destructive account change requires escalation");
    if (signals.reviewerEscalated) reasons.push("risk reviewer requested escalation");
    if (reasons.length) return { tier: "strong", ref: this.config.strong, reasons };
    return { tier: "fast", ref: this.config.fast, reasons: ["normal low-risk workload"] };
  }

  private routeGui(signals: RoutingSignals): RouteDecision {
    const strong = (signals.computerFailures ?? 0) >= this.computerFailureThreshold
      || signals.reviewerEscalated === true
      || (signals.confidence !== undefined && signals.confidence < this.confidenceThreshold);
    const fallback = strong ? this.config.guiStrong ?? this.config.guiFallback ?? this.config.gui : this.config.guiFallback ?? this.config.gui;
    const dedicated = strong ? this.config.guiDedicatedStrong ?? this.config.guiDedicated : this.config.guiDedicated;
    const candidates: GuiRouteCandidate[] = [
      ...(dedicated ? [{ kind: "dedicated" as const, ref: dedicated }] : []),
      { kind: "pi-vision", ref: fallback }
    ];
    return {
      tier: strong ? "strong" : "gui",
      ref: fallback,
      reasons: [strong ? "repeated or low-confidence GUI work uses the strong grounding route" : "visual grounding uses the primary GUI route", "dedicated GUI provider is preferred before PiVision fallback"],
      guiCandidates: candidates
    };
  }
}

export interface CreatePiModelsOptions {
  /**
   * Custom OpenAI/Anthropic-compatible providers registered after the built-in catalog.
   * Defaults to the JSON list in env[ADPILOT_CUSTOM_PROVIDERS], which
   * SettingsStore.effectiveEnv() writes from the stored settings.
   */
  customProviders?: z.input<typeof CustomProviderConfig>[];
}

/** Placeholder bearer token for keyless local servers (llama.cpp, Ollama, vLLM) whose API ignores auth. */
const KEYLESS_API_KEY = "adpilot-keyless-local";

/** Build a pi-ai Provider from a stored custom provider config (gateway or local inference server). */
export function createCustomProvider(config: z.input<typeof CustomProviderConfig>): Provider {
  const parsed = CustomProviderConfig.parse(config);
  return createProvider({
    id: parsed.id,
    name: parsed.name,
    baseUrl: parsed.baseUrl,
    auth: {
      apiKey: {
        name: `${parsed.name} API key`,
        resolve: async ({ credential }) => ({
          auth: { apiKey: credential?.key ?? parsed.apiKey ?? KEYLESS_API_KEY },
          source: credential?.key ? "stored credential" : parsed.apiKey ? "settings" : "keyless placeholder"
        })
      }
    },
    models: parsed.models.map((model): Model<Api> => ({
      id: model.id,
      name: model.id,
      api: parsed.api,
      provider: parsed.id,
      baseUrl: parsed.baseUrl,
      reasoning: model.reasoning,
      input: model.vision ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW,
      maxTokens: CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS
    })),
    api: parsed.api === "anthropic-messages" ? anthropicMessagesApi() : openAICompletionsApi()
  });
}

function customProvidersFromEnv(env: NodeJS.ProcessEnv, options: CreatePiModelsOptions): CustomProviderConfig[] {
  if (options.customProviders) return options.customProviders.map((config) => CustomProviderConfig.parse(config));
  const raw = env[CUSTOM_PROVIDERS_ENV];
  if (!raw || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CUSTOM_PROVIDERS_ENV} contains invalid JSON`);
  }
  const result = z.array(CustomProviderConfig).safeParse(parsed);
  if (!result.success) throw new Error(`${CUSTOM_PROVIDERS_ENV} is invalid: ${result.error.issues[0]?.message ?? "malformed custom provider list"}`);
  const seen = new Set<string>();
  for (const config of result.data) {
    if (seen.has(config.id)) throw new Error(`duplicate custom provider id: ${config.id}`);
    seen.add(config.id);
  }
  return result.data;
}

/**
 * Thrown when local-only privacy mode blocks a chat/planning call to a remote model.
 * Carries the same code as the computer-use screenshot-side block so callers can
 * handle both paths uniformly.
 */
export class PrivacyModeRemoteModelError extends Error {
  readonly code = "PRIVACY_MODE_REMOTE_PROVIDER_BLOCKED" as const;
  constructor(readonly provider: string, readonly modelId: string) {
    super(`local-only privacy mode blocked remote model ${provider}/${modelId}`);
    this.name = "PrivacyModeRemoteModelError";
  }
}

/**
 * Wrap a Models registry with the router-side local-only privacy guard. Every model call
 * (stream/complete/streamSimple/completeSimple) is checked synchronously before dispatch:
 * with ADPILOT_PRIVACY_MODE=local-only, calls to models that are not local (provider id like
 * ollama/lmstudio/llama.cpp, or a loopback/private baseUrl host) throw PrivacyModeRemoteModelError
 * before any request leaves the machine. In standard mode the wrapper is a pure pass-through.
 */
export function withLocalOnlyGuard(models: Models, env: NodeJS.ProcessEnv = process.env): Models {
  const assertLocal = (model: Model<Api>): void => {
    if (env.ADPILOT_PRIVACY_MODE === "local-only" && !isLocalModelEndpoint(model.provider, model.baseUrl)) {
      throw new PrivacyModeRemoteModelError(model.provider, model.id);
    }
  };
  return {
    getProviders: () => models.getProviders(),
    getProvider: (id) => models.getProvider(id),
    getModels: (provider) => models.getModels(provider),
    getModel: (provider, id) => models.getModel(provider, id),
    refresh: (options) => models.refresh(options),
    checkAuth: (providerId) => models.checkAuth(providerId),
    getAvailable: (providerId) => models.getAvailable(providerId),
    getAuth: ((target: string | Model<Api>, overrides?: Parameters<Models["getAuth"]>[1]) =>
      typeof target === "string" ? models.getAuth(target, overrides) : models.getAuth(target, overrides)) as Models["getAuth"],
    login: (providerId, type, interaction) => models.login(providerId, type, interaction),
    logout: (providerId) => models.logout(providerId),
    stream: <TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>) => {
      assertLocal(model);
      return models.stream(model, context, options);
    },
    complete: <TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>) => {
      assertLocal(model);
      return models.complete(model, context, options);
    },
    streamSimple: (model, context, options) => {
      assertLocal(model);
      return models.streamSimple(model, context, options);
    },
    completeSimple: (model, context, options) => {
      assertLocal(model);
      return models.completeSimple(model, context, options);
    }
  };
}

export function createPiModels(env: NodeJS.ProcessEnv = process.env, credentials?: CredentialStore, options: CreatePiModelsOptions = {}): Models {
  const models = createModels({
    ...(credentials ? { credentials } : {}),
    authContext: {
      env: async (name) => env[name],
      fileExists: async (path) => access(path).then(() => true).catch(() => false)
    }
  });
  for (const provider of builtinProviders()) models.setProvider(provider);
  for (const config of customProvidersFromEnv(env, options)) {
    if (models.getProvider(config.id)) throw new Error(`custom provider id collides with registered provider: ${config.id}`);
    models.setProvider(createCustomProvider(config));
  }
  return withLocalOnlyGuard(models, env);
}

export function resolvePiModel(models: Models, ref: ModelRef): Model<Api> {
  const model = models.getModel(ref.provider, ref.model);
  if (!model) throw new Error(`model not found: ${ref.provider}/${ref.model}`);
  return model;
}

export function modelRouterFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRouter {
  const fastProvider = env.ADPILOT_FAST_PROVIDER ?? "openai";
  const fastModel = env.ADPILOT_FAST_MODEL ?? "gpt-5-mini";
  // Single-model semantics: when no strong model is configured the strong role
  // follows the fast one; the built-in defaults only apply to a bare env.
  const strongModel = env.ADPILOT_STRONG_MODEL ?? env.ADPILOT_FAST_MODEL ?? "gpt-5.2";
  const guiFallback = { provider: env.ADPILOT_GUI_FALLBACK_PROVIDER ?? fastProvider, model: env.ADPILOT_GUI_FALLBACK_MODEL ?? fastModel };
  const dedicatedGui = env.ADPILOT_GUI_BASE_URL && env.ADPILOT_GUI_MODEL
    ? { provider: env.ADPILOT_GUI_PROVIDER ?? "ui-tars-openai-compatible", model: env.ADPILOT_GUI_MODEL }
    : undefined;
  return new ModelRouter({
    fast: { provider: fastProvider, model: fastModel },
    strong: { provider: env.ADPILOT_STRONG_PROVIDER ?? fastProvider, model: strongModel },
    gui: guiFallback,
    guiStrong: { provider: env.ADPILOT_GUI_STRONG_FALLBACK_PROVIDER ?? env.ADPILOT_STRONG_PROVIDER ?? fastProvider, model: env.ADPILOT_GUI_STRONG_FALLBACK_MODEL ?? strongModel },
    guiFallback,
    ...(dedicatedGui ? { guiDedicated: dedicatedGui } : {}),
    ...(env.ADPILOT_GUI_BASE_URL && env.ADPILOT_GUI_STRONG_MODEL ? {
      guiDedicatedStrong: { provider: env.ADPILOT_GUI_PROVIDER ?? "ui-tars-openai-compatible", model: env.ADPILOT_GUI_STRONG_MODEL }
    } : {})
  });
}
