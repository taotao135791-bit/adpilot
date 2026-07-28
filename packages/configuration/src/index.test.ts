import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getModelCatalog, SettingsStore, WorkspaceCredentialStore } from "./index.js";

describe("SettingsStore", () => {
  it("publishes the Pi catalog without exposing secrets and persists valid routing", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-settings-"));
    const store = new SettingsStore(root, { OPENAI_API_KEY: "ambient-secret" });
    const catalog = getModelCatalog();
    expect(catalog.providers.length).toBeGreaterThanOrEqual(30);
    expect(catalog.computerFields.map((field) => field.env)).toEqual(expect.arrayContaining([
      "ADPILOT_GUI_BASE_URL", "ADPILOT_GUI_MODEL", "ADPILOT_VERIFY_BASE_URL", "ADPILOT_VERIFY_MODEL"
    ]));
    expect(catalog.providers.find((provider) => provider.id === "openai")?.models.length).toBeGreaterThan(10);
    const initial = await store.publicView();
    expect(initial.configured.OPENAI_API_KEY).toBe(true);
    expect(JSON.stringify(initial)).not.toContain("ambient-secret");

    await store.save({
      locale: "en", appearance: "light",
      models: { fast: { provider: "openai", model: "gpt-5-mini" }, strong: { provider: "anthropic", model: "claude-sonnet-4-5" } },
      env: { ANTHROPIC_API_KEY: "stored-secret" }
    });
    const effective = await store.effectiveEnv();
    expect(effective.ADPILOT_STRONG_PROVIDER).toBe("anthropic");
    expect(effective.ANTHROPIC_API_KEY).toBe("stored-secret");
    expect(await readFile(store.path, "utf8")).toContain("stored-secret");
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  it("rejects models outside the Pi catalog and arbitrary environment variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-settings-"));
    const store = new SettingsStore(root, {});
    await expect(store.save({ locale: "zh-CN", appearance: "dark", models: { fast: { provider: "openai", model: "not-real" }, strong: { provider: "openai", model: "gpt-5.2" } }, env: {} })).rejects.toThrow("model not found");
    await expect(store.save({ locale: "zh-CN", appearance: "dark", models: { fast: { provider: "openai", model: "gpt-5-mini" }, strong: { provider: "openai", model: "gpt-5.2" } }, env: { PATH: "/tmp" } })).rejects.toThrow("unsupported setting");
  });

  it("persists Pi OAuth credentials privately for the CLI and desktop runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-auth-"));
    const store = new WorkspaceCredentialStore(root);
    await store.modify("openai-codex", async () => ({ type: "oauth", access: "access-secret", refresh: "refresh-secret", expires: Date.now() + 60_000 }));
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
    expect(await store.read("openai-codex")).toMatchObject({ type: "oauth", access: "access-secret" });
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    await store.delete("openai-codex");
    expect(await store.read("openai-codex")).toBeUndefined();
  });

  it("stores custom providers privately, exposes them in the catalog, and routes them via env", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-settings-"));
    const store = new SettingsStore(root, {});
    await store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "corp-gateway", model: "gpt-4o-internal" }, strong: { provider: "openai", model: "gpt-5.2" } },
      env: {},
      customProviders: [
        { id: "corp-gateway", name: "Corp Gateway", baseUrl: "https://gateway.corp.example/v1", apiKey: "gateway-secret", models: [{ id: "gpt-4o-internal" }] },
        { id: "local-llama", name: "Local llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", models: [{ id: "qwen3-8b", vision: true }] }
      ]
    });
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(store.path, "utf8")).toContain("gateway-secret");

    const view = await store.publicView();
    expect(JSON.stringify(view)).not.toContain("gateway-secret");
    expect(JSON.stringify(view)).not.toContain("ADPILOT_CUSTOM_PROVIDERS");
    expect(view.customProviders).toEqual([
      { id: "corp-gateway", name: "Corp Gateway", baseUrl: "https://gateway.corp.example/v1", api: "openai-completions", hasApiKey: true, models: [{ id: "gpt-4o-internal", vision: false, reasoning: false }] },
      { id: "local-llama", name: "Local llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", api: "openai-completions", hasApiKey: false, models: [{ id: "qwen3-8b", vision: true, reasoning: false }] }
    ]);
    expect(view.models.fast).toEqual({ provider: "corp-gateway", model: "gpt-4o-internal" });
    const catalogEntry = view.catalog.providers.find((provider) => provider.id === "local-llama");
    expect(catalogEntry).toMatchObject({ name: "Local llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", auth: { apiKey: true, oauth: false }, models: [{ id: "qwen3-8b", vision: true }] });

    const effective = await store.effectiveEnv();
    expect(effective.ADPILOT_FAST_PROVIDER).toBe("corp-gateway");
    const routed = JSON.parse(effective.ADPILOT_CUSTOM_PROVIDERS ?? "[]") as Array<{ id: string; apiKey?: string }>;
    expect(routed.map((provider) => provider.id)).toEqual(["corp-gateway", "local-llama"]);
    expect(routed[0]?.apiKey).toBe("gateway-secret");
  });

  it("rejects invalid custom provider definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-settings-"));
    const store = new SettingsStore(root, {});
    const base = {
      locale: "zh-CN" as const, appearance: "dark" as const,
      models: { fast: { provider: "openai", model: "gpt-5-mini" }, strong: { provider: "openai", model: "gpt-5.2" } },
      env: {}
    };
    await expect(store.save({ ...base, customProviders: [{ id: "x", name: "X", baseUrl: "not-a-url", models: [{ id: "m" }] }] })).rejects.toThrow("baseUrl");
    await expect(store.save({ ...base, customProviders: [{ id: "x", name: "X", baseUrl: "ftp://files.example/v1", models: [{ id: "m" }] }] })).rejects.toThrow("baseUrl");
    await expect(store.save({ ...base, customProviders: [{ id: "openai", name: "X", baseUrl: "https://x.example/v1", models: [{ id: "m" }] }] })).rejects.toThrow("collides with built-in");
    await expect(store.save({
      ...base,
      customProviders: [
        { id: "x", name: "X", baseUrl: "https://x.example/v1", models: [{ id: "m" }] },
        { id: "x", name: "Y", baseUrl: "https://y.example/v1", models: [{ id: "m" }] }
      ]
    })).rejects.toThrow("duplicate custom provider id");
    await expect(store.save({ ...base, customProviders: [{ id: "x", name: "X", baseUrl: "https://x.example/v1", models: [{ id: "m" }, { id: "m" }] }] })).rejects.toThrow("duplicate model id");
    await expect(store.save({ ...base, customProviders: [{ id: "x", name: "X", baseUrl: "https://x.example/v1", models: [] }] })).rejects.toThrow();
    expect(await store.load()).toMatchObject({ customProviders: [] });
  });

  it("keeps the stored custom provider list when an update omits it", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-settings-"));
    const store = new SettingsStore(root, {});
    const customProviders = [{ id: "corp-gateway", name: "Corp", baseUrl: "https://gateway.corp.example/v1", apiKey: "gw-secret", models: [{ id: "m1" }] }];
    await store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "corp-gateway", model: "m1" }, strong: { provider: "openai", model: "gpt-5.2" } },
      env: {}, customProviders
    });
    // A later update without customProviders must not drop the stored list, and the
    // selection referencing the kept provider still validates.
    await store.save({
      locale: "en", appearance: "dark",
      models: { fast: { provider: "corp-gateway", model: "m1" }, strong: { provider: "openai", model: "gpt-5.2" } },
      env: {}
    });
    expect((await store.load()).customProviders.map((provider) => provider.id)).toEqual(["corp-gateway"]);
    expect(JSON.parse((await store.effectiveEnv()).ADPILOT_CUSTOM_PROVIDERS ?? "[]")).toHaveLength(1);
    // An explicit empty list is a real replacement and clears the stored providers.
    await expect(store.save({
      locale: "en", appearance: "dark",
      models: { fast: { provider: "openai", model: "gpt-5-mini" }, strong: { provider: "openai", model: "gpt-5.2" } },
      env: {}, customProviders: []
    })).resolves.toBeUndefined();
    expect((await store.load()).customProviders).toEqual([]);
  });

  it("validates fast/strong selections against the effective custom provider list", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-settings-"));
    const store = new SettingsStore(root, {});
    const customProviders = [{ id: "corp-gateway", name: "Corp", baseUrl: "https://gateway.corp.example/v1", models: [{ id: "m1" }] }];
    await expect(store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "corp-gateway", model: "unknown" }, strong: { provider: "openai", model: "gpt-5.2" } },
      env: {}, customProviders
    })).rejects.toThrow("model not found");
    await store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "corp-gateway", model: "m1" }, strong: { provider: "openai", model: "gpt-5.2" } },
      env: {}, customProviders
    });
    // Removing the list invalidates the previously stored selection on the next save.
    await expect(store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "corp-gateway", model: "m1" }, strong: { provider: "openai", model: "gpt-5.2" } },
      env: {}, customProviders: []
    })).rejects.toThrow("provider not found");
    expect((await store.load()).customProviders.map((provider) => provider.id)).toEqual(["corp-gateway"]);
  });

  it("supports single-model mode: an omitted strong selection follows the fast one", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-settings-single-"));
    const store = new SettingsStore(root, {});
    await store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "openai", model: "gpt-5" } },
      env: { OPENAI_API_KEY: "single-key" }
    });
    // The fast selection materializes into both roles so downstream env
    // consumers (router, vision wiring) work unchanged.
    const effective = await store.effectiveEnv();
    expect(effective.ADPILOT_FAST_PROVIDER).toBe("openai");
    expect(effective.ADPILOT_FAST_MODEL).toBe("gpt-5");
    expect(effective.ADPILOT_STRONG_PROVIDER).toBe("openai");
    expect(effective.ADPILOT_STRONG_MODEL).toBe("gpt-5");

    const view = await store.publicView();
    expect(view.models.fast).toEqual({ provider: "openai", model: "gpt-5" });
    expect(view.models.strong).toEqual({ provider: "openai", model: "gpt-5" });
    expect(view.models.strongConfigured).toBe(false);

    // The single-model shape survives a reload from disk.
    const reloaded = new SettingsStore(root, {});
    expect((await reloaded.load()).models?.strong).toBeUndefined();
    expect((await reloaded.publicView()).models.strongConfigured).toBe(false);
    expect((await reloaded.effectiveEnv()).ADPILOT_STRONG_MODEL).toBe("gpt-5");

    // Moving back to two explicit models restores the classic split.
    await reloaded.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "openai", model: "gpt-5-mini" }, strong: { provider: "openai", model: "gpt-5.2" } },
      env: {}
    });
    const split = await reloaded.publicView();
    expect(split.models.strong).toEqual({ provider: "openai", model: "gpt-5.2" });
    expect(split.models.strongConfigured).toBe(true);
    expect((await reloaded.effectiveEnv()).ADPILOT_STRONG_MODEL).toBe("gpt-5.2");
  });

  it("persists reasoning settings, merges partial updates, and exports them through env", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-settings-reasoning-"));
    const store = new SettingsStore(root, { ADPILOT_REASONING_EFFORT: "high", ADPILOT_REASONING_SCOPE: "all" });
    // Default is off, and a stored "off" wins over the ambient env.
    const initial = await store.publicView();
    expect(initial.reasoning).toEqual({ effort: "off", scope: "strong" });
    const initialEnv = await store.effectiveEnv();
    expect(initialEnv.ADPILOT_REASONING_EFFORT).toBeUndefined();
    expect(initialEnv.ADPILOT_REASONING_SCOPE).toBeUndefined();

    await store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "openai", model: "gpt-5" } },
      reasoning: { effort: "high", scope: "all" },
      env: {}
    });
    const enabled = await store.effectiveEnv();
    expect(enabled.ADPILOT_REASONING_EFFORT).toBe("high");
    expect(enabled.ADPILOT_REASONING_SCOPE).toBe("all");
    expect((await store.publicView()).reasoning).toEqual({ effort: "high", scope: "all" });

    // Omitted fields keep their stored values across partial updates.
    await store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "openai", model: "gpt-5" } },
      reasoning: { effort: "low" },
      env: {}
    });
    expect((await store.publicView()).reasoning).toEqual({ effort: "low", scope: "all" });
    // Omitting reasoning entirely keeps the stored setting.
    await store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "openai", model: "gpt-5" } },
      env: {}
    });
    expect((await store.publicView()).reasoning).toEqual({ effort: "low", scope: "all" });

    // Turning it off removes the env overrides again, even over an ambient env.
    await store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "openai", model: "gpt-5" } },
      reasoning: { effort: "off" },
      env: {}
    });
    const disabled = await store.effectiveEnv();
    expect(disabled.ADPILOT_REASONING_EFFORT).toBeUndefined();
    expect(disabled.ADPILOT_REASONING_SCOPE).toBeUndefined();

    await expect(store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "openai", model: "gpt-5" } },
      reasoning: { effort: "extreme" as never },
      env: {}
    })).rejects.toThrow();
  });

  it("surfaces custom provider reasoning capability in the catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-settings-reasoning-flag-"));
    const store = new SettingsStore(root, {});
    await store.save({
      locale: "zh-CN", appearance: "dark",
      models: { fast: { provider: "corp-gateway", model: "reasoner" } },
      env: {},
      customProviders: [
        { id: "corp-gateway", name: "Corp Gateway", baseUrl: "https://gateway.corp.example/v1", models: [{ id: "reasoner", reasoning: true }, { id: "plain" }] }
      ]
    });
    const catalog = (await store.publicView()).catalog.providers.find((provider) => provider.id === "corp-gateway");
    expect(catalog?.models).toEqual([
      { id: "reasoner", name: "reasoner", reasoning: true, vision: false, contextWindow: 128000 },
      { id: "plain", name: "plain", reasoning: false, vision: false, contextWindow: 128000 }
    ]);
  });
});
