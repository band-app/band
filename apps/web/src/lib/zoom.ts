const ZOOM_LEVEL_KEY = "band:zoom-level";

export const DEFAULT_ZOOM = 1.0;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.0;
export const ZOOM_STEP = 0.1;

/** CSS custom property mirroring the current `<html>` zoom factor. Anything that
 *  needs to opt out of the document-level CSS `zoom` (notably the xterm.js
 *  terminal — see TerminalPanel) can counter-scale with
 *  `zoom: calc(1 / var(--app-zoom, 1))`. The `<html>` `zoom` itself is what
 *  zooms everything else; the CSS variable just gives consumers a handle. */
export const ZOOM_CSS_VAR = "--app-zoom";

/** Custom window event fired whenever the app-wide zoom level changes (locally
 *  via {@link applyZoomLevel} or via the cross-window storage handler in
 *  `ZoomSync`). Subscribers receive the new level via `event.detail`.
 *  TerminalPanel uses this to drive xterm's `fontSize` so terminal text scales
 *  with the rest of the UI even though the terminal container itself is taken
 *  out of the document-level `zoom` coordinate space. */
export const ZOOM_CHANGE_EVENT = "band:zoom-changed";

/**
 * Load the persisted zoom level (0.5–2.0).
 * Falls back to DEFAULT_ZOOM if nothing is stored or the value is invalid.
 */
export function loadZoomLevel(): number {
  try {
    const stored = localStorage.getItem(ZOOM_LEVEL_KEY);
    if (stored) {
      const parsed = Number.parseFloat(stored);
      if (!Number.isNaN(parsed) && parsed >= MIN_ZOOM && parsed <= MAX_ZOOM) {
        return parsed;
      }
    }
  } catch {}
  return DEFAULT_ZOOM;
}

/** Persist a zoom level to localStorage, clamped and rounded. */
export function saveZoomLevel(level: number): void {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, level));
  const rounded = Math.round(clamped * 100) / 100;
  try {
    localStorage.setItem(ZOOM_LEVEL_KEY, String(rounded));
  } catch {}
}

/**
 * DOM-only zoom application: updates `<html>` `zoom`, mirrors the value onto
 * the {@link ZOOM_CSS_VAR} CSS variable, and dispatches the
 * {@link ZOOM_CHANGE_EVENT}. Does NOT persist to localStorage — call this
 * from contexts where the value is already persisted elsewhere (e.g. the
 * cross-window `storage` event handler in `ZoomSync`, where the originating
 * window already wrote the value). Returns the clamped/rounded level it
 * actually applied so callers can save it without re-clamping.
 *
 * Prefer {@link applyZoomLevel} for user-driven zoom changes; this lower-
 * level helper exists only for the sync path that must avoid the
 * (currently benign in Chromium, but spec-non-guaranteed) cross-window
 * storage echo.
 */
export function applyZoomLevelToDom(level: number): number {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, level));
  const rounded = Math.round(clamped * 100) / 100;
  const root = document.documentElement;
  root.style.zoom = String(rounded);
  // Mirror onto a CSS custom property so anything that needs to counter-zoom
  // (TerminalPanel's xterm container) can do
  // `zoom: calc(1 / var(--app-zoom, 1))` without touching JS.
  root.style.setProperty(ZOOM_CSS_VAR, String(rounded));
  // Fire the change event AFTER the DOM is up to date so subscribers can
  // read the post-update state synchronously. `CustomEvent` and
  // `dispatchEvent` have universal cross-browser support and cannot throw
  // with a `number` detail, so we deliberately do NOT wrap this in a
  // try/catch — a silent swallow would only mask a real regression (the
  // event failing to fire means TerminalPanel would stop reacting to
  // zoom, and we'd rather see the exception loudly).
  window.dispatchEvent(new CustomEvent<number>(ZOOM_CHANGE_EVENT, { detail: rounded }));
  return rounded;
}

/**
 * Apply a zoom level to the document root, mirror it onto the
 * {@link ZOOM_CSS_VAR} custom property, dispatch the
 * {@link ZOOM_CHANGE_EVENT} so subscribers (e.g. TerminalPanel) can react, and
 * persist the level to localStorage.
 */
export function applyZoomLevel(level: number): void {
  const applied = applyZoomLevelToDom(level);
  saveZoomLevel(applied);
}

/**
 * Read the currently applied zoom factor. Prefers the live CSS variable on
 * `<html>` (what the DOM is actually rendering with) and falls back to the
 * persisted value, then the default. Safe to call before any `applyZoomLevel`
 * has run — returns {@link DEFAULT_ZOOM} in that case.
 */
export function getCurrentZoomLevel(): number {
  if (typeof document !== "undefined") {
    const css = document.documentElement.style.getPropertyValue(ZOOM_CSS_VAR);
    if (css) {
      const parsed = Number.parseFloat(css);
      if (!Number.isNaN(parsed) && parsed >= MIN_ZOOM && parsed <= MAX_ZOOM) {
        return parsed;
      }
    }
  }
  return loadZoomLevel();
}

/**
 * Subscribe to {@link ZOOM_CHANGE_EVENT}. The handler is invoked with the new
 * zoom level whenever {@link applyZoomLevel} runs (locally or via cross-window
 * sync). Returns an unsubscribe function.
 */
export function subscribeToZoomChanges(handler: (level: number) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<number>).detail;
    if (typeof detail === "number") handler(detail);
  };
  window.addEventListener(ZOOM_CHANGE_EVENT, listener);
  return () => window.removeEventListener(ZOOM_CHANGE_EVENT, listener);
}

export function zoomIn(): void {
  applyZoomLevel(loadZoomLevel() + ZOOM_STEP);
}

export function zoomOut(): void {
  applyZoomLevel(loadZoomLevel() - ZOOM_STEP);
}

export function zoomReset(): void {
  applyZoomLevel(DEFAULT_ZOOM);
}
