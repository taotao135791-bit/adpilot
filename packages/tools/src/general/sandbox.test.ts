import { mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createProtectedPathMatcher } from "./protected-paths.js";
import {
  buildSeatbeltProfile,
  createPrivateSandboxDirectory,
  removePrivateSandboxDirectory,
  resolveSandboxExec,
  sandboxedEnv,
  SANDBOX_EXEC_PATH
} from "./sandbox.js";

async function makeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adpilot-sandbox-")));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const protect = createProtectedPathMatcher({ workspaceRoot: workspace, homeDir: home });
  return { root, workspace, home, protect };
}

describe("resolveSandboxExec (fail-closed availability)", () => {
  it("accepts the platform sandbox-exec only when the binary exists", () => {
    if (process.platform === "darwin") {
      expect(resolveSandboxExec().available).toBe(true);
      expect(resolveSandboxExec().path).toBe(SANDBOX_EXEC_PATH);
    } else {
      const result = resolveSandboxExec();
      expect(result.available).toBe(false);
      expect(result.reason).toContain("no sandbox-exec");
    }
  });

  it("reports a missing binary as unavailable with an actionable reason", () => {
    const result = resolveSandboxExec("/nonexistent/sandbox-exec");
    expect(result.available).toBe(false);
    expect(result.path).toBeNull();
    expect(result.reason ?? "").toMatch(/does not exist|no sandbox-exec/);
  });
});

describe("buildSeatbeltProfile", () => {
  it("denies by default, kills all network, and confines writes to the workspace and temp dirs", async () => {
    const { workspace, home, protect } = await makeFixture();
    const profile = buildSeatbeltProfile({ workspaceRoot: workspace, protect, homeDir: home });
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(deny network*)");
    // Write confinement: the workspace subpath is allowed for writes, the home
    // directory is not a broad write (or read) root — only its protected
    // subtrees appear, inside deny rules.
    const writeBlock = profile.slice(profile.indexOf("(allow file-write*"), profile.indexOf("\n)", profile.indexOf("(allow file-write*")));
    expect(writeBlock).toContain(`(subpath "${workspace}")`);
    expect(writeBlock).not.toContain(home);
    const readBlock = profile.slice(profile.indexOf("(allow file-read*"), profile.indexOf("\n)", profile.indexOf("(allow file-read*")));
    expect(readBlock).toContain(`(subpath "${workspace}")`);
    expect(readBlock).not.toContain(home);
    // dyld's CacheFinder opens the root directory at process startup; without
    // this literal the sandboxed process aborts inside dyld (macOS 26).
    expect(readBlock).toContain('(literal "/")');
  });

  it("denies the protected paths after the broad allows (SBPL last-match-wins ordering)", async () => {
    const { workspace, home, protect } = await makeFixture();
    const profile = buildSeatbeltProfile({ workspaceRoot: workspace, protect, homeDir: home });
    const broadAllow = profile.indexOf("(allow file-read*");
    const adpilotDeny = profile.indexOf(`(deny file-read* file-write* (subpath "${resolve(workspace, ".adpilot")}"))`);
    const skillsReallow = profile.indexOf(resolve(workspace, ".adpilot", "skills"));
    expect(broadAllow).toBeGreaterThan(-1);
    expect(adpilotDeny).toBeGreaterThan(broadAllow);
    expect(skillsReallow).toBeGreaterThan(adpilotDeny);
    // Browser profile stores and credential stores are denied, .env/audit by regex.
    expect(profile).toContain(`(deny file-read* file-write* (subpath "${resolve(workspace, "browser-profiles")}"))`);
    expect(profile).toContain(`(deny file-read* file-write* (subpath "${resolve(home, "Library", "Safari")}"))`);
    expect(profile).toContain(`/\\.env[^/]*$`);
    expect(profile).toContain(`audit\\.jsonl$`);
  });

  it("keeps screencapture and osascript out of the sandboxed process table", async () => {
    const { workspace, home, protect } = await makeFixture();
    const profile = buildSeatbeltProfile({ workspaceRoot: workspace, protect, homeDir: home });
    expect(profile).toContain('(deny process-exec (literal "/usr/sbin/screencapture") (literal "/usr/bin/osascript"))');
  });

  it("uses only the explicit private temp and denies GUI launch for an isolated shell", async () => {
    const { workspace, home, protect } = await makeFixture();
    const isolatedTemp = await createPrivateSandboxDirectory();
    try {
      const profile = buildSeatbeltProfile({
        workspaceRoot: workspace,
        protect,
        homeDir: home,
        isolatedTempDir: isolatedTemp,
        denyGuiLaunch: true
      });
      expect(profile).toContain(`(subpath "${isolatedTemp}")`);
      expect(profile).not.toContain('(subpath "/tmp")');
      expect(profile).not.toContain('(subpath "/private/tmp")');
      expect(profile).toContain('(literal "/usr/bin/open")');
    } finally {
      await removePrivateSandboxDirectory(isolatedTemp);
    }
  });

  it("escapes quotes and backslashes in interpolated paths", async () => {
    const { workspace, home, protect } = await makeFixture();
    const weird = `${workspace}/quo"te`;
    const profile = buildSeatbeltProfile({ workspaceRoot: weird, protect, homeDir: home });
    expect(profile).toContain('quo\\"te');
    expect(profile).not.toContain('quo"te"');
  });
});

describe("sandboxedEnv", () => {
  it("strips every secret of the host process and keeps an allowlist", () => {
    const env = sandboxedEnv({
      HOME: "/home/tester",
      USER: "tester",
      TMPDIR: "/tmp/x",
      OPENAI_API_KEY: "sk-live",
      ANTHROPIC_API_KEY: "sk-ant",
      ADPILOT_APPROVAL_SECRET: "s3cr3t",
      AWS_SECRET_ACCESS_KEY: "aws",
      PATH: "/usr/bin"
    });
    expect(env.PATH).toContain("/usr/bin");
    expect(env.HOME).toBe("/home/tester");
    expect(env.USER).toBe("tester");
    for (const leaked of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ADPILOT_APPROVAL_SECRET", "AWS_SECRET_ACCESS_KEY"]) {
      expect(env[leaked], leaked).toBeUndefined();
    }
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "SHELL", "TERM", "TMPDIR", "USER"].sort());
  });

  it("creates a 0700 private home and removes it safely", async () => {
    const privateHome = await createPrivateSandboxDirectory();
    expect((await stat(privateHome)).mode & 0o777).toBe(0o700);
    expect(sandboxedEnv({}, privateHome)).toMatchObject({ HOME: privateHome, TMPDIR: privateHome });
    await removePrivateSandboxDirectory(privateHome);
    await expect(stat(privateHome)).rejects.toThrow();
  });
});
