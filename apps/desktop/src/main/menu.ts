/**
 * Application menu — direct port of the Tauri menu set up in
 * `apps/dashboard/src-tauri/src/lib.rs::run`:
 *
 *   - **Band** submenu: About, Quit, plus standard hide/show siblings.
 *   - **Edit** submenu: undo/redo/cut/copy/paste/select-all (macOS routes
 *     Cmd+C/V/X/A through these even for webviews loading external URLs).
 *   - **View** submenu: Reload (Cmd+R), Zoom In/Out/Reset (Cmd+=/-/0),
 *     Settings… (Cmd+,).
 *
 * The zoom and settings menu items don't run main-process logic on click —
 * they call window globals (`window.__bandZoom`, `window.__bandOpenSettings`)
 * registered by the React tree (see `routes/__root.tsx` and
 * `packages/dashboard-core/src/components/DashboardShell.tsx`). Same pattern
 * the Tauri shell uses (`webview.eval`); here we use Electron's
 * `executeJavaScript`.
 *
 * Phase 5 of issue #306 added everything except "Check for Updates…",
 * which Phase 6 (issue #363) wires up here against `electron-updater`.
 */

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import type { BrowserViewManager } from "../browser/view-manager.js";
import { createLogger } from "./services/log.js";
import { checkForUpdate, isUpdaterEnabled } from "./updater.js";

const log = createLogger("menu");

/**
 * Resolved at menu-click time so the menu can be installed before the
 * `BrowserViewManager` exists (we install the menu in `app.whenReady`,
 * the manager is constructed after the main window is created).
 */
export interface MenuDeps {
  getBrowserManager: () => BrowserViewManager | null;
}

/** Run JS in whichever window is focused, falling back to the main window. */
function evalInFocused(js: string): void {
  const target =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
    null;
  if (!target) return;
  void target.webContents.executeJavaScript(js, true).catch(() => {
    // Renderer hasn't registered the global yet (e.g. mid-reload). Drop.
  });
}

/**
 * Cmd+= / Cmd+- / Actual-Size routing — same shape as `reloadFocused`:
 *
 *   1. WebContentsView has focus (user is in a rendered web page) →
 *      adjust that view's `zoomFactor` directly.
 *   2. Otherwise call `window.__bandZoom(action)`, which decides between
 *      "zoom the browser pane the user is in" (IPC back to
 *      `browser_zoom`) and "zoom the dashboard chrome".
 */
function zoomFocused(deps: MenuDeps, action: "in" | "out" | "reset"): void {
  if (deps.getBrowserManager()?.zoomFocused(action)) return;
  evalInFocused(`if(window.__bandZoom)window.__bandZoom(${JSON.stringify(action)})`);
}

/**
 * Try to invoke a renderer-registered global like `window.__bandOpenSettings`.
 * Returns whether the global was actually present and called. Logs diagnostic
 * info to ~/.band/desktop.log when it's missing — the typical cause is that
 * the renderer's preload didn't load (so `isDesktop` is false in the React
 * tree, so the global was never registered).
 */
async function callRendererGlobal(name: string): Promise<void> {
  const target =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
    null;
  if (!target) {
    log.warn({ name }, "no window to invoke");
    return;
  }
  // Run a probe expression that returns whether the global was present and
  // called. The renderer's `__bandOpenSettings` handler is set by
  // `DashboardShell.tsx` in response to `isDesktop`, which depends on the
  // preload. If this returns false we know the chain is broken.
  const js = `(() => {
    if (typeof window["${name}"] === "function") { window["${name}"](); return true; }
    return false;
  })()`;
  try {
    const ok = await target.webContents.executeJavaScript(js, true);
    if (!ok) {
      const present = await target.webContents.executeJavaScript(
        "'__BAND_DESKTOP__' in window",
        true,
      );
      log.warn(
        { name, bandDesktopPresent: present },
        "renderer global not registered (if bandDesktopPresent=false the preload didn't load; if true the renderer hasn't mounted yet)",
      );
    }
  } catch (err) {
    log.error({ name, err: String(err) }, "failed to invoke renderer global");
  }
}

