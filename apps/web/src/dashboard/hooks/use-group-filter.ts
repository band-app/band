import { useCallback, useEffect, useState } from "react";
import { clientStorage } from "../../lib/client-state";

/**
 * Tracks the currently-selected repo-list group filter and shares it across
 * every DashboardShell instance on the page. Multiple worktrees each render
 * their own DashboardShell (inactive ones are display:none-hidden), so a plain
 * `useState` would give each one a separate filter — switching worktrees
 * would appear to "reset" the dropdown. Persisting through localStorage plus
 * a same-tab CustomEvent keeps every instance in sync and survives reloads.
 *
 * Value is the group id, or `null` for "All".
 */

/** localStorage key for the active group filter. */
export const GROUP_FILTER_KEY = "band.repos-list.group-filter";

/** Custom event used to broadcast same-tab updates. The native `storage`
 *  event only fires across tabs, so we dispatch this on every write. */
const SYNC_EVENT = "band:group-filter-change";

function read(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(GROUP_FILTER_KEY);
    return raw ?? null;
  } catch {
    return null;
  }
}

function write(value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value == null) {
      clientStorage.removeItem(GROUP_FILTER_KEY);
    } else {
      clientStorage.setItem(GROUP_FILTER_KEY, value);
    }
  } catch {
    // localStorage full or unavailable — ignore
  }
  window.dispatchEvent(new CustomEvent(SYNC_EVENT));
}

export function useGroupFilter(): [string | null, (next: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => read());

  useEffect(() => {
    const sync = (e: Event) => {
      if (e instanceof StorageEvent && e.key !== GROUP_FILTER_KEY) return;
      setValue(read());
    };
    window.addEventListener("storage", sync);
    window.addEventListener(SYNC_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SYNC_EVENT, sync);
    };
  }, []);

  const setGroupFilter = useCallback((next: string | null) => {
    write(next);
    setValue(next);
  }, []);

  return [value, setGroupFilter];
}
