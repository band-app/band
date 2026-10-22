import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc-client";
import { queryKeys } from "../query-client";
import { useDashboardStore } from "../stores/index";
import type { GroupDefinition } from "../types";

// Reference-stable fallback while the query loads, so effects that depend on the list don't re-run.
const EMPTY_GROUPS: readonly GroupDefinition[] = Object.freeze([]);

/** The worktree groups in their display order (`groups.list`), and whether the list has loaded. */
export function useGroupsQuery(): { groups: GroupDefinition[]; loaded: boolean } {
  const { data } = useQuery({
    queryKey: queryKeys.groups,
    queryFn: async () => (await trpc.groups.list.query()).groups as GroupDefinition[],
  });
  return { groups: data ?? (EMPTY_GROUPS as GroupDefinition[]), loaded: data !== undefined };
}

/** The worktree groups in their display order (`groups.list`). */
export function useGroups(): GroupDefinition[] {
  return useGroupsQuery().groups;
}

/** Group changes and moving a worktree between groups. Each one refreshes the groups and repos. */
export function useGroupMutations() {
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
    void queryClient.invalidateQueries({ queryKey: queryKeys.repos });
  };
  const options = { onSuccess: refresh, onError: (err: unknown) => setError(err) };
  const create = useMutation({
    mutationFn: (input: { name: string; color?: string }) => trpc.groups.create.mutate(input),
    ...options,
  });
  const update = useMutation({
    mutationFn: (input: { id: string; name?: string; color?: string }) =>
      trpc.groups.update.mutate(input),
    ...options,
  });
  const remove = useMutation({
    mutationFn: (input: { id: string }) => trpc.groups.remove.mutate(input),
    ...options,
  });
  const reorder = useMutation({
    mutationFn: (input: { ids: string[] }) => trpc.groups.reorder.mutate(input),
    ...options,
  });
  const setWorktreeGroup = useMutation({
    mutationFn: (input: { worktreeId: string; groupId: string | null; withChildren?: boolean }) =>
      trpc.worktrees.setGroup.mutate(input),
    ...options,
  });
  return { create, update, remove, reorder, setWorktreeGroup };
}
