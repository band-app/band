import { projectIdOfScope } from "@band-app/shared/scope-id";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { trpc } from "../../lib/trpc-client";
import { useRepos } from "./use-repos";

/**
 * Resolve a worktree's absolute filesystem path (the worktree root on disk)
 * from its `worktreeId`. Matches against the repos list, where each
 * worktree carries its absolute `path`. A project's folder view
 * (`project:<id>`) takes the folder its coordinator host last reported.
 *
 * Returns `undefined` while repos are still loading or when no worktree
 * matches the id — callers should treat that as "absolute path unavailable"
 * (e.g. hide a "Copy absolute path" action).
 */
export function useWorktreePath(worktreeId: string): string | undefined {
  const { repos } = useRepos();
  const projectId = projectIdOfScope(worktreeId);
  const folder = useQuery({
    queryKey: ["projects.folder", projectId],
    queryFn: () => trpc.projects.folder.query({ project: projectId ?? "" }),
    enabled: projectId !== undefined,
    // The path changes only when the coordinator host moves. Opening the view refreshes it
    // (`projects.prepareFolder`), and `select` re-renders callers only when the string changes.
    refetchInterval: 30_000,
    select: (d) => d.folder?.folder,
  });
  return useMemo(() => {
    if (projectId) return folder.data;
    for (const proj of repos) {
      for (const wt of proj.worktrees) {
        if (toWorktreeId(proj.name, wt.name) === worktreeId) {
          return wt.path;
        }
      }
    }
    return undefined;
  }, [repos, worktreeId, projectId, folder.data]);
}
