import { describe, expect, it } from "vitest";
import {
  adsAccountsUrl,
  adsCampaignsUrl,
  adsCreativesUrl,
  adsDailyBriefUrl,
  adsDecisionTransitionUrl,
  adsDecisionsUrl,
  artifactDownloadFile,
  artifactOutputUrl,
  artifactThumbFiles,
  automationActionUrl,
  automationRunApproveUrl,
  automationRunSummary,
  automationRunsUrl,
  automationsUrl,
  automationUrl,
  briefSections,
  briefSectionSeverity,
  buildBriefFacts,
  buildMissionRequest,
  buildProjectMessageRequest,
  buildProjectSessionRequest,
  BRIEF_SECTION_KEYS,
  countUnread,
  cronPresetFields,
  currentVersionFiles,
  decisionTransitionActions,
  describeCron,
  diffLineKind,
  fsTreeUrl,
  groupKernelTasks,
  homeGreetingKey,
  interpolate,
  kernelArtifactsUrl,
  kernelProjectMissionUrl,
  kernelProjectSessionUrl,
  kernelProjectUrl,
  kernelProjectsUrl,
  kernelTasksUrl,
  localProjectUserMessage,
  localTerminalChunk,
  mergeTerminalChunks,
  notificationReadUrl,
  notificationsUrl,
  parseRootPathsInput,
  groupSessionsByProject,
  shortId,
  sortArtifactsRecent,
  sortDecisionsRecent,
  sortRunsRecent,
  serverLastSeq,
  stripAnsi,
  terminalLastSeq,
  terminalOutputUrl,
  type AdAccount,
  type AdCampaign,
  type AdCreative,
  type AdDecision,
  type AppNotification,
  type AutomationRun,
  type BriefItem,
  type DailyBrief,
  type KernelArtifact,
  type KernelTask,
  type TerminalChunk
} from "./workspace.js";

let counter = 0;
function task(overrides: Partial<KernelTask> = {}): KernelTask {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    title: `Task ${counter}`,
    description: "",
    status: "queued",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    revision: 1,
    ...overrides
  };
}

function artifact(overrides: Partial<KernelArtifact> = {}): KernelArtifact {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    projectId: "project",
    type: "slides",
    title: `Artifact ${counter}`,
    exportFormats: [],
    version: 1,
    status: "ready",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    revision: 1,
    ...overrides
  };
}

function chunk(seq: number, data = `chunk-${seq}`): TerminalChunk {
  return { seq, ts: seq, stream: "stdout", data };
}

describe("parseRootPathsInput", () => {
  it("parses one path per line, trimming blanks and de-duplicating", () => {
    expect(parseRootPathsInput("/a\n\n  /b  \n/a\n   \n/c")).toEqual(["/a", "/b", "/c"]);
    expect(parseRootPathsInput("")).toEqual([]);
  });
});

describe("groupKernelTasks", () => {
  it("orders groups running → queued → blocked → completed → failed and omits empty ones", () => {
    const groups = groupKernelTasks([
      task({ title: "done", status: "completed" }),
      task({ title: "live", status: "running" }),
      task({ title: "stuck", status: "blocked" }),
      task({ title: "next", status: "queued" })
    ]);
    expect(groups.map((group) => group.status)).toEqual(["running", "queued", "blocked", "completed"]);
    expect(groups[0]?.tasks[0]?.title).toBe("live");
  });

  it("folds waiting_approval into the blocked group and keeps failed last", () => {
    const groups = groupKernelTasks([
      task({ title: "approval", status: "waiting_approval" }),
      task({ title: "broken", status: "failed" })
    ]);
    expect(groups.map((group) => group.status)).toEqual(["blocked", "failed"]);
    expect(groups[0]?.tasks[0]?.title).toBe("approval");
  });
});

