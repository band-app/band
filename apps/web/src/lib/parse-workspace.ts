/**
 * Parse the active workspace ID from a URL pathname.
 * Returns the decoded workspace ID or null if not on a workspace route.
 */
export function parseWorkspaceFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/workspace\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
