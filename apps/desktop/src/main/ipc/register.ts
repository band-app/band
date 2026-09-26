/**
 * Register every `ipcMain.handle` for the renderer's command surface.
 *
 * One `ipcMain.handle` per command. Handlers return Promises (or values that
 * resolve to Promises via `Promise.resolve` semantics) so the renderer's
 * `invoke()` always returns a Promise.
 */

import { type BrowserWindow, ipcMain } from "electron";
import {
  clearProfileData,
  importChromeProfile,
  listChromeImportProfiles,
  pruneProfileData,
} from "../../browser/chrome-import/import.js";
import type { BrowserGuestManager } from "../../browser/guest-manager.js";
import { Channels } from "../../shared/ipc-channels.js";
import type {
  BrowserChromeImportArgs,
  BrowserEnsureArgs,
  BrowserKeyArg,
  BrowserOpenDevToolsArgs,
  BrowserProfileArg,
  BrowserProfilePruneArgs,
  BrowserRegisterGuestArgs,
  CheckAppExistsArgs,
  InstallCliArgs,
  OpenExternalArgs,
  OpenWithAppArgs,
  PickSaveFileArgs,
  RevealInFinderArgs,
} from "../../shared/types.js";
import type { CliPathOptions } from "../services/cli-paths.js";
import { type ManagedProcess, webserverStart, webserverStop } from "../services/web-server.js";
import type { UpdateController } from "../updater.js";
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
  browserManager: BrowserGuestManager;
  /**
   * Host paths used by the bundled-CLI resolver in `installCli` (issue #364).
   * `app.isPackaged`, `process.resourcesPath`, and `app.getAppPath()` from
   * the bootstrap. Captured at registration time so the IPC handler can
   * resolve the sidecar binary inside the trust boundary.
   */
  cliPaths: CliPathOptions;
  /** The bootstrap's auto-update controller, which the update toast drives. */
  updates: UpdateController;
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
  // Pass the dashboard window's webContents id so the mapper can label its
  // renderer "Dashboard" and not confuse it with other top-level windows.
  handle(Channels.getAppMetrics, () => getAppMetrics(opts.mainWindow.webContents.id));

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

  // ---- App-update toast ----
  // The renderer reads `updater_status` once on mount (it may mount after a
  // check already finished) and follows `updater-status-changed` after
  // that. The action channels resolve when the step starts, not when it
  // finishes: progress and results arrive as status events.
  handle(Channels.updaterStatus, () => opts.updates.getStatus());
  handle(Channels.updaterCheck, () => {
    void opts.updates.check({ userInitiated: true });
  });
  handle(Channels.updaterDownload, () => {
    void opts.updates.download();
  });
  handle(Channels.updaterRestart, () => opts.updates.restart());
  handle(Channels.updaterDismiss, () => opts.updates.dismiss());

  // ---- Browser panes ----
  const bm = { manager: opts.browserManager };
  handle(Channels.browserRegisterGuest, (args: BrowserRegisterGuestArgs) =>
    browserHandlers.registerGuest(bm, args),
  );
  // CDP screencast experiment bridge
  handle(Channels.browserEnsure, (args: BrowserEnsureArgs) => browserHandlers.ensure(bm, args));
  handle(Channels.browserGetCdpTarget, (args: BrowserKeyArg) =>
    browserHandlers.getCdpTarget(bm, args),
  );
  // DevTools docked into the pane's second <webview>
  handle(Channels.browserOpenDevTools, (args: BrowserOpenDevToolsArgs) =>
    browserHandlers.openDevTools(bm, args),
  );
  handle(Channels.browserCloseDevTools, (args: BrowserKeyArg) =>
    browserHandlers.closeDevTools(bm, args),
  );
  // Cert / load error pages are rendered inside the guest via a `data:`
  // URI (issue #444); button clicks become `band-action://` navigations
  // intercepted by the guest manager. The only renderer-facing surface is
  // this catch-up call so the dashboard chrome can paint the "Not Secure"
  // badge for hosts the user already proceeded to in this session.
  handle(Channels.browserGetOverriddenHosts, () => browserHandlers.getOverriddenHosts(bm));

  // ---- Browser profiles ----
  // Reads Chrome's profile list and cookie DB on this Mac. The renderer
  // asks the user first; only counts come back over IPC.
  handle(Channels.browserChromeProfiles, () => listChromeImportProfiles());
  handle(Channels.browserChromeImport, (args: BrowserChromeImportArgs) =>
    importChromeProfile(args),
  );
  const stopProfilePages = (profileId: string) => opts.browserManager.stopProfilePages(profileId);
  handle(Channels.browserProfileClearData, (args: BrowserProfileArg) =>
    clearProfileData(args.profileId, stopProfilePages),
  );
  handle(Channels.browserProfilePrune, (args: BrowserProfilePruneArgs) =>
    pruneProfileData(Array.isArray(args?.keep) ? args.keep : [], stopProfilePages),
  );

  return () => {
    for (const [channel] of handlers) {
      ipcMain.removeHandler(channel);
    }
  };
}
