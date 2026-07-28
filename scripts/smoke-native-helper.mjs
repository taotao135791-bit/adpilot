import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const helperPath = process.env.ADPILOT_NATIVE_HELPER_PATH
  ?? join(
    repoRoot,
    "build",
    "native-helper",
    "AdPilot Computer Helper.app",
    "Contents",
    "MacOS",
    "adpilot-native-helper"
  );
const runPermissionChecks = process.argv.includes("--permissions");
const runPermissionRequest = process.argv.includes("--request");
const token = randomBytes(32).toString("base64url");
const sessionId = `native-smoke-${randomUUID()}`;
const child = spawn(helperPath, [], {
  env: {
    PATH: "/usr/bin:/bin",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ADPILOT_NATIVE_HELPER_TOKEN: token
  },
  shell: false,
  stdio: ["pipe", "pipe", "pipe"]
});
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const waiting = [];
let sequence = 0;
let stderrBytes = 0;
let closedError;

child.stderr.on("data", (chunk) => {
  stderrBytes += chunk.byteLength;
});
child.on("error", (error) => {
  closedError = error;
  while (waiting.length > 0) {
    waiting.shift().reject(error);
  }
});
child.on("close", (code, signal) => {
  if (!closedError && code !== 0 && code !== null) {
    closedError = new Error(
      `native helper exited unexpectedly (code=${code}, signal=${signal ?? "none"}, stderrBytes=${stderrBytes})`
    );
  }
  while (waiting.length > 0) {
    waiting.shift().reject(closedError ?? new Error("native helper closed"));
  }
});
lines.on("line", (line) => {
  const pending = waiting.shift();
  if (!pending) {
    closedError = new Error("native helper emitted an unsolicited response");
    child.kill("SIGKILL");
    return;
  }
  try {
    pending.resolve(JSON.parse(line));
  } catch (error) {
    pending.reject(error);
  }
});

async function request(method, params = {}, options = {}) {
  if (closedError) {
    throw closedError;
  }
  const requestSequence = ++sequence;
  const id = randomUUID();
  const actionId = options.action
    ? options.actionId ?? `smoke-action-${randomUUID()}`
    : undefined;
  const envelope = {
    protocolVersion: 3,
    id,
    sessionId,
    ...(actionId === undefined ? {} : { actionId }),
    nonce: randomUUID(),
    sequence: requestSequence,
    deadlineUnixMs: Date.now() + (options.timeoutMs ?? 15_000),
    authToken: token,
    method,
    params
  };
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${method} timed out`));
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 15_000);
    waiting.push({
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.stdin.write(`${JSON.stringify(envelope)}\n`, "utf8");
  });
  if (
    response.protocolVersion !== 3
    || response.id !== id
    || response.sequence !== requestSequence
  ) {
    throw new Error(`${method} returned an invalid correlation envelope`);
  }
  if (!response.ok) {
    const error = new Error(`${method} failed: ${response.error?.code ?? "UNKNOWN"}`);
    error.code = response.error?.code;
    throw error;
  }
  return response.result;
}

const summary = {
  status: "passed",
  helperPath,
  protocolVersion: 3,
  permissionChecks: runPermissionChecks ? "not-run" : "not-requested"
};

try {
  const hello = await request("hello");
  if (
    hello.identity?.bundleIdentifier !== "com.adpilot.computer-helper"
    || hello.identity?.signingIdentifier !== "com.adpilot.computer-helper"
  ) {
    throw new Error("staged helper identity does not match com.adpilot.computer-helper");
  }
  summary.helperVersion = hello.helperVersion;
  summary.identity = {
    bundleIdentifier: hello.identity.bundleIdentifier,
    signingIdentifier: hello.identity.signingIdentifier
  };

  const permissions = await request("permissions.status");
  summary.permissions = {
    screenCapture: permissions.screenCapture?.state,
    accessibility: permissions.accessibility?.state
  };
  summary.displayCount = (await request("displays.list")).length;
  const frontmost = await request("frontmost");
  summary.frontmost = {
    bundleId: frontmost.bundleId,
    hasWindow: frontmost.window !== null
  };

  if (runPermissionChecks) {
    const checks = {};
    if (permissions.screenCapture?.granted) {
      const capture = await request(
        "capture",
        { target: "screen", includeCursor: false },
        { timeoutMs: 30_000 }
      );
      checks.screenCapture = capture.format === "png"
        && typeof capture.base64 === "string"
        && capture.base64.startsWith("iVBORw0KGgo")
        && capture.width > 0
        && capture.height > 0
        ? "passed"
        : "failed";
    } else {
      checks.screenCapture = "blocked-by-permission";
    }

    if (permissions.accessibility?.granted && frontmost.window) {
      await request(
        "window.focus",
        {
          windowId: frontmost.window.windowId,
          ownerPid: frontmost.ownerPid,
          bundleId: frontmost.bundleId
        },
        { action: true, actionId: `permission-focus-${randomUUID()}` }
      );
      const verified = await request("frontmost");
      checks.accessibility =
        verified.ownerPid === frontmost.ownerPid
        && verified.bundleId === frontmost.bundleId
        && verified.window?.windowId === frontmost.window.windowId
          ? "passed"
          : "failed";
    } else {
      checks.accessibility = "blocked-by-permission";
    }
    summary.permissionChecks = checks;
    if (Object.values(checks).includes("failed")) {
      summary.status = "failed";
      process.exitCode = 1;
    } else if (Object.values(checks).includes("blocked-by-permission")) {
      summary.status = "blocked-by-permission";
    }
  }

  if (runPermissionRequest) {
    const requested = await request("permissions.request", {}, { timeoutMs: 30_000 });
    summary.permissionRequest = {
      screenCapture: requested.status?.screenCapture?.state,
      accessibility: requested.status?.accessibility?.state,
      promptAttempted: requested.promptAttempted,
      restartRecommended: requested.restartRecommended === true
    };
    await request("permissions.openSettings", { permission: "accessibility" });
    summary.openedSettings = "accessibility";
    if (!requested.status?.accessibility?.granted || !requested.status?.screenCapture?.granted) {
      summary.status = "blocked-by-permission";
    }
  }
} catch (error) {
  summary.status = "failed";
  summary.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