describe("mergeTerminalChunks", () => {
  it("appends only newer seqs and keeps output ordered (incremental poll)", () => {
    const merged = mergeTerminalChunks([chunk(1), chunk(2)], [chunk(2, "dup"), chunk(3)]);
    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(merged[2]?.data).toBe("chunk-3");
  });

  it("is a no-op for empty or fully duplicated polls", () => {
    const existing = [chunk(5), chunk(6)];
    expect(mergeTerminalChunks(existing, [])).toEqual(existing);
    expect(mergeTerminalChunks(existing, [chunk(5)])).toEqual(existing);
  });

  it("tracks the high-water mark for the next ?since= poll", () => {
    expect(terminalLastSeq([chunk(3), chunk(9), chunk(7)])).toBe(9);
    expect(terminalLastSeq([])).toBe(0);
  });

  it("keeps local exec pseudo-chunks above real session seqs", () => {
    const merged = mergeTerminalChunks([chunk(1)], [localTerminalChunk(1, "$ ls", "meta")]);
    expect(terminalLastSeq(merged)).toBeGreaterThan(1_000_000);
    expect(merged.map((item) => item.seq)).toEqual([...merged.map((item) => item.seq)].sort((a, b) => a - b));
  });

  it("never lets local pseudo-chunks raise the server ?since= watermark", () => {
    const mixed = mergeTerminalChunks([chunk(7)], [localTerminalChunk(3, "exit code 0")]);
    expect(serverLastSeq(mixed)).toBe(7);
  });
});

describe("diffLineKind", () => {
  it("classifies unified diff lines for the colored view", () => {
    expect(diffLineKind("+added")).toBe("add");
    expect(diffLineKind("-removed")).toBe("del");
    expect(diffLineKind("@@ -1,2 +1,2 @@")).toBe("hunk");
    expect(diffLineKind("+++ b/file.ts")).toBe("meta");
    expect(diffLineKind("--- a/file.ts")).toBe("meta");
    expect(diffLineKind("diff --git a/x b/x")).toBe("meta");
    expect(diffLineKind(" context")).toBe("context");
    expect(diffLineKind("")).toBe("context");
  });
});

describe("URL builders", () => {
  it("builds kernel routes with the workspace query", () => {
    expect(kernelProjectsUrl("personal")).toBe("/api/kernel/projects?workspaceId=personal");
    expect(kernelProjectUrl("abc", "personal")).toBe("/api/kernel/projects/abc?workspaceId=personal");
    expect(kernelTasksUrl("personal", { status: "running" })).toBe("/api/kernel/tasks?workspaceId=personal&status=running");
    expect(kernelArtifactsUrl("personal", "p 1")).toBe("/api/kernel/artifacts?workspaceId=personal&projectId=p+1");
  });

  it("encodes artifact output paths segment by segment", () => {
    expect(artifactOutputUrl("id 1", "v1/thumb-01.svg", "personal")).toBe("/api/kernel/artifacts/id%201/output/v1/thumb-01.svg?workspaceId=personal");
  });

  it("builds fs and terminal routes", () => {
    expect(fsTreeUrl("/tmp/x y", 3)).toBe("/api/fs/tree?root=%2Ftmp%2Fx+y&depth=3");
    expect(terminalOutputUrl("t1", 41)).toBe("/api/terminals/t1/output?since=41");
  });
});

describe("artifact view helpers", () => {
  it("sorts artifacts by recency and caps the home list", () => {
    const old = artifact({ title: "old", updatedAt: "2026-07-01T00:00:00.000Z" });
    const fresh = artifact({ title: "fresh", updatedAt: "2026-07-20T00:00:00.000Z" });
    expect(sortArtifactsRecent([old, fresh], 1).map((item) => item.title)).toEqual(["fresh"]);
  });

  it("picks slide thumbnails in order and the deliverable for download", () => {
    const files = ["slides.pptx", "thumb-02.svg", "thumb-01.svg", "thumb-10.svg"];
    expect(artifactThumbFiles(files)).toEqual(["thumb-01.svg", "thumb-02.svg", "thumb-10.svg"]);
    expect(artifactDownloadFile(files)).toBe("slides.pptx");
    expect(artifactDownloadFile(["preview.json", "workbook.xlsx"])).toBe("workbook.xlsx");
    expect(artifactDownloadFile(["preview.txt"])).toBeUndefined();
  });

  it("resolves the current version's files from the detail payload", () => {
    const record = artifact({ version: 2 });
    const versions = [{ version: 1, files: ["old.pptx"] }, { version: 2, files: ["new.pptx"] }];
    expect(currentVersionFiles(record, versions)).toEqual(["new.pptx"]);
    expect(currentVersionFiles(record, [])).toEqual([]);
  });
});

