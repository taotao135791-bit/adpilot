#!/usr/bin/env node
/**
 * Real-machine Live View end-to-end verification.
 *
 * Boots the real AdPilot system and HTTP server with the Electron desktop
 * native bridge, launches a real managed browser window, then pulls actual
 * frames from /api/desktop-native/live-frame and the Permission Center state
 * from /api/desktop-native/permissions. Frames are written to artifacts/ so a
 * human can confirm the pixels are real. Nothing is mocked: the captures come
 * from the authenticated Swift Helper bound to the managed browser window.
 *
 * Usage: pnpm tsx scripts/live-view-e2e.ts [--keep-browser]
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "@adpilot/server";
import { ElectronDesktopNativeBridge } from "../apps/electron/src/desktop-native-bridge.js";

const keepBrowser = process.argv.includes("--keep-browser");
const outDir = new URL("../artifacts/session-ui/", import.meta.url).pathname;
const clientId = "live-view-e2e";
const browserProfile = "live-view-e2e";
const summary: Record<string, unknown> = { status: "failed" };

function fail(message: string): never {
  summary.error = message;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
}

const token = randomBytes(32).toString("base64url");
const system = await createAdPilotSystem();
if (!system.nativeComputerHost) fail("native Helper host did not start; run pnpm build:native-helper first");

const bridge = new ElectronDesktopNativeBridge({
  service: system.nativeComputerHost,
  dataDirectory: outDir,
  processName: "AdPilot",
  bundleId: "com.adpilot.desktop",
  openExternal: async () => undefined,
  keychainInUse: () => false,
  backgroundServiceEnabled: () => false
});
const server = await createServer(system, { desktopNative: bridge, desktopNativeAuthToken: token });
const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
const cookie = `adpilot_native_instance=${token}`;

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      cookie,
      "sec-fetch-site": "same-origin",
      ...(init.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

let browserSessionId: string | undefined;
try {
  const clients = (await system.workspace.listClients()) as Array<{ profile?: { id?: string } }>;
  if (!clients.some((client) => client.profile?.id === clientId)) {
    await system.workspace.initializeClient({
      profile: { id: clientId, name: "Live View E2E" },
      kpi: { primary: "CPA", target: 1, currency: "USD" },
      accounts: {
        accounts: [{
          platform: "google_ads",
          accountRef: "live-e2e-account",
          browserProfile,
          allowedDomains: ["ads.google.com"]
        }]
      }
    });
  }

  const session = (await api(`/api/clients/${clientId}/sessions`, {
    method: "POST",
    body: JSON.stringify({ title: "Live View E2E", actor: "live-view-e2e" })
  })) as { id: string; revision: number };

  await api(`/api/clients/${clientId}/sessions/${session.id}/computer-use`, {
    method: "PUT",
    body: JSON.stringify({
      revision: session.revision,
      browserProfile,
      computerUse: "observe",
      confirm: true
    })
  });

  const started = (await api("/api/browser-session/start", {
    method: "POST",
    body: JSON.stringify({ clientId, browserProfile, platform: "google_ads" })
  })) as { session: { sessionId: string; processId: number | null; windowId: string | null } };
  browserSessionId = started.session.sessionId;
  if (!started.session.processId || !started.session.windowId) {
    fail("managed browser started without a bound native process/window");
  }
  summary.browserSession = {
    sessionId: browserSessionId,
    processId: started.session.processId,
    windowId: started.session.windowId
  };

  const permissions = (await api(
    `/api/desktop-native/permissions?clientId=${clientId}&productSessionId=${session.id}&browserSessionId=${browserSessionId}`
  )) as { helperAvailable: boolean; helperVersion: string | null; permissions: Array<{ id: string; status: string }> };
  summary.permissionCenter = {
    helperAvailable: permissions.helperAvailable,
    helperVersion: permissions.helperVersion,
    statuses: Object.fromEntries(permissions.permissions.map((item) => [item.id, item.status]))
  };

  // Allow the freshly launched window to finish its first paint before capture.
  await new Promise((resolve) => setTimeout(resolve, 4_000));

  const query = `clientId=${clientId}&productSessionId=${session.id}&browserSessionId=${browserSessionId}`;
  const frame = (await api(`/api/desktop-native/live-frame?${query}`)) as {
    frameId: string;
    dataUrl: string;
    width: number;
    height: number;
    source: { width: number; height: number };
    capturedAt: string;
    application: { pid: number; bundleId: string; name: string };
    window: { id: string; title?: string };
    browser: { profile: string; url?: string; pageIdentity: { status: string } };
  };
  if (frame.application.pid !== started.session.processId) {
    fail(`frame PID ${frame.application.pid} does not match the bound browser PID ${started.session.processId}`);
  }
  if (frame.window.id !== started.session.windowId) {
    fail(`frame window ${frame.window.id} does not match the bound window ${started.session.windowId}`);
  }
  await mkdir(outDir, { recursive: true });
  const bytes = Buffer.from(frame.dataUrl.split(",")[1]!, "base64");
  await writeFile(`${outDir}live-view-e2e-frame.jpg`, bytes);
  summary.frame = {
    frameId: frame.frameId.slice(0, 16),
    preview: `${frame.width}x${frame.height}`,
    source: `${frame.source.width}x${frame.source.height}`,
    capturedAt: frame.capturedAt,
    application: frame.application.bundleId,
    windowTitle: frame.window.title ?? null,
    pageIdentity: frame.browser.pageIdentity.status,
    bytes: bytes.byteLength,
    artifact: "artifacts/session-ui/live-view-e2e-frame.jpg"
  };
  summary.status = "passed";
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  if (browserSessionId) {
    summary.browserSessionAfterError = await api(
      `/api/browser-session?clientId=${clientId}&browserProfile=${browserProfile}`
    ).catch((probeError) => String(probeError));
  }
} finally {
  if (browserSessionId && !keepBrowser) {
    await api("/api/browser-session/close", {
      method: "POST",
      body: JSON.stringify({ clientId, browserProfile })
    }).catch(() => undefined);
  }
  await server.close().catch(() => undefined);
  await system.shutdown().catch(() => undefined);
}

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.status === "passed" ? 0 : 1);
