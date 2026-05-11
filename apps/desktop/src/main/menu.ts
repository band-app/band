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
import { dashLog } from "./services/log.js";
import { checkForUpdate, isUpdaterEnabled } from "./updater.js";

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
    dashLog(`menu: no window to invoke ${name}`);
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
      dashLog(
        `menu: ${name} not registered. __BAND_DESKTOP__ in window: ${present}. ` +
          `If false, the preload didn't load; if true, the renderer hasn't mounted yet.`,
      );
    }
  } catch (err) {
    dashLog(`menu: failed to invoke ${name}: ${String(err)}`);
  }
}

function reloadFocused(): void {
  const target = BrowserWindow.getFocusedWindow();
  if (!target) return;
  target.webContents.reload();
}

export function buildAppMenu(): Menu {
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
              dashLog(`menu: check for updates failed: ${String(err)}`);
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
      click: () => reloadFocused(),
    },
    { type: "separator" },
    {
      label: "Zoom In",
      accelerator: "CmdOrCtrl+=",
      click: () => evalInFocused("if(window.__bandZoom)window.__bandZoom('in')"),
    },
    {
      label: "Zoom Out",
      accelerator: "CmdOrCtrl+-",
      click: () => evalInFocused("if(window.__bandZoom)window.__bandZoom('out')"),
    },
    // Zoom-reset deliberately has no accelerator: CmdOrCtrl+0 is owned by
    // the dashboard's "All projects" label filter (see DashboardShell).
    // Reset is still reachable here via menu click.
    {
      label: "Actual Size",
      click: () => evalInFocused("if(window.__bandZoom)window.__bandZoom('reset')"),
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

export function installAppMenu(): void {
  Menu.setApplicationMenu(buildAppMenu());
}