describe("misc view logic", () => {
  it("buckets the greeting by time of day", () => {
    expect(homeGreetingKey(new Date("2026-07-28T08:00:00"))).toBe("greetingMorning");
    expect(homeGreetingKey(new Date("2026-07-28T14:00:00"))).toBe("greetingAfternoon");
    expect(homeGreetingKey(new Date("2026-07-28T21:00:00"))).toBe("greetingEvening");
  });

  it("interpolates copy placeholders and leaves unknown ones intact", () => {
    expect(interpolate("{count} 个目标", { count: "3" })).toBe("3 个目标");
    expect(interpolate("{missing}", {})).toBe("{missing}");
  });

  it("groups sessions under their project with freshest group first", () => {
    const projects = [
      { id: "p1", name: "Alpha", status: "active" },
      { id: "p2", name: "Beta", status: "active" }
    ] as never[];
    const session = (id: string, projectId: string | undefined, lastActivityAt: string) => ({
      id, projectId, lastActivityAt
    }) as never;
    const groups = groupSessionsByProject([
      session("s1", "p1", "2026-07-28T00:00:00Z"),
      session("s2", "p2", "2026-07-29T00:00:00Z"),
      session("s3", "p1", "2026-07-28T06:00:00Z"),
      session("s4", undefined, "2026-07-27T00:00:00Z"),
      session("s5", "ghost", "2026-07-29T01:00:00Z")
    ], projects);
    expect(groups.map((group) => group.project === null ? "ungrouped" : (group.project as { id: string }).id)).toEqual(["p2", "p1", "ungrouped"]);
    expect(groups[1]!.sessions.map((item: { id: string }) => item.id)).toEqual(["s3", "s1"]);
    expect(groups[2]!.sessions.map((item: { id: string }) => item.id)).toEqual(["s5", "s4"]);
  });

  it("shortens ids for display", () => {
    expect(shortId("12345678-abcd")).toBe("12345678");
  });

  it("strips ANSI escape sequences from shell output", () => {
    expect(stripAnsi("[1m[7m[27m[1m[0m guolu%")).toBe(" guolu%");
    expect(stripAnsi("[31merror[0m: failed")).toBe("error: failed");
    expect(stripAnsi("plain text")).toBe("plain text");
    expect(stripAnsi("[1;32m✓[0m done")).toBe("✓ done");
  });
});


/* ------------------------------------------------------------------ */
/* Automations                                                         */
/* ------------------------------------------------------------------ */

describe("describeCron", () => {
  it("recognizes the common schedule shapes", () => {
    expect(describeCron({ minute: "*", hour: "*", dom: "*", month: "*", dow: "*" })).toEqual({ kind: "every-minute" });
    expect(describeCron({ minute: "30", hour: "*", dom: "*", month: "*", dow: "*" })).toEqual({ kind: "hourly", minute: 30 });
    expect(describeCron({ minute: "0", hour: "9", dom: "*", month: "*", dow: "*" })).toEqual({ kind: "daily", time: "09:00" });
    expect(describeCron({ minute: "5", hour: "23", dom: "*", month: "*", dow: "*" })).toEqual({ kind: "daily", time: "23:05" });
    expect(describeCron({ minute: "0", hour: "9", dom: "*", month: "*", dow: "1" })).toEqual({ kind: "weekly", dow: 1, time: "09:00" });
    expect(describeCron({ minute: "0", hour: "9", dom: "*", month: "*", dow: "7" })).toEqual({ kind: "weekly", dow: 0, time: "09:00" });
    expect(describeCron({ minute: "0", hour: "9", dom: "15", month: "*", dow: "*" })).toEqual({ kind: "monthly", dom: 15, time: "09:00" });
  });

  it("falls back to the raw spec for richer expressions", () => {
    expect(describeCron({ minute: "*/15", hour: "*", dom: "*", month: "*", dow: "*" })).toEqual({ kind: "raw", text: "*/15 * * * *" });
    expect(describeCron({ minute: "0", hour: "9-17", dom: "*", month: "*", dow: "1-5" })).toEqual({ kind: "raw", text: "0 9-17 * * 1-5" });
  });
});

