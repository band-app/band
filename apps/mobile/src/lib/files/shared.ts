/** The worktree id a shared-file card's URL (`/api/shared/<worktreeId>/...`) belongs to, or null. */
export function sharedFileWorktree(url: string): string | null {
  const match = /^\/api\/shared\/([^/?]+)\/[^?]+/.exec(url);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
