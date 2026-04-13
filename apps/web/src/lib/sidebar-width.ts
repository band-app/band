const SIDEBAR_WIDTH_KEY = "band:sidebar-width";

/**
 * Load the persisted sidebar width as a percentage (0–100).
 * Falls back to null if nothing is stored yet.
 */
export function loadSidebarWidth(): number | null {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored) {
      const parsed = Number.parseFloat(stored);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed < 100) {
        return parsed;
      }
    }
  } catch {}
  return null;
}

export function saveSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {}
}

/** Minimum sidebar size — matches the original fixed w-80 (320px / 20rem) width */
export const SIDEBAR_MIN_SIZE = "20rem";

/** Maximum sidebar size as a percentage string (numbers are treated as px by react-resizable-panels) */
export const SIDEBAR_MAX_SIZE = "60%";
