import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileComputerActionRecordStore,
  FileMutationReplayStore,
  type ComputerActionRecord
} from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adpilot-computer-runtime-"));
  roots.push(root);
  return root;
}

function actionRecord(sessionId: string, actionId: string): ComputerActionRecord {
  return {
    id: actionId,
    sessionId,
    runId: "run-1",
    appPid: 42,
    appBundleId: "com.google.Chrome",
    windowId: "window-1",
    windowTitle: "Google Ads",
    displayId: "display-1",
    scaleFactor: 2,
    beforeFrameId: randomUUID(),
    action: { kind: "wait", milliseconds: 100 },
    proposedBy: "test",
    policyDecision: "policy-1",
    startedAt: "2026-07-28T00:00:00.000Z",
    userTookOver: false
  };
}

describe("Computer Runtime durable stores", () => {
  it("atomically persists and updates private action records", async () => {
    const root = await temporaryRoot();
    const store = new FileComputerActionRecordStore(join(root, "actions"));
    const sessionId = randomUUID();
    const actionId = randomUUID();
    const initial = actionRecord(sessionId, actionId);
    await store.save(initial);
    expect(await store.get(actionId)).toEqual(initial);
    const completed: ComputerActionRecord = {
      ...initial,
      completedAt: "2026-07-28T00:00:01.000Z",
      executionResult: { posted: true }
    };
    await store.save(completed);
    expect(await store.get(actionId)).toEqual(completed);
    expect(await store.list(sessionId)).toEqual([completed]);
  });

  it("refuses symlinked record targets", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "actions");
    const store = new FileComputerActionRecordStore(directory);
    const sessionId = randomUUID();
    const actionId = randomUUID();
    const outside = join(root, "outside.json");
    await writeFile(outside, "do not overwrite\n");
    // Create the directory through one safe write, then install an attacker link.
    await store.save(actionRecord(sessionId, randomUUID()));
    await symlink(outside, join(directory, `${actionId}.json`));
    await expect(store.save(actionRecord(sessionId, actionId))).rejects.toThrow("symlink");
  });

  it("claims one mutation exactly once across concurrent store instances", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "mutation-claims");
    const left = new FileMutationReplayStore(directory);
    const right = new FileMutationReplayStore(directory);
    const mutationKey = "a".repeat(64);
    const claim = {
      mutationKey,
      sessionId: randomUUID(),
      actionId: randomUUID(),
      approvalId: randomUUID(),
      claimedAt: "2026-07-28T00:00:00.000Z"
    };
    const outcomes = await Promise.all([left.claim(claim), right.claim(claim)]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await left.get(mutationKey)).toEqual(claim);
  });
});
