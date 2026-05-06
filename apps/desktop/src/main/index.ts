/**
 * Electron main process entry point. Mirrors the boot sequence of
 * `apps/dashboard/src-tauri/src/lib.rs::run`:
 *
 *   1. Install panic hook → log to ~/.band/desktop.log.
 *   2. Auto-start the web server (release builds only — in dev the
 *      orchestrating script provides the URL via `BAND_DEV_WEB_URL`,
 *      matching how `tauri.conf.json` skips `ensure_webserver_running`
 *      in debug builds).
 *   3. Create the main BrowserWindow pointed at the web URL.
 *   4. Register IPC handlers (Phases 1-3 ported; menus are Phase 5).
 *   5. On quit: kill the web server tree, destroy all WebContentsViews,
 *      free port 3456 (release builds only — same gate as Tauri).
 */

import { app, BrowserWindow } from "electron";

import { BrowserViewManager } from "../browser/view-manager.js";
import { resolveAppIcon } from "./icon.js";
import { registerIpc } from "./ipc/register.js";
import { installAppMenu } from "./menu.js";
import { dashLog, logToFile } from "./services/log.js";
import { killPort } from "./services/port.js";
import { getConfiguredPort } from "./services/settings.js";
import { resolveWebDir } from "./services/web-paths.js";
import { ensureWebserverRunning, ManagedProcess } from "./services/web-server.js";
import { scheduleStartupCheck } from "./updater.js";
import { createMainWindow } from "./window.js";

interface AppState {
  mainWindow: BrowserWindow | null;
  managed: ManagedProcess;
  browserManager: BrowserViewManager | null;
  unregisterIpc: (() => void) | null;
  cancelStartupUpdateCheck: (() => void) | null;
  cleanedUp: boolean;
  port: number;
  /** Empty string in dev mode where we don't own the server. */
  webDir: string;
}

const state: AppState = {
  mainWindow: null,
  managed: new ManagedProcess(),
  browserManager: null,
  unregisterIpc: null,
  cancelStartupUpdateCheck: null,
  cleanedUp: false,
  port: getConfiguredPort(),
  webDir: "",
};

function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => {
    const stack = err.stack ?? String(err);
    dashLog(`uncaughtException: ${stack}`);
  });
  process.on("unhandledRejection", (reason) => {
    dashLog(`unhandledRejection: ${String(reason)}`);
  });
}

/**
 * Resolve the URL to load. In dev, the orchestrating script supplies
 * `BAND_DEV_WEB_URL` after vite is up. In release we spawn the bundled web
 * server ourselves and embed `?token=` from `~/.band/settings.json`.
 *
 * Sets `state.webDir` and `state.port` as a side-effect so the IPC handlers
 * (and the cleanup path) can reference them later.
 */
async function resolveDashboardUrl(): Promise<string> {
  const devUrl = process.env.BAND_DEV_WEB_URL;
  if (!app.isPackaged && devUrl) {
    state.port = Number.parseInt(new URL(devUrl).port || "3456", 10);
    return devUrl;
  }

  state.webDir = resolveWebDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  const { port, token } = await ensureWebserverRunning({
    webDir: state.webDir,
    managed: state.managed,
  });
  state.port = port;
  return `http://localhost:${port}/?token=${encodeURIComponent(token)}`;
}

async function cleanupOnce(): Promise<void> {
  if (state.cleanedUp) return;
  state.cleanedUp = true;

  // Cancel any pending startup update check so its dialog doesn't pop up
  // mid-shutdown (the 10s delay can outlive Cmd+Q on a quick quit).
  state.cancelStartupUpdateCheck?.();
  state.unregisterIpc?.();
  state.browserManager?.destroyAll();
  await state.managed.kill();

  // Only force-free the port in packaged builds where we own the server.
  // In dev the orchestrating script (or an external dev:web invocation)
  // owns it — blindly killing 3456 could nuke another Band instance.
  if (app.isPackaged) {
    await killPort(state.port);
  }
}

async function bootstrap(): Promise<void> {
  installCrashHandlers();
  logToFile("dashboard starting (electron)");

  await app.whenReady();

  // Install the application menu (Edit/View/Settings + accelerators) before
  // creating the window so Cmd+, etc. are bound from the first frame.
  installAppMenu();

  // macOS dock icon. In a packaged build this comes from the .app's .icns
  // (Info.plist resolves CFBundleIconFile); in dev there's no bundle so we
  // override the default Electron icon with the Band PNG.
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    const iconPath = resolveAppIcon();
    if (iconPath) {
      try {
        app.dock.setIcon(iconPath);
      } catch (err) {
        dashLog(`failed to set dock icon: ${String(err)}`);
      }
    }
  }

  const url = await resolveDashboardUrl();
  dashLog(`loading url: ${url}`);
  state.mainWindow = createMainWindow({ url });

  // Surface preload load failures, which otherwise fail silently and leave
  // `__BAND_DESKTOP__` undefined on `window` (collapses isDesktop everywhere).
  state.mainWindow.webContents.on("preload-error", (_e, preloadPath, error) => {
    dashLog(`preload-error: ${preloadPath} → ${error.stack ?? error.message}`);
  });

  state.browserManager = new BrowserViewManager({ mainWindow: state.mainWindow });

  state.unregisterIpc = registerIpc({
    mainWindow: state.mainWindow,
    webDir: state.webDir,
    managed: state.managed,
    browserManager: state.browserManager,
    cliPaths: {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    },
  });

  // Auto-update check 10s after launch (matches the Tauri shell's
  // `tokio::time::sleep(Duration::from_secs(10))` in lib.rs::run). No-op
  // unless `BAND_UPDATER_ENABLED=1` is set AND we're in a packaged build —
  // see updater.ts for the full gating.
  state.cancelStartupUpdateCheck = scheduleStartupCheck(app.isPackaged, {
    parentWindow: state.mainWindow,
  });

  state.mainWindow.on("close", () => {
    void cleanupOnce();
  });
}

app.on("window-all-closed", () => {
  void cleanupOnce().finally(() => {
    if (process.platform !== "darwin") app.quit();
  });
});

app.on("before-quit", (event) => {
  if (!state.cleanedUp) {
    event.preventDefault();
    void cleanupOnce().finally(() => app.exit(0));
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && state.mainWindow === null) {
    void bootstrap();
  }
});

bootstrap().catch((err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  dashLog(`bootstrap failed: ${message}`);
  app.exit(1);
});
