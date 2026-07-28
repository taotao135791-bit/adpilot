import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "./index.js";

type Server = Awaited<ReturnType<typeof createServer>>;

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
  it("creates sessions, execs with cwd continuity, streams interactive IO, interrupts and kills", async () => {
    const { server } = await boot();
    // The service canonicalizes cwd via realpath (/var → /private/var on macOS).
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "adpilot-terminal-cwd-")));
    roots.push(cwd);

    const created = await server.inject({
      method: "POST",
      url: "/api/terminals",
      payload: { cwd, title: "ops" }
    });
    expect(created.statusCode).toBe(201);
    const session = created.json();
    expect(session).toMatchObject({ cwd, title: "ops", running: true, exitCode: null });

    // One-shot exec through the session shell: exit code, stdout and cwd.
    const execResult = await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/exec`,
      payload: { command: "echo exec-hello && pwd" }
    });
    expect(execResult.statusCode).toBe(200);
    expect(execResult.json()).toMatchObject({ exitCode: 0, timedOut: false });
    expect(execResult.json().stdout).toContain("exec-hello");
    expect(execResult.json().stdout).toContain(cwd);

    // cwd continuity: an approved cd persists into later exec calls.
    await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/exec`,
      payload: { command: "mkdir sub", approved: true }
    });
    const moved = await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/exec`,
      payload: { command: "cd sub", approved: true }
    });
    expect(moved.json().exitCode).toBe(0);
    const pwd = await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/exec`,
      payload: { command: "pwd" }
    });
    expect(pwd.json().stdout.trim()).toBe(join(cwd, "sub"));

    // Interactive write: the shell reads a line from stdin and prints it back.
    await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/input`,
      payload: { data: "read answer; printf 'got:%s\\n' \"$answer\"\n" }
    });
    await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/input`,
      payload: { data: "hello-terminal\n" }
    });
    expect(
      await waitForChunks(server, session.id, (chunks) => chunks.some((chunk) => chunk.data.includes("got:hello-terminal")))
    ).toBe(true);

    // Incremental reads: since=<lastSeq> starts empty, then only new chunks arrive.
    const all = (await server.inject({ method: "GET", url: `/api/terminals/${session.id}/output` })).json();
    expect(all.chunks.length).toBeGreaterThan(0);
    expect(all.running).toBe(true);
    const lastSeq = all.chunks[all.chunks.length - 1].seq as number;
    const none = (await server.inject({ method: "GET", url: `/api/terminals/${session.id}/output?since=${lastSeq}` })).json();
    expect(none.chunks).toHaveLength(0);
    await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/input`,
      payload: { data: "echo incremental-marker\n" }
    });
    expect(
      await waitForChunks(
        server,
        session.id,
        (chunks) => chunks.some((chunk) => chunk.data.includes("incremental-marker") && chunk.seq > lastSeq),
        lastSeq
      )
    ).toBe(true);

    // Interrupt: SIGINT to the process group kills the foreground sleep, the
    // interactive shell survives and reports exit status 130.
    await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/input`,
      payload: { data: "sleep 30\n" }
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const interrupted = await server.inject({ method: "POST", url: `/api/terminals/${session.id}/interrupt` });
    expect(interrupted.statusCode).toBe(200);
    await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/input`,
      payload: { data: "echo status-$?\n" }
    });
    expect(
      await waitForChunks(server, session.id, (chunks) => chunks.some((chunk) => chunk.data.includes("status-130")))
    ).toBe(true);

    // Kill: SIGTERM (SIGKILL after grace), removed from the listing.
    const killed = await server.inject({ method: "DELETE", url: `/api/terminals/${session.id}` });
    expect(killed.statusCode).toBe(200);
    const listed = (await server.inject({ method: "GET", url: "/api/terminals" })).json();
    expect(listed.sessions.some((candidate: { id: string }) => candidate.id === session.id)).toBe(false);
    const goneOutput = await server.inject({ method: "GET", url: `/api/terminals/${session.id}/output` });
    expect(goneOutput.statusCode).toBe(404);
    expect(goneOutput.json().code).toBe("TERMINAL_NOT_FOUND");
  });

  it("rejects destructive exec without approval and never runs it", async () => {
    const { server } = await boot();
    const cwd = await mkdtemp(join(tmpdir(), "adpilot-terminal-gate-"));
    roots.push(cwd);
    const target = join(cwd, "doomed");
    await mkdir(target);
    const session = (
      await server.inject({ method: "POST", url: "/api/terminals", payload: { cwd } })
    ).json();

    const denied = await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/exec`,
      payload: { command: `rm -rf "${target}"` }
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ code: "COMMAND_APPROVAL_REQUIRED" });
    expect(denied.json().classification).toMatchObject({ verdict: "deny" });
    expect((await stat(target)).isDirectory()).toBe(true); // not executed

    const approved = await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/exec`,
      payload: { command: `rm -rf "${target}"`, approved: true }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().exitCode).toBe(0);
    expect(await stat(target).catch(() => null)).toBeNull();
  });

  it("times out a hanging exec instead of blocking forever", async () => {
    const { server } = await boot();
    const session = (
      await server.inject({ method: "POST", url: "/api/terminals", payload: { cwd: await tempDir() } })
    ).json();
    const result = await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/exec`,
      payload: { command: "sleep 30", timeoutMs: 500, approved: true }
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().timedOut).toBe(true);
    expect(result.json().durationMs).toBeLessThan(10_000);
    // The session itself stays alive and usable afterwards.
    const echo = await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/exec`,
      payload: { command: "echo still-alive" }
    });
    expect(echo.json()).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it("rejects input and exec once the shell exited", async () => {
    const { server } = await boot();
    const session = (
      await server.inject({ method: "POST", url: "/api/terminals", payload: { cwd: await tempDir() } })
    ).json();
    await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/input`,
      payload: { data: "exit\n" }
    });
    const deadline = Date.now() + 8_000;
    let running = true;
    while (Date.now() < deadline && running) {
      const listed = (await server.inject({ method: "GET", url: "/api/terminals" })).json();
      running = listed.sessions.find((candidate: { id: string }) => candidate.id === session.id)?.running ?? false;
      if (running) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(running).toBe(false);

    const write = await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/input`,
      payload: { data: "echo nope\n" }
    });
    expect(write.statusCode).toBe(400);
    expect(write.json().code).toBe("TERMINAL_EXITED");

    const exec = await server.inject({
      method: "POST",
      url: `/api/terminals/${session.id}/exec`,
      payload: { command: "echo nope" }
    });
    expect(exec.statusCode).toBe(400);
    expect(exec.json().code).toBe("TERMINAL_EXITED");
  });

  it("rejects a missing cwd with a coded 400", async () => {
    const { server } = await boot();
    const base = await tempDir();
    const response = await server.inject({
      method: "POST",
      url: "/api/terminals",
      payload: { cwd: join(base, "missing") }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("TERMINAL_CWD_INVALID");
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

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "adpilot-terminal-dir-"));
  roots.push(dir);
  return dir;
}

async function waitForChunks(
  server: Server,
  id: string,
  predicate: (chunks: Chunk[]) => boolean,
  since?: number
): Promise<boolean> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const url = since !== undefined
      ? `/api/terminals/${id}/output?since=${since}`
      : `/api/terminals/${id}/output`;
    const response = await server.inject({ method: "GET", url });
    if (response.statusCode === 200 && predicate(response.json().chunks)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
