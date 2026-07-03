/**
 * Register every `ipcMain.handle` for the renderer's command surface.
 *
 * One `ipcMain.handle` per command. Handlers return Promises (or values that
 * resolve to Promises via `Promise.resolve` semantics) so the renderer's
 * `invoke()` always returns a Promise.
 */

import { type BrowserWindow, ipcMain } from "electron";
import type { BrowserViewManager } from "../../browser/view-manager.js";
import { Channels } from "../../shared/ipc-channels.js";
import type {
  BrowserBoundsArgs,
  BrowserCreateArgs,
  BrowserEnsureArgs,
  BrowserEvalArgs,
  BrowserFindInPageArgs,
  BrowserKeyArg,
  BrowserNavigateArgs,
  BrowserStopFindInPageArgs,
  BrowserZoomArgs,
  CheckAppExistsArgs,
  InstallCliArgs,
  OpenExternalArgs,
  OpenWithAppArgs,
  PickSaveFileArgs,
  RevealInFinderArgs,
} from "../../shared/types.js";
import type { CliPathOptions } from "../services/cli-paths.js";
import { type ManagedProcess, webserverStart, webserverStop } from "../services/web-server.js";
import { getAppMetrics } from "./app-metrics.js";
import { browserHandlers } from "./browser.js";
import {
  checkAppExists,
  installCli,
  openExternal,
  openWithApp,
  pickFile,
  pickFolder,
  pickSaveFile,
  revealInFinder,
} from "./macos-shell.js";
import { getAppTitle } from "./window-title.js";

export interface RegisterOptions {
  mainWindow: BrowserWindow;
  webDir: string;
  managed: ManagedProcess;
  browserManager: BrowserViewManager;
  /**
   * Host paths used by the bundled-CLI resolver in `installCli` (issue #364).
   * `app.isPackaged`, `process.resourcesPath`, and `app.getAppPath()` from
   * the bootstrap. Captured at registration time so the IPC handler can
   * resolve the sidecar binary inside the trust boundary.
   */
  cliPaths: CliPathOptions;
  /**
   * Background app-update banner state. The bootstrap owns the
   * `pendingUpdate` cache and the install closure (which captures the
   * `electron-updater` deps). Passing them in keeps `register.ts`
   * decoupled from the updater module.
   */
  getPendingUpdate: () => { version: string } | null;
  installUpdate: () => Promise<void>;
}

/**
 * Wire every ipcMain.handle. Returns a teardown function that removes all
 * handlers — useful in tests, harmless otherwise.
 */
