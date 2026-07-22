import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session, shell } from "electron";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "@adpilot/server";
import { isExternalWebUrl, isTrustedDesktopUrl } from "./security.js";

let mainWindow: BrowserWindow | undefined;
let localServer: Awaited<ReturnType<typeof createServer>> | undefined;
let isQuitting = false;
const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));

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

  loadEnvironment();
  const workspaceRoot = process.env.ADPILOT_WORKSPACE ?? join(app.getPath("userData"), "workspace");
  const system = await createAdPilotSystem({ workspaceRoot });
  localServer = await createServer(system, {
    uiRoot: desktopUiRoot(),
    onRestartRequested: () => { app.relaunch(); app.quit(); }
  });
  const localUrl = await localServer.listen({ host: "127.0.0.1", port: 0 });

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

  const origin = new URL(localUrl).origin;
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
  await mainWindow.loadURL(`${localUrl}?desktop=1`);
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
  if (isQuitting || !localServer) return;
  event.preventDefault();
  isQuitting = true;
  void localServer.close().finally(() => app.quit());
});
