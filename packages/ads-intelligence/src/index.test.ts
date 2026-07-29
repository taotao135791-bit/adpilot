import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdAccount,
  AdvertisingDecision,
  CreativeAsset,
  DailyBriefService,
  DecisionService,
  FileAdAccountStore,
  FileAdvertisingDecisionStore,
  FileCreativeAssetStore,
  PythonUacEngine,
  UAC_ENGINE_FAILED,
  UAC_ENGINE_UNAVAILABLE,
  UAC_OUTPUT_INVALID,
  hashRecommendation,
  type AdAccount as AdAccountValue,
  type AdvertisingDecision as AdvertisingDecisionValue,
  type CreativeAsset as CreativeAssetValue
} from "./index.js";
import { AdsIntelligenceError } from "./errors.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const QUICK_OPS_EXAMPLE = fileURLToPath(
  new URL("../../../packages/advertising-core/python/skills/ads-google-app/assets/UAC-QUICK-OPS.example.yaml", import.meta.url)
);
const ANALYZE_EXAMPLE = fileURLToPath(
  new URL("../../../packages/advertising-core/python/skills/ads-google-app/assets/UAC-INPUT.example.yaml", import.meta.url)
);

async function loadYamlCase(path: string): Promise<Record<string, unknown>> {
  return parseYaml(await readFile(path, "utf8")) as Record<string, unknown>;
}

function sampleAccount(id: string, workspaceId = "personal"): AdAccountValue {
  const now = new Date().toISOString();
  return AdAccount.parse({
    id,
    workspaceId,
    platform: "google",
    name: "Northwind Google",
    currency: "USD",
    createdAt: now,
    updatedAt: now,
    revision: 1
  });
}

function sampleDecision(id: string, projectId: string, overrides: Record<string, unknown> = {}): AdvertisingDecisionValue {
  const now = new Date().toISOString();
  return AdvertisingDecision.parse({
    id,
    projectId,
    recommendation: "Raise tCPA by 10%",
    confidence: "medium",
    status: "proposed",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    ...overrides
  });
}

