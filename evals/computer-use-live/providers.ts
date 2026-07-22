import { resolve } from "node:path";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import {
  DualVisualIdentityVerifier,
  GuiGroundingProviderRouter,
  OpenAICompatibleUiTarsProvider,
  OpenAICompatibleVisualIdentityReviewer,
  OpenAICompatibleVisualVerifier,
  PiVisualIdentityReviewer,
  PiVisionModel,
  type VisualGroundingProvider,
  type VisualVerifier
} from "@adpilot/computer-use";
import { SettingsStore, WorkspaceCredentialStore } from "@adpilot/configuration";
import { createPiModels, modelRouterFromEnv, resolvePiModel } from "@adpilot/model-router";
import { PiVisualTableModel, PiVisualTableVerifier, VisualTableReader } from "@adpilot/visual-table-reader";
import type { ProductLiveProviderSuite } from "./evaluator.js";

export interface LiveProviderFactoryOptions {
  env?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
  models?: Models;
}

/**
 * Assemble the same Computer Use providers used by the product. This factory is intentionally
 * independent of prediction files: a route exists only when its real provider is configured.
 */
export async function createProductLiveProviderSuite(options: LiveProviderFactoryOptions = {}): Promise<{
  providers: ProductLiveProviderSuite;
  effectiveEnv: NodeJS.ProcessEnv;
}> {
  const baseEnv = options.env ?? process.env;
  const workspaceRoot = options.workspaceRoot ?? baseEnv.ADPILOT_WORKSPACE ?? resolve(process.cwd(), "workspace");
  const settings = new SettingsStore(workspaceRoot, baseEnv);
  const effectiveEnv = await settings.effectiveEnv();
  const credentials = new WorkspaceCredentialStore(workspaceRoot);
  const models = options.models ?? createPiModels(effectiveEnv, credentials);
  const productRouter = modelRouterFromEnv(effectiveEnv);

  const fastDecision = productRouter.route({ task: "grounding", computerFailures: 0 });
  const deepDecision = productRouter.route({ task: "grounding", computerFailures: 2 });
  let primaryVision: Model<Api> | undefined;
  let deepVision: Model<Api> | undefined;
  const visionFailures: string[] = [];

  try {
    const candidate = resolvePiModel(models, fastDecision.ref);
    if (!candidate.input.includes("image")) visionFailures.push(`${candidate.provider}/${candidate.id} does not accept images`);
    else if (!await isAuthenticated(models, candidate.provider)) visionFailures.push(`${candidate.provider}/${candidate.id} has no usable credential`);
    else primaryVision = candidate;
  } catch (caught) {
    visionFailures.push(caught instanceof Error ? caught.message : String(caught));
  }

  try {
    const candidate = resolvePiModel(models, deepDecision.ref);
    if (!candidate.input.includes("image")) visionFailures.push(`${candidate.provider}/${candidate.id} does not accept images`);
    else if (!await isAuthenticated(models, candidate.provider)) visionFailures.push(`${candidate.provider}/${candidate.id} has no usable credential`);
    else deepVision = candidate;
  } catch (caught) {
    visionFailures.push(caught instanceof Error ? caught.message : String(caught));
  }

  // Product behavior: either authenticated vision-capable code model can keep the visual route available.
  primaryVision ??= deepVision;
  deepVision ??= primaryVision;
  const piVision = primaryVision && deepVision ? new PiVisionModel(models, primaryVision, deepVision) : undefined;
  const dedicatedGrounding = createDedicatedGrounding(effectiveEnv);
  const builtInGrounding = dedicatedGrounding || piVision
    ? new GuiGroundingProviderRouter(dedicatedGrounding, piVision)
    : undefined;
  const dedicatedVerifier = createDedicatedVerifier(effectiveEnv);
  const verifier: VisualVerifier | undefined = dedicatedVerifier ?? piVision;
  const tableReader = primaryVision && deepVision
    ? new VisualTableReader({
        model: new PiVisualTableModel(models, primaryVision, deepVision),
        verifier: new PiVisualTableVerifier(models, deepVision)
      })
    : undefined;
  const dedicatedIdentity = createDedicatedIdentityReviewer(effectiveEnv);
  const guiIdentity = dedicatedIdentity
    ?? (deepVision ? new PiVisualIdentityReviewer(models, deepVision, `gui-verification:${deepVision.provider}/${deepVision.id}`) : undefined);
  const deepIdentity = deepVision
    ? new PiVisualIdentityReviewer(models, deepVision, `deep-vision:${deepVision.provider}/${deepVision.id}`)
    : undefined;
  const dualVisualIdentity = guiIdentity && deepIdentity
    ? new DualVisualIdentityVerifier(guiIdentity, deepIdentity)
    : undefined;
  const productMaxAttempts = visualMaxAttempts(effectiveEnv.ADPILOT_GUI_MAX_RETRIES);
  const visionReason = visionFailures.length
    ? `No authenticated image-capable Pi route: ${[...new Set(visionFailures)].join("; ")}`
    : "No authenticated image-capable Pi route is configured.";

  const providers: ProductLiveProviderSuite = {
    routes: {
      ...(builtInGrounding ? {
        builtInGuiGrounding: {
          provider: builtInGrounding,
          providerLabel: dedicatedGrounding
            ? `${dedicatedGrounding.id} with ${piVision ? "PiVision fallback" : "no fallback"}`
            : `PiVision ${primaryVision!.provider}/${primaryVision!.id}`,
          initialTier: "gui" as const,
          maxAttempts: productMaxAttempts,
          escalationTier: "strong" as const
        }
      } : {}),
      ...(piVision && primaryVision ? {
        fastVisionModel: {
          provider: piVision,
          providerLabel: `${primaryVision.provider}/${primaryVision.id}`,
          initialTier: "fast" as const,
          maxAttempts: 1 as const
        }
      } : {}),
      ...(piVision && deepVision ? {
        deepVisionModel: {
          provider: piVision,
          providerLabel: `${deepVision.provider}/${deepVision.id}`,
          initialTier: "strong" as const,
          maxAttempts: 1 as const
        }
      } : {})
    },
    routeAvailability: {
      builtInGuiGrounding: builtInGrounding
        ? { status: "configured", provider: dedicatedGrounding?.id ?? piVision!.id }
        : { status: "not-run", reason: `${dedicatedGroundingReason(effectiveEnv)} ${visionReason}`.trim() },
      fastVisionModel: piVision && primaryVision
        ? { status: "configured", provider: `${primaryVision.provider}/${primaryVision.id}` }
        : { status: "not-run", reason: visionReason },
      deepVisionModel: piVision && deepVision
        ? { status: "configured", provider: `${deepVision.provider}/${deepVision.id}` }
        : { status: "not-run", reason: visionReason }
    },
    ...(verifier ? {
      verification: {
        provider: verifier,
        providerLabel: dedicatedVerifier
          ? `OpenAI-compatible verifier/${verifierModel(effectiveEnv)}`
          : `PiVision ${deepVision!.provider}/${deepVision!.id}`
      }
    } : {}),
    verificationAvailability: verifier
      ? { status: "configured", provider: dedicatedVerifier ? `verifier/${verifierModel(effectiveEnv)}` : piVision!.id }
      : { status: "not-run", reason: `No GUI verification endpoint or authenticated Pi vision model is configured. ${visionReason}` },
    ...(tableReader && primaryVision && deepVision ? {
      tableReader: {
        reader: tableReader,
        providerLabel: `VisualTableReader reader=${primaryVision.provider}/${primaryVision.id}; verifier=${deepVision.provider}/${deepVision.id}`
      }
    } : {}),
    tableReaderAvailability: tableReader && primaryVision && deepVision
      ? { status: "configured", provider: `${primaryVision.provider}/${primaryVision.id} + ${deepVision.provider}/${deepVision.id}` }
      : { status: "not-run", reason: `VisualTableReader needs an authenticated image-capable code model. ${visionReason}` },
    ...(dualVisualIdentity ? {
      dualVisualIdentity: {
        verifier: dualVisualIdentity,
        providerLabel: dedicatedIdentity
          ? `${dedicatedIdentity.id} + ${deepIdentity!.id}`
          : `${guiIdentity!.id} + ${deepIdentity!.id}`
      }
    } : {}),
    dualVisualIdentityAvailability: dualVisualIdentity
      ? { status: "configured", provider: dedicatedIdentity ? `${dedicatedIdentity.id} + ${deepIdentity!.id}` : `${guiIdentity!.id} + ${deepIdentity!.id}` }
      : { status: "not-run", reason: `Dual visual identity needs a GUI verification reviewer and an authenticated Deep Vision reviewer. ${visionReason}` }
  };

  return { providers, effectiveEnv };
}

