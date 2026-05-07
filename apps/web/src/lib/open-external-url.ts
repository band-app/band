import { invoke as desktopInvoke } from "./desktop-ipc";
import { isDesktop } from "./is-desktop";

/**
 * Opens a URL in the system browser.
 *
 * In the Electron desktop shell, `window.open()` navigates the webview
 * instead of opening the user's default browser. The shell exposes an
 * `open_external` verb backed by Electron's `shell.openExternal(url)`.
 *
 * In a regular web context (non-desktop), `window.open()` works as expected.
 */
export function openExternalUrl(url: string): void {
  if (isDesktop) {
    desktopInvoke("open_external", { url }).catch(() => {
      window.open(url, "_blank", "noopener");
    });
    return;
  }
  window.open(url, "_blank", "noopener");
}
