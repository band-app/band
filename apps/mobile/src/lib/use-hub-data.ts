import type { HubClient } from "@band-app/client/hub-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { removeRequest } from "./deleting";
import { useHubSession } from "./hub-session";
import type { removeFromGroupRequests, setParentRequests } from "./parenting";
import { type pinRequest, withPinned } from "./pinning";
import { type unreadRequest, withUnread } from "./unread";
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

/** Marks a worktree unread or read: the dot changes at once and the list is read again when the call settles. */
export function useSetUnread() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: ReturnType<typeof unreadRequest>) =>
      client.worktrees.setUnread.mutate(request),
    onMutate: async (request) => {
      await queryClient.cancelQueries({ queryKey: ["repos.list"] });
      const previous = queryClient.getQueryData<ReposReply>(["repos.list"]);
      if (previous) {
        const repos = withUnread<Repo>(previous.repos, request.worktreeId, request.unread);
        queryClient.setQueryData<ReposReply>(["repos.list"], { ...previous, repos });
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

/** Sets or clears a worktree's parent and moves it into the parent's group, then reads the list again. */
export function useSetParent() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (requests: ReturnType<typeof setParentRequests>) => {
      await client.worktrees.setOrigin.mutate(requests.origin);
      if (requests.group) await client.worktrees.setGroup.mutate(requests.group);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["repos.list"] }),
  });
}

/** Clears a worktree's group (and its parent, when the parent is grouped), then reads the list again. */
export function useRemoveFromGroup() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (requests: ReturnType<typeof removeFromGroupRequests>) => {
      if (requests.origin) await client.worktrees.setOrigin.mutate(requests.origin);
      await client.worktrees.setGroup.mutate(requests.group);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["repos.list"] }),
  });
}

/** Makes a worktree group; it shows in the filter and the list once the repos are read again. */
export function useCreateGroup() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => client.groups.create.mutate({ name }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["repos.list"] }),
  });
}

/** Saves a new group order; the list reads the groups again when the call settles. */
export function useReorderGroups() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => client.groups.reorder.mutate({ ids }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["repos.list"] }),
  });
}
