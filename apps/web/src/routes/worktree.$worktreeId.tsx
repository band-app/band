import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useWorktreeRoute } from "../lib/use-worktree-route";

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
  useWorktreeRoute(decoded);

  // Both layouts render every worktree from AppShell: the desktop
  // `SharedDockviewLayout` and the mobile `MobileWorktreeShell` keep each
  // visited worktree mounted, so switching back to one is instant (no chat
  // replay, no layout restore, no refetch). This route has nothing of its own
  // to render; keeping the URL canonical at `/worktree/$id` (no sub-paths)
  // means worktree switches don't churn the AppShell's `<Outlet />`.
  return null;
}
