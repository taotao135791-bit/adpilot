import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { createReadPathGuard, PATH_ESCAPE_MESSAGE, workspaceReadPolicy } from "./path-guard.js";

/**
 * Path-escape matrix for the read-path guard. Every model-supplied path must
 * stay inside the allowed roots minus the denied subtrees, lexically and
 * after symlink resolution; anything else is rejected before any read.
 */
async function makeTree() {
  // Canonicalize the temp root (macOS /var → /private/var) so lexical
  // expectations match the guard's canonical resolution.
  const root = await realpath(await mkdtemp(join(tmpdir(), "adpilot-guard-")));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(join(workspace, "reports"), { recursive: true });
  await mkdir(join(workspace, ".adpilot", "skills", "my-skill"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, "reports", "daily.md"), "# report\n");
  await writeFile(join(workspace, ".adpilot", "approval-secret"), "s3cr3t0123456789abcdef0123456789");
  await writeFile(join(workspace, ".adpilot", "settings.json"), "{}\n");
  await writeFile(join(workspace, ".adpilot", "skills", "my-skill", "SKILL.md"), "---\nname: my-skill\ndescription: test\n---\nbody\n");
  await writeFile(join(outside, "secret.txt"), "outside\n");
  return { root, workspace, outside };
}

describe("read path guard", () => {
  it("resolves relative paths against the primary root and absolute paths inside any allowed root", async () => {
    const { workspace, outside } = await makeTree();
    const guard = createReadPathGuard({ allow: [workspace, outside] });
    expect(await guard.resolve("reports/daily.md")).toBe(resolve(workspace, "reports", "daily.md"));
    expect(await guard.resolve("./reports/../reports/daily.md")).toBe(resolve(workspace, "reports", "daily.md"));
    expect(await guard.resolve(join(outside, "secret.txt"))).toBe(resolve(outside, "secret.txt"));
    expect(await guard.resolve(".")).toBe(resolve(workspace));
  });

  it("rejects every lexical escape shape before touching the filesystem", async () => {
    const { workspace, outside } = await makeTree();
    const guard = createReadPathGuard({ allow: [workspace] });
    const escapes = [
      "../outside/secret.txt",
      "reports/../../outside/secret.txt",
      "..",
      "../..",
      join(outside, "secret.txt"), // absolute path outside every root
      "/etc/passwd",
      `${workspace}${sep}..${sep}outside${sep}secret.txt`,
      "reports/../../../etc/passwd"
    ];
    for (const input of escapes) {
      await expect(guard.resolve(input), input).rejects.toThrow(PATH_ESCAPE_MESSAGE);
    }
  });

  it("rejects symlink escapes that pass the lexical check", async () => {
    const { workspace, outside } = await makeTree();
    await symlink(outside, join(workspace, "linked-out"), "dir");
    await symlink(join(outside, "secret.txt"), join(workspace, "linked-file.txt"), "file");
    const guard = createReadPathGuard({ allow: [workspace] });
    await expect(guard.resolve("linked-out/secret.txt")).rejects.toThrow(PATH_ESCAPE_MESSAGE);
    await expect(guard.resolve("linked-file.txt")).rejects.toThrow(PATH_ESCAPE_MESSAGE);
    // A symlink whose target stays inside the policy remains readable.
    await symlink(join(workspace, "reports"), join(workspace, "linked-reports"), "dir");
    expect(await guard.resolve("linked-reports/daily.md")).toBe(resolve(workspace, "reports", "daily.md"));
  });

  it("applies longest-match-wins: denied private subtree, allowed public skill directory inside it", async () => {
    const { workspace } = await makeTree();
    const guard = createReadPathGuard(workspaceReadPolicy(workspace, [join(workspace, ".adpilot", "skills")]));
    await expect(guard.resolve(".adpilot/approval-secret")).rejects.toThrow(PATH_ESCAPE_MESSAGE);
    await expect(guard.resolve(".adpilot/settings.json")).rejects.toThrow(PATH_ESCAPE_MESSAGE);
    await expect(guard.resolve(".adpilot")).rejects.toThrow(PATH_ESCAPE_MESSAGE);
    expect(await guard.resolve(".adpilot/skills/my-skill/SKILL.md")).toBe(resolve(workspace, ".adpilot", "skills", "my-skill", "SKILL.md"));
    expect(await guard.resolve("reports/daily.md")).toBe(resolve(workspace, "reports", "daily.md"));
  });

  it("resolves non-existent tails inside the policy but still rejects escapes", async () => {
    const { workspace } = await makeTree();
    const guard = createReadPathGuard(workspaceReadPolicy(workspace));
    expect(await guard.resolve("reports/not-yet-written.md")).toBe(resolve(workspace, "reports", "not-yet-written.md"));
    await expect(guard.resolve("../not-there.md")).rejects.toThrow(PATH_ESCAPE_MESSAGE);
  });

  it("rejects empty and NUL-carrying paths outright", async () => {
    const { workspace } = await makeTree();
    const guard = createReadPathGuard({ allow: [workspace] });
    await expect(guard.resolve("")).rejects.toThrow("non-empty");
    await expect(guard.resolve("reports/daily.md\u0000.txt")).rejects.toThrow("non-empty");
  });

  it("describes the readable roots for tool descriptions and errors", async () => {
    const { workspace, outside } = await makeTree();
    const guard = createReadPathGuard({ allow: [workspace, outside], deny: [join(workspace, ".adpilot")] });
    expect(guard.describeRoots()).toContain(resolve(workspace));
    expect(guard.describeRoots()).toContain(resolve(outside));
    expect(guard.describeRoots()).not.toContain(".adpilot");
    expect(guard.isAllowed(resolve(workspace, "reports"))).toBe(true);
    expect(guard.isAllowed(resolve(workspace, ".adpilot", "settings.json"))).toBe(false);
    expect(guard.isAllowed(resolve(outside))).toBe(true);
  });
});
