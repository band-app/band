import type { ClientPluginHost } from "@band-app/plugin-api/client";
import { useQuery } from "@tanstack/react-query";
import { readAgentMode } from "@/dashboard/lib/agent-mode";
import { queryClient } from "@/dashboard/query-client";
import { openExternalUrl } from "../lib/open-external-url";
import { trpc } from "../lib/trpc-client";

const reviewQueryKey = (workspaceId: string) => ["workspaceReview", workspaceId] as const;

/** The core's side of the plugin client API, backed by tRPC and TanStack Query. */
export const clientPluginHost: ClientPluginHost = {
  useWorkspaceReview(workspaceId, { enabled, refetchInterval }) {
    const query = useQuery({
      queryKey: reviewQueryKey(workspaceId),
      queryFn: () => trpc.reviews.forWorkspace.query({ workspaceId }),
      enabled,
      // Polling refreshes the panel; this only saves a `gh` call when the
      // user flips between tabs or workspaces.
      staleTime: 15_000,
      refetchInterval:
        typeof refetchInterval === "function"
          ? (q) => refetchInterval(q.state.data)
          : refetchInterval,
    });
    return {
      data: query.data,
      isLoading: query.isLoading,
      isFetching: query.isFetching,
      error: query.error,
      refetch: () => void query.refetch(),
    };
  },

  async mergeReview(workspaceId, method) {
    try {
      await trpc.reviews.merge.mutate({ workspaceId, method });
    } finally {
      void queryClient.invalidateQueries({ queryKey: reviewQueryKey(workspaceId) });
    }
  },

  async startAgent(workspaceId, prompt) {
    // The server announces the new chat or terminal, and the workspace's
    // center dock adds its pane from that event.
    await trpc.agentSessions.launch.mutate({ workspaceId, prompt, mode: readAgentMode() });
  },

  openUrl(url) {
    // Plugin UI shows URLs from third parties (a check's details link), and
    // the desktop opens them with the system's handler for their scheme.
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return;
    }
    if (protocol === "https:" || protocol === "http:") openExternalUrl(url);
  },
};
