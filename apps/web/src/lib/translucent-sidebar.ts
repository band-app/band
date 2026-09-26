/**
 * Translucent project-list sidebar (macOS desktop app only).
 *
 * The desktop window on macOS is transparent over a `sidebar` vibrancy layer
 * (`apps/desktop/src/main/window.ts`). Setting the `data-translucent-sidebar`
 * attribute on `<html>` makes `html`/`body` and the AppShell root transparent
 * and tints the sidebar column lightly, so the blurred desktop shows through
 * it. Every other region keeps its solid background (see the rules in
 * `styles/globals.css`).
 *
 * The attribute is applied before first paint by an inline `<head>` script
 * that reads the cached preference from localStorage, then kept in sync with
 * `settings.translucentSidebar` by `TranslucentSidebarSync` in `__root.tsx`.
 */

import { isDesktop } from "./is-desktop";

export const TRANSLUCENT_SIDEBAR_ATTR = "data-translucent-sidebar";

/** localStorage cache of `settings.translucentSidebar` ("0" = off), read by
 *  the pre-paint init script. */
export const TRANSLUCENT_SIDEBAR_STORAGE_KEY = "band:translucent-sidebar";

/** Only the Electron shell on macOS has a vibrancy layer behind the page. */
export const supportsTranslucentSidebar =
  isDesktop && typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** Blocking `<head>` script: sets the attribute before first paint so the
 *  sidebar does not flash solid on launch. Mirrors
 *  `supportsTranslucentSidebar` + `applyTranslucentSidebar`. */
export const TRANSLUCENT_SIDEBAR_INIT_SCRIPT = `(function(){try{if(!("__BAND_DESKTOP__" in window)||!/Mac/.test(navigator.userAgent))return;if(localStorage.getItem(${JSON.stringify(TRANSLUCENT_SIDEBAR_STORAGE_KEY)})==="0")return;document.documentElement.setAttribute(${JSON.stringify(TRANSLUCENT_SIDEBAR_ATTR)},"")}catch(e){}})()`;

export function applyTranslucentSidebar(enabled: boolean): void {
  const on = enabled && supportsTranslucentSidebar;
  document.documentElement.toggleAttribute(TRANSLUCENT_SIDEBAR_ATTR, on);
  try {
    localStorage.setItem(TRANSLUCENT_SIDEBAR_STORAGE_KEY, enabled ? "1" : "0");
  } catch {}
}