async function isAuthenticated(models: Models, provider: string): Promise<boolean> {
  return Boolean(await models.checkAuth(provider).catch(() => undefined));
}

function createDedicatedGrounding(env: NodeJS.ProcessEnv): VisualGroundingProvider | undefined {
  if (!env.ADPILOT_GUI_BASE_URL || !env.ADPILOT_GUI_MODEL || env.ADPILOT_GUI_IMAGE_INPUT === "false") return undefined;
  return new OpenAICompatibleUiTarsProvider({
    baseURL: env.ADPILOT_GUI_BASE_URL,
    ...(env.ADPILOT_GUI_API_KEY ? { apiKey: env.ADPILOT_GUI_API_KEY } : {}),
    model: env.ADPILOT_GUI_MODEL,
    ...(env.ADPILOT_GUI_STRONG_MODEL ? { strongModel: env.ADPILOT_GUI_STRONG_MODEL } : {}),
    timeoutMs: positiveInteger(env.ADPILOT_GUI_TIMEOUT_MS, 20_000),
    protocol: env.ADPILOT_GUI_PROTOCOL === "adpilot-json" ? "adpilot-json" : "ui-tars",
    coordinateFormat: env.ADPILOT_GUI_COORDINATE_FORMAT === "normalized"
      ? "normalized"
      : env.ADPILOT_GUI_COORDINATE_FORMAT === "pixels"
        ? "pixels"
        : "ui-tars-1000",
    normalization: env.ADPILOT_GUI_NORMALIZATION === "screenshot" ? "screenshot" : "window"
  });
}

