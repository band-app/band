import { isTauri } from "./is-tauri";

/**
 * Opens a URL in the system browser.
 *
 * In Tauri, `window.open()` navigates the webview instead of opening the
 * user's default browser.  We use the `@tauri-apps/plugin-shell` `open()`
 * function for proper behaviour and fall back to `window.open()` on failure.
 *
 * In a regular web context, `window.open()` works as expected.
 */
export function openExternalUrl(url: string): void {
  if (isTauri) {
    import("@tauri-apps/plugin-shell").then(({ open }) => open(url)).catch(() => window.open(url));
  } else {
    window.open(url, "_blank", "noopener");
  }
}
