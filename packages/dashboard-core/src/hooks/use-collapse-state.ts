import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Tracks which items in a collection are collapsed, persisting the set to
 * localStorage so the state survives page reloads. Used by the project list
 * to remember which projects and label groups the user has collapsed.
 *
 * The state is stored as a JSON-serialised array of string ids; missing keys
 * mean "expanded" so brand-new projects/labels show up expanded by default.
 */

/** localStorage key for the collapsed-projects set (project names). */
export const PROJECTS_COLLAPSE_KEY = "band.projects-list.collapsed-projects";
/** localStorage key for the collapsed-label-groups set (label ids + UNLABELED_KEY). */
export const LABELS_COLLAPSE_KEY = "band.projects-list.collapsed-labels";
/** Sentinel id for the "Unlabeled" group — it has no real label.id. */
export const UNLABELED_KEY = "__unlabeled";

/** Custom event used to broadcast same-tab updates. The native `storage`
 *  event only fires across tabs, so we dispatch this on every write. */
const SYNC_EVENT = "band:collapse-state-change";

function read(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
      return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    // Corrupted entry — start fresh
  }
  return new Set();
}

function write(key: string, set: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    // localStorage full or unavailable — ignore
  }
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { key } }));
}

export interface CollapseState {
  isCollapsed: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Replace the entire collapsed set in one shot (used for collapse-all). */
  setAll: (ids: Iterable<string>) => void;
}

export function useCollapseState(storageKey: string): CollapseState {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => read(storageKey));

  // Sync across tabs *and* across same-tab consumers. The native `storage`
  // event covers cross-tab; the SYNC_EVENT fires from `write` so a setAll
  // call (e.g. from the toolbar's Collapse-all button) immediately re-renders
  // every component that uses the same storage key.
  useEffect(() => {
    const sync = (e: Event) => {
      if (e instanceof StorageEvent && e.key !== storageKey) return;
      if (e instanceof CustomEvent && e.detail?.key !== storageKey) return;
      setCollapsed(read(storageKey));
    };
    window.addEventListener("storage", sync);
    window.addEventListener(SYNC_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SYNC_EVENT, sync);
    };
  }, [storageKey]);

  const isCollapsed = useCallback((id: string) => collapsed.has(id), [collapsed]);

  const toggle = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        write(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const setAll = useCallback(
    (ids: Iterable<string>) => {
      const next = new Set(ids);
      write(storageKey, next);
      setCollapsed(next);
    },
    [storageKey],
  );

  // Memoised so consumers can use the returned object as a useMemo/useEffect
  // dependency without triggering work on every render.
  return useMemo(() => ({ isCollapsed, toggle, setAll }), [isCollapsed, toggle, setAll]);
}