export function registerIpc(opts: RegisterOptions): () => void {
  const handlers: Array<readonly [string, (args: unknown) => unknown]> = [];

  const handle = <T>(channel: string, fn: (args: T) => unknown): void => {
    const wrapped = (_e: unknown, args: T) => fn(args);
    ipcMain.handle(channel, wrapped);
    handlers.push([channel, wrapped as (args: unknown) => unknown]);
  };

  // ---- Web server + window ----
  // Native window dragging is handled via CSS `-webkit-app-region: drag` on
  // the title bar — no IPC handler needed.
  handle(Channels.webserverStart, () =>
    webserverStart({
      webDir: opts.webDir,
      managed: opts.managed,
      isPackaged: opts.cliPaths.isPackaged,
    }),
  );
  handle(Channels.webserverStop, () =>
    webserverStop({ webDir: opts.webDir, managed: opts.managed }),
  );
  handle(Channels.getAppTitle, () => getAppTitle());
  handle(Channels.getWindowFullscreen, () => opts.mainWindow.isFullScreen());
  // Per-process Electron/Chromium resource metrics for the Resources page.
  handle(Channels.getAppMetrics, () => getAppMetrics());

  // ---- macOS shell ----
  // Args are camelCase because they're forwarded to the handlers as typed
  // objects — Electron's IPC has no FFI-level case conversion.
  handle(Channels.pickFolder, () => pickFolder(opts.mainWindow));
  handle(Channels.pickFile, () => pickFile(opts.mainWindow));
  handle(Channels.pickSaveFile, (args: PickSaveFileArgs) => pickSaveFile(opts.mainWindow, args));
  handle(Channels.revealInFinder, (args: RevealInFinderArgs) => revealInFinder(args.path));
  handle(Channels.checkAppExists, (args: CheckAppExistsArgs) => checkAppExists(args.appName));
  handle(Channels.openWithApp, (args: OpenWithAppArgs) => openWithApp(args.path, args.appName));
  handle(Channels.installCli, (args: InstallCliArgs) =>
    installCli(args.binaryPath, args.symlinkPath, opts.cliPaths),
  );
  handle(Channels.openExternal, (args: OpenExternalArgs) => openExternal(args.url));

  // ---- Background app-update banner ----
  // The renderer calls `updater_status` once on mount to seed initial state
  // (a missed broadcast race) and subscribes to `updater-status-changed`
  // for subsequent transitions. `updater_install` kicks off
  // `installPendingUpdate` — the response never resolves on success because
  // `electron-updater` quits the process to install.
  handle(Channels.updaterStatus, () => opts.getPendingUpdate());
  handle(Channels.updaterInstall, () => opts.installUpdate());

  // ---- Browser panels ----
  const bm = { manager: opts.browserManager };
  handle(Channels.browserCreate, (args: BrowserCreateArgs) => browserHandlers.create(bm, args));
  handle(Channels.browserNavigate, (args: BrowserNavigateArgs) =>
    browserHandlers.navigate(bm, args),
  );
  handle(Channels.browserSetBounds, (args: BrowserBoundsArgs) =>
    browserHandlers.setBounds(bm, args),
  );
  handle(Channels.browserShow, (args: BrowserKeyArg) => browserHandlers.show(bm, args));
  handle(Channels.browserHide, (args: BrowserKeyArg) => browserHandlers.hide(bm, args));
  handle(Channels.browserReload, (args: BrowserKeyArg) => browserHandlers.reload(bm, args));
  handle(Channels.browserGoBack, (args: BrowserKeyArg) => browserHandlers.goBack(bm, args));
  handle(Channels.browserGoForward, (args: BrowserKeyArg) => browserHandlers.goForward(bm, args));
  handle(Channels.browserEval, (args: BrowserEvalArgs) => browserHandlers.evalJs(bm, args));
  handle(Channels.browserDestroy, (args: BrowserKeyArg) => browserHandlers.destroy(bm, args));
  handle(Channels.browserHideAllForWorkspace, () => browserHandlers.hideAll(bm));
  handle(Channels.browserShowAllForWorkspace, () => browserHandlers.showAll(bm));
  // CDP screencast experiment bridge
  handle(Channels.browserEnsure, (args: BrowserEnsureArgs) => browserHandlers.ensure(bm, args));
  handle(Channels.browserGetCdpTarget, (args: BrowserKeyArg) =>
    browserHandlers.getCdpTarget(bm, args),
  );
  // Find in page
  handle(Channels.browserFindInPage, (args: BrowserFindInPageArgs) =>
    browserHandlers.findInPage(bm, args),
  );
  handle(Channels.browserStopFindInPage, (args: BrowserStopFindInPageArgs) =>
    browserHandlers.stopFindInPage(bm, args),
  );
  // Capture-page (JPEG snapshot for the freeze-on-overlay mechanism)
  handle(Channels.browserCapturePage, (args: BrowserKeyArg) =>
    browserHandlers.capturePage(bm, args),
  );
  // Pause / resume media on freeze
  handle(Channels.browserPauseMedia, (args: BrowserKeyArg) => browserHandlers.pauseMedia(bm, args));
  handle(Channels.browserResumeMedia, (args: BrowserKeyArg) =>
    browserHandlers.resumeMedia(bm, args),
  );
  // Per-tab zoom
  handle(Channels.browserZoom, (args: BrowserZoomArgs) => browserHandlers.zoom(bm, args));
  // Toggle DevTools for a browser tab
  handle(Channels.browserToggleDevTools, (args: BrowserKeyArg) =>
    browserHandlers.toggleDevTools(bm, args),
  );
  // Cert / load error pages are rendered inside the WebContentsView
  // via a `data:` URI (issue #444); button clicks become
  // `band-action://` navigations intercepted by the view manager. The
  // only renderer-facing surface is this catch-up call so the
  // dashboard chrome can paint the "Not Secure" badge for hosts the
  // user already proceeded to in this session.
  handle(Channels.browserGetOverriddenHosts, () => browserHandlers.getOverriddenHosts(bm));

  return () => {
    for (const [channel] of handlers) {
      ipcMain.removeHandler(channel);
    }
  };
}
