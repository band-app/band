import { projectScopeFromPath, useProjectSlugs } from "./project-slugs";

/**
 * Parse the active worktree ID from a URL pathname.
 * Returns the decoded worktree ID or null if not on a worktree route. A project's view,
 * `/project/<name>`, is the worktree view of the project's scope id (`project:<id>`).
 */
export function parseWorktreeFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/worktree\/([^/]+)/);
  if (match) return decodeURIComponent(match[1]);
  return projectScopeFromPath(pathname);
}

/** `parseWorktreeFromPath` for a component: it re-renders once a project's name resolves. */
export function useWorktreeFromPath(pathname: string): string | null {
  useProjectSlugs();
  return parseWorktreeFromPath(pathname);
}
