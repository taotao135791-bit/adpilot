import { access } from "node:fs/promises";
import { createModels, type Model, type Api, type CredentialStore, type Models } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelTier } from "@adpilot/shared";

export interface ModelRef {
  provider: string;
  model: string;
}

export interface ModelRouterConfig {
  fast: ModelRef;
  strong: ModelRef;
  gui: ModelRef;
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
}

export class ModelRouter {
  private readonly confidenceThreshold: number;
  private readonly computerFailureThreshold: number;

  constructor(private readonly config: ModelRouterConfig) {
    this.confidenceThreshold = config.confidenceThreshold ?? 0.65;
    this.computerFailureThreshold = config.computerFailureThreshold ?? 2;
  }

  route(signals: RoutingSignals): RouteDecision {
    if (signals.task === "grounding") return { tier: "gui", ref: this.config.gui, reasons: ["visual grounding uses the selected vision-capable code model"] };
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
}

export function createPiModels(env: NodeJS.ProcessEnv = process.env, credentials?: CredentialStore): Models {
  const models = createModels({
    ...(credentials ? { credentials } : {}),
    authContext: {
      env: async (name) => env[name],
      fileExists: async (path) => access(path).then(() => true).catch(() => false)
    }
  });
  for (const provider of builtinProviders()) models.setProvider(provider);
  return models;
}

export function resolvePiModel(models: Models, ref: ModelRef): Model<Api> {
  const model = models.getModel(ref.provider, ref.model);
  if (!model) throw new Error(`model not found: ${ref.provider}/${ref.model}`);
  return model;
}

export function modelRouterFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRouter {
  const fastProvider = env.ADPILOT_FAST_PROVIDER ?? "openai";
  const fastModel = env.ADPILOT_FAST_MODEL ?? "gpt-5-mini";
  return new ModelRouter({
    fast: { provider: fastProvider, model: fastModel },
    strong: { provider: env.ADPILOT_STRONG_PROVIDER ?? fastProvider, model: env.ADPILOT_STRONG_MODEL ?? "gpt-5.2" },
    gui: { provider: fastProvider, model: fastModel }
  });
}
