import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  type ChangeEntry,
  type ChangeSection,
  useDiffTarget,
  type WorkspaceChanges,
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
 * The workspace's Changes sections (conflicts, unstaged, staged, untracked,
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
export function useWorkspaceChanges(
  workspaceId: string,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  const { compareBranch } = useDiffTarget(workspaceId);
  const queryClient = useQueryClient();
  const enabled = !!workspaceId && (options.enabled ?? true);
  const interval = options.refetchInterval ?? false;
  const query = useQuery({
    queryKey: ["workspaceChanges", workspaceId, compareBranch],
    queryFn: (): Promise<WorkspaceChanges> =>
      trpc.workspace.getChanges.query({
        workspaceId,
        compareBranch: compareBranch ?? undefined,
      }),
    enabled,
  });

  useEffect(() => {
    if (!enabled || !interval) return;
    const queryKey = ["workspaceChanges", workspaceId, compareBranch];
    const id = setInterval(() => {
      const state = queryClient.getQueryState(queryKey);
      if (state?.fetchStatus === "fetching") return;
      // 80%, not 100%: this caller's own last fetch finished a little after
      // its previous tick, and must not make it skip the next one.
      if (state && Date.now() - state.dataUpdatedAt < interval * 0.8) return;
      void queryClient.refetchQueries({ queryKey, exact: true });
    }, interval);
    return () => clearInterval(id);
  }, [queryClient, enabled, interval, workspaceId, compareBranch]);

  return query;
}

/** Refetch every workspace's Changes query after a stage / unstage / discard. */
export function invalidateWorkspaceChanges(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
) {
  return queryClient.invalidateQueries({ queryKey: ["workspaceChanges", workspaceId] });
}

/** The first section (in render order) that lists `path`, with its entry. */
export function findChange(
  changes: WorkspaceChanges | undefined,
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
export function countChangedPaths(changes: WorkspaceChanges | undefined): number {
  if (!changes) return 0;
  const paths = new Set<string>();
  for (const section of CHANGE_SECTIONS) for (const e of changes[section]) paths.add(e.path);
  return paths.size;
}
