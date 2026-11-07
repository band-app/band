import { toWorktreeId } from "@band-app/shared/worktree-id";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { trpc } from "../../lib/trpc-client";
import { queryKeys } from "../query-client";
import { useDashboardStore } from "../stores/index";
import type { QuickCommand, QuickCommandInput } from "../types";
import { useRepos } from "./use-repos";

const EMPTY: readonly QuickCommand[] = Object.freeze([]);

/** Every saved quick command, most recently run first (`quickCommands.list`). */
export function useQuickCommands(): QuickCommand[] {
  const { data } = useQuery({
    queryKey: queryKeys.quickCommands,
    queryFn: async () => (await trpc.quickCommands.list.query()).commands as QuickCommand[],
  });
  return data ?? (EMPTY as QuickCommand[]);
}

/** The repo a worktree belongs to, or null while the repo list loads or for an unknown id. */
export function useRepoNameOfWorktree(worktreeId: string | null | undefined): string | null {
  const { repos } = useRepos();
  return useMemo(() => {
    if (!worktreeId) return null;
    const repo = repos.find((r) =>
      r.worktrees.some((wt) => toWorktreeId(r.name, wt.name, wt.hostId) === worktreeId),
    );
    return repo?.name ?? null;
  }, [repos, worktreeId]);
}

/** The commands a worktree of `repoName` may run: global ones plus those scoped to its repo. */
export function useQuickCommandsFor(repoName: string | null): QuickCommand[] {
  const all = useQuickCommands();
  return all.filter((c) => c.repo === null || c.repo === repoName);
}

export function useQuickCommandMutations() {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.quickCommands });
  // The dialog shows the message itself, so these do not feed the global error banner.
  const create = useMutation({
    mutationFn: (input: QuickCommandInput) => trpc.quickCommands.create.mutate(input),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: (input: { id: string; command: QuickCommandInput }) =>
      trpc.quickCommands.update.mutate(input),
    onSuccess: refresh,
  });
  const setError = useDashboardStore((s) => s.setError);
  const remove = useMutation({
    mutationFn: (input: { id: string }) => trpc.quickCommands.remove.mutate(input),
    onSuccess: refresh,
    onError: (err: unknown) => setError(err),
  });
  const markRun = useMutation({
    mutationFn: (input: { id: string }) => trpc.quickCommands.markRun.mutate(input),
    onSuccess: refresh,
  });
  return { create, update, remove, markRun };
}
