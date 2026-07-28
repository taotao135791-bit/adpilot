import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type {
  NativeOperator,
  Screenshot,
  VisualAction,
  VisualComputerSessionBinding,
  VisualMicroTask
} from "./index.js";
import {
  BrowserPageIdentityChangedError,
  BrowserPageIdentityState,
  BrowserPageIdentityUnavailableError,
  browserPageMatchesTask,
  sameBrowserPage,
  staleBrowserPageIdentity,
  unavailableBrowserPageIdentity,
  type BrowserPageIdentity,
  type BrowserPageIdentitySource,
  type PageIdentityBinding
} from "./browser-page-identity.js";
import {
  MacOSNativeSurfaceIdentity,
  NativeSurface,
  SurfaceBounds,
  browserProfileFingerprint,
  type NativeSurfaceIdentity
} from "./surface.js";

export const BrowserSessionStatus = z.enum(["starting", "connected", "lost", "closed"]);
export type BrowserSessionStatus = z.infer<typeof BrowserSessionStatus>;

export const BrowserSession = z.object({
  sessionId: z.string().regex(/^[a-f0-9]{32}$/),
  clientId: z.string().min(1),
  browserProfile: z.string().min(1),
  profileDirectory: z.string().min(1),
  nativeProfileFingerprint: z.string().min(1),
  processId: z.number().int().positive().optional(),
  windowId: z.string().min(1).optional(),
  windowBounds: SurfaceBounds.optional(),
  platform: z.string().min(1),
  runtimePlatform: z.enum(["darwin", "win32", "linux"]),
  browserApplicationId: z.string().min(1),
  browserApp: z.string().min(1),
  sessionStatus: BrowserSessionStatus,
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastValidatedAt: z.string().datetime().optional(),
  pageIdentity: BrowserPageIdentityState.optional(),
  lostAt: z.string().datetime().optional(),
  lostReason: z.string().min(1).optional()
}).superRefine((session, context) => {
  if (session.sessionStatus === "connected" && (!session.processId || !session.windowId || !session.windowBounds)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "a connected browser session requires process, window, and bounds bindings" });
  }
});
export type BrowserSession = z.infer<typeof BrowserSession>;

export const StartBrowserSessionInput = z.object({
  clientId: z.string().min(1),
  browserProfile: z.string().min(1),
  platform: z.string().min(1),
  startUrl: z.string().url().optional()
});
export type StartBrowserSessionInput = z.infer<typeof StartBrowserSessionInput>;

export interface BrowserProcessLaunchRequest {
  profileDirectory: string;
  profileName: string;
  startUrl: string;
}

export interface BrowserProcessHandle {
  processId: number;
  applicationId: string;
  appName: string;
  nativeProfileFingerprint: string;
}

export interface BrowserProcessController {
  launch(request: BrowserProcessLaunchRequest): Promise<BrowserProcessHandle>;
  isAlive(processId: number): Promise<boolean>;
  terminate(processId: number): Promise<void>;
}

export interface BrowserSessionStore {
  load(sessionId: string): Promise<BrowserSession | undefined>;
  list(): Promise<BrowserSession[]>;
  save(session: BrowserSession): Promise<void>;
}

/** Local-only durable metadata. Browser Profile contents are never inspected. */
export class FileBrowserSessionStore implements BrowserSessionStore {
  constructor(private readonly directory: string) {}

