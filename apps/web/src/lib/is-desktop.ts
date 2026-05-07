/**
 * Desktop-shell detection. The dashboard UI (this React app) runs in two
 * contexts: a plain browser tab or the Electron desktop shell.
 *
 * The Electron preload (`apps/desktop/src/preload/index.cts`) exposes
 * `window.__BAND_DESKTOP__`, so detection at runtime is a single property
 * check.
 */

export const isDesktop = typeof window !== "undefined" && "__BAND_DESKTOP__" in window;
