import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createReadPathGuard, workspaceReadPolicy, workspaceWritePolicy } from "./path-guard.js";
import { createProtectedPathMatcher, PROTECTED_PATH_MESSAGE } from "./protected-paths.js";
import { createReadTool } from "./read.js";
import { createGrepTool } from "./grep.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";

/**
 * Protected paths must hold on BOTH sides of the tool surface: the
 * read/write/edit path guard (this file) and the bash command classifier
 * (covered by packages/shared/src/bash-classifier.test.ts). The denial is
 * absolute — reads included, no approval exception — and every side reports
 * the same PROTECTED_PATH_MESSAGE prefix.
 */
async function makeWorkspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adpilot-protected-")));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(join(workspace, "reports"), { recursive: true });
  await mkdir(join(workspace, "clients", "client-a"), { recursive: true });
  await mkdir(join(workspace, ".adpilot", "skills", "my-skill"), { recursive: true });
  await mkdir(join(workspace, "browser-profiles", "client-a-google"), { recursive: true });
  await mkdir(join(home, "Library", "Application Support", "Google", "Chrome", "Default"), { recursive: true });
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(workspace, "reports", "daily.md"), "# report\nCPA: 4.20\n");
  await writeFile(join(workspace, ".env"), "OPENAI_API_KEY=sk-live\n");
  await writeFile(join(workspace, ".env.local"), "TOKEN=abc\n");
  await writeFile(join(workspace, "clients", "client-a", "audit.jsonl"), '{"seq":1}\n');
  await writeFile(join(workspace, ".adpilot", "approval-secret"), "s3cr3t0123456789abcdef0123456789");
  await writeFile(join(workspace, ".adpilot", "pi-auth.json"), '{"key":"x"}\n');
  await writeFile(join(workspace, ".adpilot", "skills", "my-skill", "SKILL.md"), "---\nname: my-skill\n---\nbody\n");
  await writeFile(join(workspace, "browser-profiles", "client-a-google", "Cookies"), "cookie-db\n");
  await writeFile(join(workspace, "server.pem"), "-----BEGIN\n");
  await writeFile(join(home, ".ssh", "id_rsa"), "private-key\n");
  await writeFile(join(home, "Library", "Application Support", "Google", "Chrome", "Default", "Cookies"), "cookies\n");
  return { root, workspace, home };
}

describe("protected path matcher", () => {
  it("matches the approval secret, provider credentials, settings and the audit chain", async () => {
    const { workspace, home } = await makeWorkspace();
    const matcher = createProtectedPathMatcher({ workspaceRoot: workspace, homeDir: home });
    expect(matcher.match(resolve(workspace, ".adpilot", "approval-secret"))).toBe("approval_secret");
    expect(matcher.match(resolve(workspace, ".adpilot", "pi-auth.json"))).toBe("provider_credentials");
    expect(matcher.match(resolve(workspace, ".adpilot", "settings.json"))).toBe("settings_credentials");
    expect(matcher.match(resolve(workspace, "clients", "client-a", "audit.jsonl"))).toBe("audit_chain");
  });

  it("matches .env files, key material and credential stores wherever they live", async () => {
    const { workspace, home } = await makeWorkspace();
    const matcher = createProtectedPathMatcher({ workspaceRoot: workspace, homeDir: home });
    expect(matcher.match(resolve(workspace, ".env"))).toBe("env_file");
    expect(matcher.match(resolve(workspace, ".env.local"))).toBe("env_file");
    expect(matcher.match(resolve(workspace, "reports", ".env.production"))).toBe("env_file");
    expect(matcher.match(resolve(workspace, "server.pem"))).toBe("key_material");
    expect(matcher.match(resolve(home, ".ssh", "id_rsa"))).toBe("credential_store");
    expect(matcher.match(resolve(home, ".aws", "credentials"))).toBe("credential_store");
    // Basename rules still fire outside the injected home (defense in depth).
    expect(matcher.match("/other/machine/id_ed25519")).toBe("ssh_material");
  });

  it("matches workspace and macOS browser profile/cookie stores", async () => {
    const { workspace, home } = await makeWorkspace();
    const matcher = createProtectedPathMatcher({ workspaceRoot: workspace, homeDir: home });
    expect(matcher.match(resolve(workspace, "browser-profiles", "client-a-google", "Cookies"))).toBe("managed_browser_profile");
    expect(matcher.match(resolve(workspace, "browser-sessions", "session.json"))).toBe("browser_session_state");
    expect(matcher.match(resolve(home, "Library", "Application Support", "Google", "Chrome", "Default", "Cookies"))).toBe("browser_profile_store");
    expect(matcher.match(resolve(home, "Library", "Safari", "Cookies.plist"))).toBe("browser_profile_store");
    expect(matcher.match(resolve(home, "Library", "Cookies", "Cookies.binarycookies"))).toBe("browser_profile_store");
  });

  it("leaves ordinary workspace files and the public skill subtree unprotected", async () => {
    const { workspace, home } = await makeWorkspace();
    const matcher = createProtectedPathMatcher({ workspaceRoot: workspace, homeDir: home });
    expect(matcher.match(resolve(workspace, "reports", "daily.md"))).toBeNull();
    expect(matcher.match(resolve(workspace, "environment-notes.md"))).toBeNull();
    expect(matcher.match(resolve(workspace, ".adpilot", "skills", "my-skill", "SKILL.md"))).toBeNull();
    expect(matcher.deniedFiles()).toContain(resolve(workspace, ".adpilot", "approval-secret"));
    expect(matcher.deniedPrefixes()).toContain(resolve(workspace, "browser-profiles"));
  });
});

