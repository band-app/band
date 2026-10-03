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
 *   5. On quit: kill the web server tree, close offscreen browser pages,
 *      free port 3456 (release builds only — same gate as Tauri).
 */

import { app, BrowserWindow, dialog, powerMonitor, protocol, session } from "electron";
import { CertExceptionStore } from "../browser/cert-exceptions.js";
import { BrowserGuestManager } from "../browser/guest-manager.js";
import { Events } from "../shared/ipc-channels.js";
import {
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  appHostForHub,
  appOriginForHost,
  createAppHandler,
  LOCAL_APP_HOST,
} from "./app-protocol.js";
import { createHiddenBrowserWindow } from "./hidden-browser-window.js";
import { resolveAppIcon } from "./icon.js";
import { isTrustedSender, registerHubConfigSync } from "./ipc/hub.js";
import { registerIpc } from "./ipc/register.js";
import { installAppMenu } from "./menu.js";
import { type ActivityMonitorHandle, startActivityMonitor } from "./services/activity-monitor.js";
import { type HubChoice, loadHubChoice, saveHubChoice } from "./services/hub-choice.js";
import { createLogger } from "./services/log.js";
import { killPort } from "./services/port.js";
import { getConfiguredPort, getWebBrowserCdpEnabled, tryGetToken } from "./services/settings.js";
import { resolveUiDir } from "./services/ui-paths.js";
import { resolveWebDir } from "./services/web-paths.js";
import { ensureWebserverRunning, ManagedProcess } from "./services/web-server.js";
import { isUpdaterEnabled, UpdateController } from "./updater.js";
import { installWebviewSecurity } from "./webview-security.js";
import { createMainWindow } from "./window.js";

const log = createLogger("desktop");

interface AppState {
  mainWindow: BrowserWindow | null;
  managed: ManagedProcess;
  browserManager: BrowserGuestManager | null;
  /**
   * Session-scoped TLS exception store, shared between the
   * `BrowserGuestManager` (which records exceptions on user proceed)
   * and the process-wide `app.on("certificate-error")` override hook
   * installed below (which reads them back to decide whether to
   * call `callback(true)`). See `browser/cert-exceptions.ts`.
   */
  certExceptions: CertExceptionStore;
  unregisterIpc: (() => void) | null;
  /** Cancels the background update checks started in `bootstrap`. */
  stopUpdateChecks: (() => void) | null;
  activityMonitor: ActivityMonitorHandle | null;
  cleanedUp: boolean;
  port: number;
  /** Empty string in dev mode where we don't own the server. */
  webDir: string;
  /** The hub the window talks to. "local" spawns the bundled hub. */
  hubChoice: HubChoice;
  /** The built UI served over `app://`, or null when there is no build. */
  uiDir: string | null;
  /** The `app://` host the window is loaded under: one per hub, so storage is separate. */
  appHost: string;
  /** What the preload tells the UI (`window.__BAND_HUB__`). Null: the page is its hub's own. */
  rendererHub: { url: string; token?: string } | null;
}

/** powerMonitor listeners survive window close; wire them at most once. */
let powerEventsWired = false;

const state: AppState = {
  mainWindow: null,
  managed: new ManagedProcess(),
  browserManager: null,
  certExceptions: new CertExceptionStore(),
  unregisterIpc: null,
  stopUpdateChecks: null,
  activityMonitor: null,
  cleanedUp: false,
  port: getConfiguredPort(),
  webDir: "",
  hubChoice: loadHubChoice(),
  uiDir: null,
  appHost: LOCAL_APP_HOST,
  rendererHub: null,
};

/**
 * Owns the auto-update flow for the life of the process, so a download
 * started from the toast keeps its state across a dashboard reload. Every
 * status change goes to every renderer, which shows it in the update toast.
 */
const updates = new UpdateController({
  currentVersion: app.getVersion(),
  onStatus: (status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(Events.updaterStatusChanged, status);
    }
  },
});

