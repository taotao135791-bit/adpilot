import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Models } from "@earendil-works/pi-ai";
import { SettingsStore } from "@adpilot/configuration";
import {
  createPiModels,
  ModelRouter,
  modelRouterFromEnv,
  PrivacyModeRemoteModelError,
  resolvePiModel,
  withLocalOnlyGuard
} from "./index.js";

const router = new ModelRouter({
  fast: { provider: "p", model: "fast" },
  strong: { provider: "p", model: "strong" },
  gui: { provider: "p", model: "vision" },
  guiStrong: { provider: "p", model: "vision-strong" },
  guiDedicated: { provider: "ui-tars", model: "ground" },
  guiDedicatedStrong: { provider: "ui-tars", model: "ground-strong" }
});

describe("ModelRouter", () => {
  it("routes grounding exclusively to the GUI tier", () => {
    expect(router.route({ task: "grounding" })).toMatchObject({
      tier: "gui",
      ref: { provider: "p", model: "vision" },
      guiCandidates: [
        { kind: "dedicated", ref: { provider: "ui-tars", model: "ground" } },
        { kind: "pi-vision", ref: { provider: "p", model: "vision" } }
      ]
    });
  });

  it("uses the strong dedicated GUI model before the strong PiVision fallback", () => {
    expect(router.route({ task: "grounding", computerFailures: 2 })).toMatchObject({
      tier: "strong",
      guiCandidates: [
        { kind: "dedicated", ref: { provider: "ui-tars", model: "ground-strong" } },
        { kind: "pi-vision", ref: { provider: "p", model: "vision-strong" } }
      ]
    });
  });

  it("escalates conflicts, low confidence, failures, and risky reviews", () => {
    expect(router.route({ task: "planning", conflictingSources: true }).tier).toBe("strong");
    expect(router.route({ task: "classification", confidence: 0.3 }).tier).toBe("strong");
    expect(router.route({ task: "screenshot", computerFailures: 2 }).tier).toBe("strong");
    expect(router.route({ task: "risk_review" }).tier).toBe("strong");
  });

  it("keeps ordinary planning on the fast model", () => {
    expect(router.route({ task: "planning", confidence: 0.9 }).tier).toBe("fast");
  });
});

const gateway = {
  id: "corp-gateway", name: "Corp Gateway", baseUrl: "https://gateway.corp.example/v1", apiKey: "gw-secret",
  models: [{ id: "gpt-4o-internal", vision: true }]
};
const localLlama = { id: "local-llama", name: "Local llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", models: [{ id: "qwen3-8b" }] };
const lanVllm = { id: "lan-vllm", name: "LAN vLLM", baseUrl: "http://192.168.1.20:8000/v1", models: [{ id: "qwen3-32b" }] };

