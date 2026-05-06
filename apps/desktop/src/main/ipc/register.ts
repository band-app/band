/**
 * Register every `ipcMain.handle` for the renderer's command surface.
 *
 * Channel names match Tauri exactly so the bridge in
 * `apps/web/src/lib/desktop-ipc.ts` can dispatch the same `invoke(cmd, args)`
 * payloads to either shell.
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
  BrowserEvalArgs,
  BrowserKeyArg,
  BrowserNavigateArgs,
  CheckAppExistsArgs,
  InstallCliArgs,
  OpenExternalArgs,
  OpenWithAppArgs,
  RevealInFinderArgs,
} from "../../shared/types.js";
import type { CliPathOptions } from "../services/cli-paths.js";
import { type ManagedProcess, webserverStart, webserverStop } from "../services/web-server.js";
import { browserHandlers } from "./browser.js";
import {
  checkAppExists,
  installCli,
  openExternal,
  openWithApp,
  pickFolder,
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

  // ---- Phase 1: web server + window ----
  handle(Channels.webserverStart, () =>
    webserverStart({ webDir: opts.webDir, managed: opts.managed }),
  );
  handle(Channels.webserverStop, () =>
    webserverStop({ webDir: opts.webDir, managed: opts.managed }),
  );
  handle(Channels.getAppTitle, () => getAppTitle());
  handle(Channels.windowStartDragging, () => {
    // Electron has no public "start dragging" API. macOS forwards mouse-
    // down events on `-webkit-app-region: drag` regions automatically. We
    // expose a no-op so the renderer's bridge doesn't reject — Phase 5
    // wires the title bar to use the CSS region instead.
  });

  // ---- Phase 2: macOS shell ----
  // Args are camelCase because the renderer (Tauri-shaped) sends camelCase
  // and Electron has no FFI-level case conversion.
  handle(Channels.pickFolder, () => pickFolder(opts.mainWindow));
  handle(Channels.revealInFinder, (args: RevealInFinderArgs) => revealInFinder(args.path));
  handle(Channels.checkAppExists, (args: CheckAppExistsArgs) => checkAppExists(args.appName));
  handle(Channels.openWithApp, (args: OpenWithAppArgs) => openWithApp(args.path, args.appName));
  handle(Channels.installCli, (args: InstallCliArgs) =>
    installCli(args.binaryPath, args.symlinkPath, opts.cliPaths),
  );
  handle(Channels.openExternal, (args: OpenExternalArgs) => openExternal(args.url));

  // ---- Phase 3: browser panels ----
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

  return () => {
    for (const [channel] of handlers) {
      ipcMain.removeHandler(channel);
    }
  };
}
