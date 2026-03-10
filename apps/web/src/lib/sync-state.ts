import { listWorktrees } from "./git";
import { loadState, saveState, type WorktreeState } from "./state";

export async function syncWorktrees(): Promise<void> {
  const state = loadState();
  let changed = false;

  for (const project of state.projects) {
    let diskWorktrees: WorktreeState[];
    try {
      const gitWorktrees = await listWorktrees(project.path);
      diskWorktrees = gitWorktrees
        .filter((wt) => !wt.isBare)
        .map((wt) => ({ branch: wt.branch, path: wt.path, head: wt.head }));
    } catch {
      // If git fails for this project (e.g. path doesn't exist), skip it
      continue;
    }

    const existingSet = new Set(
      project.worktrees.map((wt) => `${wt.branch}\0${wt.path}`),
    );
    const diskSet = new Set(
      diskWorktrees.map((wt) => `${wt.branch}\0${wt.path}`),
    );

    if (
      existingSet.size !== diskSet.size ||
      Array.from(existingSet).some((key) => !diskSet.has(key))
    ) {
      project.worktrees = diskWorktrees;
      changed = true;
    }
  }

  if (changed) {
    saveState(state);
  }
}
