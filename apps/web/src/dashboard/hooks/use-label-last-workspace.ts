import { useCallback, useEffect, useState } from "react";

/**
 * Per-label "last selected workspace" memory.
 *
 * Lets the dashboard restore the workspace the user was last viewing under
 * a particular label when they switch back to that label (issue #505). The
 * map is stored as JSON in localStorage with a custom event for same-tab
 * synchronisation — mirroring `useLabelFilter` so multiple DashboardShell
 * instances (one per cached workspace) all agree on what's remembered.
 *
 * The dashboard's `setLabelFilter` orchestration layer is responsible for
 * deciding *when* to call `setLastWorkspace` — see `DashboardShell` — so
 * this hook is a passive store. In particular, ALL (label === null) has
 * no per-label memory: callers must not write the null key here.
 */

/** localStorage key for the per-label "last workspace" map. */
export const LABEL_LAST_WORKSPACE_KEY = "band.projects-list.label-last-workspace";

/** Custom event broadcast on every write so other consumers re-read. */
const SYNC_EVENT = "band:label-last-workspace-change";

function read(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LABEL_LAST_WORKSPACE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k === "string" && typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // Corrupted entry — start fresh.
  }
  return {};
}

function write(value: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LABEL_LAST_WORKSPACE_KEY, JSON.stringify(value));
  } catch {
    // localStorage full or unavailable — ignore.
  }
  window.dispatchEvent(new CustomEvent(SYNC_EVENT));
}

export interface UseLabelLastWorkspaceReturn {
  /** Look up the last workspaceId selected while `labelId` was active.
   *  Returns `undefined` when no history exists yet. */
  getLastWorkspace: (labelId: string) => string | undefined;
  /** Record `workspaceId` as the last workspace selected while `labelId`
   *  was active. Safe to call repeatedly with the same value (no-op when
   *  unchanged). */
  setLastWorkspace: (labelId: string, workspaceId: string) => void;
}

export function useLabelLastWorkspace(): UseLabelLastWorkspaceReturn {
  const [map, setMap] = useState<Record<string, string>>(() => read());

  // Sync across tabs (native StorageEvent) and across same-tab consumers
  // (custom SYNC_EVENT, fired by `write` since the StorageEvent is
  // cross-tab-only). Same pattern as `useLabelFilter` for consistency.
  useEffect(() => {
    const sync = (e: Event) => {
      if (e instanceof StorageEvent && e.key !== LABEL_LAST_WORKSPACE_KEY) return;
      setMap(read());
    };
    window.addEventListener("storage", sync);
    window.addEventListener(SYNC_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SYNC_EVENT, sync);
    };
  }, []);

  const getLastWorkspace = useCallback((labelId: string) => map[labelId], [map]);

  // Two-step write: persist + dispatch FIRST, then update local React state.
  // Calling `write()` inside the functional updater would dispatch
  // SYNC_EVENT during the setter, which queues `setMap(read())` from the
  // sync handler — a state setter invoked from inside another setter's
  // updater is unsupported by React (the nested call can be silently
  // dropped). `useLabelFilter` uses the same two-step pattern; mirror it
  // here. Reading the current map via `read()` (rather than the closed-
  // over `map`) keeps the no-op short-circuit correct across rapid
  // back-to-back calls where `map` hasn't yet committed.
  const setLastWorkspace = useCallback((labelId: string, workspaceId: string) => {
    const current = read();
    if (current[labelId] === workspaceId) return;
    const next = { ...current, [labelId]: workspaceId };
    write(next);
    setMap(next);
  }, []);

  return { getLastWorkspace, setLastWorkspace };
}
