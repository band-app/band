import { toWorkspaceId } from "@band-app/dashboard-core";
import { loadState } from "./state";

export function resolveWorkspace(workspaceId: string) {
  const state = loadState();

  for (const project of state.projects) {
    for (const wt of project.worktrees) {
      if (toWorkspaceId(project.name, wt.branch) === workspaceId) {
        return { project, worktree: wt };
      }
    }
  }
  return null;
}
