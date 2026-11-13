import { toWorktreeId } from "@band-app/shared/worktree-id";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { clientStorage } from "../../lib/client-state";
import { useDashboardStore } from "../stores/index";
import { useRepos } from "./use-repos";

// Worktree-scoped so the Changes sidepanel, the diff leaves and the
// Changes-tab badge always read the same target — see issue #396 ("Changes
// tab — out of sync").
const COMPARE_BRANCH_KEY_PREFIX = "band:diff-compare-branch:";

// The Changes view used to switch between an "uncommitted" and a "branch"
// diff mode, stored under this per-worktree key. It now shows both at once
// in separate sections, so the key is dead and is removed on mount.
const LEGACY_DIFF_MODE_KEY_PREFIX = "band:diff-mode:";

/**
 * Custom DOM event fired whenever any subscriber changes the compare branch.
 * The browser's `storage` event only fires across windows, so we add this
 * same-window broadcast so the Changes badge and open diff leaves re-fetch
 * when the user picks another branch in the sidepanel.
 */
const CHANGE_EVENT = "band:diff-target-changed";

export interface DiffTargetChangeDetail {
  worktreeId: string;
  compareBranch: string | null;
  /**
   * Per-instance identifier of the subscriber that dispatched the event.
   * Used to skip the echo-back into the same instance's event handler.
   * Optional — handlers that don't recognize the value should still update
   * normally, so external dispatches (e.g. tests) work without it.
   */
  source?: string;
}

function readStoredCompareBranch(worktreeId: string): string | null {
  try {
    return localStorage.getItem(COMPARE_BRANCH_KEY_PREFIX + worktreeId);
  } catch {
    return null;
  }
}

function writeCompareBranch(worktreeId: string, branch: string | null) {
  try {
    if (branch) {
      clientStorage.setItem(COMPARE_BRANCH_KEY_PREFIX + worktreeId, branch);
    } else {
      clientStorage.removeItem(COMPARE_BRANCH_KEY_PREFIX + worktreeId);
    }
  } catch {}
}

function dispatchChange(detail: DiffTargetChangeDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<DiffTargetChangeDetail>(CHANGE_EVENT, { detail }));
}

export interface UseDiffTargetReturn {
  /** The branch the "Committed on branch" section compares against: the
   *  user's pick, else the worktree's base (see `baseBranch`); null means the
   *  repo's default branch. */
  compareBranch: string | null;
  /** The branch the user picked by hand, or null when they have not. */
  pickedBranch: string | null;
  /** The worktree's real base: the open PR's base, else the branch the
   *  worktree was created from; null when it has neither. It may equal the
   *  default branch. */
  baseBranch: string | null;
  setCompareBranch: (branch: string | null) => void;
}

/**
 * React hook for reading and updating the compare branch of a worktree's
 * Changes view. State is mirrored to localStorage so it survives reloads,
 * and any subscriber in the same window receives a synthetic event when
 * another subscriber changes it — this is what keeps the Changes-tab badge
 * and diff leaves in sync with the sidepanel's branch picker.
 */
export function useDiffTarget(worktreeId: string): UseDiffTargetReturn {
  const [pickedBranch, setCompareBranchState] = useState<string | null>(() =>
    readStoredCompareBranch(worktreeId),
  );

  // Per-instance identifier for skipping the echo-back when this instance is
  // the dispatcher of the event.
  const instanceId = useId();

  // Re-read the stored value when the worktree changes — every worktree
  // has its own entry, and we want to honor a previously stored selection
  // rather than carry over the previous worktree's pick.
  useEffect(() => {
    setCompareBranchState(readStoredCompareBranch(worktreeId));
    try {
      localStorage.removeItem(LEGACY_DIFF_MODE_KEY_PREFIX + worktreeId);
    } catch {}
  }, [worktreeId]);

  // Same-window broadcast: when another subscriber changes the target, mirror
  // it locally so React re-renders. The `storage` event carries a pick made on
  // another device: the client-state sync writes it into localStorage and
  // dispatches one (see `lib/client-state.ts`).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<DiffTargetChangeDetail>).detail;
      if (!detail || detail.worktreeId !== worktreeId) return;
      if (detail.source && detail.source === instanceId) return;
      setCompareBranchState(detail.compareBranch);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== COMPARE_BRANCH_KEY_PREFIX + worktreeId) return;
      setCompareBranchState(e.newValue);
    };
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener("storage", onStorage);
    };
  }, [worktreeId, instanceId]);

  const setCompareBranch = useCallback(
    (branch: string | null) => {
      writeCompareBranch(worktreeId, branch);
      setCompareBranchState(branch);
      dispatchChange({ worktreeId, compareBranch: branch, source: instanceId });
    },
    [worktreeId, instanceId],
  );

  const { repos } = useRepos();
  const prBase = useDashboardStore((s) => {
    const pr = s.branchStatuses.get(worktreeId)?.ci.pr;
    return pr?.state === "open" ? (pr.baseBranch ?? null) : null;
  });
  const storedBase = useMemo(() => {
    for (const repo of repos) {
      for (const wt of repo.worktrees) {
        if (toWorktreeId(repo.name, wt.name, wt.hostId) === worktreeId) {
          return wt.baseBranch ?? null;
        }
      }
    }
    return null;
  }, [repos, worktreeId]);
  const baseBranch = prBase ?? storedBase;

  return {
    compareBranch: pickedBranch ?? baseBranch,
    pickedBranch,
    baseBranch,
    setCompareBranch,
  };
}
