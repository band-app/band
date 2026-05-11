import { useCallback, useEffect, useState } from "react";

/**
 * Tracks the currently-selected project-list label filter and shares it across
 * every DashboardShell instance on the page. Multiple workspaces each render
 * their own DashboardShell (inactive ones are display:none-hidden), so a plain
 * `useState` would give each one a separate filter — switching workspaces
 * would appear to "reset" the dropdown. Persisting through localStorage plus
 * a same-tab CustomEvent keeps every instance in sync and survives reloads.
 *
 * Value is the label id, or `null` for "All".
 */

/** localStorage key for the active label filter. */
export const LABEL_FILTER_KEY = "band.projects-list.label-filter";

/** Custom event used to broadcast same-tab updates. The native `storage`
 *  event only fires across tabs, so we dispatch this on every write. */
const SYNC_EVENT = "band:label-filter-change";

function read(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LABEL_FILTER_KEY);
    return raw ?? null;
  } catch {
    return null;
  }
}

function write(value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value == null) {
      window.localStorage.removeItem(LABEL_FILTER_KEY);
    } else {
      window.localStorage.setItem(LABEL_FILTER_KEY, value);
    }
  } catch {
    // localStorage full or unavailable — ignore
  }
  window.dispatchEvent(new CustomEvent(SYNC_EVENT));
}

export function useLabelFilter(): [string | null, (next: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => read());

  useEffect(() => {
    const sync = (e: Event) => {
      if (e instanceof StorageEvent && e.key !== LABEL_FILTER_KEY) return;
      setValue(read());
    };
    window.addEventListener("storage", sync);
    window.addEventListener(SYNC_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SYNC_EVENT, sync);
    };
  }, []);

  const setLabelFilter = useCallback((next: string | null) => {
    write(next);
    setValue(next);
  }, []);

  return [value, setLabelFilter];
}
