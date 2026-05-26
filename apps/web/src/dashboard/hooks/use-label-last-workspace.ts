import { useCallback } from "react";

/**
 * Per-label "last selected workspace" memory.
 *
 * Lets the dashboard restore the workspace the user was last viewing under
 * a particular label when they switch back to that label (issue #505). The
 * map is stored as JSON in localStorage; both `getLastWorkspace` and
 * `setLastWorkspace` go through `read()` / `write()` at call time, so the
 * hook needs no React state of its own — values are always fresh, and
 * callers that need reactivity should subscribe to the SYNC_EVENT directly.
 *
 * The dashboard's `setLabelFilter` orchestration layer is responsible for
 * deciding *when* to call `setLastWorkspace` — see `DashboardShell` — so
 * this hook is a passive store. In particular, ALL (label === null) has
 * no per-label memory: callers must not write the null key here.
 */

/** localStorage key for the per-label "last workspace" map. */
export const LABEL_LAST_WORKSPACE_KEY = "band.projects-list.label-last-workspace";

/** Custom event broadcast on every successful write. Cross-tab updates
 *  also reach consumers via the native `storage` event. No same-file
 *  consumer subscribes today; the event is exposed for future
 *  reactive use cases that might want to refresh when another tab
 *  mutates the map. */
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
  // NB: dispatch lives INSIDE the try block — intentional deviation
  // from `useLabelFilter.write`, which dispatches unconditionally. The
  // map carries cross-consumer state that subscribers re-read via
  // `read()` on every SYNC_EVENT, so a failed `setItem` paired with
  // an unconditional dispatch would make every consumer pick up the
  // stale on-disk value and silently lose the caller's intended
  // update. `useLabelFilter`'s value is consumed locally per shell
  // rather than read back from storage on each event, so the
  // trade-off there doesn't apply.
  try {
    window.localStorage.setItem(LABEL_LAST_WORKSPACE_KEY, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent(SYNC_EVENT));
  } catch {
    // localStorage full or unavailable — ignore, and skip the dispatch.
  }
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
  // Both methods go through `read()` / `write()` at call time. No React
  // state is needed because nothing about the map is rendered today —
  // `getLastWorkspace` is only invoked imperatively from
  // `DashboardShell.setLabelFilter` on a user action, where reading
  // localStorage directly gives an always-fresh value and frees the
  // callback closure from any React state, keeping
  // `getLastWorkspace`'s identity stable across navigations so
  // downstream `useCallback`s don't rebuild and the keyboard shortcut
  // listener doesn't re-attach. If a future reactive consumer is
  // added, subscribe to SYNC_EVENT + the native `storage` event in
  // that consumer rather than re-introducing global state here.
  const getLastWorkspace = useCallback((labelId: string) => read()[labelId], []);
  const setLastWorkspace = useCallback((labelId: string, workspaceId: string) => {
    const current = read();
    if (current[labelId] === workspaceId) return;
    write({ ...current, [labelId]: workspaceId });
  }, []);

  return { getLastWorkspace, setLastWorkspace };
}
