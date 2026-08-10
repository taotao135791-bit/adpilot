import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdPilotSystem, type AdPilotSystem } from "@adpilot/application";
import { createServer } from "./index.js";
import { TerminalService } from "./terminal-service.js";

type Server = Awaited<ReturnType<typeof createServer>>;

interface Scope {
  clientId: string;
  projectId: string;
  root: string;
}

interface Chunk {
  seq: number;
  ts: number;
  stream: "stdout" | "stderr";
  data: string;
}

let roots: string[] = [];
let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("terminal REST routes", () => {
  it("installs the interactive cwd guard without zsh startup diagnostics", async () => {
    const { server, system } = await boot();
    const scope = await createProjectScope(system);
    const session = (await createSession(server, scope)).body;

    await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: "echo guard-ready\n" }
    });
    expect(
      await waitForChunks(
        server,
        session.id,
        scope,
        (chunks) => chunks.some((chunk) => chunk.data.includes("guard-ready"))
      )
    ).toBe(true);

    const output = (await server.inject({
      method: "GET",
      url: scoped(`/api/terminals/${session.id}/output`, scope)
    })).json() as { chunks: Chunk[] };
    expect(output.chunks.map((chunk) => chunk.data).join("\n")).not.toContain("bad option: -r");
  });

  it("runs safe project-root commands, streams interactive IO, interrupts and kills", async () => {
    const { server, system } = await boot();
    const scope = await createProjectScope(system);

    const created = await createSession(server, scope, "ops");
    expect(created.response.statusCode).toBe(201);
    const session = created.body;
    expect(session).toMatchObject({
      cwd: scope.root,
      title: "ops",
      running: true,
      exitCode: null
    });

    // Positive safe-command path: read-only commands run without approval.
    const execResult = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/exec`, scope),
      payload: { command: "echo exec-hello && pwd" }
    });
    expect(execResult.statusCode).toBe(200);
    expect(execResult.json()).toMatchObject({ exitCode: 0, timedOut: false });
    expect(execResult.json().stdout).toContain("exec-hello");
    expect(execResult.json().stdout).toContain(scope.root);

    // An approved write and a cwd change may persist only inside the root.
    const mkdirResult = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/exec`, scope),
      payload: { command: "mkdir sub", approved: true }
    });
    expect(mkdirResult.statusCode).toBe(200);
    const moved = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/exec`, scope),
      payload: { command: "cd sub", approved: true }
    });
    expect(moved.json().exitCode).toBe(0);
    const pwd = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/exec`, scope),
      payload: { command: "pwd" }
    });
    expect(pwd.json().stdout.trim()).toBe(join(scope.root, "sub"));

    // Interactive input remains user-driven, while carrying the same scope.
    await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: "read answer; printf 'got:%s\\n' \"$answer\"\n", approved: true }
    });
    await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: "hello-terminal\n", approved: true }
    });
    expect(
      await waitForChunks(
        server,
        session.id,
        scope,
        (chunks) => chunks.some((chunk) => chunk.data.includes("got:hello-terminal"))
      )
    ).toBe(true);

    const all = (
      await server.inject({
        method: "GET",
        url: scoped(`/api/terminals/${session.id}/output`, scope)
      })
    ).json();
    expect(all.chunks.length).toBeGreaterThan(0);
    expect(all.running).toBe(true);
    const lastSeq = all.chunks[all.chunks.length - 1].seq as number;
    const none = (
      await server.inject({
        method: "GET",
        url: scoped(`/api/terminals/${session.id}/output`, scope, { since: lastSeq })
      })
    ).json();
    expect(none.chunks).toHaveLength(0);
    await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: "echo incremental-marker\n" }
    });
    expect(
      await waitForChunks(
        server,
        session.id,
        scope,
        (chunks) => chunks.some(
          (chunk) => chunk.data.includes("incremental-marker") && chunk.seq > lastSeq
        ),
        lastSeq
      )
    ).toBe(true);

    await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: "sleep 30\n", approved: true }
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const interrupted = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/interrupt`, scope)
    });
    expect(interrupted.statusCode).toBe(200);
    await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: "echo status-$?\n", approved: true }
    });
    expect(
      await waitForChunks(
        server,
        session.id,
        scope,
        (chunks) => chunks.some((chunk) => chunk.data.includes("status-130"))
      )
    ).toBe(true);

    const killed = await server.inject({
      method: "DELETE",
      url: scoped(`/api/terminals/${session.id}`, scope)
    });
    expect(killed.statusCode).toBe(200);
    const listed = (
      await server.inject({ method: "GET", url: scoped("/api/terminals", scope) })
    ).json();
    expect(listed.sessions.some((candidate: { id: string }) => candidate.id === session.id)).toBe(false);
    const goneOutput = await server.inject({
      method: "GET",
      url: scoped(`/api/terminals/${session.id}/output`, scope)
    });
    expect(goneOutput.statusCode).toBe(404);
    expect(goneOutput.json().code).toBe("TERMINAL_NOT_FOUND");
  });

  it("never runs deny-classified commands, even with approved true or interactive input", async () => {
    const { server, system } = await boot();
    const scope = await createProjectScope(system);
    const target = join(scope.root, "doomed");
    await mkdir(target);
    const session = (await createSession(server, scope)).body;

    const approved = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/exec`, scope),
      payload: { command: `rm -rf "${target}"`, approved: true }
    });
    expect(approved.statusCode).toBe(403);
    expect(approved.json()).toMatchObject({ code: "COMMAND_DENIED" });
    expect(approved.json().classification).toMatchObject({ verdict: "deny" });
    expect((await stat(target)).isDirectory()).toBe(true);

    const interactive = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: `rm -rf "${target}"\n` }
    });
    expect(interactive.statusCode).toBe(403);
    expect(interactive.json()).toMatchObject({ code: "COMMAND_DENIED" });
    expect((await stat(target)).isDirectory()).toBe(true);

    // A shell line continuation cannot split a denied program name across
    // requests and bypass classification.
    const partial = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: "r\\\n" }
    });
    expect(partial.statusCode).toBe(200);
    const completed = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: `m -rf "${target}"\n` }
    });
    expect(completed.statusCode).toBe(403);
    expect(completed.json()).toMatchObject({ code: "COMMAND_DENIED" });
    expect((await stat(target)).isDirectory()).toBe(true);

    // Raw REST writes are byte chunks, not command boundaries. Holding the
    // first byte until a newline means the shell never sees a reconstructed
    // denied command that the classifier did not inspect as a whole.
    const ordinaryPartial = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: "r" }
    });
    expect(ordinaryPartial.statusCode).toBe(200);
    const ordinaryCompleted = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: `m -rf "${target}"\n`, approved: true }
    });
    expect(ordinaryCompleted.statusCode).toBe(403);
    expect(ordinaryCompleted.json()).toMatchObject({ code: "COMMAND_DENIED" });
    expect((await stat(target)).isDirectory()).toBe(true);

    const guiLaunch = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: "open https://example.com\n", approved: true }
    });
    expect(guiLaunch.statusCode).toBe(403);
    expect(guiLaunch.json()).toMatchObject({
      code: "COMMAND_DENIED",
      classification: { verdict: "deny" }
    });
  });

  it("requires 409 confirmation before forwarding write-classified interactive input", async () => {
    const { server, system } = await boot();
    const scope = await createProjectScope(system);
    const session = (await createSession(server, scope)).body;
    const marker = join(scope.root, "interactive-approved.txt");
    const command = "printf x >> interactive-approved.txt\n";

    const pending = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: command }
    });
    expect(pending.statusCode).toBe(409);
    expect(pending.json()).toMatchObject({
      code: "COMMAND_APPROVAL_REQUIRED",
      classification: { verdict: "write" }
    });
    await expect(stat(marker)).rejects.toThrow();

    const approved = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: command, approved: true }
    });
    expect(approved.statusCode).toBe(200);
    expect(await waitForFile(marker)).toBe(true);
    // The rejected pending buffer was cleared before the retry, so the
    // approved command runs exactly once rather than being concatenated.
    expect(await readFile(marker, "utf8")).toBe("x");
  });

  it("uses distinct 0700 temp homes and denies another client sentinel", async () => {
    const { server, system } = await boot();
    await system.workspace.initializeClient({
      profile: { id: "client-b", name: "Client B", industry: "test", timezone: "UTC" },
      kpi: { primary: "CPA", target: 1, currency: "USD" }
    });
    const scopeA = await createProjectScope(system);
    const scopeB = await createProjectScope(system, "client-b");
    const sessionA = (await createSession(server, scopeA)).body;
    const sessionB = (await createSession(server, scopeB)).body;

    const homeA = (await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${sessionA.id}/exec`, scopeA),
      payload: { command: "printf '%s' \"$HOME\"", approved: true }
    })).json().stdout.trim() as string;
    const homeB = (await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${sessionB.id}/exec`, scopeB),
      payload: { command: "printf '%s' \"$HOME\"", approved: true }
    })).json().stdout.trim() as string;
    expect(homeA).not.toBe(homeB);
    expect((await stat(homeA)).mode & 0o777).toBe(0o700);
    expect((await stat(homeB)).mode & 0o777).toBe(0o700);

    const sentinel = join(homeA, "client-a-sentinel.txt");
    await writeFile(sentinel, "client-a-private\n", { mode: 0o600 });
    const crossClientRead = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${sessionB.id}/exec`, scopeB),
      payload: { command: `cat '${sentinel}'` }
    });
    expect(crossClientRead.statusCode).toBe(200);
    expect(crossClientRead.json().exitCode).not.toBe(0);
    expect(crossClientRead.json().stdout).not.toContain("client-a-private");

    const ownRead = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${sessionA.id}/exec`, scopeA),
      payload: { command: `cat '${sentinel}'` }
    });
    expect(ownRead.json()).toMatchObject({ exitCode: 0 });
    expect(ownRead.json().stdout).toContain("client-a-private");

    await server.inject({ method: "DELETE", url: scoped(`/api/terminals/${sessionA.id}`, scopeA) });
    await expect(stat(homeA)).rejects.toThrow();
    expect((await stat(homeB)).isDirectory()).toBe(true);
  });

  it("cannot attach a terminal across a client, project, or canonical project root", async () => {
    const { server, system } = await boot();
    const rootA = await tempDir();
    const rootB = await tempDir();
    const projectA = await system.kernel.createProject({
      workspaceId: "personal",
      name: "A",
      rootPaths: [rootA, rootB]
    });
    const scopeA = { clientId: "personal", projectId: projectA.id, root: rootA };
    const session = (await createSession(server, scopeA)).body;

    const crossRoot = await server.inject({
      method: "GET",
      url: scoped(`/api/terminals/${session.id}/output`, { ...scopeA, root: rootB })
    });
    expect(crossRoot.statusCode).toBe(404);
    expect(crossRoot.json().code).toBe("TERMINAL_NOT_FOUND");

    const projectB = await system.kernel.createProject({
      workspaceId: "personal",
      name: "B",
      rootPaths: [rootA]
    });
    const crossProject = await server.inject({
      method: "GET",
      url: scoped(`/api/terminals/${session.id}/output`, {
        clientId: "personal",
        projectId: projectB.id,
        root: rootA
      })
    });
    expect(crossProject.statusCode).toBe(404);
    expect(crossProject.json().code).toBe("TERMINAL_NOT_FOUND");

    await system.workspace.initializeClient({
      profile: {
        id: "client-b",
        name: "Client B",
        industry: "test",
        timezone: "UTC"
      },
      kpi: { primary: "CPA", target: 1, currency: "USD" }
    });
    const projectC = await system.kernel.createProject({
      workspaceId: "client-b",
      name: "C",
      rootPaths: [rootA]
    });
    const crossClient = await server.inject({
      method: "GET",
      url: scoped(`/api/terminals/${session.id}/output`, {
        clientId: "client-b",
        projectId: projectC.id,
        root: rootA
      })
    });
    expect(crossClient.statusCode).toBe(404);
    expect(crossClient.json().code).toBe("TERMINAL_NOT_FOUND");

    const unrelated = await tempDir();
    const arbitraryCwd = await server.inject({
      method: "POST",
      url: "/api/terminals",
      payload: {
        clientId: scopeA.clientId,
        projectId: scopeA.projectId,
        cwd: unrelated
      }
    });
    expect(arbitraryCwd.statusCode).toBe(400);
    expect(arbitraryCwd.json().code).toBe("TERMINAL_CWD_INVALID");
  });

  it("rejects a one-shot cwd escape and returns interactive cd to the root", async () => {
    const { server, system } = await boot();
    const scope = await createProjectScope(system);
    const session = (await createSession(server, scope)).body;

    const escaped = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/exec`, scope),
      payload: { command: "cd ..", approved: true }
    });
    expect(escaped.statusCode).toBe(400);
    expect(escaped.json().code).toBe("TERMINAL_CWD_ESCAPE");

    const stillPinned = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/exec`, scope),
      payload: { command: "pwd" }
    });
    expect(stillPinned.json().stdout.trim()).toBe(scope.root);

    await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: "cd ..; pwd\n", approved: true }
    });
    expect(
      await waitForChunks(
        server,
        session.id,
        scope,
        (chunks) => chunks.some((chunk) => chunk.data.includes("blocked terminal cwd escape"))
          && chunks.some((chunk) => chunk.data.includes(scope.root))
      )
    ).toBe(true);
  });

  it("times out a hanging exec instead of blocking forever", async () => {
    const { server, system } = await boot();
    const scope = await createProjectScope(system);
    const session = (await createSession(server, scope)).body;
    const result = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/exec`, scope),
      payload: { command: "sleep 30", timeoutMs: 500, approved: true }
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().timedOut).toBe(true);
    expect(result.json().durationMs).toBeLessThan(10_000);
    const echo = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/exec`, scope),
      payload: { command: "echo still-alive" }
    });
    expect(echo.json()).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it("rejects input and exec once the shell exited", async () => {
    const { server, system } = await boot();
    const scope = await createProjectScope(system);
    const session = (await createSession(server, scope)).body;
    await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: "exit\n", approved: true }
    });
    const deadline = Date.now() + 8_000;
    let running = true;
    while (Date.now() < deadline && running) {
      const listed = (
        await server.inject({ method: "GET", url: scoped("/api/terminals", scope) })
      ).json();
      running = listed.sessions.find(
        (candidate: { id: string }) => candidate.id === session.id
      )?.running ?? false;
      if (running) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(running).toBe(false);

    const write = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/input`, scope),
      payload: { data: "echo nope\n" }
    });
    expect(write.statusCode).toBe(400);
    expect(write.json().code).toBe("TERMINAL_EXITED");

    const exec = await server.inject({
      method: "POST",
      url: scoped(`/api/terminals/${session.id}/exec`, scope),
      payload: { command: "echo nope" }
    });
    expect(exec.statusCode).toBe(400);
    expect(exec.json().code).toBe("TERMINAL_EXITED");
  });

  it("rejects a missing project root with a coded 400", async () => {
    const { server, system } = await boot();
    const scope = await createProjectScope(system);
    const response = await server.inject({
      method: "POST",
      url: "/api/terminals",
      payload: {
        clientId: scope.clientId,
        projectId: scope.projectId,
        cwd: join(scope.root, "missing")
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("TERMINAL_CWD_INVALID");
  });

  it("rejects filesystem, home, and volume roots as terminal boundaries", async () => {
    const { server, system } = await boot();
    const project = await system.kernel.createProject({
      workspaceId: "personal",
      name: "Unsafe root fixture",
      rootPaths: ["/"]
    });
    const terminal = await server.inject({
      method: "POST",
      url: "/api/terminals",
      payload: { clientId: "personal", projectId: project.id, cwd: "/" }
    });
    expect(terminal.statusCode).toBe(400);
    expect(terminal.json()).toMatchObject({ code: "TERMINAL_CWD_INVALID" });

    for (const root of ["/", homedir(), "/Users", "/Applications", "/System", "/private/tmp", "/Volumes"]) {
      if (!(await stat(root).catch(() => null))?.isDirectory()) continue;
      const response = await server.inject({
        method: "POST",
        url: "/api/kernel/projects",
        payload: {
          workspaceId: "personal",
          name: "Unsafe project root",
          type: "development",
          rootPaths: [root]
        }
      });
      expect(response.statusCode, root).toBe(400);
      expect(response.json(), root).toMatchObject({ code: "PROJECT_ROOT_INVALID" });
    }
  });

  it("also rejects broad roots when coding tools call TerminalService directly", async () => {
    const service = new TerminalService();
    await expect(service.create({ cwd: homedir() })).rejects.toMatchObject({
      code: "TERMINAL_CWD_INVALID"
    });
    await expect(service.exec({ cwd: "/" }, "pwd")).rejects.toMatchObject({
      code: "TERMINAL_CWD_INVALID"
    });
    await service.shutdown();
  });
});

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-terminal-routes-"));
  roots.push(root);
  const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
  const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
  servers.push(server);
  return { server, system };
}

async function createProjectScope(
  system: AdPilotSystem,
  clientId = "personal"
): Promise<Scope> {
  const root = await tempDir();
  const project = await system.kernel.createProject({
    workspaceId: clientId,
    name: "Terminal project",
    rootPaths: [root]
  });
  return { clientId, projectId: project.id, root };
}

async function createSession(server: Server, scope: Scope, title?: string) {
  const response = await server.inject({
    method: "POST",
    url: "/api/terminals",
    payload: {
      clientId: scope.clientId,
      projectId: scope.projectId,
      cwd: scope.root,
      ...(title ? { title } : {})
    }
  });
  return { response, body: response.json() };
}

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "adpilot-terminal-dir-")));
  roots.push(dir);
  return dir;
}

function scoped(
  path: string,
  scope: Scope,
  extra: Record<string, string | number> = {}
): string {
  const search = new URLSearchParams({
    clientId: scope.clientId,
    projectId: scope.projectId,
    root: scope.root
  });
  for (const [key, value] of Object.entries(extra)) search.set(key, String(value));
  return `${path}?${search.toString()}`;
}

async function waitForChunks(
  server: Server,
  id: string,
  scope: Scope,
  predicate: (chunks: Chunk[]) => boolean,
  since?: number
): Promise<boolean> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const response = await server.inject({
      method: "GET",
      url: scoped(
        `/api/terminals/${id}/output`,
        scope,
        since !== undefined ? { since } : {}
      )
    });
    if (response.statusCode === 200 && predicate(response.json().chunks)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForFile(path: string): Promise<boolean> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if ((await stat(path).catch(() => null))?.isFile()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