describe("protected paths on the path-guard side", () => {
  it("denies protected reads with the unified message even inside the allowed root", async () => {
    const { workspace, home } = await makeWorkspace();
    const guard = createReadPathGuard(workspaceReadPolicy(workspace, [join(workspace, ".adpilot", "skills")], home));
    const protectedReads: Array<[string, string]> = [
      [".env", "env_file"],
      [".env.local", "env_file"],
      ["clients/client-a/audit.jsonl", "audit_chain"],
      ["server.pem", "key_material"],
      ["browser-profiles/client-a-google/Cookies", "managed_browser_profile"]
    ];
    for (const [input, rule] of protectedReads) {
      await expect(guard.resolve(input), input).rejects.toThrow(PROTECTED_PATH_MESSAGE);
      expect(guard.protection(resolve(workspace, ...input.split("/"))), input).toBe(rule);
      expect(guard.isAllowed(resolve(workspace, ...input.split("/"))), input).toBe(false);
    }
    // The private .adpilot subtree is already denied by the guard's deny rule;
    // the matcher still reports its rule for the unified audit trail.
    await expect(guard.resolve(".adpilot/pi-auth.json")).rejects.toThrow("outside the readable roots");
    expect(guard.protection(resolve(workspace, ".adpilot", "pi-auth.json"))).toBe("provider_credentials");
    // Ordinary files and the public skill subtree still resolve.
    expect(await guard.resolve("reports/daily.md")).toBe(resolve(workspace, "reports", "daily.md"));
    expect(await guard.resolve(".adpilot/skills/my-skill/SKILL.md")).toContain("SKILL.md");
  });

  it("denies protected writes on the write guard with the same message", async () => {
    const { workspace, home } = await makeWorkspace();
    const writeGuard = createReadPathGuard(workspaceWritePolicy(workspace, home));
    for (const input of [".env", "clients/client-a/audit.jsonl", "browser-profiles/x/Cookies", ".adpilot/approval-secret"]) {
      await expect(writeGuard.resolve(input), input).rejects.toThrow(/protected by AdPilot policy|outside the readable roots/);
    }
    // The write guard never widens to the read-only skill exception.
    await expect(writeGuard.resolve(".adpilot/skills/my-skill/SKILL.md")).rejects.toThrow("outside the readable roots");
  });

  it("keeps protected file contents out of the read and grep tools end to end", async () => {
    const { workspace, home } = await makeWorkspace();
    const guard = createReadPathGuard(workspaceReadPolicy(workspace, [], home));
    const read = createReadTool(guard);
    const grep = createGrepTool(guard);
    const run = (tool: unknown, params: Record<string, unknown>) =>
      (tool as { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text?: string }> }> }).execute("c", params);
    await expect(run(read, { path: ".env" })).rejects.toThrow(PROTECTED_PATH_MESSAGE);
    await expect(run(read, { path: "clients/client-a/audit.jsonl" })).rejects.toThrow(PROTECTED_PATH_MESSAGE);
    await expect(run(read, { path: ".adpilot/approval-secret" })).rejects.toThrow(/protected by AdPilot policy|outside the readable roots/);
    // The walkers report protected entries as not allowed, so grep never sees the secret content.
    const result = await run(grep, { pattern: "sk-live" });
    expect(result.content.map((item) => item.text ?? "").join("\n")).toBe("No matches found");
  });

  it("blocks the write and edit tools before a byte is touched", async () => {
    const { workspace, home } = await makeWorkspace();
    const writeGuard = createReadPathGuard(workspaceWritePolicy(workspace, home));
    const write = createWriteTool(writeGuard);
    const edit = createEditTool(writeGuard);
    const run = (tool: unknown, params: Record<string, unknown>) =>
      (tool as { execute: (id: string, params: unknown) => Promise<unknown> }).execute("c", params);
    await expect(run(write, { path: ".env", content: "x" })).rejects.toThrow(PROTECTED_PATH_MESSAGE);
    await expect(run(write, { path: "clients/client-a/audit.jsonl", content: "x" })).rejects.toThrow(PROTECTED_PATH_MESSAGE);
    await expect(run(edit, { path: ".env", edits: [{ oldText: "OPENAI_API_KEY=sk-live", newText: "REDACTED" }] })).rejects.toThrow(PROTECTED_PATH_MESSAGE);
    await expect(run(edit, { path: ".adpilot/approval-secret", edits: [{ oldText: "s3cr3t", newText: "forged" }] })).rejects.toThrow(/protected by AdPilot policy|outside the readable roots/);
  });
});
