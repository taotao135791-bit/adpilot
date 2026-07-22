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
});
