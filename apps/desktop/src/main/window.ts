/**
 * BrowserWindow factory.
 *
 * Mirrors the window setup in `apps/dashboard/src-tauri/tauri.conf.json` and
 * the post-build adjustments in `apps/dashboard/src-tauri/src/lib.rs`:
 *   - 1200×800 default, min 800
 *   - Black window background (so the area behind macOS traffic lights
 *     matches the dark UI; identical to Tauri's NSColor setBackgroundColor),
 *     except on macOS, where the window is transparent over a `sidebar`
 *     vibrancy layer so the renderer can let the blurred desktop show
 *     through the project-list sidebar (see `data-translucent-sidebar` in
 *     apps/web/src/styles/globals.css)
 *   - Hidden inset title bar (overlay) with traffic lights at (13, 16)
 *   - Reopen at the last size, position and maximized / full-screen state
 *     (`services/window-state.ts`); the first launch, or one whose saved
 *     bounds are on no connected display, fills the primary monitor
 *   - Drag-drop disabled on the window chrome
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, screen } from "electron";
import { resolveAppIcon } from "./icon.js";
import { createLogger } from "./services/log.js";
import {
  fitToDisplays,
  loadWindowState,
  saveWindowState,
  type WindowState,
} from "./services/window-state.js";

const log = createLogger("window");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolves to the compiled preload entry alongside the main bundle. */
function preloadPath(): string {
  // dist/main/main/index.js → ../../preload/preload/index.cjs
  // The `.cjs` extension is set by `apps/desktop/scripts/postbuild.mjs` so
  // Electron's sandbox loader unambiguously treats the file as CommonJS,
  // independent of any package.json `"type"` settings.
  return resolve(__dirname, "..", "..", "preload", "preload", "index.cjs");
}

/** Save at most this often while the window is dragged or resized. */
const SAVE_DELAY_MS = 500;

/**
 * Apply the saved bounds, or fill the primary display's work area like Tauri
 * did. Returns the saved state when its bounds were used, so the caller
 * maximizes or enters full screen once the window shows: `maximize()` would
 * show the window before the page paints, and macOS ignores full screen on
 * a hidden window.
 */
function restoreWindowState(win: BrowserWindow): WindowState | null {
  const saved = loadWindowState();
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  const bounds = saved ? fitToDisplays(saved.bounds, areas) : null;
  if (bounds) {
    win.setBounds(bounds);
  } else {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    win.setBounds({ x: 0, y: 0, width, height });
  }
  return bounds ? saved : null;
}

/** Save the window's state as it moves, resizes, (un)maximizes and closes. */
function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (win.isDestroyed() || win.isMinimized()) return;
    try {
      saveWindowState({
        bounds: win.getNormalBounds(),
        maximized: win.isMaximized(),
        fullScreen: win.isFullScreen(),
      });
    } catch (err) {
      log.warn({ err: String(err) }, "failed to save window state");
    }
  };
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  };
  win.on("resize", later);
  win.on("move", later);
  win.on("maximize", save);
  win.on("unmaximize", save);
  win.on("enter-full-screen", save);
  win.on("leave-full-screen", save);
  win.on("close", save);
}

export interface CreateMainWindowOptions {
  /** Initial URL to load. */
  url: string;
}

export function createMainWindow(opts: CreateMainWindowOptions): BrowserWindow {
  const iconPath = resolveAppIcon();
  const preload = preloadPath();
  // Diagnostic: log the resolved preload path AND whether the file exists.
  // The most common preload-not-loading cause is a path mismatch.
  log.info({ preload, exists: existsSync(preload) }, "preload path");
  const win = new BrowserWindow({
    title: "Band",
    width: 1200,
    minWidth: 800,
    height: 800,
    x: 0,
    y: 0,
    show: false,
    // On macOS the window is transparent over a `sidebar` vibrancy layer. The
    // renderer paints every region opaque except the project-list sidebar,
    // which it tints lightly so the blurred desktop shows through (or paints
    // solid when the user turns the translucent sidebar off in Settings).
    // `visualEffectState: "active"` keeps the blur when the window loses
    // focus, like Finder's sidebar.
    ...(process.platform === "darwin"
      ? { backgroundColor: "#00000000", vibrancy: "sidebar", visualEffectState: "active" }
      : { backgroundColor: "#000000" }),
    // BrowserWindow.icon is honoured on Windows/Linux; on macOS the dock
    // icon comes from the .icns in the packaged app, so we set it via
    // app.dock.setIcon() below for dev mode.
    icon: iconPath ?? undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Higher than Tauri's `y: 16` so the lights vertically align with the
    // toolbar icons inside the 38px title bar.
    trafficLightPosition: process.platform === "darwin" ? { x: 13, y: 10 } : undefined,
    webPreferences: {
      preload,
      contextIsolation: true,
      // sandbox=false in dev so a preload throw surfaces as an exception
      // rather than being swallowed by Electron's sandbox bundle. Packaged
      // builds re-enable sandbox once we're confident the preload runs.
      sandbox: app.isPackaged,
      nodeIntegration: false,
      // Browser tabs are <webview> guests laid out in the DOM, so Band's
      // menus, dialogs and tooltips stack over them with plain CSS. Every
      // attach goes through `webview-security.ts`, which refuses unknown
      // partitions and sources and strips Node and preload access.
      webviewTag: true,
    },
  });

  const saved = restoreWindowState(win);
  trackWindowState(win);

  // The dashboard's zoom is CSS-based (`<html> zoom`, see
  // apps/web/src/lib/zoom.ts) — its Chromium-level zoom must always stay
  // at 1. Chromium persists per-origin zoom in the default partition's
  // Preferences, so a stray zoom on the dashboard's origin (historically:
  // zooming a browser tab pointed at localhost:<port> back when tabs
  // shared the default session) would silently rescale the whole window
  // on every boot. Force it back on every load; this also rewrites the
  // persisted entry.
  win.webContents.on("did-finish-load", () => {
    win.webContents.setZoomLevel(0);
  });

  win.once("ready-to-show", () => {
    win.show();
    if (saved?.maximized) win.maximize();
    if (saved?.fullScreen) win.setFullScreen(true);
    // Auto-open DevTools in dev so the renderer is inspectable from the
    // first frame. Packaged builds stay quiet — users can toggle DevTools
    // from the View menu (Cmd+Opt+I) on demand.
    if (!app.isPackaged) {
      win.webContents.openDevTools({ mode: "right" });
    }
  });
  void win.loadURL(opts.url);

  return win;
}
