/**
 * Join a workspace's absolute root path with a workspace-relative path to
 * produce an absolute filesystem path.
 *
 * `workspaceRoot` is the worktree directory on disk (no trailing slash, as
 * returned by `WorktreeInfo.path`); `relativePath` is the workspace-relative
 * path the file trees operate in (no leading slash, `""` for the root).
 *
 * The empty relative path maps to the root itself. Any stray trailing slash on
 * the root or leading slash on the relative path is tolerated.
 */
export function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = workspaceRoot.replace(/\/+$/, "");
  const rel = relativePath.replace(/^\/+/, "");
  return rel ? `${root}/${rel}` : root;
}
