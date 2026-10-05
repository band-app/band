import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useDashboardStore } from "@/dashboard";

export const Route = createFileRoute("/workspace/$workspaceId")({
  component: WorkspaceLayout,
  // Bookmarks / shared links from before route unification (`/workspace/$id/changes`,
  // `/workspace/$id/code/foo.ts`, `/workspace/$id/terminal`) used to resolve to
  // child routes that no longer exist. Redirect them to the canonical workspace
  // URL instead of showing the root 404. See issue #467.
  //
  // CAVEAT: this catches ANY unmatched sub-path under `/workspace/$id`, not
  // just the five retired routes. If a future child route is added here, a
  // typo'd link (e.g. `/workspace/$id/settigns` for a real `/settings` route)
  // will silently land on the workspace root rather than surfacing a 404.
  // If that becomes a problem, narrow this to an allowlist of known retired
  // path prefixes.
  notFoundComponent: WorkspaceNotFoundRedirect,
});

function WorkspaceNotFoundRedirect() {
  const { workspaceId } = Route.useParams();
  return <Navigate to="/workspace/$workspaceId" params={{ workspaceId }} replace />;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function WorkspaceLayout() {
  const { workspaceId } = Route.useParams();
  const decoded = decodeURIComponent(workspaceId);

  // Sync zustand active workspace from URL. We set on param change but never
  // clear on unmount: on mobile the project-list "menu" lives on a *separate*
  // route (`/`) from the workspace (`/workspace/$id`), so unmounting this route
  // to show the menu would wipe `activeWorkspaceId` and leave the menu unable
  // to bold the workspace the user just came from. Keeping the last-opened id
  // lets the menu mark it active on every viewport. The title bar reads the
  // active id from the pathname (`parseWorkspaceFromPath` in __root), not this
  // store, so it still clears correctly when no workspace route is mounted.
  const setActiveWorkspace = useDashboardStore((s) => s.setActiveWorkspace);
  useEffect(() => {
    setActiveWorkspace(decoded);
  }, [decoded, setActiveWorkspace]);

  // Re-read this workspace's git status when it is selected, and when the
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

  // Clear needs_attention status when viewing this workspace
  const clearNeedsAttention = useDashboardStore((s) => s.clearNeedsAttention);
  useEffect(() => {
    clearNeedsAttention(decoded);
  }, [decoded, clearNeedsAttention]);

  // Both layouts render every workspace from AppShell: the desktop
  // `SharedDockviewLayout` and the mobile `MobileWorkspaceShell` keep each
  // visited workspace mounted, so switching back to one is instant (no chat
  // replay, no layout restore, no refetch). This route has nothing of its own
  // to render; keeping the URL canonical at `/workspace/$id` (no sub-paths)
  // means workspace switches don't churn the AppShell's `<Outlet />`.
  return null;
}
