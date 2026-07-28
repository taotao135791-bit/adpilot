import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "./index.js";

let roots: string[] = [];

afterEach(async () => {
  delete process.env.ADPILOT_UAC_PYTHON;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-ads-routes-"));
  roots.push(root);
  const system = await createAdPilotSystem({ workspaceRoot: root, env: {} });
  const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
  return { server, system };
}

const QUICK_OPS_EXAMPLE = fileURLToPath(
  new URL("../../advertising-core/python/skills/ads-google-app/assets/UAC-QUICK-OPS.example.yaml", import.meta.url)
);

async function createProject(server: Awaited<ReturnType<typeof boot>>["server"]) {
  const response = await server.inject({
    method: "POST",
    url: "/api/kernel/projects",
    payload: { workspaceId: "personal", name: "Ads project", type: "advertising" }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; workspaceId: string };
}

async function createAccount(server: Awaited<ReturnType<typeof boot>>["server"]) {
  const response = await server.inject({
    method: "POST",
    url: "/api/ads/accounts",
    payload: { workspaceId: "personal", platform: "google", name: "Northwind Google", currency: "USD" }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; workspaceId: string };
}

describe("ads REST routes", () => {
  it("runs accounts → campaigns → decisions → transition → creatives → brief end to end", async () => {
    const { server, system } = await boot();
    const project = await createProject(server);

    const account = await createAccount(server);
    expect(account).toMatchObject({ workspaceId: "personal", platform: "google", name: "Northwind Google" });

    const listedAccounts = await server.inject({ method: "GET", url: "/api/ads/accounts?workspaceId=personal" });
    expect(listedAccounts.statusCode).toBe(200);
    expect(listedAccounts.json().accounts).toHaveLength(1);

    const campaignResponse = await server.inject({
      method: "POST",
      url: "/api/ads/campaigns",
      payload: {
        workspaceId: "personal",
        accountId: account.id,
        name: "UAC Android US",
        objective: "installs",
        budget: 500,
        bid: 2.5,
        status: "enabled"
      }
    });
    expect(campaignResponse.statusCode).toBe(201);
    const campaign = campaignResponse.json() as { id: string };

    const listedCampaigns = await server.inject({
      method: "GET",
      url: `/api/ads/campaigns?workspaceId=personal&accountId=${account.id}`
    });
    expect(listedCampaigns.json().campaigns).toHaveLength(1);

    const decisionResponse = await server.inject({
      method: "POST",
      url: "/api/ads/decisions",
      payload: {
        workspaceId: "personal",
        projectId: project.id,
        campaignId: campaign.id,
        recommendation: "Raise tCPA by 10%",
        rationale: ["CPA below target for 7 days"],
        evidenceIds: ["fact-1", "fact-2"],
        confidence: "medium",
        risks: ["learning reset"],
        observationWindow: "7 days",
        rollbackPlan: "Restore previous tCPA"
      }
    });
    expect(decisionResponse.statusCode).toBe(201);
    const decision = decisionResponse.json() as { id: string; status: string };
    expect(decision.status).toBe("proposed");

    // Duplicate recommendation against an open decision is suppressed.
    const duplicate = await server.inject({
      method: "POST",
      url: "/api/ads/decisions",
      payload: {
        workspaceId: "personal",
        projectId: project.id,
        campaignId: campaign.id,
        recommendation: "Raise tCPA by 10%",
        confidence: "high"
      }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "DECISION_DUPLICATE", decision: { id: decision.id } });

    const similar = await server.inject({
      method: "GET",
      url: `/api/ads/decisions/similar?workspaceId=personal&projectId=${project.id}&campaignId=${campaign.id}&recommendation=${encodeURIComponent("Raise tCPA by 10%")}`
    });
    expect(similar.statusCode).toBe(200);
    expect(similar.json().similar.id).toBe(decision.id);

    // Illegal transition: proposed → observing.
    const illegal = await server.inject({
      method: "POST",
      url: `/api/ads/decisions/${decision.id}/transition`,
      payload: { workspaceId: "personal", status: "observing" }
    });
    expect(illegal.statusCode).toBe(400);
    expect(illegal.json()).toMatchObject({ code: "DECISION_INVALID_TRANSITION" });

    for (const status of ["approved", "executed", "observing", "successful"] as const) {
      const transitioned = await server.inject({
        method: "POST",
        url: `/api/ads/decisions/${decision.id}/transition`,
        payload: { workspaceId: "personal", status }
      });
      expect(transitioned.statusCode).toBe(200);
      expect(transitioned.json()).toMatchObject({ status });
    }

    const listedDecisions = await server.inject({
      method: "GET",
      url: `/api/ads/decisions?workspaceId=personal&projectId=${project.id}`
    });
    expect(listedDecisions.json().decisions).toHaveLength(1);

    const creativeResponse = await server.inject({
      method: "POST",
      url: "/api/ads/creatives",
      payload: {
        workspaceId: "personal",
        accountId: account.id,
        name: "Rewarded video v3",
        platform: "google",
        campaignIds: [campaign.id],
        metrics: { spend: 1_200, ctr: 0.04 },
        lifecycle: "active"
      }
    });
    expect(creativeResponse.statusCode).toBe(201);
    const creative = creativeResponse.json() as { id: string };

    const lifecycle = await server.inject({
      method: "POST",
      url: `/api/ads/creatives/${creative.id}/lifecycle`,
      payload: { workspaceId: "personal", lifecycle: "fatiguing" }
    });
    expect(lifecycle.statusCode).toBe(200);
    expect(lifecycle.json()).toMatchObject({ lifecycle: "fatiguing", revision: 2 });

    const briefResponse = await server.inject({
      method: "POST",
      url: "/api/ads/daily-brief",
      payload: {
        workspaceId: "personal",
        projectId: project.id,
        facts: {
          metrics: {
            accounts: [{ accountId: account.id, spend: 3_000, cpa: 220, evidenceIds: ["fact-spend"] }],
            campaigns: [{ campaignId: campaign.id, learningStatus: "learning", conversionsInLearning: 2 }],
            creatives: []
          },
          measurementIssues: [{ issue: "Firebase dedup window unclear", accountId: account.id }]
        }
      }
    });
    expect(briefResponse.statusCode).toBe(200);
    const brief = briefResponse.json();
    expect(brief.workspaceId).toBe("personal");
    expect(brief.sections.creativeFatigue.map((item: { ruleId: string }) => item.ruleId))
      .toContain("creative_declared_fatiguing");
    expect(brief.sections.learningPhaseRisks).toHaveLength(1);
    expect(brief.sections.measurementIssues).toHaveLength(1);
    // The successful decision is terminal: it appears in neither pending section.
    expect(brief.sections.pendingApprovals).toHaveLength(0);
    expect(brief.sections.pendingObservations).toHaveLength(0);

    const audits = await system.audit.list("personal");
    const actions = audits.map((event) => event.action);
    expect(actions).toContain("ads_decision_transition");
    expect(actions).toContain("ads_daily_brief_generate");
    const transitions = audits.filter((event) => event.action === "ads_decision_transition");
    expect(transitions).toHaveLength(4);
    expect(transitions.at(-1)?.details).toMatchObject({ from: "observing", to: "successful" });
  });

  it("enforces workspace scoping and coded not-found errors", async () => {
    const { server, system } = await boot();
    const project = await createProject(server);
    const account = await createAccount(server);
    // Bring a second workspace into existence so scoping (not workspace
    // existence) is what the assertions below exercise.
    await system.workspace.initializeClient({
      profile: { id: "someone-else", name: "Other" },
      kpi: { primary: "CPA", target: 10 }
    });

    const wrongWorkspaceCampaign = await server.inject({
      method: "GET",
      url: `/api/ads/campaigns?workspaceId=someone-else&accountId=${account.id}`
    });
    expect(wrongWorkspaceCampaign.statusCode).toBe(404);
    expect(wrongWorkspaceCampaign.json()).toMatchObject({ code: "AD_ACCOUNT_NOT_FOUND" });

    const missingProject = await server.inject({
      method: "POST",
      url: "/api/ads/decisions",
      payload: {
        workspaceId: "personal",
        projectId: crypto.randomUUID(),
        recommendation: "x",
        confidence: "low"
      }
    });
    expect(missingProject.statusCode).toBe(404);
    expect(missingProject.json()).toMatchObject({ code: "PROJECT_NOT_FOUND" });

    const crossWorkspace = await server.inject({
      method: "POST",
      url: "/api/ads/decisions",
      payload: {
        workspaceId: "someone-else",
        projectId: project.id,
        recommendation: "x",
        confidence: "low"
      }
    });
    expect(crossWorkspace.statusCode).toBe(404);

    const missingDecision = await server.inject({
      method: "POST",
      url: `/api/ads/decisions/${crypto.randomUUID()}/transition`,
      payload: { workspaceId: "personal", status: "approved" }
    });
    expect(missingDecision.statusCode).toBe(404);
    expect(missingDecision.json()).toMatchObject({ code: "DECISION_NOT_FOUND" });

    const missingCreative = await server.inject({
      method: "POST",
      url: `/api/ads/creatives/${crypto.randomUUID()}/lifecycle`,
      payload: { workspaceId: "personal", lifecycle: "retired" }
    });
    expect(missingCreative.statusCode).toBe(404);
    expect(missingCreative.json()).toMatchObject({ code: "CREATIVE_NOT_FOUND" });
  });

  it("runs the real UAC engine over /api/ads/uac/analyze", async () => {
    const { server } = await boot();
    await createAccount(server);
    const engineCase = parseYaml(await readFile(QUICK_OPS_EXAMPLE, "utf8")) as Record<string, unknown>;
    const response = await server.inject({
      method: "POST",
      url: "/api/ads/uac/analyze",
      payload: { workspaceId: "personal", kind: "decide", case: engineCase }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: "decide" });
    expect(response.json().result.decision.verdict.length).toBeGreaterThan(0);
  });

  it("maps an engine contract failure to 400 UAC_ENGINE_FAILED", async () => {
    const { server } = await boot();
    const response = await server.inject({
      method: "POST",
      url: "/api/ads/uac/analyze",
      payload: { workspaceId: "personal", kind: "analyze", case: { scope: { platform: "meta" } } }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "UAC_ENGINE_FAILED" });
  });

  it("returns 503 UAC_ENGINE_UNAVAILABLE when python3 is missing", async () => {
    process.env.ADPILOT_UAC_PYTHON = "/nonexistent/adpilot-python3";
    const { server } = await boot();
    const response = await server.inject({
      method: "POST",
      url: "/api/ads/uac/analyze",
      payload: { workspaceId: "personal", kind: "analyze", case: {} }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "UAC_ENGINE_UNAVAILABLE" });
  });
});
