import { toWorktreeId } from "@band-app/shared/worktree-id";
import { useMemo } from "react";
import { useRepos } from "./use-repos";

/**
 * Resolve a worktree's absolute filesystem path (the worktree root on disk)
 * from its `worktreeId`. Matches against the repos list, where each
 * worktree carries its absolute `path`.
 *
 * Returns `undefined` while repos are still loading or when no worktree
 * matches the id — callers should treat that as "absolute path unavailable"
 * (e.g. hide a "Copy absolute path" action).
 */
export function useWorktreePath(worktreeId: string): string | undefined {
  const { repos } = useRepos();
  return useMemo(() => {
    for (const proj of repos) {
      for (const wt of proj.worktrees) {
        if (toWorktreeId(proj.name, wt.name) === worktreeId) {
          return wt.path;
        }
      }
    }
    return undefined;
  }, [repos, worktreeId]);
}
