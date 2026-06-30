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

const SIDEBAR_COLLAPSED_KEY = "band:sidebar-collapsed";

/**
 * Whether the project-list sidebar was last left collapsed (hidden).
 * Defaults to `false` (visible) when nothing is stored.
 */
export function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {}
}

/** Minimum sidebar size (240px / 15rem) */
export const SIDEBAR_MIN_SIZE = "15rem";

/** Maximum sidebar size as a percentage string (numbers are treated as px by react-resizable-panels) */
export const SIDEBAR_MAX_SIZE = "60%";
