import { invoke as desktopInvoke } from "./desktop-ipc";
import { isDesktop, isTauri } from "./is-tauri";

/**
 * Opens a URL in the system browser.
 *
 * In a desktop shell, `window.open()` navigates the webview instead of
 * opening the user's default browser. Both shells expose an `open_external`
 * verb that calls `shell.openExternal(url)` (Electron) or `tauri-plugin-shell`
 * `open(url)` (Tauri). We dispatch via the unified bridge.
 *
 * In a regular web context (non-desktop), `window.open()` works as expected.
 */
export function openExternalUrl(url: string): void {
  if (isDesktop) {
    // Tauri's bridge maps `open_external` → the @tauri-apps/plugin-shell
    // `open()` import below; Electron's main process has a direct handler.
    if (isTauri) {
      import("@tauri-apps/plugin-shell")
        .then(({ open }) => open(url))
        .catch(() => window.open(url));
      return;
    }
    desktopInvoke("open_external", { url }).catch(() => {
      window.open(url, "_blank", "noopener");
    });
    return;
  }
  window.open(url, "_blank", "noopener");
}
