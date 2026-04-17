const ZOOM_LEVEL_KEY = "band:zoom-level";

export const DEFAULT_ZOOM = 1.0;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.0;
export const ZOOM_STEP = 0.1;

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

/** Apply a zoom level to the document root and persist it. */
export function applyZoomLevel(level: number): void {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, level));
  const rounded = Math.round(clamped * 100) / 100;
  document.documentElement.style.zoom = String(rounded);
  saveZoomLevel(rounded);
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