describe("custom providers", () => {
  it("registers custom providers from env JSON into the catalog and router resolution", () => {
    const env = { ADPILOT_CUSTOM_PROVIDERS: JSON.stringify([gateway, localLlama]) };
    const models = createPiModels(env);
    expect(models.getProviders().map((provider) => provider.id)).toEqual(expect.arrayContaining(["openai", "corp-gateway", "local-llama"]));
    const resolved = resolvePiModel(models, { provider: "corp-gateway", model: "gpt-4o-internal" });
    expect(resolved).toMatchObject({
      api: "openai-completions", provider: "corp-gateway",
      baseUrl: "https://gateway.corp.example/v1", input: ["text", "image"]
    });
    expect(resolvePiModel(models, { provider: "local-llama", model: "qwen3-8b" }).input).toEqual(["text"]);
    const routed = modelRouterFromEnv({ ...env, ADPILOT_FAST_PROVIDER: "corp-gateway", ADPILOT_FAST_MODEL: "gpt-4o-internal" });
    const decision = routed.route({ task: "conversation" });
    expect(decision.ref).toEqual({ provider: "corp-gateway", model: "gpt-4o-internal" });
    expect(resolvePiModel(models, decision.ref).provider).toBe("corp-gateway");
  });

  it("accepts explicit custom providers and rejects collisions, duplicates, and malformed env JSON", () => {
    const models = createPiModels({}, undefined, { customProviders: [localLlama] });
    expect(models.getModel("local-llama", "qwen3-8b")).toMatchObject({ provider: "local-llama" });
    expect(() => createPiModels({}, undefined, { customProviders: [{ ...localLlama, id: "openai" }] })).toThrow("collides with registered provider");
    expect(() => createPiModels({ ADPILOT_CUSTOM_PROVIDERS: JSON.stringify([localLlama, localLlama]) })).toThrow("duplicate custom provider id");
    expect(() => createPiModels({ ADPILOT_CUSTOM_PROVIDERS: "not json" })).toThrow("invalid JSON");
    expect(() => createPiModels({ ADPILOT_CUSTOM_PROVIDERS: JSON.stringify([{ id: "x", name: "X", baseUrl: "nope", models: [{ id: "m" }] }]) })).toThrow("ADPILOT_CUSTOM_PROVIDERS is invalid");
  });

  it("resolves auth for keyed and keyless custom providers", async () => {
    const models = createPiModels({}, undefined, { customProviders: [gateway, localLlama] });
    expect((await models.getAuth("corp-gateway"))?.auth.apiKey).toBe("gw-secret");
    const keyless = await models.getAuth("local-llama");
    expect(typeof keyless?.auth.apiKey).toBe("string");
    expect(keyless?.auth.apiKey?.length).toBeGreaterThan(0);
  });

  it("flows a custom provider from a 0600 settings file through env into registry and routing tiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-router-settings-"));
    const store = new SettingsStore(root, {});
    await store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "corp-gateway", model: "gpt-4o-internal" }, strong: { provider: "local-llama", model: "qwen3-8b" } },
      env: {},
      customProviders: [gateway, localLlama]
    });
    // The runtime path: SettingsStore.effectiveEnv() -> createPiModels(env) -> modelRouterFromEnv(env).
    const env = await store.effectiveEnv();
    const models = createPiModels(env);
    expect(models.getProviders().map((provider) => provider.id)).toEqual(expect.arrayContaining(["corp-gateway", "local-llama"]));
    const router = modelRouterFromEnv(env);
    const fastDecision = router.route({ task: "conversation" });
    expect(fastDecision).toMatchObject({ tier: "fast", ref: { provider: "corp-gateway", model: "gpt-4o-internal" } });
    expect(resolvePiModel(models, fastDecision.ref)).toMatchObject({ baseUrl: gateway.baseUrl, input: ["text", "image"] });
    const strongDecision = router.route({ task: "risk_review" });
    expect(strongDecision).toMatchObject({ tier: "strong", ref: { provider: "local-llama", model: "qwen3-8b" } });
    expect(resolvePiModel(models, strongDecision.ref)).toMatchObject({ baseUrl: localLlama.baseUrl, input: ["text"] });
    expect((await models.getAuth("corp-gateway"))?.auth.apiKey).toBe("gw-secret");
  });

  it("routes the strong tier to the fast model when only one model is configured", async () => {
    // Bare env single-model: no strong override anywhere.
    const single = modelRouterFromEnv({ ADPILOT_FAST_PROVIDER: "corp-gateway", ADPILOT_FAST_MODEL: "gpt-4o-internal" });
    expect(single.route({ task: "risk_review" })).toMatchObject({ tier: "strong", ref: { provider: "corp-gateway", model: "gpt-4o-internal" } });
    // Explicitly configured strong models keep the classic split.
    const split = modelRouterFromEnv({
      ADPILOT_FAST_PROVIDER: "corp-gateway", ADPILOT_FAST_MODEL: "gpt-4o-internal",
      ADPILOT_STRONG_PROVIDER: "local-llama", ADPILOT_STRONG_MODEL: "qwen3-8b"
    });
    expect(split.route({ task: "risk_review" })).toMatchObject({ tier: "strong", ref: { provider: "local-llama", model: "qwen3-8b" } });

    // Settings-file single-model: effectiveEnv materializes both roles.
    const root = await mkdtemp(join(tmpdir(), "adpilot-router-single-"));
    const store = new SettingsStore(root, {});
    await store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "corp-gateway", model: "gpt-4o-internal" } },
      env: {},
      customProviders: [gateway]
    });
    const router = modelRouterFromEnv(await store.effectiveEnv());
    expect(router.route({ task: "risk_review" })).toMatchObject({ tier: "strong", ref: { provider: "corp-gateway", model: "gpt-4o-internal" } });
  });
});

