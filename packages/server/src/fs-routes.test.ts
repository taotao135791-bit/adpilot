import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "./index.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fs REST routes", () => {
  it("serves a bounded directory tree with node_modules/.git excluded", async () => {
    const { server, projectRoot } = await boot();
    await mkdir(join(projectRoot, "src", "nested"), { recursive: true });
    await mkdir(join(projectRoot, "node_modules", "dep"), { recursive: true });
    await mkdir(join(projectRoot, ".git", "objects"), { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "hello\n");
    await writeFile(join(projectRoot, "src", "index.ts"), "export {};\n");
    await writeFile(join(projectRoot, "node_modules", "dep", "index.js"), "x\n");

    const response = await server.inject({ method: "GET", url: `/api/fs/tree?root=${encodeURIComponent(projectRoot)}&depth=2` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { root: string; truncated: boolean; entries: Array<{ name: string; kind: string; children?: unknown[] }> };
    expect(body.truncated).toBe(false);
    const names = body.entries.map((entry) => entry.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    const src = body.entries.find((entry) => entry.name === "src");
    expect(src?.kind).toBe("directory");
    expect(src?.children?.length).toBeGreaterThan(0);
  });

  it("expands ~ for the tree root and rejects missing roots", async () => {
    const { server } = await boot();
    const home = await server.inject({ method: "GET", url: "/api/fs/tree?root=~&depth=0" });
    expect(home.statusCode).toBe(200);
    expect((home.json() as { root: string }).root).not.toContain("~");
    const missing = await server.inject({ method: "GET", url: "/api/fs/tree?root=/definitely/not/here" });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { code?: string }).code).toBe("FS_ROOT_INVALID");
  });

  it("reads small text files and refuses binary or oversized ones", async () => {
    const { server, projectRoot } = await boot();
    await writeFile(join(projectRoot, "note.txt"), "你好 AdPilot\n");
    await writeFile(join(projectRoot, "blob.bin"), Buffer.from([0, 1, 2, 3]));

    const text = await server.inject({ method: "GET", url: `/api/fs/file?path=${encodeURIComponent(join(projectRoot, "note.txt"))}` });
    expect(text.statusCode).toBe(200);
    expect((text.json() as { content: string }).content).toBe("你好 AdPilot\n");

    const binary = await server.inject({ method: "GET", url: `/api/fs/file?path=${encodeURIComponent(join(projectRoot, "blob.bin"))}` });
    expect(binary.statusCode).toBe(400);
    expect((binary.json() as { code?: string }).code).toBe("FS_FILE_BINARY");

    const missing = await server.inject({ method: "GET", url: `/api/fs/file?path=${encodeURIComponent(join(projectRoot, "gone.txt"))}` });
    expect(missing.statusCode).toBe(404);
  });

  it("exposes the user skill catalog for the Skills view", async () => {
    const { server, homeRoot } = await boot();
    await mkdir(join(homeRoot, "skills", "demo"), { recursive: true });
    await writeFile(
      join(homeRoot, "skills", "demo", "SKILL.md"),
      "---\nname: demo-skill\ndescription: A demo skill for tests\n---\n\nBody text.\n"
    );
    const response = await server.inject({ method: "GET", url: "/api/skills" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { skills: Array<{ name: string; source: string }>; warnings: unknown[] };
    const found = body.skills.find((skill) => skill.name === "demo-skill");
    expect(found).toBeDefined();
    expect(body.warnings).toEqual([]);
  });
});

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-fs-routes-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const homeRoot = join(root, "home");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(homeRoot, { recursive: true });
  const system = await createAdPilotSystem({ workspaceRoot: root, env: { ADPILOT_HOME: homeRoot } });
  const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
  return { server, projectRoot, homeRoot };
}
