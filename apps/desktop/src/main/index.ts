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

import { app, BrowserWindow, session } from "electron";
import { CertExceptionStore, partitionForSession } from "../browser/cert-exceptions.js";
import { BrowserViewManager } from "../browser/view-manager.js";
import { createHiddenBrowserWindow } from "./hidden-browser-window.js";
import { resolveAppIcon } from "./icon.js";
import { registerIpc } from "./ipc/register.js";
import { installAppMenu } from "./menu.js";
import { type ActivityMonitorHandle, startActivityMonitor } from "./services/activity-monitor.js";
import { dashLog, logToFile } from "./services/log.js";
import { killPort } from "./services/port.js";
import { getConfiguredPort, getWebBrowserCdpEnabled } from "./services/settings.js";
import { resolveWebDir } from "./services/web-paths.js";
import { ensureWebserverRunning, ManagedProcess } from "./services/web-server.js";
import {
  installPendingUpdate,
  type PendingUpdate,
  schedulePeriodicCheck,
  scheduleStartupCheck,
} from "./updater.js";
import { createMainWindow } from "./window.js";

interface AppState {
  mainWindow: BrowserWindow | null;
  managed: ManagedProcess;
  browserManager: BrowserViewManager | null;
  /**
   * Session-scoped TLS exception store, shared between the
   * `BrowserViewManager` (which records exceptions on user proceed)
   * and the process-wide `app.on("certificate-error")` override hook
   * installed below (which reads them back to decide whether to
   * call `callback(true)`). See `browser/cert-exceptions.ts`.
   */
  certExceptions: CertExceptionStore;
  unregisterIpc: (() => void) | null;
  cancelStartupUpdateCheck: (() => void) | null;
  cancelPeriodicUpdateCheck: (() => void) | null;
  /** The most recently observed available update, or null. Owned here so
   *  the renderer can ask via `updater_status` (catching the race where it
   *  mounts after the startup check completed) and so the broadcast layer
   *  can dedupe by version. */
  pendingUpdate: PendingUpdate;
  activityMonitor: ActivityMonitorHandle | null;
  cleanedUp: boolean;
  port: number;
  /** Empty string in dev mode where we don't own the server. */
  webDir: string;
}

const state: AppState = {
  mainWindow: null,
  managed: new ManagedProcess(),
  browserManager: null,
  certExceptions: new CertExceptionStore(),
  unregisterIpc: null,
  cancelStartupUpdateCheck: null,
  cancelPeriodicUpdateCheck: null,
  pendingUpdate: null,
  activityMonitor: null,
  cleanedUp: false,
  port: getConfiguredPort(),
  webDir: "",
};

/**
 * Broadcast the current `pendingUpdate` to every renderer (multi-window
 * safe). Dedupes by version so a stable periodic-no-update tick doesn't
 * re-render the banner every 2h.
 */
function setPendingUpdate(next: PendingUpdate): void {
  const prevVersion = state.pendingUpdate?.version ?? null;
  const nextVersion = next?.version ?? null;
  if (prevVersion === nextVersion) return;
  state.pendingUpdate = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("updater-status-changed", next);
  }
}

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
    isPackaged: app.isPackaged,
  });
  state.port = port;
  return `http://localhost:${port}/?token=${encodeURIComponent(token)}`;
}

