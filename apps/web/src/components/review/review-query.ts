import type { ReviewActionArgs, WorktreeReview } from "@band-app/plugin-api";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { queryClient } from "@/dashboard/query-client";
import { trpc } from "../../lib/trpc-client";

const reviewQueryKey = (worktreeId: string) => ["worktreeReview", worktreeId] as const;
const providerQueryKey = (worktreeId: string) => ["worktreeReviewProvider", worktreeId] as const;

/**
 * A poller tick or another device learned a CI state for the worktree. An open
 * Checks panel that still shows another state refetches; a closed one is only
 * marked stale, so nothing is fetched while it is hidden. A state the panel
 * already shows (its own load put it in the sidebar) costs no query.
 */
export function syncReviewWithCI(worktreeId: string, ciState: string): void {
  const key = reviewQueryKey(worktreeId);
  const cached = queryClient.getQueryData<WorktreeReview>(key);
  if (cached?.status === "ok") {
    const shown = cached.review?.state === "merged" ? "merged" : cached.checks.state;
    if (shown === ciState) return;
  }
  void queryClient.invalidateQueries({ queryKey: key });
}

/** The review provider that serves the worktree's repo, or null. Runs no forge command. */
export function useReviewProvider(worktreeId: string) {
  return useQuery({
    queryKey: providerQueryKey(worktreeId),
    queryFn: () => trpc.reviews.provider.query({ worktreeId }),
    staleTime: 5 * 60_000,
  }).data;
}

export function useWorktreeReview(
  worktreeId: string,
  {
    enabled,
    refetchInterval,
  }: {
    enabled: boolean;
    /** Poll interval in ms, or `false` to stop polling. May depend on the last result. */
    refetchInterval: number | false | ((data: WorktreeReview | undefined) => number | false);
  },
) {
  const query = useQuery({
    queryKey: reviewQueryKey(worktreeId),
    queryFn: () => trpc.reviews.forWorktree.query({ worktreeId }),
    enabled,
    // Polling refreshes the panel; this only saves a `gh` call when the
    // user flips between tabs or worktrees.
    staleTime: 15_000,
    // Coming back to a worktree within 30 minutes shows the last data at
    // once while it refetches.
    gcTime: 30 * 60_000,
    refetchInterval:
      typeof refetchInterval === "function"
        ? (q) => refetchInterval(q.state.data)
        : refetchInterval,
  });
  return {
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

/** Run one action the provider offered, then refetch the review. Rejects with the forge's message. */
export async function runReviewAction(
  worktreeId: string,
  actionId: string,
  args: ReviewActionArgs = {},
): Promise<void> {
  try {
    await trpc.reviews.runAction.mutate({ worktreeId, actionId, args });
  } finally {
    void queryClient.invalidateQueries({ queryKey: reviewQueryKey(worktreeId) });
  }
}

/** The provider's name and Fix hint, for the copy that names the forge. */
export const ReviewProviderContext = createContext<{ name: string; fixHint: string }>({
  name: "the forge",
  fixHint: "",
});

export function useReviewProviderInfo() {
  return useContext(ReviewProviderContext);
}
