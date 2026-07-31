import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "./index.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project → session → message binding", () => {
  it("shadows every kernel project into the session-service under the same id", async () => {
    const { server, system } = await boot();
    const created = await server.inject({
      method: "POST",
      url: "/api/kernel/projects",
      payload: { workspaceId: "personal", name: "Shadow check" }
    });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    const shadow = await system.sessions.getProject(project.id);
    expect(shadow).toMatchObject({ id: project.id, clientId: "personal", name: "Shadow check" });
    // Explicit-id creation is conflict-safe with a coded error.
    await expect(
      system.sessions.createProject({ id: project.id, clientId: "personal", name: "duplicate" })
    ).rejects.toMatchObject({ code: "PROJECT_EXISTS" });
    // The shadow unlocks project-bound sessions (same-client project check).
    const session = await system.sessions.create({ clientId: "personal", projectId: project.id, title: "bound" });
    expect(session.projectId).toBe(project.id);
  });

  it("ensures a project session idempotently and links it into the kernel project", async () => {
    const { server, system } = await boot();
    const project = (await server.inject({
      method: "POST",
      url: "/api/kernel/projects",
      payload: { workspaceId: "personal", name: "Binding" }
    })).json();

    const first = await server.inject({
      method: "POST",
      url: `/api/kernel/projects/${project.id}/session`,
      payload: { workspaceId: "personal" }
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);
    const sessionId = first.json().session.id;
    expect(first.json().session).toMatchObject({ clientId: "personal", projectId: project.id, title: "Binding" });

    // Resume: the second ensure returns the same session.
    const second = await server.inject({
      method: "POST",
      url: `/api/kernel/projects/${project.id}/session`,
      payload: { workspaceId: "personal" }
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ created: false, session: { id: sessionId } });

    // "New session" forces a fresh binding for the same project.
    const third = await server.inject({
      method: "POST",
      url: `/api/kernel/projects/${project.id}/session`,
      payload: { workspaceId: "personal", force: true }
    });
    expect(third.statusCode).toBe(201);
    expect(third.json().session.id).not.toBe(sessionId);
    expect(third.json().session.projectId).toBe(project.id);

    // The kernel project links every created session id.
    const reloaded = await system.kernel.getProject(project.id);
    expect(reloaded?.sessionIds).toEqual(expect.arrayContaining([sessionId, third.json().session.id]));

    // Cross-workspace access stays rejected.
    const alien = await server.inject({
      method: "POST",
      url: `/api/kernel/projects/${project.id}/session`,
      payload: { workspaceId: "someone-else" }
    });
    expect(alien.statusCode).toBe(400);
  });

  it("threads the execution context into agent.respond and returns session + projectId", async () => {
    const { server, system } = await boot();
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "adpilot-bound-project-")));
    roots.push(projectRoot);
    const project = (await server.inject({
      method: "POST",
      url: "/api/kernel/projects",
      payload: { workspaceId: "personal", name: "Context", rootPaths: [projectRoot], enabledCapabilityPacks: ["ads"] }
    })).json();
    const calls: { clientId: string; prompt: string; context: Record<string, unknown> }[] = [];
    system.agent.respond = async (clientId: string, prompt: string, context: Record<string, unknown> = {}) => {
      calls.push({ clientId, prompt, context });
      return { reply: "项目内回复", task: null };
    };

    const response = await server.inject({
      method: "POST",
      url: "/api/messages",
      payload: { clientId: "personal", projectId: project.id, message: "你好", locale: "zh-CN" }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.projectId).toBe(project.id);
    expect(body.session).toMatchObject({ clientId: "personal", projectId: project.id });
    expect(body.message).toMatchObject({ role: "assistant", content: "项目内回复" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.context.executionContext).toEqual({
      projectId: project.id,
      rootPaths: [projectRoot],
      enabledCapabilityPacks: ["ads"]
    });
    expect(calls[0]?.context.sessionId).toBe(body.session.id);

    // Follow-up with the explicit bound session keeps the same session and
    // threads goal/task ids through the execution context.
    const goal = await system.kernel.createGoal({ projectId: project.id, title: "g", objective: "o" });
    const followUp = await server.inject({
      method: "POST",
      url: "/api/messages",
      payload: {
        clientId: "personal",
        projectId: project.id,
        sessionId: body.session.id,
        goalId: goal.id,
        message: "继续",
        locale: "zh-CN"
      }
    });
    expect(followUp.statusCode).toBe(201);
    expect(followUp.json().session.id).toBe(body.session.id);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.context.executionContext).toMatchObject({ projectId: project.id, goalId: goal.id });
    expect((calls[1]?.context.executionContext as Record<string, unknown>).taskId).toBeUndefined();

    // A project from another workspace rejects the binding.
    const mismatch = await server.inject({
      method: "POST",
      url: "/api/messages",
      payload: { clientId: "someone-else", projectId: project.id, message: "x" }
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().code).toBe("PROJECT_CLIENT_MISMATCH");
  });

  it("rejects a session bound to another project with 409", async () => {
    const { server } = await boot();
    const projectA = (await server.inject({
      method: "POST",
      url: "/api/kernel/projects",
      payload: { workspaceId: "personal", name: "A" }
    })).json();
    const projectB = (await server.inject({
      method: "POST",
      url: "/api/kernel/projects",
      payload: { workspaceId: "personal", name: "B" }
    })).json();
    const sessionA = (await server.inject({
      method: "POST",
      url: `/api/kernel/projects/${projectA.id}/session`,
      payload: { workspaceId: "personal" }
    })).json().session;

    const conflict = await server.inject({
      method: "POST",
      url: "/api/messages",
      payload: { clientId: "personal", projectId: projectB.id, sessionId: sessionA.id, message: "不匹配" }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("SESSION_PROJECT_MISMATCH");
  });

  it("triages missions: small talk stays plain, long or keyword missions create a goal", async () => {
    const { server } = await boot();
    const project = (await server.inject({
      method: "POST",
      url: "/api/kernel/projects",
      payload: { workspaceId: "personal", name: "Missions" }
    })).json();
    const mission = (message: string) => server.inject({
      method: "POST",
      url: `/api/kernel/projects/${project.id}/mission`,
      payload: { workspaceId: "personal", message }
    });

    const smallTalk = await mission("今天天气怎么样");
    expect(smallTalk.statusCode).toBe(200);
    expect(smallTalk.json()).toEqual({});

    const keyword = await mission("帮我修复登陆页按钮错位的问题");
    expect(keyword.statusCode).toBe(201);
    expect(keyword.json().goalId).toBeTruthy();
    expect(keyword.json().taskId).toBeTruthy();

    const longMessage = "把项目里所有过期的依赖都升级一遍然后跑全量测试确认没有回归再整理成一份升级清单发给我审阅之后顺手把锁文件也一并提交上去并且通知相关同学检查各自负责的模块是否受到这次改动影响";
    expect(longMessage.length).toBeGreaterThanOrEqual(80);
    const long = await mission(longMessage);
    expect(long.statusCode).toBe(201);

    const detail = (await server.inject({
      method: "GET",
      url: `/api/kernel/projects/${project.id}?workspaceId=personal`
    })).json();
    expect(detail.goals).toHaveLength(2);
    expect(detail.goals[0]).toMatchObject({ title: "帮我修复登陆页按钮错位的问题", objective: "帮我修复登陆页按钮错位的问题" });
    expect(detail.goals[1]).toMatchObject({ title: longMessage.slice(0, 80), objective: longMessage });
    // Each goal carries exactly one initial planning task.
    expect(detail.tasks).toHaveLength(2);
    expect(detail.tasks[0]).toMatchObject({ goalId: detail.goals[0].id, title: "规划执行路径" });
    expect(detail.tasks[1]).toMatchObject({ goalId: detail.goals[1].id, title: "规划执行路径" });
  });
});

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-project-binding-"));
  roots.push(root);
  const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
  const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
  return { server, system };
}
