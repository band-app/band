import { execGit, listWorktrees } from "./git";
import { loadState, saveState, type WorktreeState } from "./state";

/**
 * Detect the remote's default branch from the local origin/HEAD ref.
 * Returns null if the ref doesn't exist (e.g. origin/HEAD was never set).
 */
async function detectRemoteDefaultBranch(projectPath: string): Promise<string | null> {
  try {
    const ref = (await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], projectPath)).trim();
    // ref is like "refs/remotes/origin/main" — extract the branch name
    const prefix = "refs/remotes/origin/";
    if (ref.startsWith(prefix)) {
      return ref.slice(prefix.length);
    }
  } catch {
    // origin/HEAD not set — try to auto-detect it (one-time network call)
    try {
      await execGit(["remote", "set-head", "origin", "--auto"], projectPath);
      const ref = (await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], projectPath)).trim();
      const prefix = "refs/remotes/origin/";
      if (ref.startsWith(prefix)) {
        return ref.slice(prefix.length);
      }
    } catch {
      // No remote or network unavailable — skip
    }
  }
  return null;
}

export async function syncWorktrees(): Promise<void> {
  const state = loadState();
  let changed = false;

  for (const project of state.projects) {
    let diskWorktrees: WorktreeState[];
    try {
      const gitWorktrees = await listWorktrees(project.path);
      // Preserve the `pinned` flag for branches that still exist —
      // syncWorktrees runs on a timer, and replacing the tracked
      // worktrees with git's view would otherwise wipe pin state on
      // every sync that adds/removes a worktree.
      const pinnedByBranch = new Map(project.worktrees.map((wt) => [wt.branch, wt.pinned]));
      diskWorktrees = gitWorktrees
        .filter((wt) => !wt.isBare)
        .map((wt) => ({
          branch: wt.branch,
          path: wt.path,
          head: wt.head,
          pinned: pinnedByBranch.get(wt.branch) ?? false,
        }));
    } catch {
      // If git fails for this project (e.g. path doesn't exist), skip it
      continue;
    }

    const existingSet = new Set(project.worktrees.map((wt) => `${wt.branch}\0${wt.path}`));
    const diskSet = new Set(diskWorktrees.map((wt) => `${wt.branch}\0${wt.path}`));

    if (
      existingSet.size !== diskSet.size ||
      Array.from(existingSet).some((key) => !diskSet.has(key))
    ) {
      project.worktrees = diskWorktrees;
      changed = true;
    }

    // Sync default branch with remote's HEAD
    const remoteBranch = await detectRemoteDefaultBranch(project.path);
    if (remoteBranch && remoteBranch !== project.defaultBranch) {
      project.defaultBranch = remoteBranch;
      changed = true;
    }
  }

  if (changed) {
    saveState(state);
  }
}
