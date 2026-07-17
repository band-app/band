/**
 * BrowserWindow factory.
 *
 * Mirrors the window setup in `apps/dashboard/src-tauri/tauri.conf.json` and
 * the post-build adjustments in `apps/dashboard/src-tauri/src/lib.rs`:
 *   - 1200×800 default, min 800
 *   - Black window background (so the area behind macOS traffic lights
 *     matches the dark UI; identical to Tauri's NSColor setBackgroundColor)
 *   - Hidden inset title bar (overlay) with traffic lights at (13, 16)
 *   - Resize to fill the primary monitor on launch
 *   - Drag-drop disabled on the window chrome
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, screen } from "electron";
import { resolveAppIcon } from "./icon.js";
import { createLogger } from "./services/log.js";

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
    backgroundColor: "#000000",
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
      // The Tauri shell sets dragDropEnabled=false on the window. The renderer
      // implements its own drag/drop; we don't want files dropped onto the
      // window chrome to navigate the webview.
      webviewTag: false,
    },
  });

  // Tauri sizes the window to fill the primary monitor on launch. Match it.
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.workAreaSize;
  win.setBounds({ x: 0, y: 0, width, height });

  // The dashboard's zoom is CSS-based (`<html> zoom`, see
  // apps/web/src/lib/zoom.ts) — its Chromium-level zoom must always stay
  // at 1. Chromium persists per-origin zoom in the default partition's
  // Preferences, so a stray zoom on the dashboard's origin (historically:
  // zooming a browser tab pointed at localhost:<port> back when tabs
  // shared the default session) would silently rescale the whole window
  // on every boot, misaligning the native WebContentsView overlays.
  // Force it back on every load; this also rewrites the persisted entry.
  win.webContents.on("did-finish-load", () => {
    win.webContents.setZoomLevel(0);
  });

  win.once("ready-to-show", () => {
    win.show();
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
