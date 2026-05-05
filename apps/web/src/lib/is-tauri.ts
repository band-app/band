/**
 * Desktop-shell detection. The dashboard UI (this React app) runs in three
 * contexts: a plain browser tab, the Tauri desktop shell, or the Electron
 * desktop shell (during the issue #306 migration both shells coexist).
 *
 * Each shell exposes a different global so we can detect cheaply at runtime:
 *   - Tauri: `window.__TAURI_INTERNALS__` (Tauri 2.x convention)
 *   - Electron: `window.__BAND_DESKTOP__` (set by our preload — see
 *     `apps/desktop/src/preload/index.ts`)
 *
 * Use `isDesktop` for branches that just need "are we in a native shell?".
 * The shell-specific exports remain available for the rare call site that
 * needs to differentiate (e.g. the Tauri-specific `data-tauri-drag-region`
 * attribute, or shell-specific quirks during the migration).
 */

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const isElectron = typeof window !== "undefined" && "__BAND_DESKTOP__" in window;

export const isDesktop = isTauri || isElectron;
