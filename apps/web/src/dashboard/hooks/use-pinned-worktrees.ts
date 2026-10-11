import { toWorktreeId } from "@band-app/shared/worktree-id";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useAdapter } from "../context";
import { queryKeys } from "../query-client";
import { useDashboardStore } from "../stores/index";
import type { RepoInfo, WorktreeInfo } from "../types";
import { useRepos } from "./use-repos";

export interface PinnedEntry {
  repo: RepoInfo;
  worktree: WorktreeInfo;
  worktreeId: string;
}

/**
 * Reads the set of pinned worktrees from the existing `useRepos()` data
 * and exposes mutations to pin/unpin a worktree. Mutations apply optimistic
 * updates to the `repos` query cache and invalidate it on settle so the
 * UI reflects the change immediately.
 *
 * Pinned state itself lives on the `worktrees.pinned` column in the SQLite
 * database — this hook is a thin client-side facade over that storage.
 */
export function usePinnedWorktrees() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);
  const { repos } = useRepos();

  const pinned = useMemo<PinnedEntry[]>(() => {
    const list: PinnedEntry[] = [];
    for (const repo of repos) {
      for (const wt of repo.worktrees) {
        if (wt.pinned) {
          list.push({
            repo,
            worktree: wt,
            worktreeId: toWorktreeId(repo.name, wt.name, wt.hostId),
          });
        }
      }
    }
    return list;
  }, [repos]);

  const pinnedSet = useMemo(() => new Set(pinned.map((p) => p.worktreeId)), [pinned]);
  const isPinned = useCallback((id: string) => pinnedSet.has(id), [pinnedSet]);

  const mutation = useMutation({
    mutationFn: ({
      repo,
      name,
      pinned: nextPinned,
      hostId,
    }: {
      repo: string;
      name: string;
      pinned: boolean;
      hostId?: string;
    }) => adapter.setWorktreePinned(repo, name, nextPinned, hostId),
    onMutate: async ({ repo, name, pinned: nextPinned, hostId }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.repos });
      const previous = queryClient.getQueryData<RepoInfo[]>(queryKeys.repos);
      if (previous) {
        const next = previous.map((p) =>
          p.name === repo
            ? {
                ...p,
                worktrees: p.worktrees.map((w) =>
                  w.name === name && (w.hostId ?? "local") === (hostId ?? "local")
                    ? { ...w, pinned: nextPinned }
                    : w,
                ),
              }
            : p,
        );
        queryClient.setQueryData(queryKeys.repos, next);
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.repos, context.previous);
      }
      setError(err);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repos });
    },
  });

  // Depend on `mutation.mutate` (stable across renders) rather than the
  // `mutation` object itself, which `useMutation` re-creates every render
  // and would defeat the memoisation here.
  const toggle = useCallback(
    (repo: string, name: string, currentlyPinned: boolean, hostId?: string) =>
      mutation.mutate({ repo, name, pinned: !currentlyPinned, hostId }),
    [mutation.mutate],
  );

  return { pinned, isPinned, toggle };
}
