import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, session, shell, type OpenDialogOptions } from "electron";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "@adpilot/server";
import { ElectronDesktopNativeBridge } from "./desktop-native-bridge.js";
import { DesktopRuntimeLifecycle } from "./runtime-lifecycle.js";
import { isExternalWebUrl, isTrustedDesktopUrl, packagedNativeHelperPath } from "./security.js";

let mainWindow: BrowserWindow | undefined;
let isQuitting = false;
const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
const runtimeLifecycle = new DesktopRuntimeLifecycle<Awaited<ReturnType<typeof createServer>>>();
const desktopNativeAuthToken = randomBytes(32).toString("base64url");

app.setName("AdPilot");

function loadEnvironment(): void {
  const environmentFile = join(app.getPath("userData"), ".env");
  if (!existsSync(environmentFile)) return;
  try { process.loadEnvFile(environmentFile); } catch (error) { console.warn(`Unable to load ${environmentFile}`, error); }
}

function desktopUiRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "dist", "desktop")
    : resolve(moduleDirectory, "..", "desktop");
}

async function openDesktop(): Promise<void> {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }

  const runtime = await runtimeLifecycle.ensure(async () => {
    loadEnvironment();
    configurePackagedNativeHelperPath();
    const workspaceRoot = process.env.ADPILOT_WORKSPACE ?? join(app.getPath("userData"), "workspace");
    const system = await createAdPilotSystem({ workspaceRoot });
    try {
      const desktopNative = new ElectronDesktopNativeBridge({
        ...(system.nativeComputerHost ? { service: system.nativeComputerHost } : {}),
        dataDirectory: app.getPath("userData"),
        processName: app.getName(),
        bundleId: "com.adpilot.desktop",
        openExternal: (url) => shell.openExternal(url),
        selectProjectRoot: async () => {
          const options: OpenDialogOptions = {
            properties: ["openDirectory"]
          };
          const result = mainWindow
            ? await dialog.showOpenDialog(mainWindow, options)
            : await dialog.showOpenDialog(options);
          return result.canceled ? undefined : result.filePaths[0];
        },
        // WorkspaceCredentialStore is not yet backed by Electron safeStorage;
        // never report Keychain as granted merely because the API exists.
        keychainInUse: () => false,
        backgroundServiceEnabled: () => {
          try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
        }
      });
      const server = await createServer(system, {
        uiRoot: desktopUiRoot(),
        onRestartRequested: () => { app.relaunch(); app.quit(); },
        desktopNative,
        desktopNativeAuthToken
      });
      server.addHook("onClose", async () => system.shutdown());
      const url = await server.listen({ host: "127.0.0.1", port: 0 });
      return { server, url };
    } catch (error) {
      await system.shutdown().catch(() => undefined);
      throw error;
    }
  });

  await session.defaultSession.cookies.set({
    url: runtime.url,
    name: "adpilot_native_instance",
    value: desktopNativeAuthToken,
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: false
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    backgroundColor: "#090a08",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 19 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });

  const origin = new URL(runtime.url).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedDesktopUrl(url, origin)) return { action: "allow" };
    if (isExternalWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isTrustedDesktopUrl(url, origin)) return;
    event.preventDefault();
    if (isExternalWebUrl(url)) void shell.openExternal(url);
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = undefined; });
  await mainWindow.loadURL(`${runtime.url}?desktop=1`);
}

function configurePackagedNativeHelperPath(): void {
  if (!app.isPackaged) return;
  // Packaged builds never accept a user-controlled executable override.
  process.env.ADPILOT_NATIVE_HELPER_PATH = packagedNativeHelperPath(process.resourcesPath);
  // Let the Python UAC engine resolve its bundled script under
  // resources/advertising-core/python (see resolveEngineScript in uac-engine.ts).
  process.env.ADPILOT_RESOURCES_PATH = process.resourcesPath;
}

app.whenReady().then(async () => {
  await openDesktop();
  app.on("activate", () => { void openDesktop(); });
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (isQuitting || !runtimeLifecycle.current()) return;
  event.preventDefault();
  isQuitting = true;
  void runtimeLifecycle.close((server) => server.close()).finally(() => app.quit());
});