  async load(sessionId: string): Promise<BrowserSession | undefined> {
    assertSessionId(sessionId);
    try {
      return BrowserSession.parse(JSON.parse(await readFile(join(this.directory, `${sessionId}.json`), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<BrowserSession[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const sessions = await Promise.all(names
      .filter((name) => /^[a-f0-9]{32}\.json$/.test(name))
      .map(async (name) => BrowserSession.parse(JSON.parse(await readFile(join(this.directory, name), "utf8")))));
    return sessions.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async save(session: BrowserSession): Promise<void> {
    const parsed = BrowserSession.parse(session);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = join(this.directory, `${parsed.sessionId}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600);
  }
}

export interface BrowserSessionManagerOptions {
  store?: BrowserSessionStore;
  launcher?: BrowserProcessController;
  surfaceIdentity?: NativeSurfaceIdentity;
  pageIdentity?: BrowserPageIdentitySource;
  now?: () => Date;
  pollAttempts?: number;
  pollIntervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

export class BrowserSessionLostError extends Error {
  readonly code = "BROWSER_SESSION_LOST" as const;

  constructor(
    message: string,
    readonly session?: BrowserSession,
    readonly actualSurface?: NativeSurface
  ) {
    super(message);
    this.name = "BrowserSessionLostError";
  }
}

/**
 * Owns a dedicated native browser process and binds Computer Use to one exact
 * client/Profile/PID/window/bounds tuple. Recovery never silently rebinds.
 */
export class BrowserSessionManager {
  private readonly store: BrowserSessionStore;
  private readonly launcher: BrowserProcessController;
  private readonly surfaceIdentity: NativeSurfaceIdentity | undefined;
  private readonly pageIdentitySource: BrowserPageIdentitySource | undefined;
  private readonly pageIdentities = new Map<string, BrowserPageIdentityState>();
  private readonly now: () => Date;
  private readonly pollAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly profileRoot: string;

  constructor(private readonly workspaceDirectory: string, options: BrowserSessionManagerOptions = {}) {
    this.store = options.store ?? new FileBrowserSessionStore(join(workspaceDirectory, "browser-sessions"));
    this.launcher = options.launcher ?? new SystemBrowserProcessController();
    this.surfaceIdentity = options.surfaceIdentity ?? (process.platform === "darwin" ? new MacOSNativeSurfaceIdentity() : undefined);
    this.pageIdentitySource = options.pageIdentity;
    this.now = options.now ?? (() => new Date());
    this.pollAttempts = options.pollAttempts ?? 40;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
    this.profileRoot = join(workspaceDirectory, "browser-profiles");
    if (!Number.isInteger(this.pollAttempts) || this.pollAttempts < 1) throw new Error("pollAttempts must be a positive integer");
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 0) throw new Error("pollIntervalMs must be a non-negative integer");
  }

  async start(input: StartBrowserSessionInput): Promise<BrowserSession> {
    const parsed = StartBrowserSessionInput.parse(input);
    const existing = await this.find(parsed.clientId, parsed.browserProfile);
    if (existing && existing.sessionStatus === "connected") {
      throw new BrowserSessionLostError("a connected browser session already exists for this client and Profile", existing);
    }
    const sessionId = sessionIdentifier(parsed.clientId, parsed.browserProfile, parsed.platform);
    const profileDirectory = dedicatedProfileDirectory(this.profileRoot, parsed.clientId, parsed.browserProfile, parsed.platform);
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    const startedAt = this.now().toISOString();
    let handle: BrowserProcessHandle;
    try {
      handle = await this.launcher.launch({
        profileDirectory,
        profileName: "Default",
        startUrl: parsed.startUrl ?? platformStartUrl(parsed.platform)
      });
    } catch (error) {
      throw new BrowserSessionLostError(`managed browser could not be launched: ${errorMessage(error)}`);
    }
    let session = BrowserSession.parse({
      sessionId,
      clientId: parsed.clientId,
      browserProfile: parsed.browserProfile,
      profileDirectory,
      nativeProfileFingerprint: handle.nativeProfileFingerprint,
      processId: handle.processId,
      platform: parsed.platform,
      runtimePlatform: runtimePlatform(),
      browserApplicationId: handle.applicationId,
      browserApp: handle.appName,
      sessionStatus: "starting",
      startedAt,
      updatedAt: startedAt
    });
    this.surfaceIdentity?.registerBrowserProfile?.(handle.processId, handle.nativeProfileFingerprint);
    await this.store.save(session);
    try {
      const surface = await this.waitForManagedWindow(handle.processId);
      validateLaunchSurface(session, surface);
      const connectedAt = this.now().toISOString();
      session = BrowserSession.parse({
        ...session,
        windowId: surface.windowId,
        windowBounds: surface.bounds,
        sessionStatus: "connected",
        updatedAt: connectedAt,
        lastValidatedAt: connectedAt
      });
      await this.store.save(session);
      return session;
    } catch (error) {
      const lost = await this.markLost(session, `managed browser window binding failed: ${errorMessage(error)}`);
      throw new BrowserSessionLostError(lost.lostReason ?? "managed browser window binding failed", lost);
    }
  }

  async get(clientId: string, browserProfile?: string): Promise<BrowserSession | undefined> {
    const session = await this.find(clientId, browserProfile);
    return session ? this.withPageIdentity(session) : undefined;
  }

  async list(): Promise<BrowserSession[]> {
    return (await this.store.list()).map((session) => this.withPageIdentity(session));
  }

  /** Validate the current foreground window immediately before every action. */
  async assertActive(clientId: string, browserProfile?: string, platform?: string): Promise<BrowserSession> {
    const session = await this.requireConnected(clientId, browserProfile);
    if (platform && session.platform !== platform) {
      const lost = await this.markLost(session, `platform binding changed (${session.platform} -> ${platform})`);
      throw new BrowserSessionLostError(lost.lostReason!, lost);
    }
    if (!session.processId || !(await this.launcher.isAlive(session.processId))) {
      const lost = await this.markLost(session, "managed browser process is no longer running");
      throw new BrowserSessionLostError(lost.lostReason!, lost);
    }
    this.surfaceIdentity?.registerBrowserProfile?.(session.processId, session.nativeProfileFingerprint);
    let registered: NativeSurface | undefined;
    try { registered = await this.findSurfaceByProcess(session.processId); }
    catch (error) {
      const lost = await this.markLost(session, `managed browser registry is unavailable: ${errorMessage(error)}`);
      throw new BrowserSessionLostError(lost.lostReason!, lost);
    }
    if (!registered) {
      const lost = await this.markLost(session, "managed browser window is closed");
      throw new BrowserSessionLostError(lost.lostReason!, lost);
    }
    const registryMismatch = surfaceBindingMismatch(session, registered);
    if (registryMismatch) {
      const lost = await this.markLost(session, registryMismatch);
      throw new BrowserSessionLostError(lost.lostReason!, lost, registered);
    }
    let active: NativeSurface;
    try { active = await this.identity().identifyActiveSurface(); }
    catch (error) {
      const lost = await this.markLost(session, `active browser identity is unavailable: ${errorMessage(error)}`);
      throw new BrowserSessionLostError(lost.lostReason!, lost);
    }
    const activeMismatch = surfaceBindingMismatch(session, active);
    if (activeMismatch) {
      const lost = await this.markLost(session, `foreground window is not the bound browser: ${activeMismatch}`);
      throw new BrowserSessionLostError(lost.lostReason!, lost, active);
    }
    const validatedAt = this.now().toISOString();
    const validated = BrowserSession.parse({ ...session, lastValidatedAt: validatedAt, updatedAt: validatedAt });
    await this.store.save(validated);
    return validated;
  }

  /**
   * Best-effort fresh page identity for status and Live View. An unavailable
   * result is explicit and never replaced with the browser launch URL.
   */
  async observePageIdentity(
    clientId: string,
    browserProfile?: string,
    platform?: string
  ): Promise<BrowserPageIdentityState> {
    const session = await this.requireConnected(clientId, browserProfile);
    await this.assertRegisteredSurface(session, platform);
    const binding = pageIdentityBinding(session);
    let identity: BrowserPageIdentityState;
    try {
      identity = this.pageIdentitySource
        ? await this.pageIdentitySource.read(binding, { requireFrontmost: false })
        : unavailableBrowserPageIdentity(
            binding,
            "helper_unavailable",
            "the authenticated browser page identity channel is unavailable",
            this.now()
          );
    } catch {
      identity = unavailableBrowserPageIdentity(
        binding,
        "helper_unavailable",
        "the authenticated browser page identity channel could not be read",
        this.now()
      );
    }
    this.pageIdentities.set(session.sessionId, identity);
    return identity;
  }

  /**
   * Mandatory fresh page proof for capture/input. This is fail-closed when
   * Accessibility or the exact address-bar URL cannot be read.
   */
  async assertPageIdentityForTask(
    task: VisualMicroTask,
    expected?: BrowserPageIdentity
  ): Promise<BrowserPageIdentity> {
    if (!task.clientId || !task.surface.browserProfile || !task.platform) {
      throw new BrowserSessionLostError("visual task is missing client, Profile, or platform page binding");
    }
    const session = await this.requireConnected(task.clientId, task.surface.browserProfile);
    if (task.browserSessionId && task.browserSessionId !== session.sessionId) {
      throw new BrowserSessionLostError("visual task browser Session differs from the page identity binding", session);
    }
    if (task.surface.processId !== undefined && task.surface.processId !== session.processId) {
      throw new BrowserSessionLostError("visual task process differs from the page identity binding", session);
    }
    if (task.surface.windowId !== undefined && task.surface.windowId !== session.windowId) {
      throw new BrowserSessionLostError("visual task window differs from the page identity binding", session);
    }
    if (
      task.surface.applicationId !== undefined
      && task.surface.applicationId !== session.browserApplicationId
    ) {
      throw new BrowserSessionLostError("visual task application differs from the page identity binding", session);
    }
    const binding = pageIdentityBinding(session);
    const identity = this.pageIdentitySource
      ? await this.pageIdentitySource.read(binding, { requireFrontmost: true })
      : unavailableBrowserPageIdentity(
          binding,
          "helper_unavailable",
          "the authenticated browser page identity channel is unavailable",
          this.now()
        );
    this.pageIdentities.set(session.sessionId, identity);
    if (identity.status === "unavailable") {
      throw new BrowserPageIdentityUnavailableError(identity);
    }
    if (!browserPageMatchesTask(identity, task.surface)) {
      throw new BrowserPageIdentityUnavailableError(
        unavailableBrowserPageIdentity(
          binding,
          "binding_mismatch",
          "the actual address-bar URL does not match the task page binding",
          this.now()
        )
      );
    }
    if (expected && !sameBrowserPage(expected, identity)) {
      throw new BrowserPageIdentityChangedError(expected, identity);
    }
    return identity;
  }

  invalidatePageIdentity(browserSessionId: string): void {
    const current = this.pageIdentities.get(browserSessionId);
    if (!current) return;
    this.pageIdentities.set(
      browserSessionId,
      staleBrowserPageIdentity(current, this.now())
    );
  }

  /** Capture only after the strict foreground binding check. */
  async captureBoundWindow(clientId: string, browserProfile?: string, platform?: string) {
    const session = await this.assertActive(clientId, browserProfile, platform);
    try {
      const expected = await this.identity().identifyActiveSurface();
      return await this.identity().captureActiveWindow(expected);
    } catch (error) {
      const lost = await this.markLost(session, `bound browser changed while capturing: ${errorMessage(error)}`);
      throw new BrowserSessionLostError(lost.lostReason!, lost);
    }
  }

  /** Validate a just-captured image against the durable binding, closing capture/action races. */
  async assertCapturedSurface(clientId: string, surface: NativeSurface | undefined, browserProfile?: string, platform?: string): Promise<BrowserSession> {
    const session = await this.requireConnected(clientId, browserProfile);
    if (platform && session.platform !== platform) {
      const lost = await this.markLost(session, `platform binding changed (${session.platform} -> ${platform})`);
      throw new BrowserSessionLostError(lost.lostReason!, lost, surface);
    }
    if (!surface) {
      const lost = await this.markLost(session, "captured screenshot has no native browser identity");
      throw new BrowserSessionLostError(lost.lostReason!, lost);
    }
    const mismatch = surfaceBindingMismatch(session, surface);
    if (mismatch) {
      const lost = await this.markLost(session, `captured window is not the bound browser: ${mismatch}`);
      throw new BrowserSessionLostError(lost.lostReason!, lost, surface);
    }
    return session;
  }

  /**
   * Restore durable sessions after application restart. Only the original live
   * process and exact original window/Profile may reconnect.
   */
  async recover(): Promise<BrowserSession[]> {
    const recovered: BrowserSession[] = [];
    for (const session of await this.store.list()) {
      if (session.sessionStatus !== "connected" && session.sessionStatus !== "starting") continue;
      if (!session.processId || !(await this.launcher.isAlive(session.processId))) {
        recovered.push(await this.markLost(session, "managed browser process did not survive application restart"));
        continue;
      }
      this.surfaceIdentity?.registerBrowserProfile?.(session.processId, session.nativeProfileFingerprint);
      let surface: NativeSurface | undefined;
      try { surface = await this.findSurfaceByProcess(session.processId); }
      catch (error) {
        recovered.push(await this.markLost(session, `native browser recovery failed: ${errorMessage(error)}`));
        continue;
      }
      if (!surface) {
        recovered.push(await this.markLost(session, "managed browser window was not found after application restart"));
        continue;
      }
      const mismatch = surfaceBindingMismatch(session, surface);
      if (mismatch) {
        recovered.push(await this.markLost(session, `browser restart recovery rejected: ${mismatch}`));
        continue;
      }
      const recoveredAt = this.now().toISOString();
      const active = BrowserSession.parse({ ...session, sessionStatus: "connected", updatedAt: recoveredAt, lastValidatedAt: recoveredAt });
      await this.store.save(active);
      recovered.push(active);
    }
    return recovered;
  }

  /** Explicit user recovery; it never adopts a replacement process or window. */
  async resume(clientId: string, browserProfile?: string): Promise<BrowserSession> {
    const session = await this.find(clientId, browserProfile);
    if (!session || session.sessionStatus !== "lost" || !session.processId) {
      throw new BrowserSessionLostError("no lost browser session is available for explicit recovery", session);
    }
    if (!(await this.launcher.isAlive(session.processId))) throw new BrowserSessionLostError("the original browser process is no longer running", session);
    this.surfaceIdentity?.registerBrowserProfile?.(session.processId, session.nativeProfileFingerprint);
    let surface: NativeSurface;
    try { surface = await this.identity().identifyActiveSurface(); }
    catch (error) { throw new BrowserSessionLostError(`active browser identity is unavailable: ${errorMessage(error)}`, session); }
    const mismatch = surfaceBindingMismatch(session, surface);
    if (mismatch) throw new BrowserSessionLostError(`browser recovery rejected: ${mismatch}`, session, surface);
    const resumedAt = this.now().toISOString();
    const resumed = BrowserSession.parse({
      ...session,
      sessionStatus: "connected",
      updatedAt: resumedAt,
      lastValidatedAt: resumedAt,
      lostAt: undefined,
      lostReason: undefined
    });
    await this.store.save(resumed);
    return resumed;
  }

  async close(clientId: string, browserProfile?: string): Promise<BrowserSession> {
    const session = await this.find(clientId, browserProfile);
    if (!session) throw new BrowserSessionLostError("browser session does not exist");
    if (session.processId && await this.launcher.isAlive(session.processId)) await this.launcher.terminate(session.processId);
    if (session.processId) this.surfaceIdentity?.forgetBrowserProfile?.(session.processId);
    this.pageIdentities.delete(session.sessionId);
    const updatedAt = this.now().toISOString();
    const closed = BrowserSession.parse({ ...session, sessionStatus: "closed", updatedAt });
    await this.store.save(closed);
    return closed;
  }

  private identity(): NativeSurfaceIdentity {
    if (!this.surfaceIdentity) throw new BrowserSessionLostError(`native browser identity is unavailable on ${process.platform}`);
    return this.surfaceIdentity;
  }

  private async waitForManagedWindow(processId: number): Promise<NativeSurface> {
    for (let attempt = 1; attempt <= this.pollAttempts; attempt += 1) {
      const surface = await this.findSurfaceByProcess(processId);
      if (surface) return surface;
      if (attempt < this.pollAttempts) await this.wait(this.pollIntervalMs);
    }
    throw new Error(`no browser window appeared for process ${processId}`);
  }

  private async findSurfaceByProcess(processId: number): Promise<NativeSurface | undefined> {
    const identity = this.identity();
    if (identity.identifySurfaceByProcess) return identity.identifySurfaceByProcess(processId);
    const active = await identity.identifyActiveSurface().catch(() => undefined);
    return active?.pid === processId ? active : undefined;
  }

  private async assertRegisteredSurface(
    session: BrowserSession,
    platform?: string
  ): Promise<void> {
    if (platform && session.platform !== platform) {
      const lost = await this.markLost(session, `platform binding changed (${session.platform} -> ${platform})`);
      throw new BrowserSessionLostError(lost.lostReason!, lost);
    }
    if (!session.processId || !(await this.launcher.isAlive(session.processId))) {
      const lost = await this.markLost(session, "managed browser process is no longer running");
      throw new BrowserSessionLostError(lost.lostReason!, lost);
    }
    this.surfaceIdentity?.registerBrowserProfile?.(
      session.processId,
      session.nativeProfileFingerprint
    );
    let registered: NativeSurface | undefined;
    try {
      registered = await this.findSurfaceByProcess(session.processId);
    } catch (error) {
      const lost = await this.markLost(
        session,
        `managed browser registry is unavailable: ${errorMessage(error)}`
      );
      throw new BrowserSessionLostError(lost.lostReason!, lost);
    }
    if (!registered) {
      const lost = await this.markLost(session, "managed browser window is closed");
      throw new BrowserSessionLostError(lost.lostReason!, lost);
    }
    const mismatch = surfaceBindingMismatch(session, registered);
    if (mismatch) {
      const lost = await this.markLost(session, mismatch);
      throw new BrowserSessionLostError(lost.lostReason!, lost, registered);
    }
  }

  private async find(clientId: string, browserProfile?: string): Promise<BrowserSession | undefined> {
    if (!clientId) throw new Error("clientId is required");
    const matches = (await this.store.list()).filter((session) => session.clientId === clientId && (!browserProfile || session.browserProfile === browserProfile));
    if (matches.length > 1 && !browserProfile) throw new BrowserSessionLostError("client has multiple browser Profiles; an exact Profile is required");
    return matches[0];
  }

  private async requireConnected(clientId: string, browserProfile?: string): Promise<BrowserSession> {
    const session = await this.find(clientId, browserProfile);
    if (!session || session.sessionStatus !== "connected") {
      throw new BrowserSessionLostError(`bound browser session is not connected${session?.lostReason ? `: ${session.lostReason}` : ""}`, session);
    }
    return session;
  }

  private async markLost(session: BrowserSession, reason: string): Promise<BrowserSession> {
    const lostAt = this.now().toISOString();
    const lost = BrowserSession.parse({ ...session, sessionStatus: "lost", lostAt, lostReason: reason, updatedAt: lostAt });
    this.pageIdentities.delete(session.sessionId);
    await this.store.save(lost);
    return lost;
  }

  private withPageIdentity(session: BrowserSession): BrowserSession {
    const pageIdentity = this.pageIdentities.get(session.sessionId);
    return pageIdentity
      ? BrowserSession.parse({ ...session, pageIdentity })
      : session;
  }
}

/** Native operator guard for a single client browser binding. */
export class BrowserSessionBoundOperator implements NativeOperator {
  private readonly binding: { clientId: string; browserProfile: string; platform: string } | undefined;
  private readonly fixedBinding: boolean;
  private readonly capturedPages = new Map<string, BrowserPageIdentity>();

  constructor(
    private readonly underlying: NativeOperator,
    private readonly sessions: BrowserSessionManager,
    clientId?: string,
    browserProfile?: string,
    platform?: string
  ) {
    const supplied = [clientId, browserProfile, platform].filter((value) => value !== undefined).length;
    if (supplied !== 0 && supplied !== 3) throw new Error("fixed browser binding requires client, Profile, and platform");
    this.fixedBinding = supplied === 3;
    if (clientId && browserProfile && platform) this.binding = { clientId, browserProfile, platform };
  }

  bindTask(task: VisualMicroTask): void {
    this.bindingFor(task);
  }

  async capture(task?: VisualMicroTask): Promise<Screenshot> {
    const binding = this.bindingFor(task);
    await this.sessions.assertActive(binding.clientId, binding.browserProfile, binding.platform);
    const pageIdentity = task
      ? await this.sessions.assertPageIdentityForTask(task)
      : undefined;
    const screenshot = await this.underlying.capture(task);
    await this.sessions.assertCapturedSurface(binding.clientId, screenshot.surface, binding.browserProfile, binding.platform);
    if (task && pageIdentity) {
      this.capturedPages.set(pageEvidenceKey(task), pageIdentity);
    }
    return screenshot;
  }

  async execute(action: VisualAction, screenshot: Screenshot, task?: VisualMicroTask, signal?: AbortSignal): Promise<void> {
    const binding = this.bindingFor(task);
    await this.sessions.assertActive(binding.clientId, binding.browserProfile, binding.platform);
    await this.sessions.assertCapturedSurface(binding.clientId, screenshot.surface, binding.browserProfile, binding.platform);
    if (task) {
      const evidence = this.capturedPages.get(pageEvidenceKey(task));
      if (!evidence) {
        const session = await this.sessions.get(binding.clientId, binding.browserProfile);
        if (!session) {
          throw new BrowserSessionLostError("browser session is unavailable before page identity validation");
        }
        throw new BrowserPageIdentityUnavailableError(
          unavailableBrowserPageIdentity(
            pageIdentityBinding(session),
            "stale_after_control_change",
            "native input requires fresh page identity from the exact capture"
          )
        );
      }
      await this.sessions.assertPageIdentityForTask(task, evidence);
    }
    await this.underlying.execute(action, screenshot, task, signal);
  }

  async identifySurface(task?: VisualMicroTask) {
    const binding = this.bindingFor(task);
    await this.sessions.assertActive(binding.clientId, binding.browserProfile, binding.platform);
    if (this.underlying.identifySurface) return this.underlying.identifySurface(task);
    const screenshot = await this.capture(task);
    if (!screenshot.surface || !screenshot.surfaceFingerprint) {
      throw new BrowserSessionLostError("bound browser operator cannot prove a native surface");
    }
    return { surface: screenshot.surface, fingerprint: screenshot.surfaceFingerprint };
  }

  cancelPendingInput(session?: VisualComputerSessionBinding): void | Promise<void> {
    if (session) {
      this.sessions.invalidatePageIdentity(session.browserSessionId);
      for (const [key, page] of this.capturedPages) {
        if (page.browserSessionId === session.browserSessionId) {
          this.capturedPages.delete(key);
        }
      }
    } else {
      for (const page of this.capturedPages.values()) {
        this.sessions.invalidatePageIdentity(page.browserSessionId);
      }
      this.capturedPages.clear();
    }
    return this.underlying.cancelPendingInput?.(session);
  }

  private bindingFor(task?: VisualMicroTask): { clientId: string; browserProfile: string; platform: string } {
    const requested = task?.clientId && task.surface.browserProfile && task.platform
      ? { clientId: task.clientId, browserProfile: task.surface.browserProfile, platform: task.platform }
      : undefined;
    if (this.fixedBinding) {
      if (requested && JSON.stringify(requested) !== JSON.stringify(this.binding)) {
        throw new BrowserSessionLostError("visual task attempted to replace a fixed browser-session binding");
      }
      if (!this.binding) throw new BrowserSessionLostError("fixed browser-session binding is unavailable");
      return this.binding;
    }
    if (!requested) {
      throw new BrowserSessionLostError("visual task is missing client, Profile, or platform browser binding");
    }
    return requested;
  }
}

export interface SystemBrowserProcessControllerOptions {
  executablePath?: string;
  applicationId?: string;
  appName?: string;
}

/** Launches an installed desktop browser with a dedicated data directory and window. */
export class SystemBrowserProcessController implements BrowserProcessController {
  constructor(private readonly options: SystemBrowserProcessControllerOptions = {}) {}

  async launch(request: BrowserProcessLaunchRequest): Promise<BrowserProcessHandle> {
    const executable = this.options.executablePath ?? await findBrowserExecutable();
    const browser = browserIdentity(executable, this.options);
    const args = [
      `--user-data-dir=${request.profileDirectory}`,
      `--profile-directory=${request.profileName}`,
      "--new-window",
      "--no-first-run",
      request.startUrl
    ];
    const child = spawn(executable, args, { detached: false, stdio: "ignore" });
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      child.once("spawn", resolveLaunch);
      child.once("error", rejectLaunch);
    });
    if (!child.pid) throw new Error("browser process did not expose a PID");
    child.unref();
    return {
      processId: child.pid,
      applicationId: browser.applicationId,
      appName: browser.appName,
      nativeProfileFingerprint: browserProfileFingerprint(request.profileDirectory, request.profileName)
    };
  }

  async isAlive(processId: number): Promise<boolean> {
    try {
      process.kill(processId, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  async terminate(processId: number): Promise<void> {
    try { process.kill(processId, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

function validateLaunchSurface(session: BrowserSession, surface: NativeSurface): void {
  const mismatch = surfaceBindingMismatch(session, surface, false);
  if (mismatch) throw new Error(mismatch);
}

function surfaceBindingMismatch(session: BrowserSession, surface: NativeSurface, requireWindowBinding = true): string | undefined {
  if (session.runtimePlatform !== surface.platform) return `runtime platform changed (${session.runtimePlatform} -> ${surface.platform})`;
  if (session.processId !== surface.pid) return `process ID changed (${session.processId ?? "missing"} -> ${surface.pid})`;
  if (surface.bundleId) {
    if (session.browserApplicationId !== surface.bundleId) return `browser application changed (${session.browserApplicationId} -> ${surface.bundleId})`;
  } else if (session.browserApp !== surface.app) {
    return `browser application changed (${session.browserApp} -> ${surface.app})`;
  }
  if (!surface.browserProfile) return "browser Profile could not be proven from the native process";
  if (session.nativeProfileFingerprint !== surface.browserProfile) return `browser Profile changed (${session.nativeProfileFingerprint} -> ${surface.browserProfile})`;
  if (requireWindowBinding && session.windowId !== surface.windowId) return `window ID changed (${session.windowId ?? "missing"} -> ${surface.windowId})`;
  if (requireWindowBinding && (!session.windowBounds || !sameBounds(session.windowBounds, surface.bounds))) return "window bounds changed";
  return undefined;
}

function sameBounds(left: z.infer<typeof SurfaceBounds>, right: z.infer<typeof SurfaceBounds>): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function dedicatedProfileDirectory(root: string, clientId: string, browserProfile: string, platform: string): string {
  const key = createHash("sha256").update(`${clientId}\u0000${browserProfile}\u0000${platform}`).digest("hex").slice(0, 32);
  const directory = resolve(root, key);
  const safeRoot = `${resolve(root)}/`;
  if (!`${directory}/`.startsWith(safeRoot)) throw new Error("dedicated Profile directory escaped its local root");
  return directory;
}

function sessionIdentifier(clientId: string, browserProfile: string, platform: string): string {
  return createHash("sha256").update(`${clientId}\u0000${browserProfile}\u0000${platform}`).digest("hex").slice(0, 32);
}

function assertSessionId(sessionId: string): void {
  if (!/^[a-f0-9]{32}$/.test(sessionId)) throw new Error("invalid browser session ID");
}

function platformStartUrl(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized === "google_ads" || normalized === "google-ads") return "https://ads.google.com/";
  if (normalized === "meta_ads" || normalized === "meta-ads") return "https://business.facebook.com/adsmanager/";
  if (normalized === "tiktok_ads" || normalized === "tiktok-ads") return "https://ads.tiktok.com/";
  return "about:blank";
}

function runtimePlatform(): "darwin" | "win32" | "linux" {
  if (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux") return process.platform;
  return "linux";
}

async function findBrowserExecutable(): Promise<string> {
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
      ]
    : process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/microsoft-edge", "/usr/bin/brave-browser", "/usr/bin/chromium"];
  for (const candidate of candidates) {
    try { await access(candidate, fsConstants.X_OK); return candidate; }
    catch { /* continue */ }
  }
  throw new Error("no supported installed desktop browser was found");
}

function browserIdentity(executable: string, overrides: SystemBrowserProcessControllerOptions): { applicationId: string; appName: string } {
  if (overrides.applicationId && overrides.appName) return { applicationId: overrides.applicationId, appName: overrides.appName };
  const lower = executable.toLowerCase();
  if (lower.includes("microsoft edge") || lower.includes("msedge")) return { applicationId: overrides.applicationId ?? "com.microsoft.edgemac", appName: overrides.appName ?? "Microsoft Edge" };
  if (lower.includes("brave")) return { applicationId: overrides.applicationId ?? "com.brave.Browser", appName: overrides.appName ?? "Brave Browser" };
  if (lower.includes("chromium")) return { applicationId: overrides.applicationId ?? "org.chromium.Chromium", appName: overrides.appName ?? "Chromium" };
  return { applicationId: overrides.applicationId ?? "com.google.Chrome", appName: overrides.appName ?? "Google Chrome" };
}

function pageIdentityBinding(session: BrowserSession): PageIdentityBinding {
  if (!session.processId || !session.windowId) {
    throw new BrowserSessionLostError("connected browser session has no page identity binding", session);
  }
  return {
    browserSessionId: session.sessionId,
    clientId: session.clientId,
    browserProfile: session.browserProfile,
    nativeProfileFingerprint: session.nativeProfileFingerprint,
    processId: session.processId,
    windowId: session.windowId,
    applicationId: session.browserApplicationId
  };
}

function pageEvidenceKey(task: VisualMicroTask): string {
  return createHash("sha256")
    .update([
      task.adPilotSessionId ?? "",
      task.browserSessionId ?? "",
      task.clientId ?? "",
      task.surface.browserProfile ?? "",
      task.taskId ?? "",
      task.stepId ?? "",
      task.planId ?? "",
      task.instruction
    ].join("\u0000"))
    .digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
