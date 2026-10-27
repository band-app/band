import type { DeleteDialogInfo, WorktreeBranchStatus } from "../types";

/** Window event a plugin's "delete this worktree" request travels on, to the sidebar. */
export const DELETE_WORKTREE_EVENT = "band:delete-worktree";

export interface DeleteWorktreeEventDetail {
  worktreeId: string;
}

/**
 * What deleting a worktree puts at risk. Returns null when nothing is at risk and
 * the worktree can be removed at once, else the info the confirmation dialog shows.
 */
export function deleteDialogInfoFor(
  target: { repoName: string; name: string; hostId?: string },
  branchStatus: WorktreeBranchStatus | undefined,
): DeleteDialogInfo | null {
  const ciState = branchStatus?.ci.state;
  const isUnmerged = ciState !== undefined && ciState !== "none" && ciState !== "merged";
  const isDirty = branchStatus?.git.dirty ?? false;
  const hasUnpushedCommits = (branchStatus?.git.ahead ?? 0) > 0;
  if (!isUnmerged && !isDirty && !hasUnpushedCommits) return null;
  return { ...target, isUnmerged, isDirty, hasUnpushedCommits };
}