describe("custom provider reasoning capability", () => {
  const reasonerGateway = {
    id: "reasoning-gateway", name: "Reasoning Gateway", baseUrl: "http://127.0.0.1:9/v1", apiKey: "gw-secret",
    models: [{ id: "thinker", reasoning: true }, { id: "plain" }]
  };

  it("marks custom provider models as reasoning-capable only when configured", () => {
    const models = createPiModels({}, undefined, { customProviders: [reasonerGateway] });
    expect(resolvePiModel(models, { provider: "reasoning-gateway", model: "thinker" }).reasoning).toBe(true);
    expect(resolvePiModel(models, { provider: "reasoning-gateway", model: "plain" }).reasoning).toBe(false);
  });

  it("sends reasoning_effort on the wire for capable models and drops it for others", async () => {
    const models = createPiModels({}, undefined, { customProviders: [reasonerGateway] });
    const context = { systemPrompt: "test", messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

    const thinkerPayloads: Record<string, unknown>[] = [];
    const thinker = resolvePiModel(models, { provider: "reasoning-gateway", model: "thinker" });
    // Nothing listens on 127.0.0.1:9; the payload is captured before the network failure.
    await models.completeSimple(thinker, context, {
      reasoning: "high",
      onPayload: (payload) => { thinkerPayloads.push(payload as Record<string, unknown>); }
    }).catch(() => undefined);
    expect(thinkerPayloads).toHaveLength(1);
    expect(thinkerPayloads[0]?.reasoning_effort).toBe("high");

    const plainPayloads: Record<string, unknown>[] = [];
    const plain = resolvePiModel(models, { provider: "reasoning-gateway", model: "plain" });
    await models.completeSimple(plain, context, {
      reasoning: "high",
      onPayload: (payload) => { plainPayloads.push(payload as Record<string, unknown>); }
    }).catch(() => undefined);
    expect(plainPayloads).toHaveLength(1);
    expect(plainPayloads[0]).not.toHaveProperty("reasoning_effort");
    expect(JSON.stringify(plainPayloads[0])).not.toContain("thinking");
  });
});

describe("local-only privacy guard", () => {
  const context = { systemPrompt: "test", messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

  function stubModels(calls: string[]): Models {
    return {
      getProviders: () => [],
      getProvider: () => undefined,
      getModels: () => [],
      getModel: () => undefined,
      refresh: async () => ({ aborted: false, errors: new Map() }),
      checkAuth: async () => undefined,
      getAvailable: async () => [],
      getAuth: (async () => undefined) as Models["getAuth"],
      login: async () => { throw new Error("no login in stub"); },
      logout: async () => undefined,
      stream: () => { calls.push("stream"); return undefined as never; },
      complete: async () => { calls.push("complete"); return undefined as never; },
      streamSimple: () => { calls.push("streamSimple"); return undefined as never; },
      completeSimple: async () => { calls.push("completeSimple"); return undefined as never; }
    };
  }

  it("blocks remote models before dispatch in local-only mode", () => {
    const env = { ADPILOT_PRIVACY_MODE: "local-only" };
    const models = createPiModels(env, undefined, { customProviders: [localLlama, gateway] });
    const remote = resolvePiModel(models, { provider: "openai", model: "gpt-5-mini" });
    let error: unknown;
    try {
      models.streamSimple(remote, context);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PrivacyModeRemoteModelError);
    expect((error as PrivacyModeRemoteModelError).code).toBe("PRIVACY_MODE_REMOTE_PROVIDER_BLOCKED");
    expect((error as PrivacyModeRemoteModelError).message).toContain("openai/gpt-5-mini");
    const remoteGateway = resolvePiModel(models, { provider: "corp-gateway", model: "gpt-4o-internal" });
    expect(() => models.completeSimple(remoteGateway, context)).toThrow(PrivacyModeRemoteModelError);
  });

  it("passes local and private-network endpoints through to dispatch in local-only mode", () => {
    const calls: string[] = [];
    const guarded = withLocalOnlyGuard(stubModels(calls), { ADPILOT_PRIVACY_MODE: "local-only" });
    const models = createPiModels({}, undefined, { customProviders: [localLlama, lanVllm] });
    const endpoints = [
      resolvePiModel(models, { provider: "local-llama", model: "qwen3-8b" }),
      resolvePiModel(models, { provider: "lan-vllm", model: "qwen3-32b" }),
      { ...resolvePiModel(models, { provider: "local-llama", model: "qwen3-8b" }), provider: "my-ollama-box" }
    ];
    for (const model of endpoints) {
      guarded.streamSimple(model, context);
    }
    expect(calls).toEqual(["streamSimple", "streamSimple", "streamSimple"]);
    expect(() => guarded.streamSimple({ ...endpoints[0]!, baseUrl: "https://api.openai.com/v1" }, context)).toThrow(PrivacyModeRemoteModelError);
    expect(calls).toHaveLength(3);
  });

  it("lets a loopback custom endpoint dispatch past the guard in local-only mode", async () => {
    const models = createPiModels({ ADPILOT_PRIVACY_MODE: "local-only" }, undefined, { customProviders: [localLlama] });
    const model = resolvePiModel(models, { provider: "local-llama", model: "qwen3-8b" });
    // Nothing listens on 127.0.0.1:8080; the failure must come from the network, not the guard.
    const failure = await models.completeSimple(model, context).catch((caught: unknown) => caught);
    expect(failure).not.toBeInstanceOf(PrivacyModeRemoteModelError);
  });

  it("leaves standard mode fully untouched", () => {
    const models = createPiModels({}, undefined, { customProviders: [gateway] });
    const remote = resolvePiModel(models, { provider: "openai", model: "gpt-5-mini" });
    expect(() => models.streamSimple(remote, context)).not.toThrow();
    const calls: string[] = [];
    const guarded = withLocalOnlyGuard(stubModels(calls), {});
    guarded.streamSimple(resolvePiModel(models, { provider: "corp-gateway", model: "gpt-4o-internal" }), context);
    expect(calls).toEqual(["streamSimple"]);
  });
});
