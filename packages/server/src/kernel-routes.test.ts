import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "./index.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("kernel REST routes", () => {
  it("runs the project → goal → task graph → artifact render flow end to end", async () => {
    const { server } = await boot();

    const created = await server.inject({
      method: "POST",
      url: "/api/kernel/projects",
      payload: {
        workspaceId: "personal",
        name: "Northwind 投放",
        type: "advertising",
        rootPaths: ["/tmp/ads"],
        enabledCapabilityPacks: ["ads"]
      }
    });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project).toMatchObject({ workspaceId: "personal", name: "Northwind 投放", type: "advertising", rootPaths: ["/tmp/ads"] });

    const goalResponse = await server.inject({
      method: "POST",
      url: "/api/kernel/goals",
      payload: {
        projectId: project.id,
        title: "美国 Android 付费成本稳定在 100 美元以内",
        objective: "CPA ≤ 100 且日消耗 ≥ 500 连续 7 天",
        successCriteria: ["CPA ≤ 100", "daily spend ≥ 500 for 7 days"],
        constraints: ["不修改 Firebase 事件配置"],
        verificationPlan: ["每日读取成本与消耗"]
      }
    });
    expect(goalResponse.statusCode).toBe(201);
    const goal = goalResponse.json();

    const taskA = (await server.inject({
      method: "POST",
      url: "/api/kernel/tasks",
      payload: { goalId: goal.id, title: "读取账户结构" }
    })).json();
    const taskB = (await server.inject({
      method: "POST",
      url: "/api/kernel/tasks",
      payload: { goalId: goal.id, title: "汇总成本", dependencies: [taskA.id] }
    })).json();

    const readyBefore = await server.inject({
      method: "GET",
      url: `/api/kernel/tasks?workspaceId=personal&goalId=${goal.id}&ready=true`
    });
    expect(readyBefore.json().tasks.map((task: { id: string }) => task.id)).toEqual([taskA.id]);

    const completed = await server.inject({ method: "POST", url: `/api/kernel/tasks/${taskA.id}/complete` });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().unlocked.map((task: { id: string }) => task.id)).toEqual([taskB.id]);

    const progress = await server.inject({
      method: "PATCH",
      url: `/api/kernel/goals/${goal.id}`,
      payload: { progress: 0.4, status: "active" }
    });
    expect(progress.json()).toMatchObject({ progress: 0.4, status: "active" });

    const artifact = await server.inject({
      method: "POST",
      url: "/api/kernel/artifacts",
      payload: {
        projectId: project.id,
        type: "slides",
        title: "投放日报",
        spec: {
          title: "投放日报",
          slides: [
            { layout: "title", heading: "投放日报", subheading: "2026-07-28" },
            { layout: "bullets", heading: "今日结论", bullets: ["CPA 稳定", "消耗达标"] }
          ]
        }
      }
    });
    expect(artifact.statusCode).toBe(201);
    const record = artifact.json();
    expect(record).toMatchObject({ type: "slides", title: "投放日报", status: "ready", version: 1 });

    const detail = await server.inject({
      method: "GET",
      url: `/api/kernel/projects/${project.id}?workspaceId=personal`
    });
    expect(detail.statusCode).toBe(200);
    const expanded = detail.json();
    expect(expanded.goals).toHaveLength(1);
    expect(expanded.tasks).toHaveLength(2);
    expect(expanded.artifacts).toHaveLength(1);

    const output = await server.inject({
      method: "GET",
      url: `/api/kernel/artifacts/${record.id}/output/v1/slides.pptx?workspaceId=personal`
    });
    expect(output.statusCode).toBe(200);
    expect(output.headers["content-type"]).toContain("presentationml");
    expect(output.rawPayload.byteLength).toBeGreaterThan(1_000);

    const crossWorkspace = await server.inject({
      method: "GET",
      url: `/api/kernel/projects/${project.id}?workspaceId=someone-else`
    });
    expect(crossWorkspace.statusCode).toBe(400);
  });

  it("rejects invalid specs and missing parents with coded errors", async () => {
    const { server } = await boot();
    const project = (await server.inject({
      method: "POST",
      url: "/api/kernel/projects",
      payload: { workspaceId: "personal", name: "Spec validation", type: "general" }
    })).json();
    const badSpec = await server.inject({
      method: "POST",
      url: "/api/kernel/artifacts",
      payload: {
        projectId: project.id,
        type: "slides",
        title: "x",
        spec: { title: "x", slides: [{ layout: "unknown" }] }
      }
    });
    expect(badSpec.statusCode).toBe(400);
    const missingProject = await server.inject({
      method: "POST",
      url: "/api/kernel/artifacts",
      payload: {
        projectId: crypto.randomUUID(),
        type: "slides",
        title: "x",
        spec: { title: "x", slides: [{ layout: "title", heading: "x" }] }
      }
    });
    expect(missingProject.statusCode).toBe(404);
    const missingGoal = await server.inject({
      method: "POST",
      url: "/api/kernel/tasks",
      payload: { goalId: crypto.randomUUID(), title: "dangling" }
    });
    expect(missingGoal.statusCode).toBe(404);
    expect(missingGoal.json()).toMatchObject({ code: "GOAL_NOT_FOUND" });
  });
});

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-kernel-routes-"));
  roots.push(root);
  const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
  const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
  return { server, system };
}
