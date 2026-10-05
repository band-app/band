import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  type ChangeEntry,
  type ChangeSection,
  useDiffTarget,
  type WorktreeChanges,
} from "@/dashboard";
import { trpc } from "../lib/trpc-client";

/** Sections in the order the Changes view renders them (orca's default,
 *  "changes first"). */
export const CHANGE_SECTIONS: readonly ChangeSection[] = [
  "conflicts",
  "unstaged",
  "staged",
  "untracked",
  "branch",
];

/** Section headers, as orca labels them. */
export const SECTION_LABELS: Record<ChangeSection, string> = {
  conflicts: "Conflicts",
  unstaged: "Changes",
  staged: "Staged Changes",
  untracked: "Untracked Files",
  branch: "Committed on Branch",
};

/**
 * The worktree's Changes sections (conflicts, unstaged, staged, untracked,
 * committed on the branch) against its compare branch. Every consumer — the
 * Changes panel, the mobile Changes sheet, diff leaves and file leaves —
 * shares one query key, so they read one cached result. Each caller still
 * gates `enabled` and its poll interval on its own visibility.
 *
 * Polling is done here rather than with react-query's `refetchInterval`,
 * which runs one unsynchronised timer per observer: the Changes panel plus a
 * visible file leaf would run `getChanges` (several `git` processes) about
 * twice per interval. Each caller's tick here skips when the cached result is
 * younger than most of its interval, so a refresh by any caller counts for all.
 */
export function useWorktreeChanges(
  worktreeId: string,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  const { compareBranch } = useDiffTarget(worktreeId);
  const queryClient = useQueryClient();
  const enabled = !!worktreeId && (options.enabled ?? true);
  const interval = options.refetchInterval ?? false;
  const query = useQuery({
    queryKey: ["worktreeChanges", worktreeId, compareBranch],
    queryFn: (): Promise<WorktreeChanges> =>
      trpc.worktree.getChanges.query({
        worktreeId,
        compareBranch: compareBranch ?? undefined,
      }),
    enabled,
  });

  useEffect(() => {
    if (!enabled || !interval) return;
    const queryKey = ["worktreeChanges", worktreeId, compareBranch];
    const id = setInterval(() => {
      const state = queryClient.getQueryState(queryKey);
      if (state?.fetchStatus === "fetching") return;
      // 80%, not 100%: this caller's own last fetch finished a little after
      // its previous tick, and must not make it skip the next one.
      if (state && Date.now() - state.dataUpdatedAt < interval * 0.8) return;
      void queryClient.refetchQueries({ queryKey, exact: true });
    }, interval);
    return () => clearInterval(id);
  }, [queryClient, enabled, interval, worktreeId, compareBranch]);

  return query;
}

/** Refetch every worktree's Changes query after a stage / unstage / discard. */
export function invalidateWorktreeChanges(
  queryClient: ReturnType<typeof useQueryClient>,
  worktreeId: string,
) {
  return queryClient.invalidateQueries({ queryKey: ["worktreeChanges", worktreeId] });
}

/** The first section (in render order) that lists `path`, with its entry. */
export function findChange(
  changes: WorktreeChanges | undefined,
  path: string,
): { section: ChangeSection; entry: ChangeEntry } | null {
  if (!changes) return null;
  for (const section of CHANGE_SECTIONS) {
    const entry = changes[section].find((e) => e.path === path);
    if (entry) return { section, entry };
  }
  return null;
}

/** Number of distinct paths across every section — the Changes badge. */
export function countChangedPaths(changes: WorktreeChanges | undefined): number {
  if (!changes) return 0;
  const paths = new Set<string>();
  for (const section of CHANGE_SECTIONS) for (const e of changes[section]) paths.add(e.path);
  return paths.size;
}
