import { useQuery } from "@tanstack/react-query";
import { useDiffTarget } from "@/dashboard";
import { trpc } from "../lib/trpc-client";

/**
 * The workspace's changes summary against its current diff target (the mode +
 * compare branch picked in the Changes sidepanel). Every consumer — the Changes
 * tree, the mobile Changes sheet, diff leaves and file leaves — shares one query
 * key, so they read one cached result and one `git` round-trip serves them all.
 * Each caller still gates `enabled` / `refetchInterval` on its own visibility.
 */
export function useDiffSummary(
  workspaceId: string,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  const { diffMode, compareBranch } = useDiffTarget(workspaceId);
  return useQuery({
    queryKey: ["diffSummary", workspaceId, diffMode, compareBranch],
    queryFn: () =>
      trpc.workspace.getDiffSummary.query({
        workspaceId,
        diffMode,
        compareBranch: compareBranch ?? undefined,
      }),
    enabled: !!workspaceId && (options.enabled ?? true),
    refetchInterval: options.refetchInterval ?? false,
  });
}
