import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "@adpilot/workspace";
import {
  CorruptSessionRecordError,
  FileSessionRepository,
  RevisionConflictError,
  WriterLeaseRequiredError
} from "./repository.js";
import {
  PermissionEscalationRequiresApprovalError,
  SessionService,
  type SessionServiceOptions
} from "./service.js";
import {
  LostWorkspaceWriterLeaseError,
  WorkspaceWriterLease
} from "./lease.js";
import { UnsafeWorkspacePathError } from "./path-safety.js";

async function fixture(options: SessionServiceOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "adpilot-session-service-"));
  const workspace = new WorkspaceStore(root);
  const writerLease = await WorkspaceWriterLease.acquire(root, {
    owner: "session-service-test"
  });
  const repository = new FileSessionRepository(workspace, { writerLease });
  const service = new SessionService(repository, options);
  return { root, workspace, writerLease, repository, service };
}

describe("SessionService", () => {
  it("supports durable create-before-message CRUD, search and filtering", async () => {
    const { workspace, repository, service } = await fixture({
      verifyPermissionEscalation: () => true
    });
    const project = await service.createProject({
      clientId: "client-a",
      name: "Launch"
    });
    const alpha = await service.create({
      clientId: "client-a",
      projectId: project.id,
      title: "Alpha launch",
      agentProfileId: "agency-optimizer",
      advertisingWorkspaceId: "workspace-west",
      platforms: ["meta_ads", "google_ads", "meta_ads"],
      modelBinding: {
        mode: "pinned",
        providerId: "deepseek",
        modelId: "deepseek-chat"
      },
      permissionProfile: {
        level: "PREPARE",
        allowedToolNames: ["ads.read", "ads.read"],
        blockedToolNames: ["ads.write"],
        accountRefs: ["account-2", "account-1"],
        computerUse: "observe",
        approvalRequired: true
      },
      permissionApproval: {
        approvalId: crypto.randomUUID(),
        approvedBy: "workspace-owner",
        approvedAt: new Date().toISOString()
      },
      tags: ["launch", "priority", "launch"]
    });
    const beta = await service.create({
      clientId: "client-a",
      title: "Beta retention"
    });

    expect(alpha.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(alpha.runtimeConversationId).not.toBe(alpha.id);
    expect(alpha.agentProfileId).toBe("agency-optimizer");
    expect(alpha.advertisingWorkspaceId).toBe("workspace-west");
    expect(alpha.platforms).toEqual(["google_ads", "meta_ads"]);
    expect(alpha.lastOpenedAt).toBe(alpha.createdAt);
    expect(beta.agentProfileId).toBe("adpilot");
    expect(beta.platforms).toEqual([]);
    expect(new Set([
      alpha.id,
      alpha.runtimeConversationId,
      beta.id,
      beta.runtimeConversationId,
      project.id
    ]).size).toBe(5);
    expect(alpha.permissionProfile.allowedToolNames).toEqual(["ads.read"]);
    expect(alpha.permissionProfile.accountRefs).toEqual(["account-1", "account-2"]);
    expect(alpha.tags).toEqual(["launch", "priority"]);

    const renamed = await service.rename(alpha.id, "Alpha renamed", alpha.revision);
    const pinned = await service.pin(renamed.id, renamed.revision);
    const archived = await service.archive(pinned.id, pinned.revision);
    const touched = await service.touch(archived.id, archived.revision);
    const used = await service.recordUsage(
      touched.id,
      { inputTokens: 10, outputTokens: 4, toolCalls: 2, costUsd: 0.25 },
      touched.revision
    );
    const running = await service.setStatus(used.id, "running", used.revision);
    expect(running.revision).toBe(7);
    expect(running.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      toolCalls: 2,
      costUsd: 0.25
    });

    await expect(
      service.list({
        clientId: "client-a",
        archived: true,
        pinned: true,
        providerId: "deepseek",
        permissionLevel: "PREPARE",
        platform: "google_ads",
        tags: ["launch"]
      })
    ).resolves.toEqual([expect.objectContaining({ id: alpha.id })]);
    await expect(service.search("RENAMED")).resolves.toEqual([
      expect.objectContaining({ id: alpha.id })
    ]);
    await expect(service.search("workspace-west")).resolves.toEqual([
      expect.objectContaining({ id: alpha.id })
    ]);
    await expect(service.search("meta_ads")).resolves.toEqual([
      expect.objectContaining({ id: alpha.id })
    ]);
    await expect(service.list({ projectId: null })).resolves.toEqual([
      expect.objectContaining({ id: beta.id })
    ]);

    const restarted = new SessionService(new FileSessionRepository(workspace));
    await expect(restarted.require(alpha.id)).resolves.toMatchObject({
      id: alpha.id,
      title: "Alpha renamed",
      revision: 7,
      runtimeConversationId: alpha.runtimeConversationId,
      agentProfileId: "agency-optimizer",
      advertisingWorkspaceId: "workspace-west",
      platforms: ["google_ads", "meta_ads"],
      lastOpenedAt: alpha.lastOpenedAt,
      status: "running"
    });

    const mode = await stat(join(repository.recordsRoot, `${alpha.id}.json`));
    expect(mode.mode & 0o777).toBe(0o600);
    expect(
      (await readdir(repository.recordsRoot)).some((name) => name.endsWith(".tmp"))
    ).toBe(false);
    expect(repository.listDurabilityWarnings()).toEqual([]);
  });

  it("soft-deletes, restores and permanently purges without hiding recovery paths", async () => {
    const { service, repository } = await fixture();
    const session = await service.create({ clientId: "client-a", title: "Disposable" });
    const failed = await service.setStatus(session.id, "failed", session.revision);
    const deleted = await service.softDelete(session.id, failed.revision);
    expect(deleted).toMatchObject({
      status: "deleted",
      statusBeforeDelete: "failed"
    });
    await expect(service.get(session.id)).resolves.toBeUndefined();
    await expect(service.list()).resolves.toEqual([]);
    await expect(service.list({ deleted: true })).resolves.toHaveLength(1);

    const restored = await service.restore(session.id, deleted.revision);
    expect(restored.status).toBe("failed");
    expect(restored.deletedAt).toBeUndefined();

    const deletedAgain = await service.softDelete(session.id, restored.revision);
    await service.permanentPurge(session.id, deletedAgain.revision);
    await expect(repository.getSession(session.id)).resolves.toBeUndefined();
  });

  it("enforces optimistic revisions", async () => {
    const { service, workspace, writerLease } = await fixture();
    const session = await service.create({ clientId: "client-a" });
    const otherService = new SessionService(
      new FileSessionRepository(workspace, { writerLease })
    );
    const outcomes = await Promise.allSettled([
      service.rename(session.id, "First writer", 1),
      otherService.rename(session.id, "Second writer", 1)
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
    );
    expect(rejection?.reason).toBeInstanceOf(RevisionConflictError);
    await expect(service.require(session.id)).resolves.toMatchObject({
      revision: 2
    });
  });

  it("duplicates and branches with globally unique ids and explicit lineage", async () => {
    const { service } = await fixture();
    const source = await service.create({
      clientId: "client-a",
      title: "Source",
      agentProfileId: "media-buyer",
      advertisingWorkspaceId: "workspace-east",
      platforms: ["tiktok_ads", "google_ads"],
      tags: ["one"]
    });
    const used = await service.recordUsage(
      source.id,
      { inputTokens: 99, runCount: 1, costUsd: 1.5 },
      source.revision
    );
    const running = await service.setStatus(source.id, "running", used.revision);
    const duplicate = await service.duplicate(running.id);
    const branchOne = await service.branch(running.id, {
      sourceMessageId: "legacy-message-id"
    });
    const branchTwo = await service.branch(branchOne.id, {
      sourceRunId: crypto.randomUUID()
    });

    const ids = [
      source.id,
      source.runtimeConversationId,
      duplicate.id,
      duplicate.runtimeConversationId,
      branchOne.id,
      branchOne.runtimeConversationId,
      branchTwo.id,
      branchTwo.runtimeConversationId
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(duplicate.duplicatedFromSessionId).toBe(source.id);
    expect(duplicate).toMatchObject({
      agentProfileId: "media-buyer",
      advertisingWorkspaceId: "workspace-east",
      platforms: ["google_ads", "tiktok_ads"],
      status: "idle",
      usage: {
        inputTokens: 0,
        runCount: 0,
        costUsd: 0
      }
    });
    expect(duplicate.branch).toBeUndefined();
    expect(duplicate.legacy).toBeUndefined();
    expect(branchOne.branch).toMatchObject({
      parentSessionId: source.id,
      rootSessionId: source.id,
      sourceMessageId: "legacy-message-id"
    });
    expect(branchOne).toMatchObject({
      agentProfileId: "media-buyer",
      advertisingWorkspaceId: "workspace-east",
      platforms: ["google_ads", "tiktok_ads"],
      status: "idle",
      usage: {
        inputTokens: 0,
        runCount: 0,
        costUsd: 0
      }
    });
    expect(branchOne.duplicatedFromSessionId).toBeUndefined();
    expect(branchOne.legacy).toBeUndefined();
    expect(branchTwo.branch).toMatchObject({
      parentSessionId: branchOne.id,
      rootSessionId: source.id
    });
    const changedDuplicate = await service.setAgentProfileId(
      duplicate.id,
      "reviewer",
      duplicate.revision
    );
    expect(changedDuplicate.agentProfileId).toBe("reviewer");
    await expect(service.require(source.id)).resolves.toMatchObject({
      agentProfileId: "media-buyer",
      status: "running",
      usage: { inputTokens: 99, runCount: 1, costUsd: 1.5 }
    });
  });

  it("marks a session opened without changing its activity timestamp", async () => {
    let clock = Date.parse("2026-07-27T00:00:00.000Z");
    const { service } = await fixture({
      now: () => {
        const value = new Date(clock);
        clock += 1_000;
        return value;
      }
    });
    const session = await service.create({ clientId: "client-a" });
    const opened = await service.markOpened(session.id, session.revision);
    expect(opened.lastOpenedAt).toBe("2026-07-27T00:00:01.000Z");
    expect(opened.lastActivityAt).toBe(session.lastActivityAt);
    expect(opened.revision).toBe(session.revision + 1);
  });

  it("restores a record with a damaged tail from its atomic backup", async () => {
    const { repository, service, writerLease } = await fixture();
    const session = await service.create({ clientId: "client-a", title: "Recover me" });
    await service.rename(session.id, "Latest durable value", 1);
    const path = join(repository.recordsRoot, `${session.id}.json`);
    await appendFile(path, "{\"torn\":", "utf8");

    const restartedRepository = new FileSessionRepository(
      repository.workspaceRoot,
      { writerLease }
    );
    await expect(restartedRepository.getSession(session.id)).resolves.toMatchObject({
      title: "Recover me",
      revision: session.revision
    });
    await expect(restartedRepository.listRecoveryRecords()).resolves.toEqual([
      expect.objectContaining({
        kind: "record-restored-from-backup",
        path
      })
    ]);
    expect(
      (await readdir(restartedRepository.quarantineRoot)).some((name) =>
        name.endsWith(".corrupt")
      )
    ).toBe(true);
  });

  it("quarantines an unrecoverable record and keeps a durable corruption marker", async () => {
    const { repository, service } = await fixture();
    const session = await service.create({ clientId: "client-a", title: "Broken" });
    const path = join(repository.recordsRoot, `${session.id}.json`);
    await writeFile(path, "{\"broken-primary\":", "utf8");
    await writeFile(`${path}.bak`, "{\"broken-backup\":", "utf8");

    await expect(repository.getSession(session.id)).rejects.toBeInstanceOf(
      CorruptSessionRecordError
    );
    await expect(repository.getSession(session.id)).rejects.toBeInstanceOf(
      CorruptSessionRecordError
    );
    expect(
      (await readdir(repository.recordsRoot)).some((name) =>
        name.endsWith(".unrecoverable.json")
      )
    ).toBe(true);
  });

  it("fails closed for every service write without a writer lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "adpilot-read-only-session-service-"));
    const service = new SessionService(new FileSessionRepository(root));
    await expect(service.create({ clientId: "client-a" })).rejects.toBeInstanceOf(
      WriterLeaseRequiredError
    );
    expect(await stat(root)).toBeDefined();
    await expect(
      stat(join(root, ".adpilot", "sessions"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates lease ownership before a later commit", async () => {
    const { service, writerLease, root } = await fixture();
    const session = await service.create({ clientId: "client-a" });
    await writerLease.release();
    await expect(
      service.rename(session.id, "must-not-commit", session.revision)
    ).rejects.toBeInstanceOf(LostWorkspaceWriterLeaseError);
    await expect(
      new FileSessionRepository(root).requireSession(session.id)
    ).resolves.toMatchObject({ title: "New session", revision: 1 });
  });

  it("does not change the primary when backup preparation fails", async () => {
    const { service, repository } = await fixture();
    const session = await service.create({ clientId: "client-a" });
    const path = join(repository.recordsRoot, `${session.id}.json`);
    await mkdir(`${path}.bak`);
    await expect(
      service.rename(session.id, "must-not-commit", session.revision)
    ).rejects.toThrow();
    await expect(repository.requireSession(session.id)).resolves.toMatchObject({
      title: "New session",
      revision: 1
    });
  });

  it("enforces permission invariants and rejects unverified self-escalation", async () => {
    const { service } = await fixture();
    await expect(
      service.create({
        clientId: "client-a",
        permissionProfile: {
          level: "OBSERVE",
          computerUse: "execute",
          approvalRequired: true
        }
      })
    ).rejects.toThrow(/OBSERVE permission cannot execute|requires EXECUTE/);
    await expect(
      service.create({
        clientId: "client-a",
        permissionProfile: {
          level: "OBSERVE",
          computerUse: "disabled",
          approvalRequired: false
        }
      })
    ).rejects.toThrow(/approval-gated/);

    const session = await service.create({ clientId: "client-a" });
    await expect(
      service.setPermissionProfile(
        session.id,
        {
          level: "PREPARE",
          computerUse: "observe",
          approvalRequired: true
        },
        session.revision
      )
    ).rejects.toBeInstanceOf(PermissionEscalationRequiresApprovalError);
    await expect(service.require(session.id)).resolves.toMatchObject({
      revision: session.revision,
      permissionProfile: { level: "OBSERVE" }
    });
  });

  it("accepts an escalation only through the injected approval verifier", async () => {
    const approvalId = crypto.randomUUID();
    const { service } = await fixture({
      verifyPermissionEscalation: ({ approval, requestedProfile }) =>
        approval.approvalId === approvalId && requestedProfile.level === "PREPARE"
    });
    const session = await service.create({ clientId: "client-a" });
    const elevated = await service.setPermissionProfile(
      session.id,
      {
        level: "PREPARE",
        computerUse: "observe",
        approvalRequired: true
      },
      session.revision,
      {
        approvalId,
        approvedBy: "workspace-owner",
        approvedAt: new Date().toISOString()
      }
    );
    expect(elevated.permissionProfile.level).toBe("PREPARE");
  });

  it("requires approval for privileged creation and safely downgrades clones", async () => {
    const unverified = await fixture();
    await expect(
      unverified.service.create({
        clientId: "client-a",
        permissionProfile: {
          level: "EXECUTE",
          computerUse: "execute",
          approvalRequired: false
        }
      })
    ).rejects.toBeInstanceOf(PermissionEscalationRequiresApprovalError);

    const approvalId = crypto.randomUUID();
    const { service } = await fixture({
      verifyPermissionEscalation: ({ approval, requestedProfile, session }) =>
        approval.approvalId === approvalId &&
        session.permissionProfile.level === "EXECUTE" &&
        requestedProfile.level === "EXECUTE"
    });
    const source = await service.create({
      clientId: "client-a",
      permissionProfile: {
        level: "EXECUTE",
        allowedToolNames: ["ads.mutate"],
        accountRefs: ["account-a"],
        computerUse: "execute",
        approvalRequired: false
      },
      permissionApproval: {
        approvalId,
        approvedBy: "workspace-owner",
        approvedAt: new Date().toISOString()
      }
    });
    expect(source.permissionProfile).toMatchObject({
      level: "EXECUTE",
      computerUse: "execute",
      approvalRequired: false
    });

    const duplicate = await service.duplicate(source.id);
    const branch = await service.branch(source.id);
    for (const clone of [duplicate, branch]) {
      expect(clone.permissionProfile).toEqual({
        level: "OBSERVE",
        allowedToolNames: [],
        blockedToolNames: [],
        accountRefs: [],
        computerUse: "disabled",
        approvalRequired: true
      });
    }
  });

  it("rejects workspace and repository symlink escapes before chmod or write", async () => {
    const outsideWorkspace = await mkdtemp(
      join(tmpdir(), "adpilot-session-outside-workspace-")
    );
    await chmod(outsideWorkspace, 0o755);
    await writeFile(join(outsideWorkspace, "sentinel"), "unchanged", "utf8");
    const linkContainer = await mkdtemp(
      join(tmpdir(), "adpilot-session-workspace-link-")
    );
    const linkedWorkspace = join(linkContainer, "workspace");
    await symlink(outsideWorkspace, linkedWorkspace, "dir");

    await expect(
      WorkspaceWriterLease.acquire(linkedWorkspace)
    ).rejects.toBeInstanceOf(UnsafeWorkspacePathError);
    expect((await stat(outsideWorkspace)).mode & 0o777).toBe(0o755);
    expect(await readdir(outsideWorkspace)).toEqual(["sentinel"]);

    const root = await mkdtemp(join(tmpdir(), "adpilot-session-root-"));
    const outsideRepository = await mkdtemp(
      join(tmpdir(), "adpilot-session-outside-repository-")
    );
    await chmod(outsideRepository, 0o755);
    await writeFile(join(outsideRepository, "sentinel"), "unchanged", "utf8");
    const lease = await WorkspaceWriterLease.acquire(root);
    await symlink(
      outsideRepository,
      join(root, ".adpilot", "sessions"),
      "dir"
    );
    const service = new SessionService(
      new FileSessionRepository(root, { writerLease: lease })
    );
    await expect(
      service.create({ clientId: "client-a" })
    ).rejects.toBeInstanceOf(UnsafeWorkspacePathError);
    expect((await stat(outsideRepository)).mode & 0o777).toBe(0o755);
    expect(await readdir(outsideRepository)).toEqual(["sentinel"]);
    await lease.release();
  });
});
