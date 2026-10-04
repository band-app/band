import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { trpc } from "../../lib/trpc-client";
import { useAdapter } from "../context";
import { queryKeys } from "../query-client";

export const HOST_REQUESTS_KEY = ["hostRequests.list"] as const;

/**
 * Workspaces waiting for a host (`hostRequests.list`). The list follows the
 * hub's status stream; a request that turns into a workspace also refreshes
 * the project list.
 */
export function useHostRequests() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      adapter.subscribeStatusEvents((event) => {
        // A worker that exits or comes back changes whether its workspaces sleep.
        if (event.kind === "host-status-changed") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
          return;
        }
        if (event.kind !== "host-request-changed") return;
        void queryClient.invalidateQueries({ queryKey: HOST_REQUESTS_KEY });
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      }),
    [adapter, queryClient],
  );
  const query = useQuery({
    queryKey: HOST_REQUESTS_KEY,
    queryFn: async () => (await trpc.hostRequests.list.query()).requests,
  });
  return query.data ?? [];
}

/** Stops waiting for a host, or dismisses a failed request. */
export function useCancelHostRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => trpc.hostRequests.cancel.mutate({ requestId }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: HOST_REQUESTS_KEY }),
  });
}
