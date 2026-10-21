import { toWorktreeId } from "@band-app/shared/worktree-id";
import { useCallback, useEffect, useRef } from "react";
import { clientStorage } from "../../lib/client-state";
import { useGroupFilter } from "./use-group-filter";
import { useRepos } from "./use-repos";

/**
 * Per-group "last selected worktree" memory.
 *
 * Lets the dashboard restore the worktree the user was last viewing under
 * a particular group when they switch back to that group (issue #505). The
 * map is stored as JSON in localStorage; both `getLastWorktree` and
 * `setLastWorktree` read and write storage at call time, so the hook needs no React state of its own — values are always fresh, and
 * callers that need reactivity should subscribe to the SYNC_EVENT directly.
 *
 * Two callers decide *when* to write: `useRecordGroupLastWorktree` (below,
 * run by the app shell) when a worktree is opened under a group, and
 * `DashboardShell`'s `setGroupFilter` on a group switch. ALL (group ===
 * null) has no per-group memory: callers must not write the null key here.
 */

/** localStorage key for the per-group "last worktree" map. */
export const GROUP_LAST_WORKTREE_KEY = "band.repos-list.group-last-worktree";

/** Custom event broadcast on every successful write. Cross-tab updates
 *  also reach consumers via the native `storage` event. No same-file
 *  consumer subscribes today; the event is exposed for future
 *  reactive use cases that might want to refresh when another tab
 *  mutates the map. */
const SYNC_EVENT = "band:group-last-worktree-change";

/** The saved map, group id to worktree id; empty when nothing is saved. */
export function readGroupLastWorktrees(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(GROUP_LAST_WORKTREE_KEY);
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
  // from `useGroupFilter.write`, which dispatches unconditionally. The
  // map carries cross-consumer state that subscribers re-read via
  // `readGroupLastWorktrees()` on every SYNC_EVENT, so a failed
  // `setItem` paired with an unconditional dispatch would make every consumer pick up the
  // stale on-disk value and silently lose the caller's intended
  // update. `useGroupFilter`'s value is consumed locally per shell
  // rather than read back from storage on each event, so the
  // trade-off there doesn't apply.
  try {
    clientStorage.setItem(GROUP_LAST_WORKTREE_KEY, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent(SYNC_EVENT));
  } catch {
    // localStorage full or unavailable — ignore, and skip the dispatch.
  }
}

export interface UseGroupLastWorktreeReturn {
  /** Look up the last worktreeId selected while `groupId` was active.
   *  Returns `undefined` when no history exists yet. */
  getLastWorktree: (groupId: string) => string | undefined;
  /** Record `worktreeId` as the last worktree selected while `groupId`
   *  was active. Safe to call repeatedly with the same value (no-op when
   *  unchanged). */
  setLastWorktree: (groupId: string, worktreeId: string) => void;
}

export function useGroupLastWorktree(): UseGroupLastWorktreeReturn {
  // Both methods read and write storage at call time. No React state is
  // needed because nothing about the map is rendered today —
  // `getLastWorktree` is only invoked imperatively from
  // `DashboardShell.setGroupFilter` on a user action, where reading
  // localStorage directly gives an always-fresh value and frees the
  // callback closure from any React state, keeping
  // `getLastWorktree`'s identity stable across navigations so
  // downstream `useCallback`s don't rebuild and the keyboard shortcut
  // listener doesn't re-attach. If a future reactive consumer is
  // added, subscribe to SYNC_EVENT + the native `storage` event in
  // that consumer rather than re-introducing global state here.
  const getLastWorktree = useCallback((groupId: string) => readGroupLastWorktrees()[groupId], []);
  const setLastWorktree = useCallback((groupId: string, worktreeId: string) => {
    const current = readGroupLastWorktrees();
    if (current[groupId] === worktreeId) return;
    write({ ...current, [groupId]: worktreeId });
  }, []);

  return { getLastWorktree, setLastWorktree };
}

/**
 * Record each worktree opened while a group is selected as that group's
 * last worktree, when it is in the group (a worktree reached
 * through the ⌘K picker under another group isn't recorded).
 *
 * The app shell runs this, not `DashboardShell`: on a phone the dashboard
 * is a full-screen route that unmounts the moment a worktree is picked, so
 * an effect inside it never saw the new worktree.
 *
 * The `lastSeen` guard skips reruns caused by the group changing while the
 * worktree stays the same, i.e. right after a group switch and before its
 * restore navigation lands. Without it the incoming group would briefly get
 * the outgoing group's worktree and undo the restore. The guard starts
 * empty so the worktree on screen at load is recorded too, and a lookup
 * made before the repo list has loaded doesn't consume it.
 */
export function useRecordGroupLastWorktree(activeWorktreeId: string | null): void {
  const [groupFilter] = useGroupFilter();
  const { repos } = useRepos();
  const { setLastWorktree } = useGroupLastWorktree();
  const lastSeen = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWorktreeId || !groupFilter) {
      // ALL has no per-group memory, but a later group switch must still
      // see the worktree as unchanged.
      lastSeen.current = activeWorktreeId;
      return;
    }
    if (lastSeen.current === activeWorktreeId || repos.length === 0) return;
    lastSeen.current = activeWorktreeId;
    const repo = repos.find((p) =>
      p.worktrees.some((wt) => toWorktreeId(p.name, wt.name, wt.hostId) === activeWorktreeId),
    );
    const worktree = repo?.worktrees.find(
      (wt) => toWorktreeId(repo.name, wt.name, wt.hostId) === activeWorktreeId,
    );
    if (worktree?.groupId === groupFilter) setLastWorktree(groupFilter, activeWorktreeId);
  }, [groupFilter, activeWorktreeId, repos, setLastWorktree]);
}
