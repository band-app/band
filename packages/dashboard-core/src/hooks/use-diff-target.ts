import { useCallback, useEffect, useState } from "react";
import type { DiffMode } from "../types";

// Storage keys are intentionally shared across every subscriber in the same
// window so that the DiffView and the Changes-tab badge always read the same
// target — see issue #396 ("Changes tab — out of sync"), where the badge
// always reflected the default-branch comparison instead of the user's pick.
const DIFF_MODE_KEY = "band:diff-mode";
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
}

export function readStoredDiffMode(): DiffMode {
  try {
    const v = localStorage.getItem(DIFF_MODE_KEY);
    if (v === "uncommitted" || v === "branch") return v;
  } catch {}
  return "branch";
}

export function readStoredCompareBranch(workspaceId: string): string | null {
  try {
    return localStorage.getItem(COMPARE_BRANCH_KEY_PREFIX + workspaceId);
  } catch {
    return null;
  }
}

function writeDiffMode(mode: DiffMode) {
  try {
    localStorage.setItem(DIFF_MODE_KEY, mode);
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
  const [diffMode, setDiffModeState] = useState<DiffMode>(readStoredDiffMode);
  const [compareBranch, setCompareBranchState] = useState<string | null>(() =>
    readStoredCompareBranch(workspaceId),
  );

  // Re-read stored values when the workspace changes — every workspace has
  // its own compareBranch entry, and we want to honor a previously stored
  // selection rather than carry over the previous workspace's pick.
  useEffect(() => {
    setDiffModeState(readStoredDiffMode());
    setCompareBranchState(readStoredCompareBranch(workspaceId));
  }, [workspaceId]);

  // Same-window broadcast: when another subscriber mutates the target, mirror
  // the change locally so React re-renders. Cross-window `storage` events are
  // intentionally ignored — Band is single-window, and reacting to them would
  // duplicate the writeback and re-fire dispatchChange().
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<DiffTargetChangeDetail>).detail;
      if (!detail || detail.workspaceId !== workspaceId) return;
      setDiffModeState(detail.diffMode);
      setCompareBranchState(detail.compareBranch);
    };
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, [workspaceId]);

  // The dispatchChange payload reads the "other" value (the one not being
  // mutated) back from localStorage rather than from React state. This is
  // intentional: writeDiffMode / writeCompareBranch always run on the line
  // above, so localStorage is already the freshest source of truth — and
  // reading from a ref or closure would require extra plumbing to keep the
  // setter callbacks stable. Two subscribers in the same tree that mutate
  // concurrently would still observe a consistent payload.
  const setDiffMode = useCallback(
    (mode: DiffMode) => {
      writeDiffMode(mode);
      setDiffModeState(mode);
      dispatchChange({
        workspaceId,
        diffMode: mode,
        compareBranch: readStoredCompareBranch(workspaceId),
      });
    },
    [workspaceId],
  );

  const setCompareBranch = useCallback(
    (branch: string | null) => {
      writeCompareBranch(workspaceId, branch);
      setCompareBranchState(branch);
      dispatchChange({
        workspaceId,
        diffMode: readStoredDiffMode(),
        compareBranch: branch,
      });
    },
    [workspaceId],
  );

  return { diffMode, compareBranch, setDiffMode, setCompareBranch };
}
