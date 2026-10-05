import type { ClientPluginHost } from "@band-app/plugin-api/client";
import { useQuery } from "@tanstack/react-query";
import { readAgentMode } from "@/dashboard/lib/agent-mode";
import { queryClient } from "@/dashboard/query-client";
import { openExternalUrl } from "../lib/open-external-url";
import { trpc } from "../lib/trpc-client";

const reviewQueryKey = (worktreeId: string) => ["worktreeReview", worktreeId] as const;

/** The core's side of the plugin client API, backed by tRPC and TanStack Query. */
export const clientPluginHost: ClientPluginHost = {
  useWorktreeReview(worktreeId, { enabled, refetchInterval }) {
    const query = useQuery({
      queryKey: reviewQueryKey(worktreeId),
      queryFn: () => trpc.reviews.forWorktree.query({ worktreeId }),
      enabled,
      // Polling refreshes the panel; this only saves a `gh` call when the
      // user flips between tabs or worktrees.
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

  async mergeReview(worktreeId, method) {
    try {
      await trpc.reviews.merge.mutate({ worktreeId, method });
    } finally {
      void queryClient.invalidateQueries({ queryKey: reviewQueryKey(worktreeId) });
    }
  },

  async startAgent(worktreeId, prompt) {
    // The server announces the new chat or terminal, and the worktree's
    // center dock adds its pane from that event.
    await trpc.agentSessions.launch.mutate({ worktreeId, prompt, mode: readAgentMode() });
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
