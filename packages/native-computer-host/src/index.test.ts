import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  NativeComputerHost,
  NativeComputerHostSupervisor,
  NativeComputerHostError,
  NativeHelperErrorSchema,
  NativeHostAbortError,
  NativeHostClosedError,
  NativeHostOutcomeUnknownError,
  NativeHostQueueFullError,
  NativeHostRemoteError,
  NativeHostTimeoutError,
  resolveNativeHelperExecutable,
  type NativeComputerHostOptions,
  type NativeHostLogger,
  type NativeWindowSurfaceLease
} from "./index.js";

const fakeHelper = String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const config = JSON.parse(process.argv[1] || "{}");
const token = process.env.ADPILOT_NATIVE_HELPER_TOKEN;
let lastSequence = 0;
const claimedActions = new Set();
const actionMethods = new Set([
  "application.activate", "window.focus", "window.close", "input.move", "input.click",
  "input.drag", "input.type", "input.keypress", "input.scroll"
]);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const success = (request, result) => send({
  protocolVersion: 3, id: request.id, sequence: request.sequence, ok: true, result
});
const failure = (request, code, message, retryable = false, details) => send({
  protocolVersion: 3, id: request.id, sequence: request.sequence, ok: false,
  error: { code, message, retryable, ...(details === undefined ? {} : { details }) }
});
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.authToken !== token) {
    failure(request, "UNAUTHORIZED", "bad token");
    return;
  }
  if (!Number.isSafeInteger(request.deadlineUnixMs) || request.deadlineUnixMs < Date.now()) {
    failure(request, "DEADLINE_EXCEEDED", "expired");
    return;
  }
  if (request.sequence <= lastSequence) {
    failure(request, "SEQUENCE_VIOLATION", "bad sequence");
    return;
  }
  lastSequence = request.sequence;
  if (actionMethods.has(request.method)) {
    const actionKey = request.sessionId + "\n" + request.actionId;
    if (claimedActions.has(actionKey)) {
      failure(request, "ACTION_REPLAY_DETECTED", "action already claimed");
      return;
    }
    claimedActions.add(actionKey);
  }
  if (request.method === config.hangMethod) return;
  if (request.method === config.exitMethod) {
    if (!config.exitOnceFile || !fs.existsSync(config.exitOnceFile)) {
      if (config.exitOnceFile) fs.writeFileSync(config.exitOnceFile, "exited");
      process.exit(0);
    }
  }
  if (request.method === "hello") {
    success(request, {
      protocolVersion: 3, helperVersion: "fake-3", pid: process.pid, platform: "darwin",
      capabilities: [
        "hello", "permissions.status", "permissions.request", "permissions.openSettings",
        "displays.list", "windows.list", "frontmost", "application.activate", "window.focus", "window.close",
        "accessibility.snapshot", "accessibility.focusedElement", "capture", "input.activity",
        "input.move", "input.click", "input.drag", "input.type", "input.keypress",
        "input.scroll", "wait"
      ],
      identity: config.identity || {
        pid: process.pid,
        bundleIdentifier: "",
        bundleName: "Fake AdPilot Helper",
        executableName: "node",
        signingIdentifier: ""
      }
    });
    if (config.closeInputAfterHello) {
      rl.close();
      process.stdin.destroy();
      setInterval(() => {}, 1_000);
    }
    return;
  }
  if (request.method === "permissions.status") {
    success(request, {
      screenCapture: { state: "granted", granted: true },
      accessibility: { state: "notGranted", granted: false }
    });
    return;
  }
  if (request.method === "frontmost" && config.leakToken) {
    failure(request, "TEST_FAILURE", "helper leaked " + token, false, { authToken: token });
    return;
  }
  if (request.method === "frontmost") {
    success(request, {
      ownerPid: 42, ownerName: "Browser", bundleId: "com.example.browser", window: null
    });
    return;
  }
  if (request.method === "windows.list" && config.remoteError) {
    failure(request, "WINDOW_QUERY_FAILED", "window server unavailable", true, { subsystem: "CG" });
    return;
  }
  if (request.method === "windows.list") {
    success(request, []);
    return;
  }
  if (request.method === "input.type") {
    if (config.wrongSequenceMethod === request.method) {
      send({
        protocolVersion: 3,
        id: request.id,
        sequence: request.sequence + 1,
        ok: true,
        result: { posted: true, eventCount: 2, utf8Bytes: 1 }
      });
      return;
    }
    if (config.invalidInputResult) {
      success(request, { posted: false, eventCount: 1 });
      return;
    }
    success(request, {
      posted: true, eventCount: 2, utf8Bytes: Buffer.byteLength(request.params.text, "utf8")
    });
    return;
  }
  failure(request, "TEST_UNSUPPORTED", "fake method is unsupported");
});
`;

const surfaceLease: NativeWindowSurfaceLease = {
  generation: "00000000-0000-4000-8000-000000000001",
  sessionId: "session-test",
  target: "window",
  windowId: 77,
  ownerPid: 42,
  bundleId: "com.example.browser",
  bounds: { x: 100, y: 50, width: 800, height: 600 },
  capturePixels: { width: 1_600, height: 1_200 },
  capturedAtUnixMs: 1_700_000_000_000,
  expiresAtUnixMs: 4_000_000_000_000
};

type FakeConfig = {
  closeInputAfterHello?: boolean;
  exitMethod?: string;
  exitOnceFile?: string;
  hangMethod?: string;
  invalidInputResult?: boolean;
  identity?: {
    pid: number;
    bundleIdentifier: string;
    bundleName: string;
    executableName: string;
    signingIdentifier: string;
  };
  leakToken?: boolean;
  remoteError?: boolean;
  wrongSequenceMethod?: string;
};

type LogEntry = {
  level: "debug" | "warn";
  event: string;
  fields: Readonly<Record<string, unknown>>;
};

function logger(entries: LogEntry[]): NativeHostLogger {
  return {
    debug: (event, fields) => entries.push({ level: "debug", event, fields }),
    warn: (event, fields) => entries.push({ level: "warn", event, fields })
  };
}

async function launch(
  config: FakeConfig = {},
  entries: LogEntry[] = [],
  options: Pick<
    NativeComputerHostOptions,
    "maxQueueDepth" | "env" | "expectedIdentity"
  > = {}
): Promise<NativeComputerHost> {
  return NativeComputerHost.launch({
    executablePath: process.execPath,
    args: ["-e", fakeHelper, JSON.stringify(config)],
    defaultTimeoutMs: 1_000,
    sessionId: "session-test",
    logger: logger(entries),
    ...options
  });
}

async function launchSupervisor(
  config: FakeConfig = {},
  entries: LogEntry[] = []
): Promise<NativeComputerHostSupervisor> {
  return NativeComputerHostSupervisor.launch({
    executablePath: process.execPath,
    args: ["-e", fakeHelper, JSON.stringify(config)],
    defaultTimeoutMs: 1_000,
    sessionId: "session-test",
    logger: logger(entries)
  });
}

describe("NativeComputerHost protocol actor", () => {
  it("authenticates internally, sends absolute deadlines, and serializes commands", async () => {
    const entries: LogEntry[] = [];
    const host = await launch({}, entries);
    const [permissions, frontmost] = await Promise.all([
      host.request("permissions.status", {}),
      host.request("frontmost", {})
    ]);

    expect(permissions).toEqual({
      screenCapture: { state: "granted", granted: true },
      accessibility: { state: "notGranted", granted: false }
    });
    expect(frontmost).toMatchObject({ ownerPid: 42, bundleId: "com.example.browser" });
    const requests = entries.filter((entry) => entry.event === "native-helper.request");
    expect(requests.map((entry) => entry.fields.sequence)).toEqual([1, 2, 3]);
    expect(requests.every((entry) => Number(entry.fields.deadlineUnixMs) > 0)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("authToken");
    await host.close();
  });

  it("relaunches one authenticated Helper actor after a crash and replays only a safe read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adpilot-native-supervisor-"));
    const exitOnceFile = join(directory, "exited");
    const entries: LogEntry[] = [];
    const supervisor = await launchSupervisor({ exitMethod: "frontmost", exitOnceFile }, entries);
    try {
      const firstPid = supervisor.pid;
      await expect(supervisor.request("frontmost", {})).resolves.toMatchObject({
        ownerPid: 42,
        bundleId: "com.example.browser"
      });
      expect(supervisor.epoch).toBe(2);
      expect(supervisor.pid).not.toBe(firstPid);
      expect(entries.filter((entry) => entry.event === "native-helper.request"
        && entry.fields.method === "hello")).toHaveLength(2);
      expect(entries.filter((entry) => entry.event === "native-helper.request"
        && entry.fields.method === "frontmost")).toHaveLength(2);
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rotates a crashed Helper but never replays native input with an unknown outcome", async () => {
    const entries: LogEntry[] = [];
    const supervisor = await launchSupervisor({ exitMethod: "input.type" }, entries);
    try {
      await expect(supervisor.request(
        "input.type",
        { text: "value", surfaceLease },
        { sessionId: "session-test", actionId: "never-replay" }
      )).rejects.toBeInstanceOf(NativeHostOutcomeUnknownError);
      expect(supervisor.epoch).toBe(2);
      expect(entries.filter((entry) => entry.event === "native-helper.request"
        && entry.fields.method === "input.type")).toHaveLength(1);
      await expect(supervisor.request("frontmost", {})).resolves.toMatchObject({ ownerPid: 42 });
    } finally {
      await supervisor.close();
    }
  });

  it("binds every action to an explicit session and action id", async () => {
    const entries: LogEntry[] = [];
    const host = await launch({}, entries);
    await host.request(
      "input.type",
      { text: "value", surfaceLease },
      { sessionId: "session-test", actionId: "action-explicit" }
    );
    const request = entries.find(
      (entry) => entry.event === "native-helper.request"
        && entry.fields.method === "input.type"
    );
    expect(request?.fields).toMatchObject({
      sessionId: "session-test",
      actionId: "action-explicit"
    });
    await host.close();
  });

  it("never permits the same semantic action id to execute twice", async () => {
    const host = await launch();
    const options = {
      sessionId: "session-test",
      actionId: "mutation-once"
    } as const;
    await expect(
      host.request("input.type", { text: "first", surfaceLease }, options)
    ).resolves.toMatchObject({ posted: true });
    await expect(
      host.request("input.type", { text: "second", surfaceLease }, options)
    ).rejects.toMatchObject({
      code: "ACTION_REPLAY_DETECTED",
      retryable: false
    });
    expect(host.closed).toBe(false);
    await host.close();
  });

  it("rejects a surface lease from another session before writing input", async () => {
    const entries: LogEntry[] = [];
    const host = await launch({}, entries);
    await expect(
      host.request(
        "input.click",
        { pixelX: 10, pixelY: 10, surfaceLease },
        { sessionId: "different-session", actionId: "wrong-session-action" }
      )
    ).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
    expect(
      entries.some(
        (entry) => entry.event === "native-helper.request"
          && entry.fields.actionId === "wrong-session-action"
      )
    ).toBe(false);
    expect(host.closed).toBe(false);
    await host.close();
  });

  it("enforces the packaged helper bundle and signing identity at handshake", async () => {
    await expect(
      launch(
        {
          identity: {
            pid: 42,
            bundleIdentifier: "com.attacker.helper",
            bundleName: "Attacker",
            executableName: "node",
            signingIdentifier: "com.attacker.helper"
          }
        },
        [],
        {
          expectedIdentity: {
            bundleIdentifier: "com.adpilot.computer-helper",
            signingIdentifier: "com.adpilot.computer-helper"
          }
        }
      )
    ).rejects.toMatchObject({ code: "HELPER_IDENTITY_MISMATCH" });
  });

  it("resolves and validates an explicit helper executable without fallback", async () => {
    await expect(
      resolveNativeHelperExecutable({ explicitPath: "relative/helper" })
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(
      resolveNativeHelperExecutable({ explicitPath: process.execPath })
    ).resolves.toBe(process.execPath);
  });

  it("rejects caller-supplied authentication fields before writing a command", async () => {
    const host = await launch();
    await expect(
      host.request("hello", { authToken: "caller-controlled" } as never)
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(host.request("permissions.status", {})).resolves.toMatchObject({
      screenCapture: { granted: true }
    });
    await host.close();
  });

  it("preserves structured remote errors and redacts helper token leaks", async () => {
    const entries: LogEntry[] = [];
    const host = await launch({ leakToken: true }, entries);
    const error = await host.request("frontmost", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeHostRemoteError);
    expect(error).toMatchObject({
      code: "TEST_FAILURE",
      retryable: false,
      message: "helper leaked [REDACTED]",
      details: { authToken: "[REDACTED]" }
    });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("ADPILOT_NATIVE_HELPER_TOKEN");
    expect(serialized).not.toContain("helper leaked");
    await host.close();
  });

  it("returns retryability and details from structured helper failures", async () => {
    const host = await launch({ remoteError: true });
    await expect(host.request("windows.list", {})).rejects.toMatchObject({
      code: "WINDOW_QUERY_FAILED",
      retryable: true,
      details: { subsystem: "CG" }
    });
    await host.close();
  });

  it("kills the actor on a read-only timeout", async () => {
    const host = await launch({ hangMethod: "capture" });
    await expect(
      host.request("capture", { target: "screen" }, { timeoutMs: 25 })
    ).rejects.toBeInstanceOf(NativeHostTimeoutError);
    expect(host.closed).toBe(true);
    await expect(host.request("frontmost", {})).rejects.toBeInstanceOf(NativeHostClosedError);
    await host.close();
  });

  it("marks an in-flight input timeout outcome unknown and never permits automatic retry", async () => {
    const entries: LogEntry[] = [];
    const host = await launch({ hangMethod: "input.type" }, entries);
    const error = await host.request(
      "input.type",
      { text: "private typed value", surfaceLease },
      { timeoutMs: 25 }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NativeHostOutcomeUnknownError);
    expect(error).toMatchObject({
      code: "OUTCOME_UNKNOWN",
      retryable: false,
      outcomeUnknown: true,
      method: "input.type"
    });
    expect(host.closed).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("private typed value");
    await host.close();
  });

  it("marks an aborted in-flight input outcome unknown", async () => {
    const host = await launch({ hangMethod: "input.type" });
    const controller = new AbortController();
    const pending = host.request(
      "input.type",
      { text: "value", surfaceLease },
      { signal: controller.signal }
    );
    controller.abort(new Error("user takeover"));

    await expect(pending).rejects.toBeInstanceOf(NativeHostOutcomeUnknownError);
    await host.close();
  });

  it("marks a mutation outcome unknown when its success result is not trustworthy", async () => {
    const host = await launch({ invalidInputResult: true });
    const error = await host.request(
      "input.type",
      { text: "value", surfaceLease }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NativeHostOutcomeUnknownError);
    expect(error).toMatchObject({
      code: "OUTCOME_UNKNOWN",
      retryable: false,
      outcomeUnknown: true,
      method: "input.type"
    });
    expect(host.closed).toBe(true);
    await host.close();
  });

  it("marks a written mutation outcome unknown when the helper disconnects", async () => {
    const host = await launch({ exitMethod: "input.type" });
    const error = await host.request(
      "input.type",
      { text: "value", surfaceLease }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NativeHostOutcomeUnknownError);
    expect(error).toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: false });
    expect(host.closed).toBe(true);
    await host.close();
  });

  it("marks a written mutation outcome unknown when response correlation fails", async () => {
    const host = await launch({ wrongSequenceMethod: "input.type" });
    const error = await host.request(
      "input.type",
      { text: "value", surfaceLease }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NativeHostOutcomeUnknownError);
    expect(error).toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: false });
    expect(host.closed).toBe(true);
    await host.close();
  });

  it("marks a mutation outcome unknown when the helper closes its input pipe", async () => {
    const host = await launch({ closeInputAfterHello: true });
    const error = await host.request(
      "input.type",
      { text: "value", surfaceLease },
      { timeoutMs: 500 }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NativeHostOutcomeUnknownError);
    expect(error).toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: false });
    expect(host.closed).toBe(true);
    await host.close();
  });

  it("aborts queued commands definitely without killing the active actor", async () => {
    const host = await launch({ hangMethod: "frontmost" });
    const active = host.request("frontmost", {}, { timeoutMs: 500 })
      .catch((error: unknown) => error);
    const controller = new AbortController();
    const queued = host.request("permissions.status", {}, { signal: controller.signal });
    controller.abort();

    await expect(queued).rejects.toBeInstanceOf(NativeHostAbortError);
    expect(host.closed).toBe(false);
    await host.close();
    expect(await active).toBeInstanceOf(NativeHostClosedError);
  });

  it("enforces a bounded queue", async () => {
    const host = await launch({ hangMethod: "frontmost" }, [], { maxQueueDepth: 2 });
    const active = host.request("frontmost", {}, { timeoutMs: 500 })
      .catch((error: unknown) => error);
    const queued = host.request("permissions.status", {})
      .catch((error: unknown) => error);
    await expect(host.request("windows.list", {})).rejects.toBeInstanceOf(
      NativeHostQueueFullError
    );
    await host.close();
    const [activeResult, queuedResult] = await Promise.all([active, queued]);
    expect(activeResult).toBeInstanceOf(NativeHostClosedError);
    expect(queuedResult).toBeInstanceOf(NativeHostClosedError);
  });

  it("validates surface coordinates and scroll constraints before contacting the helper", async () => {
    const host = await launch();
    await expect(
      host.request("input.click", {
        pixelX: 1_600,
        pixelY: 0,
        surfaceLease
      })
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(
      host.request("input.scroll", {
        deltaX: 0,
        deltaY: 0,
        pixelX: 100,
        pixelY: 100,
        surfaceLease
      })
    ).rejects.toBeInstanceOf(z.ZodError);
    await host.close();
  });

  it("uses a strict helper environment allowlist", async () => {
    await expect(
      launch({}, [], { env: { HOME: "/attacker-controlled" } })
    ).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });
  });

  it("rejects symlinked and group-writable helper executables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adpilot-native-host-"));
    try {
      const linked = join(directory, "linked-helper");
      await symlink(process.execPath, linked);
      await expect(
        NativeComputerHost.launch({ executablePath: linked })
      ).rejects.toMatchObject({ code: "INVALID_HELPER_EXECUTABLE" });

      const writable = join(directory, "writable-helper");
      await writeFile(writable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await chmod(writable, 0o775);
      await expect(
        NativeComputerHost.launch({ executablePath: writable })
      ).rejects.toMatchObject({ code: "INVALID_HELPER_EXECUTABLE" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes configuration failures as typed host errors", async () => {
    const error = await NativeComputerHost.launch({
      executablePath: "relative/helper"
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeComputerHostError);
    expect(error).toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it("rejects any retryable outcome-unknown helper response", () => {
    expect(
      NativeHelperErrorSchema.safeParse({
        code: "OUTCOME_UNKNOWN",
        message: "partial input",
        retryable: true
      }).success
    ).toBe(false);
  });
});
