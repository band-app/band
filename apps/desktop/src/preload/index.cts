/**
 * Preload script — exposes a minimal, allowlisted IPC surface to the renderer.
 *
 * The renderer side (in `apps/web`) reads `window.__BAND_DESKTOP__` via
 * `apps/web/src/lib/desktop-ipc.ts`. The API shape (`invoke(channel, args)`
 * / `on(event, cb)`) is intentionally simple so renderer call sites do not
 * need to know about Electron's IPC primitives.
 *
 * Compiled as CommonJS (`module: CommonJS`). Electron's sandboxed preload
 * runtime is CJS-only: ESM `import` statements throw `SyntaxError: Cannot
 * use import statement outside a module` even on Electron 33+.
 *
 * **Self-contained, NO relative imports**. The sandboxed preload loader
 * uses Electron's bundled module resolver, which doesn't reliably honour
 * Node's package.json `"type"` field for sub-paths. To avoid every possible
 * resolution edge case, the channel/event allowlists are inlined here
 * rather than imported from `src/shared/ipc-channels.ts`. The list is
 * duplicated, but the list ON the main process side
 * (`apps/desktop/src/shared/ipc-channels.ts`) remains the source of truth
 * for handlers and emitters — the duplication is one-way and small.
 *
 * No third-party deps; no Node modules beyond `electron`.
 */

import type { IpcRendererEvent } from "electron";
import { contextBridge, ipcRenderer } from "electron";

// Loud trace so we can confirm the preload actually runs (visible in
// DevTools console). If you don't see this, Electron isn't even loading
// the preload — usually a path mismatch or a sandbox loader rejection.
console.log("[band-preload] running");

// ---- Inlined allowlist (kept in sync with `src/shared/ipc-channels.ts`) ----
// If you add a channel/event in the main process, add it here too.

const ALLOWED_INVOKE_CHANNELS = new Set<string>([
  // Phase 1 — web server + window
  "webserver_start",
  "webserver_stop",
  "get_app_title",
  "get_window_fullscreen",
  "get_app_metrics",
  // Phase 2 — macOS shell + open_external
  "pick_folder",
  "pick_file",
  "pick_save_file",
  "reveal_in_finder",
  "check_app_exists",
  "open_with_app",
  "install_cli",
  "open_external",
  // App-update toast
  "updater_status",
  "updater_check",
  "updater_download",
  "updater_restart",
  "updater_dismiss",
  // Browser panes (<webview> guests; navigation, find and zoom need no IPC)
  "browser_register_guest",
  // CDP screencast experiment bridge
  "browser_ensure",
  "browser_get_cdp_target",
  // DevTools docked into the pane's second <webview>
  "browser_open_dev_tools",
  "browser_close_dev_tools",
  // Chrome-style cert / load error pages (issue #444). Painted
  // inside the guest; only the overridden-hosts catch-up
  // crosses the IPC boundary.
  "browser_get_overridden_hosts",
  // Browser profiles + Chrome cookie import
  "browser_chrome_profiles",
  "browser_chrome_import",
  "browser_profile_clear_data",
  "browser_profile_prune",
]);

const ALLOWED_EVENT_NAMES = new Set<string>([
  "browser-url-changed",
  "browser-title-changed",
  "browser-view-destroyed",
  // Pane shortcuts typed inside a guest page, re-dispatched on its <webview>
  "browser-guest-shortcut",
  "browser-host-overridden",
  // Issue #488: page-initiated window.open / target="_blank" /
  // middle-click — forwarded by the main process so the renderer
  // can open a new Band tab instead of a detached OS window.
  "browser-open-window",
  "window-fullscreen-changed",
  "updater-status-changed",
  // Wake from system sleep / screen unlock (powerMonitor resume/unlock-screen);
  // WebGL surfaces subscribe to repair their glyph atlases.
  "system-resumed",
]);

type Unlisten = () => void;

const api = {
  /** Tag so the renderer can detect the Electron shell. */
  version: 1 as const,

  /**
   * Invoke a main-process handler.
   *
   * Channels are gated by the allowlist; unknown channels reject so a
   * compromised renderer cannot poke at arbitrary `ipcMain.handle` slots.
   */
  invoke(channel: string, args?: unknown): Promise<unknown> {
    if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`Channel '${channel}' is not allowed`));
    }
    return ipcRenderer.invoke(channel, args);
  },

  /**
   * Subscribe to a main-process-emitted event. Returns an unlisten function
   * the renderer calls to detach the listener.
   */
  on(event: string, cb: (payload: unknown) => void): Unlisten {
    if (!ALLOWED_EVENT_NAMES.has(event)) {
      throw new Error(`Event '${event}' is not allowed`);
    }
    const handler = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
};

try {
  contextBridge.exposeInMainWorld("__BAND_DESKTOP__", api);
  console.log("[band-preload] __BAND_DESKTOP__ exposed");
} catch (err) {
  console.error("[band-preload] exposeInMainWorld failed:", err);
}
