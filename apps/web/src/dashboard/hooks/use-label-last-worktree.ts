import { toWorktreeId } from "@band-app/shared/worktree-id";
import { useCallback, useEffect, useRef } from "react";
import { clientStorage } from "../../lib/client-state";
import { useLabelFilter } from "./use-label-filter";
import { useRepos } from "./use-repos";

/**
 * Per-label "last selected worktree" memory.
 *
 * Lets the dashboard restore the worktree the user was last viewing under
 * a particular label when they switch back to that label (issue #505). The
 * map is stored as JSON in localStorage; both `getLastWorktree` and
 * `setLastWorktree` read and write storage at call time, so the hook needs no React state of its own — values are always fresh, and
 * callers that need reactivity should subscribe to the SYNC_EVENT directly.
 *
 * Two callers decide *when* to write: `useRecordLabelLastWorktree` (below,
 * run by the app shell) when a worktree is opened under a label, and
 * `DashboardShell`'s `setLabelFilter` on a label switch. ALL (label ===
 * null) has no per-label memory: callers must not write the null key here.
 */

/** localStorage key for the per-label "last worktree" map. */
export const LABEL_LAST_WORKTREE_KEY = "band.repos-list.label-last-worktree";

/** Custom event broadcast on every successful write. Cross-tab updates
 *  also reach consumers via the native `storage` event. No same-file
 *  consumer subscribes today; the event is exposed for future
 *  reactive use cases that might want to refresh when another tab
 *  mutates the map. */
const SYNC_EVENT = "band:label-last-worktree-change";

/** The saved map, label id to worktree id; empty when nothing is saved. */
export function readLabelLastWorktrees(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LABEL_LAST_WORKTREE_KEY);
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
  // `readLabelLastWorktrees()` on every SYNC_EVENT, so a failed
  // `setItem` paired with an unconditional dispatch would make every consumer pick up the
  // stale on-disk value and silently lose the caller's intended
  // update. `useLabelFilter`'s value is consumed locally per shell
  // rather than read back from storage on each event, so the
  // trade-off there doesn't apply.
  try {
    clientStorage.setItem(LABEL_LAST_WORKTREE_KEY, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent(SYNC_EVENT));
  } catch {
    // localStorage full or unavailable — ignore, and skip the dispatch.
  }
}

export interface UseLabelLastWorktreeReturn {
  /** Look up the last worktreeId selected while `labelId` was active.
   *  Returns `undefined` when no history exists yet. */
  getLastWorktree: (labelId: string) => string | undefined;
  /** Record `worktreeId` as the last worktree selected while `labelId`
   *  was active. Safe to call repeatedly with the same value (no-op when
   *  unchanged). */
  setLastWorktree: (labelId: string, worktreeId: string) => void;
}

export function useLabelLastWorktree(): UseLabelLastWorktreeReturn {
  // Both methods read and write storage at call time. No React state is
  // needed because nothing about the map is rendered today —
  // `getLastWorktree` is only invoked imperatively from
  // `DashboardShell.setLabelFilter` on a user action, where reading
  // localStorage directly gives an always-fresh value and frees the
  // callback closure from any React state, keeping
  // `getLastWorktree`'s identity stable across navigations so
  // downstream `useCallback`s don't rebuild and the keyboard shortcut
  // listener doesn't re-attach. If a future reactive consumer is
  // added, subscribe to SYNC_EVENT + the native `storage` event in
  // that consumer rather than re-introducing global state here.
  const getLastWorktree = useCallback((labelId: string) => readLabelLastWorktrees()[labelId], []);
  const setLastWorktree = useCallback((labelId: string, worktreeId: string) => {
    const current = readLabelLastWorktrees();
    if (current[labelId] === worktreeId) return;
    write({ ...current, [labelId]: worktreeId });
  }, []);

  return { getLastWorktree, setLastWorktree };
}

/**
 * Record each worktree opened while a label is selected as that label's
 * last worktree, when its repo carries the label (a worktree reached
 * through the ⌘K picker under another label isn't recorded).
 *
 * The app shell runs this, not `DashboardShell`: on a phone the dashboard
 * is a full-screen route that unmounts the moment a worktree is picked, so
 * an effect inside it never saw the new worktree.
 *
 * The `lastSeen` guard skips reruns caused by the label changing while the
 * worktree stays the same, i.e. right after a label switch and before its
 * restore navigation lands. Without it the incoming label would briefly get
 * the outgoing label's worktree and undo the restore. The guard starts
 * empty so the worktree on screen at load is recorded too, and a lookup
 * made before the repo list has loaded doesn't consume it.
 */
export function useRecordLabelLastWorktree(activeWorktreeId: string | null): void {
  const [labelFilter] = useLabelFilter();
  const { repos } = useRepos();
  const { setLastWorktree } = useLabelLastWorktree();
  const lastSeen = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWorktreeId || !labelFilter) {
      // ALL has no per-label memory, but a later label switch must still
      // see the worktree as unchanged.
      lastSeen.current = activeWorktreeId;
      return;
    }
    if (lastSeen.current === activeWorktreeId || repos.length === 0) return;
    lastSeen.current = activeWorktreeId;
    const repo = repos.find((p) =>
      p.worktrees.some((wt) => toWorktreeId(p.name, wt.name) === activeWorktreeId),
    );
    if (repo?.label === labelFilter) setLastWorktree(labelFilter, activeWorktreeId);
  }, [labelFilter, activeWorktreeId, repos, setLastWorktree]);
}
