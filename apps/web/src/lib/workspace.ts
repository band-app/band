import { loadState } from "./state";

export function resolveWorkspace(workspaceId: string) {
  const state = loadState();

  for (const project of state.projects) {
    const prefix = `${project.name}-`;
    if (workspaceId.startsWith(prefix)) {
      const branch = workspaceId.slice(prefix.length);
      for (const wt of project.worktrees) {
        if (wt.branch === branch) {
          return { project, worktree: wt };
        }
      }
    }
  }
  return null;
}
