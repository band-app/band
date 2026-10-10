import { useEffect } from "react";
import { useDashboardStore } from "@/dashboard";

/** What opening a worktree's view does. */
export function useWorktreeRoute(decoded: string | null): void {
  // Sync zustand active worktree from URL. We set on param change but never
  // clear on unmount: on mobile the repo-list "menu" lives on a *separate*
  // route (`/`) from the worktree (`/worktree/$id`), so unmounting this route
  // to show the menu would wipe `activeWorktreeId` and leave the menu unable
  // to bold the worktree the user just came from. Keeping the last-opened id
  // lets the menu mark it active on every viewport. The title bar reads the
  // active id from the pathname (`parseWorktreeFromPath` in __root), not this
  // store, so it still clears correctly when no worktree route is mounted.
  const setActiveWorktree = useDashboardStore((s) => s.setActiveWorktree);
  useEffect(() => {
    if (decoded) setActiveWorktree(decoded);
  }, [decoded, setActiveWorktree]);

  // Re-read this worktree's git status when it is selected, and when the
  // window comes back into view, instead of waiting for the next poll tick.
  const refreshBranchStatus = useDashboardStore((s) => s.refreshBranchStatus);
  useEffect(() => {
    if (!decoded) return;
    refreshBranchStatus(decoded);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshBranchStatus(decoded);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [decoded, refreshBranchStatus]);

  // Clear needs_attention status when viewing this worktree
  const clearNeedsAttention = useDashboardStore((s) => s.clearNeedsAttention);
  useEffect(() => {
    if (decoded) clearNeedsAttention(decoded);
  }, [decoded, clearNeedsAttention]);
}
