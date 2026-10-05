/**
 * Join a worktree's absolute root path with a worktree-relative path to
 * produce an absolute filesystem path.
 *
 * `worktreeRoot` is the worktree directory on disk (no trailing slash, as
 * returned by `WorktreeInfo.path`); `relativePath` is the worktree-relative
 * path the file trees operate in (no leading slash, `""` for the root).
 *
 * The empty relative path maps to the root itself. Any stray trailing slash on
 * the root or leading slash on the relative path is tolerated.
 */
export function joinWorktreePath(worktreeRoot: string, relativePath: string): string {
  const root = worktreeRoot.replace(/\/+$/, "");
  const rel = relativePath.replace(/^\/+/, "");
  return rel ? `${root}/${rel}` : root;
}
