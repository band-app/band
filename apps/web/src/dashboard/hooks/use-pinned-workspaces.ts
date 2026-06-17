import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useAdapter } from "../context";
import { queryKeys } from "../query-client";
import { useDashboardStore } from "../stores/index";
import type { ProjectInfo, WorktreeInfo } from "../types";
import { useProjects } from "./use-projects";

export interface PinnedEntry {
  project: ProjectInfo;
  worktree: WorktreeInfo;
  workspaceId: string;
}

/**
 * Reads the set of pinned workspaces from the existing `useProjects()` data
 * and exposes mutations to pin/unpin a workspace. Mutations apply optimistic
 * updates to the `projects` query cache and invalidate it on settle so the
 * UI reflects the change immediately.
 *
 * Pinned state itself lives on the `worktrees.pinned` column in the SQLite
 * database — this hook is a thin client-side facade over that storage.
 */
export function usePinnedWorkspaces() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);
  const { projects } = useProjects();

  const pinned = useMemo<PinnedEntry[]>(() => {
    const list: PinnedEntry[] = [];
    for (const project of projects) {
      for (const wt of project.worktrees) {
        if (wt.pinned) {
          list.push({
            project,
            worktree: wt,
            workspaceId: wt.workspaceId,
          });
        }
      }
    }
    return list;
  }, [projects]);

  const pinnedSet = useMemo(() => new Set(pinned.map((p) => p.workspaceId)), [pinned]);
  const isPinned = useCallback((id: string) => pinnedSet.has(id), [pinnedSet]);

  const mutation = useMutation({
    mutationFn: ({
      project,
      branch,
      pinned: nextPinned,
    }: {
      project: string;
      branch: string;
      pinned: boolean;
    }) => adapter.setWorkspacePinned(project, branch, nextPinned),
    onMutate: async ({ project, branch, pinned: nextPinned }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects });
      const previous = queryClient.getQueryData<ProjectInfo[]>(queryKeys.projects);
      if (previous) {
        const next = previous.map((p) =>
          p.name === project
            ? {
                ...p,
                worktrees: p.worktrees.map((w) =>
                  w.branch === branch ? { ...w, pinned: nextPinned } : w,
                ),
              }
            : p,
        );
        queryClient.setQueryData(queryKeys.projects, next);
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.projects, context.previous);
      }
      setError(String(err));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });

  // Depend on `mutation.mutate` (stable across renders) rather than the
  // `mutation` object itself, which `useMutation` re-creates every render
  // and would defeat the memoisation here.
  const toggle = useCallback(
    (project: string, branch: string, currentlyPinned: boolean) =>
      mutation.mutate({ project, branch, pinned: !currentlyPinned }),
    [mutation.mutate],
  );

  return { pinned, isPinned, toggle };
}
