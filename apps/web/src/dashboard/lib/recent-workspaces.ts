const STORAGE_KEY = "band-recent-workspaces";
const MAX_ENTRIES = 50;

/**
 * Record a workspace as most-recently-accessed.
 * Moves it to the front of the list (or inserts it if new).
 */
export function recordWorkspaceAccess(workspaceId: string): void {
  const list = getRecentWorkspaceOrder();
  const filtered = list.filter((id) => id !== workspaceId);
  filtered.unshift(workspaceId);
  if (filtered.length > MAX_ENTRIES) filtered.length = MAX_ENTRIES;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

/**
 * Returns workspace IDs ordered by most-recently-accessed first.
 */
export function getRecentWorkspaceOrder(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Guard every element, not just the array shape: an older/corrupted schema
    // (e.g. numeric ids) must fall through to `[]` rather than feed non-string
    // keys into the switcher's `orderMap` comparison.
    if (Array.isArray(parsed) && parsed.every((e) => typeof e === "string")) return parsed;
  } catch {
    // Corrupted data — ignore
  }
  return [];
}
