import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useHubSession } from "./hub-session";

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
