import type { HubClient } from "@band-app/client/hub-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { useHubSession } from "./hub-session";
import { type pinRequest, withPinned } from "./pinning";
import type { LabelDefinition } from "./worktree-list";

type Repo = Awaited<ReturnType<HubClient["repos"]["list"]["query"]>>["repos"][number];

/** The live agent and branch statuses, and whether the stream is connected. */
export function useStatusFeed() {
  const { feed } = useHubSession();
  return useSyncExternalStore(feed.subscribe, feed.getSnapshot);
}

/** `repos.list`, re-read every 30 s like the web sidebar and on pull to refresh. */
export function useRepos() {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["repos.list"],
    queryFn: async () => (await client.repos.list.query()).repos,
    refetchInterval: 30_000,
  });
}

export function useHosts() {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await client.hosts.list.query()).hosts,
  });
}

/** The label definitions (name and color) repos are grouped under; the same list the web reads. */
export function useLabels() {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["settings.labels"],
    queryFn: async (): Promise<LabelDefinition[]> =>
      ((await client.settings.get.query()).labels ?? []) as LabelDefinition[],
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
      const previous = queryClient.getQueryData<Repo[]>(["repos.list"]);
      if (previous) queryClient.setQueryData(["repos.list"], withPinned(previous, request));
      return { previous };
    },
    onError: (_error, _request, context) => {
      if (context?.previous) queryClient.setQueryData(["repos.list"], context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["repos.list"] }),
  });
}
