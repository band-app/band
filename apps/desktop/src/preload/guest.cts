/**
 * Preload for browser-pane `<webview>` guests. Pinned by the main process in
 * `will-attach-webview` (`browser/guest-policy.ts`), so no renderer-supplied
 * `preload` attribute can reach a guest.
 *
 * It exposes nothing to the page. Its only job is to pin `window.close` to a
 * no-op before the page's own scripts run: a guest that closes itself
 * destroys its `<webview>`'s WebContents and leaves the pane blank, while a
 * Band tab is closed from Band's tab strip. Same guard as orca's
 * `browser-window-close` preload.
 *
 * Self-contained CommonJS with no relative imports, for the same sandboxed
 * loader reasons as `index.cts`.
 */

import { contextBridge } from "electron";

function installWindowCloseGuard(): void {
  const ignoreWindowClose = (): void => {};
  try {
    Object.defineProperty(window, "close", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: ignoreWindowClose,
    });
  } catch {
    try {
      window.close = ignoreWindowClose;
    } catch {}
  }
}

contextBridge.executeInMainWorld({ func: installWindowCloseGuard });