describe("cronPresetFields", () => {
  it("maps every preset to a concrete spec", () => {
    expect(cronPresetFields("daily-morning")).toEqual({ minute: "0", hour: "9", dom: "*", month: "*", dow: "*" });
    expect(cronPresetFields("hourly")).toEqual({ minute: "0", hour: "*", dom: "*", month: "*", dow: "*" });
    expect(cronPresetFields("weekly-monday")).toEqual({ minute: "0", hour: "9", dom: "*", month: "*", dow: "1" });
  });
});

describe("automation run view helpers", () => {
  const runBase: AutomationRun = {
    id: "00000000-0000-4000-8000-0000000000aa",
    automationId: "00000000-0000-4000-8000-0000000000bb",
    idempotencyKey: "k",
    startedAt: "2026-07-28T09:00:00.000Z",
    status: "succeeded",
    runLog: [],
    createdAt: "2026-07-28T09:00:00.000Z",
    updatedAt: "2026-07-28T09:00:00.000Z",
    revision: 1
  };

  it("summarizes a run as its error or a truncated JSON result", () => {
    expect(automationRunSummary({ ...runBase, status: "failed", error: "boom" })).toBe("boom");
    expect(automationRunSummary({ ...runBase, result: { findings: 3 } })).toBe('{"findings":3}');
    expect(automationRunSummary(runBase)).toBe("");
    const long = automationRunSummary({ ...runBase, error: "x".repeat(500) }, 10);
    expect(long).toHaveLength(10);
    expect(long.endsWith("…")).toBe(true);
  });

  it("sorts runs newest first and caps the list", () => {
    const older = { ...runBase, id: "00000000-0000-4000-8000-000000000001", startedAt: "2026-07-27T09:00:00.000Z" };
    const newer = { ...runBase, id: "00000000-0000-4000-8000-000000000002", startedAt: "2026-07-28T10:00:00.000Z" };
    expect(sortRunsRecent([older, newer]).map((run) => run.id)).toEqual([newer.id, older.id]);
    expect(sortRunsRecent([older, newer], 1)).toEqual([newer]);
  });

  it("counts unread notifications", () => {
    const note = (read: boolean): AppNotification => ({
      id: crypto.randomUUID(),
      workspaceId: "personal",
      message: "m",
      read,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1
    });
    expect(countUnread([note(true), note(false), note(false)])).toBe(2);
    expect(countUnread([])).toBe(0);
  });
});

describe("automation URL builders", () => {
  it("builds automation, run, and notification routes", () => {
    expect(automationsUrl("personal")).toBe("/api/automations?workspaceId=personal");
    expect(automationUrl("a 1", "personal")).toBe("/api/automations/a%201?workspaceId=personal");
    expect(automationActionUrl("a1", "run-now")).toBe("/api/automations/a1/run-now");
    expect(automationRunsUrl("a1", "personal")).toBe("/api/automations/a1/runs?workspaceId=personal");
    expect(automationRunApproveUrl("r1")).toBe("/api/automation-runs/r1/approve");
    expect(notificationsUrl("personal")).toBe("/api/notifications?workspaceId=personal");
    expect(notificationsUrl("personal", true)).toBe("/api/notifications?workspaceId=personal&unread=true");
    expect(notificationReadUrl("n1")).toBe("/api/notifications/n1/read");
  });
});

/* ------------------------------------------------------------------ */
/* Ads intelligence                                                    */
/* ------------------------------------------------------------------ */