/**
 * Cmd+R / Ctrl+R reload, routed by what's actually focused:
 *
 *   1. If a browser-pane `WebContentsView` has keyboard focus (the user
 *      is clicked inside a rendered web page), reload that view — don't
 *      reload the whole dashboard out from under them.
 *
 *   2. Otherwise call the renderer's `__bandReload` global. If keyboard
 *      focus is in a browser-pane's *React* chrome (address bar, find
 *      bar, tab handle), the global locates the pane via the
 *      `data-band-browser-pane-*` attributes and reloads its tab via
 *      `browser_reload` IPC. If focus is anywhere else, the global
 *      falls through to `location.reload()` — same effect as the
 *      previous dumb behaviour.
 *
 *   3. If the renderer global isn't registered (preload missing, or
 *      called before the React tree mounted), reload the focused window
 *      directly so the menu item still does *something*.
 */
async function reloadFocused(deps: MenuDeps): Promise<void> {
  const focusedView = deps.getBrowserManager()?.findFocused();
  if (focusedView) {
    focusedView.webContents.reload();
    return;
  }

  const target =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
    null;
  if (!target) return;

  // `__bandReload` returns true if it consumed the event (either
  // reloaded a browser pane or chose to reload the app itself). If it's
  // not registered we get false and fall back to reloading the window.
  const js = `(() => {
    if (typeof window.__bandReload === "function") { window.__bandReload(); return true; }
    return false;
  })()`;
  try {
    const handled = await target.webContents.executeJavaScript(js, true);
    if (!handled) target.webContents.reload();
  } catch (err) {
    log.error({ err: String(err) }, "__bandReload invocation failed");
    target.webContents.reload();
  }
}

export function buildAppMenu(deps: MenuDeps): Menu {
  const isMac = process.platform === "darwin";

  const appName = app.name ?? "Band";

  // Match the Tauri shell: when the updater is disabled (dev runs) the
  // menu item is omitted entirely rather than greyed out. See lib.rs::run
  // for the equivalent `if UPDATER_ENABLED { ... }` branch.
  const updaterItems: MenuItemConstructorOptions[] = isUpdaterEnabled(app.isPackaged)
    ? [
        { type: "separator" },
        {
          label: "Check for Updates…",
          click: () => {
            void checkForUpdate(true).catch((err) => {
              log.error({ err: String(err) }, "check for updates failed");
            });
          },
        },
      ]
    : [];

  const bandSubmenu: MenuItemConstructorOptions[] = [
    { role: "about", label: `About ${appName}` },
    ...updaterItems,
    { type: "separator" },
    { role: "services" },
    { type: "separator" },
    { role: "hide", label: `Hide ${appName}` },
    { role: "hideOthers" },
    { role: "unhide" },
    { type: "separator" },
    { role: "quit", label: `Quit ${appName}` },
  ];

  const editSubmenu: MenuItemConstructorOptions[] = [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "selectAll" },
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = [
    {
      label: "Reload",
      accelerator: "CmdOrCtrl+R",
      click: () => {
        void reloadFocused(deps);
      },
    },
    { type: "separator" },
    {
      label: "Zoom In",
      accelerator: "CmdOrCtrl+=",
      click: () => zoomFocused(deps, "in"),
    },
    {
      label: "Zoom Out",
      accelerator: "CmdOrCtrl+-",
      click: () => zoomFocused(deps, "out"),
    },
    // Zoom-reset deliberately has no accelerator: CmdOrCtrl+0 is owned by
    // the dashboard's "All projects" label filter (see DashboardShell).
    // Reset is still reachable here via menu click.
    {
      label: "Actual Size",
      click: () => zoomFocused(deps, "reset"),
    },
    { type: "separator" },
    {
      label: "Settings…",
      accelerator: "CmdOrCtrl+,",
      click: () => {
        void callRendererGlobal("__bandOpenSettings");
      },
    },
    { type: "separator" },
    // Standard accelerator: Cmd+Opt+I (macOS) / Ctrl+Shift+I (Windows/Linux).
    { role: "toggleDevTools" },
  ];

  const windowSubmenu: MenuItemConstructorOptions[] = [
    { role: "minimize" },
    { role: "zoom" },
    ...(isMac
      ? ([
          { type: "separator" as const },
          { role: "front" as const },
          { type: "separator" as const },
          { role: "window" as const },
        ] satisfies MenuItemConstructorOptions[])
      : ([{ role: "close" as const }] satisfies MenuItemConstructorOptions[])),
  ];

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({ label: appName, submenu: bandSubmenu });
  }
  template.push({ label: "Edit", submenu: editSubmenu });
  template.push({ label: "View", submenu: viewSubmenu });
  template.push({ label: "Window", submenu: windowSubmenu, role: "window" });

  return Menu.buildFromTemplate(template);
}

export function installAppMenu(deps: MenuDeps): void {
  Menu.setApplicationMenu(buildAppMenu(deps));
}
