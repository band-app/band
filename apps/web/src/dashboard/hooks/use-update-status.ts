import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { trpc } from "../../lib/trpc-client";
import { useAdapter } from "../context";

export const UPDATE_STATUS_KEY = ["hosts.updateStatus"] as const;
export const HOSTS_LIST_KEY = ["hosts.list"] as const;

export type HostView = Awaited<ReturnType<typeof trpc.hosts.list.query>>["hosts"][number];

/** How often the page asks the hub again. The hub itself checks GitHub once a day. */
const REFETCH_MS = 10 * 60_000;

/** The hub's version, the newest release it knows of and the command that updates the hub. */
export function useUpdateStatus() {
  return useQuery({
    queryKey: UPDATE_STATUS_KEY,
    queryFn: () => trpc.hosts.updateStatus.query(),
    refetchInterval: REFETCH_MS,
    // An old hub has no such procedure, and a missing badge is the right answer for it.
    retry: false,
  });
}

/** `hosts.list`, kept fresh while a worker connects, drops or updates. */
export function useHostsList(enabled = true) {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return adapter.subscribeStatusEvents((event) => {
      if (event.kind === "host-status-changed") {
        void queryClient.invalidateQueries({ queryKey: HOSTS_LIST_KEY });
      }
    });
  }, [adapter, queryClient, enabled]);
  return useQuery({
    queryKey: HOSTS_LIST_KEY,
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
    enabled,
  });
}
