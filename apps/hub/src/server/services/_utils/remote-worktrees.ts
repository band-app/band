import type { WorktreeState } from "../../infra/db/queries/repos";
import { hostRegistry } from "../../infra/host/registry";

/** True only for a definite "no such file or directory". A timeout, a permission error or a link failure leaves a worktree alone. */
export function isFolderGoneError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

const STAT_BATCH = 8;

/**
 * Refreshes the branch and head of a repo's worktrees on remote hosts from
 * what git on each worker reports, so a branch switch in a worker's terminal
 * shows up. Rows are only updated, never added or dropped: the hub can't tell
 * a worktree git no longer lists from a worker that is unreachable. A host
 * that is offline or has no checkout of the repo keeps its rows as they are.
 *
 * A row whose folder is gone from a reachable host gets `missing: true` (and the flag is cleared
 * once the folder is back). The row is kept: removing it is the caller's decision.
 */
export async function refreshRemoteWorktrees(
  repoName: string,
  repoPath: string,
  worktrees: WorktreeState[],
): Promise<{ worktrees: WorktreeState[]; changed: boolean }> {
  const hostIds = new Set<string>();
  for (const wt of worktrees) {
    if (wt.hostId !== undefined && wt.hostId !== "local") hostIds.add(wt.hostId);
  }
  let changed = false;
  let result = worktrees;
  for (const hostId of hostIds) {
    const checkout = hostRegistry.repoPathOn(repoName, hostId, repoPath);
    if (checkout === null) continue;
    let listed: Awaited<ReturnType<ReturnType<typeof hostRegistry.hostById>["worktree"]["list"]>>;
    try {
      listed = await hostRegistry.hostById(hostId).worktree.list(checkout);
    } catch {
      continue;
    }
    const host = hostRegistry.hostById(hostId);
    const byPath = new Map(listed.map((wt) => [wt.path, wt]));
    // One stat per worktree of this host, in small batches: each is a round trip on the worker link.
    // A row git does not list is statted too, so only a definite "no such folder" marks it missing.
    const statted = new Map<string, boolean>();
    const rows = result.filter((wt) => wt.hostId === hostId);
    for (let i = 0; i < rows.length; i += STAT_BATCH) {
      await Promise.all(
        rows.slice(i, i + STAT_BATCH).map(async (wt) => {
          try {
            await host.fs.stat(wt.path);
            statted.set(wt.path, false);
          } catch (err) {
            statted.set(wt.path, isFolderGoneError(err));
          }
        }),
      );
    }
    const next: WorktreeState[] = [];
    for (const wt of result) {
      if (wt.hostId !== hostId) {
        next.push(wt);
        continue;
      }
      const found = byPath.get(wt.path);
      // Git lists a worktree whose folder was deleted until it is pruned, so ask the host, not git.
      const folderGone = statted.get(wt.path) ?? false;
      let row = wt;
      if (folderGone !== (wt.missing === true)) row = { ...row, missing: folderGone || undefined };
      if (found && !found.isBare && (found.branch !== wt.branch || found.head !== wt.head)) {
        changed = true;
        row = { ...row, branch: found.branch, head: found.head };
      }
      next.push(row);
    }
    result = next;
  }
  return { worktrees: result, changed };
}
