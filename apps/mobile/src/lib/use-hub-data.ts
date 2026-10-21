import type { HubClient } from "@band-app/client/hub-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { removeRequest } from "./deleting";
import { useHubSession } from "./hub-session";
import { type pinRequest, withPinned } from "./pinning";
import type { GroupDefinition } from "./worktree-list";

type ReposReply = Awaited<ReturnType<HubClient["repos"]["list"]["query"]>>;
type Repo = ReposReply["repos"][number];

/** The live agent and branch statuses, and whether the stream is connected. */
export function useStatusFeed() {
  const { feed } = useHubSession();
  return useSyncExternalStore(feed.subscribe, feed.getSnapshot);
}

/** `repos.list`, re-read every 30 s like the web sidebar and on pull to refresh. */
function useReposReply<T>(select: (reply: ReposReply) => T) {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["repos.list"],
    queryFn: () => client.repos.list.query(),
    refetchInterval: 30_000,
    select,
  });
}

export function useRepos() {
  return useReposReply((reply) => reply.repos);
}

/** The worktree groups (name and color) the hub returns beside the repos, in their order. */
export function useGroups() {
  return useReposReply((reply): GroupDefinition[] => reply.groups as GroupDefinition[]);
}

export function useHosts() {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await client.workers.list.query()).hosts,
  });
}

/** Pins or unpins a worktree: the list changes at once and is read again when the call settles. */
export function usePinWorktree() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: ReturnType<typeof pinRequest>) =>
      client.worktrees.setPinned.mutate(request),
    onMutate: async (request) => {
      await queryClient.cancelQueries({ queryKey: ["repos.list"] });
      const previous = queryClient.getQueryData<ReposReply>(["repos.list"]);
      if (previous) {
        queryClient.setQueryData<ReposReply>(["repos.list"], {
          ...previous,
          repos: withPinned<Repo>(previous.repos, request),
        });
      }
      return { previous };
    },
    onError: (_error, _request, context) => {
      if (context?.previous) queryClient.setQueryData(["repos.list"], context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["repos.list"] }),
  });
}

/** Deletes a worktree with the call the web uses; the list is read again when it settles. */
export function useRemoveWorktree() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: ReturnType<typeof removeRequest>) =>
      client.worktrees.remove.mutate(request),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["repos.list"] }),
  });
}