async function cleanupOnce(): Promise<void> {
  if (state.cleanedUp) return;
  state.cleanedUp = true;

  // Cancel any pending update checks so the deferred timers don't fire
  // mid-shutdown. The 10s startup delay can outlive a quick Cmd+Q, and
  // the 2h periodic interval would otherwise tick during teardown.
  state.cancelStartupUpdateCheck?.();
  state.cancelPeriodicUpdateCheck?.();
  state.activityMonitor?.stop();
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

  // CDP screencast experiment: when the user has the feature enabled
  // (settings.webBrowserCdpEnabled, default false — opt-in), expose
  // every webContents on a fixed CDP port so the web UI's `/cdp` proxy
  // can attach. Must be set BEFORE app.whenReady(); afterwards chromium
  // has already finished initializing the debugger. Leaving the setting
  // off saves the port and the per-tab "always-on compositor" cost (see
  // BrowserViewManager.hide() — without the hidden window, hide()
  // parks the renderer like the original code did).
  // Port intentionally !== 9222 so it doesn't collide with a Chrome a
  // developer might have running. Keep in sync with
  // `apps/web/src/lib/browser-host.ts::DESKTOP_CDP_PORT`.
  const cdpEnabled = getWebBrowserCdpEnabled();
  if (cdpEnabled) {
    app.commandLine.appendSwitch("remote-debugging-port", "9223");
  }

  await app.whenReady();

  // Install the application menu (Edit/View/Settings + accelerators) before
  // creating the window so Cmd+, etc. are bound from the first frame.
  // The Reload item resolves `state.browserManager` lazily because the
  // manager is constructed later, after `createMainWindow`.
  installAppMenu({ getBrowserManager: () => state.browserManager });

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

  // Hidden BrowserWindow that hosts WebContentsViews ensure'd by the web
  // bridge or hidden by the desktop UI — chromium needs a "visible" parent
  // for child views to keep compositing, otherwise screencast and
  // captureScreenshot both stall. See `hidden-browser-window.ts`. Skipped
  // when the CDP screencast feature is off; BrowserViewManager falls back
  // to the original setVisible(false)-on-hide model in that case.
  const hiddenBrowserWindow = cdpEnabled ? createHiddenBrowserWindow() : undefined;

  state.browserManager = new BrowserViewManager({
    mainWindow: state.mainWindow,
    hiddenWindow: hiddenBrowserWindow,
    certExceptions: state.certExceptions,
  });

  // ---- TLS exception override (issue #444) ----
  //
  // We use `session.setCertificateVerifyProc` rather than reacting
  // to the `certificate-error` event because the verify proc is the
  // canonical Electron API for cert overrides: it intercepts BEFORE
  // Chromium decides the cert is bad, and the override sticks
  // immediately for the next loadURL — whereas the event-based
  // override path was observed to leave the next navigation blank
  // even after `callback(true)` (likely because Chromium had
  // already started tearing the connection down by the time the
  // event handler fired).
  //
  // Decision matrix:
  //   - errorCode 0 (cert is valid) → callback(0) trusts as normal
  //   - exception matches our store → callback(0) trusts (override)
  //   - otherwise → callback(-3) defers to Chromium, which fires
  //     the per-`webContents` `certificate-error` event our view
  //     manager catches to paint the in-view interstitial.
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const hostname = request.hostname.toLowerCase();
    const fingerprint = request.certificate.fingerprint;
    if (request.errorCode === 0) {
      callback(0);
      return;
    }
    const partition = partitionForSession(session.defaultSession);
    if (fingerprint && state.certExceptions.has({ partition, host: hostname, fingerprint })) {
      dashLog(`cert-verify: override-trust ${hostname} (${fingerprint})`);
      callback(0);
      return;
    }
    dashLog(
      `cert-verify: default-deny ${hostname} fp=${fingerprint} errorCode=${request.errorCode}`,
    );
    callback(-3);
  });

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
    // Background app-update banner: the renderer reads `pendingUpdate`
    // on mount and subscribes to `updater-status-changed`; `installUpdate`
    // drives electron-updater's download + quitAndInstall.
    getPendingUpdate: () => state.pendingUpdate,
    installUpdate: () => installPendingUpdate(),
  });

  // Auto-update check 10s after launch (matches the Tauri shell's
  // `tokio::time::sleep(Duration::from_secs(10))` in lib.rs::run). No-op
  // in unpacked dev runs (`!app.isPackaged`) — see updater.ts. The
  // result feeds the in-app banner via `setPendingUpdate` instead of an
  // OS dialog (the menu item "Check for Updates…" keeps the dialog flow).
  state.cancelStartupUpdateCheck = scheduleStartupCheck(app.isPackaged, {
    onResult: setPendingUpdate,
  });

  // Periodic re-check every 2h while the app is running. Same gating + same
  // banner pipeline as the startup check.
  state.cancelPeriodicUpdateCheck = schedulePeriodicCheck(app.isPackaged, {
    onResult: setPendingUpdate,
  });

  // Watch focus + AC/battery state and tell the web server to widen the
  // branch-status poller interval whenever the user isn't actively using
  // Band. Best-effort; failures are logged but don't block startup.
  state.activityMonitor = startActivityMonitor({
    mainWindow: state.mainWindow,
    port: state.port,
  });

  state.mainWindow.on("close", () => {
    void cleanupOnce();
  });

  // Forward macOS native fullscreen state to the renderer so the title bar
  // can drop the 80px traffic-light offset when the controls are hidden.
  const sendFullscreen = (fs: boolean) => {
    state.mainWindow?.webContents.send("window-fullscreen-changed", fs);
  };
  state.mainWindow.on("enter-full-screen", () => sendFullscreen(true));
  state.mainWindow.on("leave-full-screen", () => sendFullscreen(false));
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
