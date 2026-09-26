import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useDiffTarget } from "@/dashboard";
import { trpc } from "../lib/trpc-client";

/**
 * The workspace's changes summary against its current diff target (the mode +
 * compare branch picked in the Changes sidepanel). Every consumer — the Changes
 * tree, the mobile Changes sheet, diff leaves and file leaves — shares one query
 * key, so they read one cached result. Each caller still gates `enabled` and
 * its poll interval on its own visibility.
 *
 * Polling is done here rather than with react-query's `refetchInterval`,
 * which runs one unsynchronised timer per observer: the Changes panel plus a
 * visible file leaf would run `getDiffSummary` (3–4 `git` processes) about
 * twice per interval. Each caller's tick here skips when the cached result is
 * younger than most of its interval, so a refresh by any caller counts for all.
 */
export function useDiffSummary(
  workspaceId: string,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  const { diffMode, compareBranch } = useDiffTarget(workspaceId);
  const queryClient = useQueryClient();
  const enabled = !!workspaceId && (options.enabled ?? true);
  const interval = options.refetchInterval ?? false;
  const query = useQuery({
    queryKey: ["diffSummary", workspaceId, diffMode, compareBranch],
    queryFn: () =>
      trpc.workspace.getDiffSummary.query({
        workspaceId,
        diffMode,
        compareBranch: compareBranch ?? undefined,
      }),
    enabled,
  });

  useEffect(() => {
    if (!enabled || !interval) return;
    const queryKey = ["diffSummary", workspaceId, diffMode, compareBranch];
    const id = setInterval(() => {
      const state = queryClient.getQueryState(queryKey);
      if (state?.fetchStatus === "fetching") return;
      // 80%, not 100%: this caller's own last fetch finished a little after
      // its previous tick, and must not make it skip the next one.
      if (state && Date.now() - state.dataUpdatedAt < interval * 0.8) return;
      void queryClient.refetchQueries({ queryKey, exact: true });
    }, interval);
    return () => clearInterval(id);
  }, [queryClient, enabled, interval, workspaceId, diffMode, compareBranch]);

  return query;
}
