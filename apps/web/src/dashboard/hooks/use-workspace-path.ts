import { useMemo } from "react";
import { toWorkspaceId } from "../lib/workspace-id";
import { useProjects } from "./use-projects";

/**
 * Resolve a workspace's absolute filesystem path (the worktree root on disk)
 * from its `workspaceId`. Matches against the projects list, where each
 * worktree carries its absolute `path`.
 *
 * Returns `undefined` while projects are still loading or when no worktree
 * matches the id — callers should treat that as "absolute path unavailable"
 * (e.g. hide a "Copy absolute path" action).
 */
export function useWorkspacePath(workspaceId: string): string | undefined {
  const { projects } = useProjects();
  return useMemo(() => {
    for (const proj of projects) {
      for (const wt of proj.worktrees) {
        if (toWorkspaceId(proj.name, wt.branch) === workspaceId) {
          return wt.path;
        }
      }
    }
    return undefined;
  }, [projects, workspaceId]);
}