function createDedicatedVerifier(env: NodeJS.ProcessEnv): VisualVerifier | undefined {
  const mode = env.ADPILOT_VERIFY_MODE ?? "auto";
  const endpoint = mode === "gui" ? env.ADPILOT_GUI_BASE_URL : env.ADPILOT_VERIFY_BASE_URL;
  const model = mode === "gui" ? env.ADPILOT_GUI_MODEL : env.ADPILOT_VERIFY_MODEL;
  const key = mode === "gui" ? env.ADPILOT_GUI_API_KEY : env.ADPILOT_VERIFY_API_KEY;
  if (mode === "strong" || !endpoint || !model) return undefined;
  return new OpenAICompatibleVisualVerifier({
    baseURL: endpoint,
    ...(key ? { apiKey: key } : {}),
    model,
    ...(mode === "gui" && env.ADPILOT_GUI_STRONG_MODEL ? { strongModel: env.ADPILOT_GUI_STRONG_MODEL } : {}),
    timeoutMs: positiveInteger(env.ADPILOT_VERIFY_TIMEOUT_MS, 20_000)
  });
}

function createDedicatedIdentityReviewer(env: NodeJS.ProcessEnv): OpenAICompatibleVisualIdentityReviewer | undefined {
  const mode = env.ADPILOT_VERIFY_MODE ?? "auto";
  const endpoint = mode === "gui" ? env.ADPILOT_GUI_BASE_URL : env.ADPILOT_VERIFY_BASE_URL;
  const model = mode === "gui" ? env.ADPILOT_GUI_MODEL : env.ADPILOT_VERIFY_MODEL;
  const key = mode === "gui" ? env.ADPILOT_GUI_API_KEY : env.ADPILOT_VERIFY_API_KEY;
  if (mode === "strong" || !endpoint || !model) return undefined;
  return new OpenAICompatibleVisualIdentityReviewer(`gui-verification:${model}`, {
    baseURL: endpoint,
    model,
    ...(key ? { apiKey: key } : {}),
    timeoutMs: positiveInteger(env.ADPILOT_VERIFY_TIMEOUT_MS, 20_000)
  });
}

function verifierModel(env: NodeJS.ProcessEnv): string {
  return env.ADPILOT_VERIFY_MODE === "gui" ? env.ADPILOT_GUI_MODEL ?? "unknown" : env.ADPILOT_VERIFY_MODEL ?? "unknown";
}

function dedicatedGroundingReason(env: NodeJS.ProcessEnv): string {
  if (!env.ADPILOT_GUI_BASE_URL || !env.ADPILOT_GUI_MODEL) return "Dedicated GUI grounding endpoint/model is not configured.";
  if (env.ADPILOT_GUI_IMAGE_INPUT === "false") return "Dedicated GUI route declares no image input.";
  return "Dedicated GUI route is unavailable.";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function visualMaxAttempts(value: string | undefined): 1 | 2 | 3 {
  const retries = Number(value);
  return Number.isInteger(retries) && retries >= 0 && retries <= 2 ? (retries + 1) as 1 | 2 | 3 : 3;
}
