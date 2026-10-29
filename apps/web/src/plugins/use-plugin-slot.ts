import type { WorktreeSideTab } from "@band-app/plugin-api/client";
import { useQuery } from "@tanstack/react-query";
import { GitPullRequest } from "lucide-react";
import { useMemo } from "react";
import { PullRequestPanel } from "../components/review/PullRequestPanel";
import { useReviewProvider } from "../components/review/review-query";
import { trpc } from "../lib/trpc-client";
import { BUNDLED_CLIENT_PLUGINS } from "./bundled-client-plugins";

export interface SideTabContribution {
  /** `<pluginId>.<tabId>`, unique across plugins. */
  key: string;
  /** `<pluginId>-<tabId>`, for test ids. */
  slug: string;
  pluginId: string;
  tab: WorktreeSideTab;
}

/**
 * The core's own Checks tab. Its panel is drawn by the core for whichever review provider
 * serves the worktree's repo. The slug keeps the test ids the tab had as the GitHub plugin's.
 */
const CHECKS_CONTRIBUTION: SideTabContribution = {
  key: "core.checks",
  slug: "github-pull-request",
  pluginId: "core",
  tab: { id: "checks", label: "Checks", icon: GitPullRequest, component: PullRequestPanel },
};

/**
 * The tabs of a worktree's right side panel after Explorer and Changes: the core's Checks tab
 * when a review provider serves the repo, then the `worktree.sideTabs` contributions of the
 * bundled plugins the server reports as enabled. Nothing renders until the server has
 * answered, so a missing provider's or disabled plugin's tab never flashes in.
 */
export function useWorktreeSideTabs(worktreeId: string): SideTabContribution[] {
  const reviewProvider = useReviewProvider(worktreeId);
  const plugins = useQuery({
    queryKey: ["plugins"],
    queryFn: () => trpc.plugins.list.query(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return useMemo(() => {
    const checks = reviewProvider ? [CHECKS_CONTRIBUTION] : [];
    if (!plugins.data) return checks;
    const enabled = new Set(plugins.data.filter((p) => p.status !== "disabled").map((p) => p.id));
    const contributed = BUNDLED_CLIENT_PLUGINS.filter((p) => enabled.has(p.id)).flatMap((plugin) =>
      (plugin.contributions["worktree.sideTabs"] ?? []).map((tab) => ({
        key: `${plugin.id}.${tab.id}`,
        slug: `${plugin.id}-${tab.id}`,
        pluginId: plugin.id,
        tab,
      })),
    );
    return [...checks, ...contributed];
  }, [plugins.data, reviewProvider]);
}