describe("DecisionService", () => {
  const projectId = crypto.randomUUID();
  const existingProject = async (id: string) => id === projectId;

  async function boot() {
    const root = await tempRoot("adpilot-ads-decisions-");
    const store = new FileAdvertisingDecisionStore(root);
    const service = new DecisionService(store, existingProject);
    return { root, store, service };
  }

  it("creates a decision in proposed status and walks the legal chain", async () => {
    const { service } = await boot();
    const created = await service.createDecision({
      projectId,
      recommendation: "Raise tCPA by 10%",
      rationale: ["CPA below target for 7 days"],
      evidenceIds: ["fact-1"],
      confidence: "medium",
      risks: ["learning reset"],
      observationWindow: "7 days",
      rollbackPlan: "Restore previous tCPA"
    });
    expect(created.status).toBe("proposed");
    expect(created.revision).toBe(1);

    const approved = await service.transitionStatus(created.id, "approved");
    const executed = await service.transitionStatus(created.id, "executed");
    const observing = await service.transitionStatus(created.id, "observing");
    const successful = await service.transitionStatus(created.id, "successful");
    expect([approved.status, executed.status, observing.status, successful.status])
      .toEqual(["approved", "executed", "observing", "successful"]);
    expect(successful.revision).toBe(5);
  });

  it("rejects illegal transitions with a coded error", async () => {
    const { service } = await boot();
    const created = await service.createDecision({
      projectId,
      recommendation: "Pause campaign",
      confidence: "low"
    });
    await expect(service.transitionStatus(created.id, "observing")).rejects.toMatchObject({
      code: "DECISION_INVALID_TRANSITION"
    });
    await expect(service.transitionStatus(created.id, "executed")).rejects.toMatchObject({
      code: "DECISION_INVALID_TRANSITION"
    });
    await service.transitionStatus(created.id, "approved");
    await service.transitionStatus(created.id, "executed");
    await service.transitionStatus(created.id, "observing");
    await service.transitionStatus(created.id, "failed");
    await expect(service.transitionStatus(created.id, "reverted")).rejects.toMatchObject({
      code: "DECISION_INVALID_TRANSITION"
    });
    await expect(service.transitionStatus(crypto.randomUUID(), "approved")).rejects.toMatchObject({
      code: "DECISION_NOT_FOUND"
    });
  });

  it("lets a reviewer reject a proposed or approved decision as failed", async () => {
    const { service } = await boot();
    const proposed = await service.createDecision({
      projectId,
      recommendation: "Raise budget 20%",
      confidence: "medium"
    });
    const rejected = await service.transitionStatus(proposed.id, "failed");
    expect(rejected.status).toBe("failed");

    const approved = await service.createDecision({
      projectId,
      recommendation: "Switch bid strategy",
      confidence: "low"
    });
    await service.transitionStatus(approved.id, "approved");
    const withdrawn = await service.transitionStatus(approved.id, "failed");
    expect(withdrawn.status).toBe("failed");
  });

  it("rejects creation against a missing project", async () => {
    const { service } = await boot();
    await expect(service.createDecision({
      projectId: crypto.randomUUID(),
      recommendation: "x",
      confidence: "low"
    })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("suppresses duplicate open recommendations via findSimilarOpen", async () => {
    const { service } = await boot();
    const campaignId = crypto.randomUUID();
    const created = await service.createDecision({
      projectId,
      campaignId,
      recommendation: "Raise tCPA by 10%",
      confidence: "medium"
    });
    const hash = hashRecommendation("Raise tCPA by 10%");
    expect((await service.findSimilarOpen(projectId, campaignId, hash))?.id).toBe(created.id);
    // A different campaign or different recommendation does not collide.
    expect(await service.findSimilarOpen(projectId, crypto.randomUUID(), hash)).toBeUndefined();
    expect(await service.findSimilarOpen(projectId, campaignId, hashRecommendation("other"))).toBeUndefined();
    // Terminal decisions no longer occupy the recommendation slot.
    await service.transitionStatus(created.id, "approved");
    await service.transitionStatus(created.id, "executed");
    await service.transitionStatus(created.id, "observing");
    expect((await service.findSimilarOpen(projectId, campaignId, hash))?.id).toBe(created.id);
    await service.transitionStatus(created.id, "reverted");
    expect(await service.findSimilarOpen(projectId, campaignId, hash)).toBeUndefined();
  });

  it("lists decisions by project and by status", async () => {
    const { service } = await boot();
    const otherProject = crypto.randomUUID();
    const a = await service.createDecision({ projectId, recommendation: "a", confidence: "low" });
    await service.createDecision({ projectId, recommendation: "b", confidence: "low" });
    const byProject = await service.listByProject(projectId);
    expect(byProject.map((decision) => decision.recommendation)).toEqual(["a", "b"]);
    await service.transitionStatus(a.id, "approved");
    const approved = await service.listByStatus("approved");
    expect(approved.map((decision) => decision.id)).toContain(a.id);
    expect((await service.listByProject(otherProject)).length).toBe(0);
  });
});

describe("File stores", () => {
  it("persists atomically with private permissions and no leftover temp files", async () => {
    const root = await tempRoot("adpilot-ads-store-");
    const store = new FileAdAccountStore(root);
    const account = sampleAccount(crypto.randomUUID());
    await store.save(account);
    const readBack = await store.get(account.id);
    expect(readBack).toEqual(account);
    const directory = (await import("node:fs/promises")).readdir(store.directory);
    const names = await directory;
    expect(names).toEqual([`${account.id}.json`]);
    const fileMode = (await stat(join(store.directory, `${account.id}.json`))).mode & 0o777;
    const dirMode = (await stat(store.directory)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
    // Revision-bump overwrite goes through the same atomic path.
    const updated = AdAccount.parse({ ...account, name: "Renamed", revision: 2, updatedAt: new Date().toISOString() });
    await store.save(updated);
    expect((await store.get(account.id))?.name).toBe("Renamed");
    expect(await stat(join(store.directory, `${account.id}.json`))).toBeTruthy();
    expect(await store.list({ workspaceId: "personal" })).toHaveLength(1);
    expect(await store.list({ workspaceId: "other" })).toHaveLength(0);
  });

  it("fails closed on symlinked record targets", async () => {
    const root = await tempRoot("adpilot-ads-store-symlink-");
    const store = new FileCreativeAssetStore(root);
    const now = new Date().toISOString();
    const creative: CreativeAssetValue = CreativeAsset.parse({
      id: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      name: "Video A",
      platform: "meta",
      createdAt: now,
      updatedAt: now,
      revision: 1
    });
    await store.save(creative);
    const outside = join(root, "outside.json");
    await writeFile(outside, "{}\n", "utf8");
    const target = join(store.directory, `${creative.id}.json`);
    await rm(target);
    await symlink(outside, target);
    await expect(store.get(creative.id)).rejects.toThrow(/symlink/);
    await expect(store.save(creative)).rejects.toThrow(/symlink/);
  });
});

describe("PythonUacEngine", () => {
  /**
   * A stand-in "python3" executable (POSIX sh): answers --version, accepts the
   * `-c "import <module>"` dependency probe (exit 0 unless moduleProbeFails),
   * and forwards everything else to node so fake engine scripts stay JS.
   */
  async function fakePython(root: string, options: { moduleProbeFails?: boolean } = {}): Promise<string> {
    const shim = join(root, "fake-python3");
    await writeFile(shim, [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "Python 3.0.0-fake"; exit 0; fi',
      `if [ "$1" = "-c" ]; then exit ${options.moduleProbeFails ? 1 : 0}; fi`,
      `exec "${process.execPath}" "$@"`,
      ""
    ].join("\n"), { mode: 0o755 });
    return shim;
  }

  /** Minimal engine-output object that satisfies UacAnalysisResult. */
  function fakeAnalysisOutput(): Record<string, unknown> {
    return {
      schema_version: "1.0",
      account_state: {},
      measurement_state: { status: "ok" },
      learning_eligibility: { status: "ok" },
      optimization_feasibility: { status: "ok" }
    };
  }

  async function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
    const saved = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return await run();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("reports availability and refuses to fake results when python3 is missing", async () => {
    const engine = new PythonUacEngine({ pythonPath: "/nonexistent/adpilot-python3" });
    expect(await engine.isAvailable()).toBe(false);
    await expect(engine.analyze({ kind: "analyze", case: {} })).rejects.toMatchObject({
      code: UAC_ENGINE_UNAVAILABLE
    });
  });

  it("reports unavailable when a required python module cannot be imported", async () => {
    const root = await tempRoot("adpilot-uac-nodeps-");
    const shim = await fakePython(root, { moduleProbeFails: true });
    const engine = new PythonUacEngine({ pythonPath: shim });
    expect(await engine.isAvailable()).toBe(false);
    await expect(engine.analyze({ kind: "analyze", case: {} })).rejects.toMatchObject({
      code: UAC_ENGINE_UNAVAILABLE
    });
  });

  it("runs the real UAC Quick Decision engine over a JSON case", async () => {
    const engine = new PythonUacEngine();
    expect(await engine.isAvailable()).toBe(true);
    const result = await engine.analyze({ kind: "decide", case: await loadYamlCase(QUICK_OPS_EXAMPLE) });
    expect(result.kind).toBe("decide");
    if (result.kind !== "decide") return;
    expect(result.result.mode).toBe("quick_decision");
    expect(result.result.decision.verdict.length).toBeGreaterThan(0);
    expect(["AC2.0", "AC2.5", "AC3.0", null]).toContain(result.result.terminology.resolved_level);
    expect(result.result.engine?.name).toBe("uac-experiment");
  });

  it("runs the real UAC full-analysis engine over a JSON case and stamps the engine version", async () => {
    const engine = new PythonUacEngine();
    const result = await engine.analyze({ kind: "analyze", case: await loadYamlCase(ANALYZE_EXAMPLE) });
    expect(result.kind).toBe("analyze");
    if (result.kind !== "analyze") return;
    expect(result.result.schema_version).toBe("1.0");
    expect(result.result.measurement_state.status.length).toBeGreaterThan(0);
    expect(result.result.learning_eligibility.status.length).toBeGreaterThan(0);
    const expectedVersion = (await readFile(
      fileURLToPath(new URL("../../../packages/advertising-core/python/VERSION", import.meta.url)),
      "utf8"
    )).trim();
    expect(result.result.engine).toEqual({ name: "uac-experiment", version: expectedVersion });
  });

  it("maps engine contract failures to UAC_ENGINE_FAILED", async () => {
    const engine = new PythonUacEngine();
    await expect(engine.analyze({ kind: "analyze", case: { scope: { platform: "meta" } } }))
      .rejects.toMatchObject({ code: UAC_ENGINE_FAILED });
  });

  it("maps non-JSON engine stdout to UAC_OUTPUT_INVALID", async () => {
    const root = await tempRoot("adpilot-uac-fake-");
    const script = join(root, "fake-engine.cjs");
    await writeFile(script, "process.stdout.write('not json at all');\n", "utf8");
    const engine = new PythonUacEngine({ pythonPath: await fakePython(root), scriptPath: script, cwd: root });
    expect(await engine.isAvailable()).toBe(true);
    await expect(engine.analyze({ kind: "analyze", case: {} })).rejects.toMatchObject({
      code: UAC_OUTPUT_INVALID
    });
  });

  it("maps non-zero engine exits to UAC_ENGINE_FAILED", async () => {
    const root = await tempRoot("adpilot-uac-failing-");
    const script = join(root, "failing-engine.cjs");
    await writeFile(script, "console.error('boom'); process.exit(2);\n", "utf8");
    const engine = new PythonUacEngine({ pythonPath: await fakePython(root), scriptPath: script, cwd: root });
    await expect(engine.analyze({ kind: "decide", case: {} })).rejects.toMatchObject({
      code: UAC_ENGINE_FAILED
    });
  });

  it("maps schema-violating engine output to UAC_OUTPUT_INVALID", async () => {
    const root = await tempRoot("adpilot-uac-badshape-");
    const script = join(root, "bad-shape-engine.cjs");
    await writeFile(script, "process.stdout.write(JSON.stringify({ schema_version: '9.9' }));\n", "utf8");
    const engine = new PythonUacEngine({ pythonPath: await fakePython(root), scriptPath: script, cwd: root });
    await expect(engine.analyze({ kind: "analyze", case: {} })).rejects.toMatchObject({
      code: UAC_OUTPUT_INVALID
    });
  });

  it("resolves the script from ADPILOT_UAC_SCRIPT and falls back to the default version without a VERSION marker", async () => {
    const root = await tempRoot("adpilot-uac-override-");
    const scriptDir = join(root, "scripts");
    await mkdir(scriptDir, { recursive: true });
    const script = join(scriptDir, "uac_experiment.py");
    await writeFile(script, `process.stdout.write(JSON.stringify(${JSON.stringify(fakeAnalysisOutput())}));\n`, "utf8");
    const shim = await fakePython(root);
    await withEnv({ ADPILOT_UAC_SCRIPT: script }, async () => {
      const engine = new PythonUacEngine({ pythonPath: shim });
      const result = await engine.analyze({ kind: "analyze", case: {} });
      expect(result.kind).toBe("analyze");
      if (result.kind !== "analyze") return;
      expect(result.result.schema_version).toBe("1.0");
      // No VERSION marker next to the override script → documented fallback.
      expect(result.result.engine).toEqual({ name: "uac-experiment", version: "0.1.0" });
    });
  });

  it("resolves the script from ADPILOT_RESOURCES_PATH and reads the packaged VERSION marker", async () => {
    const root = await tempRoot("adpilot-uac-resources-");
    const pythonRoot = join(root, "resources", "advertising-core", "python");
    await mkdir(join(pythonRoot, "scripts"), { recursive: true });
    const script = join(pythonRoot, "scripts", "uac_experiment.py");
    await writeFile(script, `process.stdout.write(JSON.stringify(${JSON.stringify(fakeAnalysisOutput())}));\n`, "utf8");
    await writeFile(join(pythonRoot, "VERSION"), "9.9.9\n", "utf8");
    const shim = await fakePython(root);
    await withEnv({ ADPILOT_RESOURCES_PATH: join(root, "resources") }, async () => {
      const engine = new PythonUacEngine({ pythonPath: shim });
      const result = await engine.analyze({ kind: "analyze", case: {} });
      expect(result.kind).toBe("analyze");
      if (result.kind !== "analyze") return;
      expect(result.result.engine).toEqual({ name: "uac-experiment", version: "9.9.9" });
    });
  });

  it("prefers ADPILOT_UAC_SCRIPT over ADPILOT_RESOURCES_PATH", async () => {
    const root = await tempRoot("adpilot-uac-precedence-");
    const overrideDir = join(root, "override", "scripts");
    await mkdir(overrideDir, { recursive: true });
    const overrideScript = join(overrideDir, "uac_experiment.py");
    await writeFile(
      overrideScript,
      `process.stdout.write(JSON.stringify(${JSON.stringify(fakeAnalysisOutput())}));\n`,
      "utf8"
    );
    const resourcesPython = join(root, "resources", "advertising-core", "python");
    await mkdir(join(resourcesPython, "scripts"), { recursive: true });
    await writeFile(
      join(resourcesPython, "scripts", "uac_experiment.py"),
      "console.error('must not run'); process.exit(2);\n",
      "utf8"
    );
    const shim = await fakePython(root);
    await withEnv(
      { ADPILOT_UAC_SCRIPT: overrideScript, ADPILOT_RESOURCES_PATH: join(root, "resources") },
      async () => {
        const engine = new PythonUacEngine({ pythonPath: shim });
        const result = await engine.analyze({ kind: "analyze", case: {} });
        expect(result.kind).toBe("analyze");
      }
    );
  });
});

describe("DailyBriefService", () => {
  const service = new DailyBriefService();
  const now = new Date("2026-07-28T08:00:00.000Z");
  const accountId = crypto.randomUUID();
  const campaignId = crypto.randomUUID();
  const creativeId = crypto.randomUUID();

  function baseInput() {
    const account = sampleAccount(accountId);
    const campaign = {
      id: campaignId,
      accountId,
      name: "UAC Android US",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      revision: 1
    };
    const creative = CreativeAsset.parse({
      id: creativeId,
      accountId,
      name: "Rewarded video v3",
      platform: "google",
      lifecycle: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      revision: 1
    });
    return {
      workspaceId: "personal",
      accounts: [account],
      campaigns: [campaign],
      creatives: [creative],
      decisions: [] as AdvertisingDecisionValue[],
      experiments: [],
      metrics: { accounts: [], campaigns: [], creatives: [] },
      now
    };
  }

  it("flags spend ceiling breaches, spend spikes, and CPA overruns with severity", () => {
    const brief = service.generate({
      ...baseInput(),
      metrics: {
        accounts: [{
          accountId,
          spend: 3_000,
          cpa: 120,
          dailySpend: [900, 950, 1_000, 980],
          evidenceIds: ["fact-spend"]
        }],
        campaigns: [],
        creatives: []
      },
      thresholds: { maxDailySpend: 2_500, maxCpa: 100 }
    });
    const rules = brief.sections.anomalyAccounts.map((item) => item.ruleId);
    expect(rules).toContain("account_spend_over_ceiling");
    expect(rules).toContain("account_spend_spike");
    expect(rules).toContain("account_cpa_over_target");
    const cpa = brief.sections.anomalyAccounts.find((item) => item.ruleId === "account_cpa_over_target");
    expect(cpa?.severity).toBe("warning"); // 120 < 1.5×100
    expect(cpa?.evidenceIds).toEqual(["fact-spend"]);
    const ceiling = brief.sections.anomalyAccounts.find((item) => item.ruleId === "account_spend_over_ceiling");
    expect(ceiling?.severity).toBe("critical");
    expect(brief.summary.totalFindings).toBe(3);
  });

  it("marks a hard CPA breach as critical", () => {
    const brief = service.generate({
      ...baseInput(),
      metrics: { accounts: [{ accountId, cpa: 200 }], campaigns: [], creatives: [] },
      thresholds: { maxCpa: 100 }
    });
    expect(brief.sections.anomalyAccounts[0]?.severity).toBe("critical");
  });

  it("detects creative fatigue from lifecycle and from sustained CTR decline", () => {
    const fatiguing = CreativeAsset.parse({
      id: crypto.randomUUID(),
      accountId,
      name: "Static banner",
      platform: "google",
      lifecycle: "fatiguing",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      revision: 1
    });
    const brief = service.generate({
      ...baseInput(),
      creatives: [...baseInput().creatives, fatiguing],
      metrics: {
        accounts: [],
        campaigns: [],
        creatives: [{ creativeId, dailyCtr: [0.05, 0.04, 0.03, 0.02], evidenceIds: ["fact-ctr"] }]
      }
    });
    const rules = brief.sections.creativeFatigue.map((item) => item.ruleId);
    expect(rules).toContain("creative_declared_fatiguing");
    expect(rules).toContain("creative_ctr_decline");
    expect(brief.sections.creativeFatigue.find((item) => item.ruleId === "creative_ctr_decline")?.evidenceIds)
      .toEqual(["fact-ctr"]);
    // A rising series must not trigger the rule.
    const healthy = service.generate({
      ...baseInput(),
      metrics: { accounts: [], campaigns: [], creatives: [{ creativeId, dailyCtr: [0.02, 0.03, 0.04, 0.05] }] }
    });
    expect(healthy.sections.creativeFatigue).toHaveLength(0);
  });

  it("surfaces learning-phase risks by status and conversion volume", () => {
    const brief = service.generate({
      ...baseInput(),
      metrics: {
        accounts: [],
        campaigns: [
          { campaignId, learningStatus: "learning", conversionsInLearning: 3 },
          { campaignId: crypto.randomUUID(), learningStatus: "learning_limited" }
        ],
        creatives: []
      }
    });
    const lowVolume = brief.sections.learningPhaseRisks.find((item) => item.ruleId === "campaign_learning_phase");
    const limited = brief.sections.learningPhaseRisks.find((item) => item.ruleId === "campaign_learning_limited");
    expect(lowVolume?.severity).toBe("warning");
    expect(limited?.severity).toBe("critical");
  });

  it("collects observing decisions, overdue experiments, proposed decisions, and pending reports", () => {
    const observing = sampleDecision(crypto.randomUUID(), crypto.randomUUID(), { status: "observing", observationWindow: "7 days", evidenceIds: ["fact-obs"] });
    const proposed = sampleDecision(crypto.randomUUID(), crypto.randomUUID(), { status: "proposed" });
    const overdueExperiment = {
      id: crypto.randomUUID(),
      clientId: "personal",
      taskId: crypto.randomUUID(),
      approvalId: crypto.randomUUID(),
      hypothesis: "Higher tCPA keeps volume",
      variable: "tCPA",
      baseline: { cpa: 90 },
      expected: "volume +20%",
      successCriteria: "cpi stable",
      failureCriteria: "cpa > 120",
      maturityWindowDays: 7,
      rollbackCondition: "restore tCPA",
      reviewAt: "2026-07-20T00:00:00.000Z",
      status: "active" as const,
      finalConclusion: null,
      startedAt: "2026-07-01T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z"
    };
    const brief = service.generate({
      ...baseInput(),
      decisions: [observing, proposed],
      experiments: [overdueExperiment],
      pendingReports: [{ id: "report-1", kind: "weekly", dueAt: "2026-07-29T00:00:00.000Z" }]
    });
    expect(brief.sections.pendingObservations.map((item) => item.ruleId))
      .toEqual(["decision_observing", "experiment_review_overdue"]);
    expect(brief.sections.pendingObservations[0]?.evidenceIds).toEqual(["fact-obs"]);
    expect(brief.sections.pendingObservations[1]?.severity).toBe("warning");
    expect(brief.sections.pendingApprovals).toHaveLength(1);
    expect(brief.sections.pendingReports[0]).toMatchObject({ ruleId: "report_pending", severity: "info" });
  });

  it("raises measurement reminders from declared issues and reconciliation gaps", () => {
    const brief = service.generate({
      ...baseInput(),
      metrics: {
        accounts: [{ accountId, reconciliationDifference: 0.2, evidenceIds: ["fact-recon"] }],
        campaigns: [],
        creatives: []
      },
      measurementIssues: [{ issue: "Firebase dedup window unclear", accountId }]
    });
    const rules = brief.sections.measurementIssues.map((item) => item.ruleId);
    expect(rules).toContain("measurement_declared_issue");
    expect(rules).toContain("measurement_reconciliation_gap");
    expect(brief.sections.measurementIssues.find((item) => item.ruleId === "measurement_reconciliation_gap")?.evidenceIds)
      .toEqual(["fact-recon"]);
  });

  it("produces an empty brief when nothing trips a rule", () => {
    const brief = service.generate(baseInput());
    expect(brief.summary).toEqual({ totalFindings: 0, criticalCount: 0, warningCount: 0, infoCount: 0 });
    expect(brief.workspaceId).toBe("personal");
  });
});

describe("AdsIntelligenceError", () => {
  it("carries a stable machine-readable code", () => {
    expect(new AdsIntelligenceError("x", "CODE")).toMatchObject({ code: "CODE", name: "AdsIntelligenceError" });
  });
});
