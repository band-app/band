/** The hub's own host. Its worktrees keep the plain `<repo>-<branch>` id. */
const LOCAL_HOST_ID = "local";

/**
 * The id of one worktree on one host. `toWorktreeId` is the only function that makes one, so an
 * id cannot be built from a repo and a branch without naming the host.
 */
export type WorktreeId = string & { readonly __worktreeId: unique symbol };

/**
 * A worktree id is `<repo>-<branch>` on the hub's own host and `<repo>-<branch>@<hostId>` on any
 * other host, so the same repo and branch on two hosts are two worktrees.
 *
 * `hostId` has no default on purpose: pass the worktree's own `hostId` (`undefined` and `"local"`
 * both mean the hub's machine). `scripts/check-worktree-ids.sh` fails CI on ids built by hand.
 */
export function toWorktreeId(
  repo: string,
  branch: string,
  hostId: string | null | undefined,
): WorktreeId {
  const base = `${repo}-${branch.replaceAll("/", "-")}`;
  return (hostId && hostId !== LOCAL_HOST_ID ? `${base}@${hostId}` : base) as WorktreeId;
}
