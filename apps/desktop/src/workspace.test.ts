import { describe, expect, it } from "vitest";
import {
  artifactDownloadFile,
  artifactOutputUrl,
  artifactThumbFiles,
  automationActionUrl,
  automationRunApproveUrl,
  automationRunSummary,
  automationRunsUrl,
  automationsUrl,
  automationUrl,
  countUnread,
  cronPresetFields,
  currentVersionFiles,
  describeCron,
  diffLineKind,
  fsTreeUrl,
  groupKernelTasks,
  homeGreetingKey,
  interpolate,
  kernelArtifactsUrl,
  kernelProjectUrl,
  kernelProjectsUrl,
  kernelTasksUrl,
  localTerminalChunk,
  mergeTerminalChunks,
  notificationReadUrl,
  notificationsUrl,
  parseRootPathsInput,
  shortId,
  sortArtifactsRecent,
  sortRunsRecent,
  serverLastSeq,
  stripAnsi,
  terminalLastSeq,
  terminalOutputUrl,
  type AppNotification,
  type AutomationRun,
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