function adAccount(id: string): AdAccount {
  return {
    id,
    workspaceId: "personal",
    platform: "google",
    name: `Account ${id.slice(0, 4)}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    revision: 1
  };
}

function adCampaign(id: string, accountId: string, status?: string): AdCampaign {
  return {
    id,
    accountId,
    name: `Campaign ${id.slice(0, 4)}`,
    ...(status !== undefined ? { status } : {}),
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    revision: 1
  };
}

function adCreative(id: string, accountId: string): AdCreative {
  return {
    id,
    accountId,
    name: `Creative ${id.slice(0, 4)}`,
    platform: "meta",
    campaignIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    revision: 1
  };
}

function adDecision(overrides: Partial<AdDecision> = {}): AdDecision {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    projectId: "00000000-0000-4000-8000-0000000000ff",
    recommendation: `Decision ${counter}`,
    rationale: [],
    evidenceIds: [],
    confidence: "medium",
    risks: [],
    status: "proposed",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    revision: 1,
    ...overrides
  };
}

function briefItem(severity: BriefItem["severity"], title = severity): BriefItem {
  return { ruleId: "rule", severity, title, detail: "", entityRefs: {}, evidenceIds: [] };
}

describe("ads URL builders", () => {
  it("builds account, campaign, creative, decision, and brief routes", () => {
    expect(adsAccountsUrl("personal")).toBe("/api/ads/accounts?workspaceId=personal");
    expect(adsCampaignsUrl("personal")).toBe("/api/ads/campaigns?workspaceId=personal");
    expect(adsCampaignsUrl("personal", "acc 1")).toBe("/api/ads/campaigns?workspaceId=personal&accountId=acc+1");
    expect(adsCreativesUrl("personal", "acc1")).toBe("/api/ads/creatives?workspaceId=personal&accountId=acc1");
    expect(adsDecisionsUrl("personal", "p1")).toBe("/api/ads/decisions?workspaceId=personal&projectId=p1");
    expect(adsDecisionsUrl("personal", "p1", "proposed")).toBe("/api/ads/decisions?workspaceId=personal&projectId=p1&status=proposed");
    expect(adsDecisionTransitionUrl("d 1")).toBe("/api/ads/decisions/d%201/transition");
    expect(adsDailyBriefUrl()).toBe("/api/ads/daily-brief");
  });
});

describe("buildBriefFacts", () => {
  it("declares one metrics row per registry entity with evidence refs and no fabricated numbers", () => {
    const facts = buildBriefFacts({
      accounts: [adAccount("a1"), adAccount("a2")],
      campaigns: [adCampaign("c1", "a1", "learning"), adCampaign("c2", "a2")],
      creatives: [adCreative("cr1", "a1")]
    });
    expect(facts.metrics.accounts).toEqual([
      { accountId: "a1", evidenceIds: ["account:a1"] },
      { accountId: "a2", evidenceIds: ["account:a2"] }
    ]);
    expect(facts.metrics.campaigns).toEqual([
      { campaignId: "c1", learningStatus: "learning", evidenceIds: ["campaign:c1"] },
      { campaignId: "c2", evidenceIds: ["campaign:c2"] }
    ]);
    expect(facts.metrics.creatives).toEqual([{ creativeId: "cr1", evidenceIds: ["creative:cr1"] }]);
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toMatch(/spend|cpa|ctr/i);
  });

  it("assembles empty row lists for an empty registry", () => {
    expect(buildBriefFacts({ accounts: [], campaigns: [], creatives: [] })).toEqual({
      metrics: { accounts: [], campaigns: [], creatives: [] }
    });
  });
});

describe("briefSections", () => {
  it("returns all seven sections in canonical order, normalizing gaps to empty lists", () => {
    const brief = {
      schemaVersion: "1.0",
      generatedAt: "2026-07-29T00:00:00.000Z",
      workspaceId: "personal",
      sections: { creativeFatigue: [briefItem("warning")] },
      summary: { totalFindings: 1, criticalCount: 0, warningCount: 1, infoCount: 0 }
    } as unknown as DailyBrief;
    const sections = briefSections(brief);
    expect(sections.map((section) => section.key)).toEqual([...BRIEF_SECTION_KEYS]);
    expect(sections[1]?.items).toHaveLength(1);
    expect(sections.filter((section) => section.items.length > 0)).toHaveLength(1);
  });
});

describe("briefSectionSeverity", () => {
  it("picks the worst severity and null for empty sections", () => {
    expect(briefSectionSeverity([briefItem("info"), briefItem("critical"), briefItem("warning")])).toBe("critical");
    expect(briefSectionSeverity([briefItem("info"), briefItem("warning")])).toBe("warning");
    expect(briefSectionSeverity([briefItem("info")])).toBe("info");
    expect(briefSectionSeverity([])).toBeNull();
  });
});

describe("decisionTransitionActions", () => {
  it("exposes no desktop transitions until decisions are linked to verified execution", () => {
    for (const status of [
      "proposed",
      "approved",
      "executed",
      "observing",
      "successful",
      "failed",
      "reverted"
    ] as const) {
      expect(decisionTransitionActions(status)).toEqual([]);
    }
  });
});

describe("sortDecisionsRecent", () => {
  it("orders by updatedAt descending and caps the list", () => {
    const older = adDecision({ recommendation: "older", updatedAt: "2026-07-20T00:00:00.000Z" });
    const fresher = adDecision({ recommendation: "fresher", updatedAt: "2026-07-28T00:00:00.000Z" });
    expect(sortDecisionsRecent([older, fresher]).map((decision) => decision.recommendation)).toEqual(["fresher", "older"]);
    expect(sortDecisionsRecent([older, fresher], 1).map((decision) => decision.recommendation)).toEqual(["fresher"]);
  });
});

describe("project session binding helpers", () => {
  it("builds the project session and mission urls with encoding", () => {
    expect(kernelProjectSessionUrl("proj-1")).toBe("/api/kernel/projects/proj-1/session");
    expect(kernelProjectMissionUrl("proj-1")).toBe("/api/kernel/projects/proj-1/mission");
    expect(kernelProjectSessionUrl("a/b")).toBe("/api/kernel/projects/a%2Fb/session");
  });

  it("builds the session request, carrying the force flag only when set", () => {
    expect(buildProjectSessionRequest("personal")).toEqual({ workspaceId: "personal" });
    expect(buildProjectSessionRequest("personal", false)).toEqual({ workspaceId: "personal" });
    expect(buildProjectSessionRequest("personal", true)).toEqual({ workspaceId: "personal", force: true });
  });

  it("builds the mission triage request", () => {
    expect(buildMissionRequest("personal", "修复登陆页")).toEqual({ workspaceId: "personal", message: "修复登陆页" });
  });

  it("builds the project message request, omitting absent goal/task ids", () => {
    expect(buildProjectMessageRequest({
      clientId: "personal",
      sessionId: "s-1",
      projectId: "p-1",
      message: "你好",
      locale: "zh-CN"
    })).toEqual({ clientId: "personal", sessionId: "s-1", projectId: "p-1", message: "你好", locale: "zh-CN" });
    expect(buildProjectMessageRequest({
      clientId: "personal",
      sessionId: "s-1",
      projectId: "p-1",
      goalId: "g-1",
      taskId: "t-1",
      message: "审计账户",
      locale: "en"
    })).toEqual({ clientId: "personal", sessionId: "s-1", projectId: "p-1", goalId: "g-1", taskId: "t-1", message: "审计账户", locale: "en" });
    // A goal without a task (or vice versa) is passed through independently.
    expect(buildProjectMessageRequest({
      clientId: "personal",
      sessionId: "s-1",
      projectId: "p-1",
      goalId: "g-1",
      message: "m",
      locale: "en"
    })).toEqual({ clientId: "personal", sessionId: "s-1", projectId: "p-1", goalId: "g-1", message: "m", locale: "en" });
  });

  it("builds an optimistic local user message on the local-* convention", () => {
    const message = localProjectUserMessage("personal", "conv-1", "推进一下");
    expect(message).toMatchObject({
      clientId: "personal",
      conversationId: "conv-1",
      role: "user",
      content: "推进一下",
      status: "complete"
    });
    expect(message.id.startsWith("local-")).toBe(true);
    expect(Number.isNaN(Date.parse(message.at))).toBe(false);
  });
});
