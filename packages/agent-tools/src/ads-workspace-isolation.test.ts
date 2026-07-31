import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdAccount,
  CampaignEntity,
  CreativeAsset
} from "@adpilot/ads-intelligence";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionContext } from "./context.js";
import type { AgentToolDeps } from "./deps.js";
import { buildAgentToolRegistry } from "./index.js";
import { runAgentToolCall } from "./lifecycle.js";
import type { AgentToolResult } from "./result.js";
import { makeCtx, makeTestDeps } from "./testing.js";

const registry = buildAgentToolRegistry();
const roots: string[] = [];
const terminals: Array<{ shutdown(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(terminals.splice(0).map((terminal) => terminal.shutdown().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-ads-isolation-"));
  roots.push(root);
  const fixture = makeTestDeps(root);
  terminals.push(fixture.terminal);
  const projectA = await fixture.kernel.createProject({ workspaceId: "workspace-a", name: "A" });
  const projectB = await fixture.kernel.createProject({ workspaceId: "workspace-b", name: "B" });
  const now = "2026-07-29T00:00:00.000Z";
  const accountA = AdAccount.parse({
    id: randomUUID(),
    workspaceId: "workspace-a",
    platform: "google",
    name: "Account A",
    createdAt: now,
    updatedAt: now,
    revision: 1
  });
  const accountB = AdAccount.parse({
    id: randomUUID(),
    workspaceId: "workspace-b",
    platform: "meta",
    name: "Account B",
    createdAt: now,
    updatedAt: now,
    revision: 1
  });
  await fixture.deps.ads.stores!.accounts!.save(accountA);
  await fixture.deps.ads.stores!.accounts!.save(accountB);
  const campaignA = CampaignEntity.parse({
    id: randomUUID(),
    accountId: accountA.id,
    name: "Campaign A",
    createdAt: now,
    updatedAt: now,
    revision: 1
  });
  const campaignB = CampaignEntity.parse({
    id: randomUUID(),
    accountId: accountB.id,
    name: "Campaign B",
    createdAt: now,
    updatedAt: now,
    revision: 1
  });
  await fixture.deps.ads.stores!.campaigns!.save(campaignA);
  await fixture.deps.ads.stores!.campaigns!.save(campaignB);
  const creativeA = CreativeAsset.parse({
    id: randomUUID(),
    accountId: accountA.id,
    campaignIds: [campaignA.id],
    name: "Creative A",
    platform: "google",
    lifecycle: "active",
    createdAt: now,
    updatedAt: now,
    revision: 1
  });
  const creativeB = CreativeAsset.parse({
    id: randomUUID(),
    accountId: accountB.id,
    campaignIds: [campaignB.id],
    name: "Creative B",
    platform: "meta",
    lifecycle: "fatiguing",
    createdAt: now,
    updatedAt: now,
    revision: 1
  });
  await fixture.deps.ads.stores!.creatives!.save(creativeA);
  await fixture.deps.ads.stores!.creatives!.save(creativeB);
  return {
    ...fixture,
    projectA,
    projectB,
    accountA,
    accountB,
    campaignA,
    campaignB,
    creativeA,
    creativeB
  };
}

async function call(
  name: string,
  params: unknown,
  context: AgentExecutionContext,
  deps: AgentToolDeps
): Promise<AgentToolResult> {
  const definition = registry.get(name);
  if (!definition) throw new Error(`tool not registered: ${name}`);
  return runAgentToolCall(definition, params, context, deps);
}

describe("ads Agent tool workspace isolation", () => {
  it("lists and briefs only entities derived from accounts in ctx.workspaceId", async () => {
    const fixture = await boot();
    const context = makeCtx({
      workspaceId: "workspace-a",
      projectId: fixture.projectA.id
    });

    const accounts = await call("ads.list_accounts", {}, context, fixture.deps);
    expect(accounts.success).toBe(true);
    expect((accounts.data as { accounts: Array<{ id: string }> }).accounts.map((account) => account.id))
      .toEqual([fixture.accountA.id]);

    const campaigns = await call("ads.list_campaigns", {}, context, fixture.deps);
    expect(campaigns.success).toBe(true);
    expect((campaigns.data as { campaigns: Array<{ id: string }> }).campaigns.map((campaign) => campaign.id))
      .toEqual([fixture.campaignA.id]);

    const foreignAccount = await call(
      "ads.list_campaigns",
      { accountId: fixture.accountB.id },
      context,
      fixture.deps
    );
    expect(foreignAccount.error).toMatchObject({ code: "AD_ACCOUNT_NOT_FOUND" });

    // The foreign creative is marked fatiguing; an unscoped brief would expose
    // it as a finding. A workspace-scoped brief stays empty.
    const brief = await call("ads.generate_daily_brief", {}, context, fixture.deps);
    expect(brief.success).toBe(true);
    expect((brief.data as {
      brief: { sections: { creativeFatigue: unknown[] } };
    }).brief.sections.creativeFatigue).toEqual([]);

    const foreignMetric = await call("ads.generate_daily_brief", {
      metrics: {
        accounts: [{ accountId: fixture.accountB.id, spend: 100 }],
        campaigns: [],
        creatives: []
      }
    }, context, fixture.deps);
    expect(foreignMetric.error).toMatchObject({ code: "ADS_REFERENCE_NOT_FOUND" });

    const foreignIssue = await call("ads.generate_daily_brief", {
      measurementIssues: [{
        issue: "foreign campaign",
        campaignId: fixture.campaignB.id
      }]
    }, context, fixture.deps);
    expect(foreignIssue.error).toMatchObject({ code: "ADS_REFERENCE_NOT_FOUND" });
  });

  it("rejects foreign project, campaign, decision evidence, and observation references", async () => {
    const fixture = await boot();
    const context = makeCtx({
      workspaceId: "workspace-a",
      projectId: fixture.projectA.id
    });
    const foreignDecision = await fixture.deps.ads.decisions.createDecision({
      projectId: fixture.projectB.id,
      campaignId: fixture.campaignB.id,
      recommendation: "Foreign recommendation",
      confidence: "low"
    });

    const foreignProject = await call("ads.create_decision", {
      projectId: fixture.projectB.id,
      recommendation: "Cross project",
      confidence: "low"
    }, context, fixture.deps);
    expect(foreignProject.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });

    const foreignCampaign = await call("ads.create_decision", {
      campaignId: fixture.campaignB.id,
      recommendation: "Cross campaign",
      confidence: "low"
    }, context, fixture.deps);
    expect(foreignCampaign.error).toMatchObject({ code: "CAMPAIGN_NOT_FOUND" });

    const foreignEvidence = await call("ads.create_decision", {
      recommendation: "Cross evidence",
      confidence: "low",
      evidenceIds: [`decision:${foreignDecision.id}`]
    }, context, fixture.deps);
    expect(foreignEvidence.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });

    const foreignObservation = await call("ads.record_observation", {
      subject: `campaign:${fixture.campaignB.id}`,
      detail: "Must not enter workspace A"
    }, context, fixture.deps);
    expect(foreignObservation.error).toMatchObject({ code: "CAMPAIGN_NOT_FOUND" });

    const created = await call("ads.create_decision", {
      campaignId: fixture.campaignA.id,
      recommendation: "Owned recommendation",
      confidence: "medium",
      evidenceIds: [
        `campaign:${fixture.campaignA.id}`,
        "screenshot:opaque-workspace-ledger-id"
      ]
    }, context, fixture.deps);
    expect(created.success).toBe(true);
  });

  it("fails every ads entry point closed when ctx.projectId belongs to another workspace", async () => {
    const fixture = await boot();
    const foreignContext = makeCtx({
      workspaceId: "workspace-a",
      projectId: fixture.projectB.id
    });
    for (const [name, params] of [
      ["ads.list_accounts", {}],
      ["ads.list_campaigns", {}],
      ["ads.run_uac_analysis", { kind: "analyze", case: {} }],
      ["ads.generate_daily_brief", {}],
      ["ads.record_observation", { subject: "account health", detail: "check" }]
    ] as const) {
      const result = await call(name, params, foreignContext, fixture.deps);
      expect(result.error, name).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    }
  });

  it("fails closed when ownership stores are unavailable instead of returning an empty registry", async () => {
    const fixture = await boot();
    const context = makeCtx({
      workspaceId: "workspace-a",
      projectId: fixture.projectA.id
    });
    const accounts = fixture.deps.ads.stores?.accounts;
    if (!accounts) throw new Error("test account store is unavailable");
    fixture.deps.ads.stores = { accounts };

    const campaigns = await call("ads.list_campaigns", {}, context, fixture.deps);
    expect(campaigns.error).toMatchObject({ code: "STORE_NOT_CONFIGURED" });
    const brief = await call("ads.generate_daily_brief", {}, context, fixture.deps);
    expect(brief.error).toMatchObject({ code: "STORE_NOT_CONFIGURED" });
  });
});
