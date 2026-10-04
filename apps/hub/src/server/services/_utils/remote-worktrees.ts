import type { WorktreeState } from "../../infra/db/queries/projects";
import { hostRegistry } from "../../infra/host/registry";

/**
 * Refreshes the branch and head of a project's worktrees on remote hosts from
 * what git on each worker reports, so a branch switch in a worker's terminal
 * shows up. Rows are only updated, never added or dropped: the hub can't tell
 * a worktree git no longer lists from a worker that is unreachable. A host
 * that is offline or has no checkout of the project keeps its rows as they are.
 */
export async function refreshRemoteWorktrees(
  projectName: string,
  projectPath: string,
  worktrees: WorktreeState[],
): Promise<{ worktrees: WorktreeState[]; changed: boolean }> {
  const hostIds = new Set<string>();
  for (const wt of worktrees) {
    if (wt.hostId !== undefined && wt.hostId !== "local") hostIds.add(wt.hostId);
  }
  let changed = false;
  let result = worktrees;
  for (const hostId of hostIds) {
    const checkout = hostRegistry.projectPathOn(projectName, hostId, projectPath);
    if (checkout === null) continue;
    let listed: Awaited<ReturnType<ReturnType<typeof hostRegistry.hostById>["worktree"]["list"]>>;
    try {
      listed = await hostRegistry.hostById(hostId).worktree.list(checkout);
    } catch {
      continue;
    }
    const byPath = new Map(listed.map((wt) => [wt.path, wt]));
    result = result.map((wt) => {
      const found = wt.hostId === hostId ? byPath.get(wt.path) : undefined;
      if (!found || found.isBare || (found.branch === wt.branch && found.head === wt.head)) {
        return wt;
      }
      changed = true;
      return { ...wt, branch: found.branch, head: found.head };
    });
  }
  return { worktrees: result, changed };
}
