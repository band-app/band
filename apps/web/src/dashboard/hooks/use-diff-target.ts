import { useCallback, useEffect, useId, useState } from "react";
import type { DiffMode } from "../types";

// Both keys are workspace-scoped so the DiffView and the Changes-tab badge
// always read the same target — see issue #396 ("Changes tab — out of sync").
// `diffMode` used to be a global preference (one key for all workspaces) but
// that caused the badge for workspace B to inherit workspace A's mode the
// first time a user opened B in a new session; per-workspace keys keep the
// state symmetric with `compareBranch` and match the principle of least
// surprise. Users who had a stored `diffMode` under the previous global key
// will fall back to the default ("uncommitted") once after the upgrade, then
// their per-workspace pick will persist normally.
const DIFF_MODE_KEY_PREFIX = "band:diff-mode:";
const COMPARE_BRANCH_KEY_PREFIX = "band:diff-compare-branch:";

/**
 * Custom DOM event fired whenever any subscriber mutates the diff target via
 * `setDiffMode` / `setCompareBranch`. The browser's `storage` event only
 * fires across windows, so we add this same-window broadcast so the Changes
 * badge re-fetches when the user changes the dropdown inside the DiffView.
 */
const CHANGE_EVENT = "band:diff-target-changed";

export interface DiffTargetChangeDetail {
  workspaceId: string;
  diffMode: DiffMode;
  compareBranch: string | null;
  /**
   * Per-instance identifier of the subscriber that dispatched the event.
   * Used to skip the echo-back into the same instance's event handler.
   * Optional — handlers that don't recognize the value should still update
   * normally, so external dispatches (e.g. tests) work without it.
   */
  source?: string;
}

function readStoredDiffMode(workspaceId: string): DiffMode {
  try {
    const v = localStorage.getItem(DIFF_MODE_KEY_PREFIX + workspaceId);
    if (v === "uncommitted" || v === "branch") return v;
  } catch {}
  return "uncommitted";
}

export function readStoredCompareBranch(workspaceId: string): string | null {
  try {
    return localStorage.getItem(COMPARE_BRANCH_KEY_PREFIX + workspaceId);
  } catch {
    return null;
  }
}

function writeDiffMode(workspaceId: string, mode: DiffMode) {
  try {
    localStorage.setItem(DIFF_MODE_KEY_PREFIX + workspaceId, mode);
  } catch {}
}

function writeCompareBranch(workspaceId: string, branch: string | null) {
  try {
    if (branch) {
      localStorage.setItem(COMPARE_BRANCH_KEY_PREFIX + workspaceId, branch);
    } else {
      localStorage.removeItem(COMPARE_BRANCH_KEY_PREFIX + workspaceId);
    }
  } catch {}
}

function dispatchChange(detail: DiffTargetChangeDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<DiffTargetChangeDetail>(CHANGE_EVENT, { detail }));
}

export interface UseDiffTargetReturn {
  diffMode: DiffMode;
  compareBranch: string | null;
  setDiffMode: (mode: DiffMode) => void;
  setCompareBranch: (branch: string | null) => void;
}

/**
 * React hook for reading and updating the current diff target (mode +
 * compare branch) for a given workspace. State is mirrored to localStorage
 * so it survives reloads, and any subscriber in the same window receives a
 * synthetic event when another subscriber mutates the state — this is what
 * keeps the Changes-tab badge in sync with the DiffView's branch dropdown.
 */
export function useDiffTarget(workspaceId: string): UseDiffTargetReturn {
  const [diffMode, setDiffModeState] = useState<DiffMode>(() => readStoredDiffMode(workspaceId));
  const [compareBranch, setCompareBranchState] = useState<string | null>(() =>
    readStoredCompareBranch(workspaceId),
  );

  // Per-instance identifier for skipping the echo-back when this instance is
  // the dispatcher of the event. React 18 batches the redundant setState
  // calls so it's only a small efficiency win, but it also keeps any future
  // debug logging in the handler from firing on every self-mutation.
  // `useId` is stable across renders, tied to React's reconciler, and avoids
  // pulling in a `Math.random()` allocation that would otherwise run on every
  // render even though `useRef` would discard it.
  const instanceId = useId();

  // Re-read stored values when the workspace changes — every workspace has
  // its own compareBranch entry, and we want to honor a previously stored
  // selection rather than carry over the previous workspace's pick.
  useEffect(() => {
    setDiffModeState(readStoredDiffMode(workspaceId));
    setCompareBranchState(readStoredCompareBranch(workspaceId));
  }, [workspaceId]);

  // Same-window broadcast: when another subscriber mutates the target, mirror
  // the change locally so React re-renders. Cross-window `storage` events are
  // intentionally ignored — Band is single-window, and reacting to them would
  // duplicate the writeback and re-fire dispatchChange().
  //
  // NOTE: there is a brief pre-paint window between the first render and
  // when this effect registers the listener, during which an event dispatched
  // by another subscriber would be missed. In practice this is a non-issue
  // because the DiffView and the badge hooks mount together in the same tick
  // and user interaction happens much later — but worth revisiting if Band
  // ever renders them in separate React roots or defers one with
  // `startTransition`.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<DiffTargetChangeDetail>).detail;
      if (!detail || detail.workspaceId !== workspaceId) return;
      // Skip the echo-back if this instance was the dispatcher — setDiff*
      // already called setState directly before dispatching the event.
      if (detail.source && detail.source === instanceId) return;
      setDiffModeState(detail.diffMode);
      setCompareBranchState(detail.compareBranch);
    };
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, [workspaceId, instanceId]);

  // One-shot cleanup of the legacy global `band:diff-mode` key from the
  // pre-per-workspace storage layout. Runs once per mount; localStorage.removeItem
  // is a no-op once the key is gone.
  useEffect(() => {
    try {
      localStorage.removeItem("band:diff-mode");
    } catch {}
  }, []);

  // The dispatchChange payload reads the "other" value (the one not being
  // mutated) back from localStorage rather than from React state. This is
  // intentional: writeDiffMode / writeCompareBranch always run on the line
  // above, so localStorage is already the freshest source of truth — and
  // reading from a ref or closure would require extra plumbing to keep the
  // setter callbacks stable. Two subscribers in the same tree that mutate
  // concurrently would still observe a consistent payload.
  const setDiffMode = useCallback(
    (mode: DiffMode) => {
      writeDiffMode(workspaceId, mode);
      setDiffModeState(mode);
      dispatchChange({
        workspaceId,
        diffMode: mode,
        compareBranch: readStoredCompareBranch(workspaceId),
        source: instanceId,
      });
    },
    [workspaceId, instanceId],
  );

  const setCompareBranch = useCallback(
    (branch: string | null) => {
      writeCompareBranch(workspaceId, branch);
      setCompareBranchState(branch);
      dispatchChange({
        workspaceId,
        diffMode: readStoredDiffMode(workspaceId),
        compareBranch: branch,
        source: instanceId,
      });
    },
    [workspaceId, instanceId],
  );

  return { diffMode, compareBranch, setDiffMode, setCompareBranch };
}
