import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useDashboardStore } from "@/dashboard";
import { trpc } from "../lib/trpc-client";

export const Route = createFileRoute("/worktree/$worktreeId")({
  component: WorktreeLayout,
  // Bookmarks / shared links from before route unification (`/worktree/$id/changes`,
  // `/worktree/$id/code/foo.ts`, `/worktree/$id/terminal`) used to resolve to
  // child routes that no longer exist. Redirect them to the canonical worktree
  // URL instead of showing the root 404. See issue #467.
  //
  // CAVEAT: this catches ANY unmatched sub-path under `/worktree/$id`, not
  // just the five retired routes. If a future child route is added here, a
  // typo'd link (e.g. `/worktree/$id/settigns` for a real `/settings` route)
  // will silently land on the worktree root rather than surfacing a 404.
  // If that becomes a problem, narrow this to an allowlist of known retired
  // path prefixes.
  notFoundComponent: WorktreeNotFoundRedirect,
});

function WorktreeNotFoundRedirect() {
  const { worktreeId } = Route.useParams();
  return <Navigate to="/worktree/$worktreeId" params={{ worktreeId }} replace />;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function WorktreeLayout() {
  const { worktreeId } = Route.useParams();
  const decoded = decodeURIComponent(worktreeId);

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
    setActiveWorktree(decoded);
  }, [decoded, setActiveWorktree]);

  // Re-read this worktree's git status when it is selected, and when the
  // window comes back into view, instead of waiting for the next poll tick.
  const refreshBranchStatus = useDashboardStore((s) => s.refreshBranchStatus);
  useEffect(() => {
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
    clearNeedsAttention(decoded);
  }, [decoded, clearNeedsAttention]);

  // A worktree inside a task folder belongs to its task, so an old link to it opens the task view.
  // A worktree that predates task folders is its own task and keeps this view.
  const owner = useQuery({
    queryKey: ["projectTasks.forWorktree", decoded],
    queryFn: async () => (await trpc.projectTasks.forWorktree.query({ worktreeId: decoded })).task,
    staleTime: 30_000,
  });
  if (owner.data?.briefPath) {
    return <Navigate to="/task/$taskId" params={{ taskId: owner.data.id }} replace />;
  }

  // Both layouts render every worktree from AppShell: the desktop
  // `SharedDockviewLayout` and the mobile `MobileWorktreeShell` keep each
  // visited worktree mounted, so switching back to one is instant (no chat
  // replay, no layout restore, no refetch). This route has nothing of its own
  // to render; keeping the URL canonical at `/worktree/$id` (no sub-paths)
  // means worktree switches don't churn the AppShell's `<Outlet />`.
  return null;
}
