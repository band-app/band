/**
 * Parse the active worktree ID from a URL pathname.
 * Returns the decoded worktree ID or null if not on a worktree route.
 */
export function parseWorktreeFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/worktree\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