/** "Check for Updates…": bring the dashboard forward so its toast is seen. */
function checkForUpdatesFromMenu(): void {
  const win = state.mainWindow;
  if (!win || win.isDestroyed()) {
    // On macOS the app outlives its closed window, and no renderer is left
    // to show the toast. Run the same flow with native dialogs instead.
    void checkForUpdatesWithDialogs().catch((err) => {
      log.error({ err: String(err) }, "check for updates (no window) failed");
    });
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  void updates.check({ userInitiated: true });
}

async function checkForUpdatesWithDialogs(): Promise<void> {
  await updates.check({ userInitiated: true });
  let status = updates.getStatus();
  if (status.state === "available") {
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: `Band v${status.version} is available`,
      detail: `You have v${status.currentVersion}.`,
      buttons: ["Update", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    await updates.download();
    status = updates.getStatus();
  }
  if (status.state === "downloaded") {
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: `Band v${status.version} is ready`,
      detail: "Restart Band to finish updating. It also installs when you quit.",
      buttons: ["Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) updates.restart();
  } else if (status.state === "up-to-date") {
    await dialog.showMessageBox({
      type: "info",
      message: "You're on the latest version",
      detail: `Band v${status.currentVersion}`,
    });
  } else if (status.state === "error") {
    await dialog.showMessageBox({
      type: "warning",
      message:
        status.phase === "download" ? "Couldn't download the update" : "Couldn't check for updates",
      detail: status.message,
    });
  }
}

function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => {
    const stack = err.stack ?? String(err);
    log.fatal({ err: stack }, "uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    log.error({ reason: String(reason) }, "unhandledRejection");
  });
}

/** Origins whose frames may ask for the hub's token and use the hub IPC. */
function trustedUiOrigins(): string[] {
  const origins = [appOriginForHost(state.appHost)];
  const dev = devWebUrl();
  if (dev) origins.push(`${new URL(dev).protocol}//${new URL(dev).host}`);
  return origins;
}

/** The dev server's URL, when the orchestrating script supplied one for an unpackaged run. */
function devWebUrl(): string | null {
  const url = process.env.BAND_DEV_WEB_URL;
  return !app.isPackaged && url ? url : null;
}

/**
 * Connect to the chosen hub and return the URL the window should load.
 *
 *   - Remote: spawn nothing. The window loads the bundled UI from `app://`,
 *     which the preload points at the remote hub.
 *   - Local, packaged or from a repo build: spawn the bundled hub, then load
 *     the bundled UI pointed at it. With no UI build (an old checkout), load
 *     the hub's own URL, which serves the UI itself.
 *   - Local, in dev with `BAND_DEV_WEB_URL`: load the dev server, which is its
 *     own hub, as before.
 *
 * Sets `state.webDir`, `state.port` and `state.rendererHub` as side effects so
 * the IPC handlers, the preload and the cleanup path can reference them.
 */
async function connectHub(choice: HubChoice): Promise<string> {
  if (choice.mode === "remote") {
    if (!state.uiDir) {
      throw new Error("The UI build was not found, which a remote hub needs. Run `pnpm build`.");
    }
    state.rendererHub = { url: choice.url, token: choice.token };
    state.appHost = appHostForHub(choice.url);
    return `${appOriginForHost(state.appHost)}/`;
  }

  const devUrl = devWebUrl();
  if (devUrl) {
    state.port = Number.parseInt(new URL(devUrl).port || "3456", 10);
    state.rendererHub = null;
    return devUrl;
  }

  state.webDir = resolveWebDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  let token: string;
  if (state.managed.isRunning() && tryGetToken()) {
    // Switching back to local while the hub we spawned is still up.
    token = tryGetToken() as string;
  } else {
    const started = await ensureWebserverRunning({
      webDir: state.webDir,
      managed: state.managed,
      isPackaged: app.isPackaged,
    });
    state.port = started.port;
    token = started.token;
  }
  if (state.uiDir) {
    state.rendererHub = { url: `http://localhost:${state.port}`, token };
    state.appHost = LOCAL_APP_HOST;
    return `${appOriginForHost(state.appHost)}/`;
  }
  state.rendererHub = null;
  return `http://localhost:${state.port}/?token=${encodeURIComponent(token)}`;
}

function startActivityMonitorForLocalHub(win: BrowserWindow): void {
  state.activityMonitor?.stop();
  state.activityMonitor =
    state.hubChoice.mode === "local"
      ? startActivityMonitor({ mainWindow: win, port: state.port })
      : null;
}

/**
 * Save the choice and reload the window against it. A failure (the local hub
 * won't start) restores the previous choice and says so.
 */
let switchingHub = false;

async function switchHub(choice: HubChoice): Promise<void> {
  const win = state.mainWindow;
  if (!win || win.isDestroyed() || switchingHub) return;
  switchingHub = true;
  const previous = state.hubChoice;
  try {
    if (choice.mode === "remote") {
      state.activityMonitor?.stop();
      state.activityMonitor = null;
      await state.managed.kill();
      if (app.isPackaged) await killPort(state.port);
    }
    const url = await connectHub(choice);
    state.hubChoice = choice;
    startActivityMonitorForLocalHub(win);
    await win.loadURL(url);
    // Save only once the window loaded, so a failed switch is not what the
    // next launch connects to.
    saveHubChoice(choice);
    log.info({ mode: choice.mode }, "switched hub");
  } catch (err) {
    log.error({ err: String(err) }, "switching hub failed");
    dialog.showErrorBox(
      "Couldn't switch hub",
      `${err instanceof Error ? err.message : String(err)}\n\nKeeping the previous hub.`,
    );
    try {
      state.hubChoice = previous;
      const url = await connectHub(previous);
      startActivityMonitorForLocalHub(win);
      if (!win.isDestroyed()) await win.loadURL(url);
    } catch (restoreErr) {
      log.error({ err: String(restoreErr) }, "restoring the previous hub failed");
    }
  } finally {
    switchingHub = false;
  }
}

async function cleanupOnce(): Promise<void> {
  if (state.cleanedUp) return;
  state.cleanedUp = true;

  // Cancel the update timers so they don't fire mid-shutdown. The 10s
  // startup delay can outlive a quick Cmd+Q.
  state.stopUpdateChecks?.();
  state.stopUpdateChecks = null;
  state.activityMonitor?.stop();
  state.unregisterIpc?.();
  state.browserManager?.destroyAll();
  await state.managed.kill();

  // Only force-free the port in packaged builds where we own the server
  // (never with a remote hub selected, when there is no local server).
  // In dev the orchestrating script (or an external dev:web invocation)
  // owns it — blindly killing 3456 could nuke another Band instance.
  if (app.isPackaged && state.hubChoice.mode === "local") {
    await killPort(state.port);
  }
}

async function bootstrap(): Promise<void> {
  installCrashHandlers();
  log.info("dashboard starting (electron)");

  // CDP screencast experiment: when the user has the feature enabled
  // (settings.webBrowserCdpEnabled, default false — opt-in), expose
  // every webContents on a fixed CDP port so the web UI's `/cdp` proxy
  // can attach. Must be set BEFORE app.whenReady(); afterwards chromium
  // has already finished initializing the debugger. Leaving the setting
  // off saves the port, the hidden window for ensure-only pages, and the
  // cost of keeping hidden browser panes painting (the renderer's paint
  // retention in `BrowserPanel.tsx` keys off the same setting).
  // Port intentionally !== 9222 so it doesn't collide with a Chrome a
  // developer might have running. The renderer-side constant in
  // `apps/hub/src/server/infra/browser-host/host-state.ts::DESKTOP_CDP_PORT` mirrors the
  // default (9223) used by the screencast `/cdp` proxy. The env-var
  // override below is for developers running a second Band instance
  // alongside their daily-driver build — set `BAND_CDP_PORT=9224` (or
  // any free port) on the dev launch and that instance gets its own
  // CDP endpoint without colliding with the running prod app, even if
  // both have `webBrowserCdpEnabled` on. Setting the env var also
  // implicitly enables CDP for that instance — no need to flip the
  // user-facing setting just to debug the renderer.
  // Treat `BAND_CDP_PORT=""` (set but blank, e.g. from a `BAND_CDP_PORT=
  // electron .` invocation) the same as unset — handing chromium an empty
  // string would either no-op or pick a random port, neither of which is
  // what a developer typing that command meant.
  const cdpPortEnv = process.env.BAND_CDP_PORT?.trim();
  const cdpEnabled =
    getWebBrowserCdpEnabled() || (cdpPortEnv !== undefined && cdpPortEnv.length > 0);
  if (cdpEnabled) {
    const cdpPort = cdpPortEnv && cdpPortEnv.length > 0 ? cdpPortEnv : "9223";
    app.commandLine.appendSwitch("remote-debugging-port", cdpPort);
  }

  // Chromium keeps at most 16 WebGL contexts per page and drops the oldest
  // past that. Every warm terminal holds one (see the note in
  // `apps/web/src/lib/terminal-cache.ts`), and a terminal that loses its
  // context scrolls on the slow DOM renderer or rebuilds on reveal. 128 is
  // orca's value: enough for large layouts, still bounded so a context leak
  // shows up. Must be set before the app is ready.
  app.commandLine.appendSwitch("max-active-webgl-contexts", "128");

  // Make `band-action://` a known scheme so Chromium handles it
  // internally instead of falling back to the OS external-protocol
  // handler (issue #444). Without this registration, clicking a
  // `band-action://cert-proceed?…` link inside the in-view cert
  // interstitial pops the macOS "no application set to open the
  // URL" dialog because no app is registered for the scheme. With
  // it, Chromium routes the request to the no-op
  // `protocol.handle("band-action", …)` we register after app
  // ready — and our per-tab `did-start-navigation` listener does
  // the actual action dispatch. MUST be called before
  // `app.whenReady()`.
  protocol.registerSchemesAsPrivileged([
    { scheme: "band-action", privileges: { standard: false, supportFetchAPI: false } },
    // `app://band/` serves the bundled UI (see `app-protocol.ts`).
    { scheme: APP_SCHEME, privileges: { ...APP_SCHEME_PRIVILEGES } },
  ]);

  await app.whenReady();

  // Install the application menu (Edit/View/Settings + accelerators) before
  // creating the window so Cmd+, etc. are bound from the first frame.
  installAppMenu({ checkForUpdates: checkForUpdatesFromMenu });

  // macOS dock icon. In a packaged build this comes from the .app's .icns
  // (Info.plist resolves CFBundleIconFile); in dev there's no bundle so we
  // override the default Electron icon with the Band PNG.
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    const iconPath = resolveAppIcon();
    if (iconPath) {
      try {
        app.dock.setIcon(iconPath);
      } catch (err) {
        log.warn({ err: String(err) }, "failed to set dock icon");
      }
    }
  }

  state.uiDir = resolveUiDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  if (state.uiDir) {
    session.defaultSession.protocol.handle(
      APP_SCHEME,
      createAppHandler(state.uiDir, {
        host: () => state.appHost,
        hubOrigin: () => state.rendererHub?.url ?? null,
      }),
    );
  }
  // Answer the preload's hub-config read before any page can ask.
  const unregisterHubConfig = registerHubConfigSync(() => state.rendererHub, trustedUiOrigins);

  const url = await connectHub(state.hubChoice);
  log.info({ url, hub: state.hubChoice.mode }, "loading url");
  state.mainWindow = createMainWindow({ url });

  // Surface preload load failures, which otherwise fail silently and leave
  // `__BAND_DESKTOP__` undefined on `window` (collapses isDesktop everywhere).
  state.mainWindow.webContents.on("preload-error", (_e, preloadPath, error) => {
    log.error({ preloadPath, err: error.stack ?? error.message }, "preload-error");
  });

  // Hidden BrowserWindow that hosts the offscreen pages the CDP bridge
  // ensures for tabs no pane has mounted. Chromium needs a "visible" parent
  // for a view to keep compositing, otherwise screencast and
  // captureScreenshot both stall. See `hidden-browser-window.ts`. Skipped
  // when the CDP screencast feature is off, the only time `ensure` runs.
  const hiddenBrowserWindow = cdpEnabled ? createHiddenBrowserWindow() : undefined;

  state.browserManager = new BrowserGuestManager({
    mainWindow: state.mainWindow,
    hiddenWindow: hiddenBrowserWindow,
    certExceptions: state.certExceptions,
  });
  // Browser tabs are <webview> guests of the dashboard window. Gate their
  // attach in the same tick the window was created, before the renderer can
  // mount one. See `webview-security.ts`.
  installWebviewSecurity(state.mainWindow, state.browserManager);

  // NOTE on TLS overrides (issue #444): the trust decision is made
  // in `BrowserGuestManager.wireEvents` via the per-`webContents`
  // `certificate-error` event, not here via
  // `session.setCertificateVerifyProc`. The verify proc is the
  // documented Electron API for cert overrides, but empirical
  // testing showed it gets bypassed by Chromium's internal
  // per-host bad-cert cache on retry attempts after a denial — the
  // proc fires for the FIRST connection that fails, but then for
  // subsequent reconnects within the same session Chromium reuses
  // its cached "deny" decision and never re-invokes the proc.
  // `certificate-error` does fire on those retries, so that's the
  // hook the guest manager uses for the override.

  // No-op handler for `band-action://` so Chromium accepts the
  // navigation and doesn't fall back to the OS external-protocol
  // handler. The scheme is registered as privileged before
  // `app.whenReady()` above. The actual action dispatch (record
  // cert exception, loadURL the real URL, etc.) happens in the
  // per-tab `did-start-navigation` listener in `guest-manager.ts`,
  // which fires synchronously when the user clicks an in-view
  // band-action link. By the time Chromium asks this handler for
  // a response we've already kicked off the real navigation in a
  // setImmediate, so we just return an empty no-content response
  // and Chromium quietly throws away the result.
  //
  // This registration covers `session.defaultSession` (the dashboard
  // window). Each partition's `Session` has its own protocol registry, so
  // the guest manager registers the same handler on every tab's session
  // when its guest attaches (`prepareBrowserSession`), whichever partition
  // (default or browser profile) it uses.
  session.defaultSession.protocol.handle("band-action", () => new Response(null, { status: 204 }));

  const unregisterIpc = registerIpc({
    mainWindow: state.mainWindow,
    getWebDir: () => state.webDir,
    isLocalHub: () => state.hubChoice.mode === "local",
    hub: {
      isTrustedSender: (event) =>
        state.mainWindow !== null && isTrustedSender(event, state.mainWindow, trustedUiOrigins()),
      getChoice: () => state.hubChoice,
      // The reload replaces the page that asked, so it runs after the reply.
      switchTo: (choice) => {
        setImmediate(() => void switchHub(choice));
      },
    },
    managed: state.managed,
    browserManager: state.browserManager,
    cliPaths: {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    },
    updates,
  });
  state.unregisterIpc = () => {
    unregisterIpc();
    unregisterHubConfig();
  };

  // Background update checks: 10s after launch so the dashboard has loaded,
  // then hourly. They surface in the toast only when they find an update.
  // Skipped in unpacked dev runs, where electron-updater refuses to run.
  if (isUpdaterEnabled(app.isPackaged)) {
    state.stopUpdateChecks = updates.start();
  }

  // Watch focus + AC/battery state and tell the web server to widen the
  // branch-status poller interval whenever the user isn't actively using
  // Band. Best-effort; failures are logged but don't block startup.
  startActivityMonitorForLocalHub(state.mainWindow);

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

  // Forward wake-from-sleep / screen-unlock to the renderer (see the
  // `systemResumed` event doc in shared/ipc-channels.ts). powerMonitor
  // listeners are process-global, so guard against a macOS dock re-activate
  // re-running bootstrap and stacking duplicates.
  if (!powerEventsWired) {
    powerEventsWired = true;
    const sendSystemResumed = () => {
      // These listeners outlive the window: on macOS the app stays alive in
      // the dock after close, and a destroyed BrowserWindow's webContents
      // throws (optional chaining only guards null, not destroyed).
      const win = state.mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send(Events.systemResumed);
    };
    powerMonitor.on("resume", sendSystemResumed);
    powerMonitor.on("unlock-screen", sendSystemResumed);
    // The hourly update timer doesn't advance while the Mac sleeps, so a
    // laptop woken each morning would otherwise wait up to an hour more.
    powerMonitor.on("resume", () => {
      if (state.stopUpdateChecks) updates.checkIfStale();
    });
  }
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
  log.fatal({ err: message }, "bootstrap failed");
  app.exit(1);
});
