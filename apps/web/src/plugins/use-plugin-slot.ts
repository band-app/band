import type { WorktreePanel, WorktreeSideTab } from "@band-app/plugin-api/client";
import { useQuery } from "@tanstack/react-query";
import { GitPullRequest } from "lucide-react";
import { useMemo } from "react";
import { toWorktreeId, useRepos } from "@/dashboard";
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

export interface PanelContribution {
  pluginId: string;
  panel: WorktreePanel;
}

/** The id of a plugin panel's center tab: `plugin:<plugin id>:<panel id>`. */
export function pluginPanelTabId(pluginId: string, panelId: string): string {
  return `plugin:${pluginId}:${panelId}`;
}

/** The plugin and panel ids in a tab id made by {@link pluginPanelTabId}, or null. */
export function parsePluginPanelTabId(id: string): { pluginId: string; panelId: string } | null {
  const [prefix, pluginId, panelId, ...rest] = id.split(":");
  if (prefix !== "plugin" || !pluginId || !panelId || rest.length > 0) return null;
  return { pluginId, panelId };
}

/** The contribution a plugin panel tab id names, whether or not the worker offers it now. */
export function findPanelContribution(id: string): PanelContribution | null {
  const parsed = parsePluginPanelTabId(id);
  if (!parsed) return null;
  const plugin = BUNDLED_CLIENT_PLUGINS.find((p) => p.id === parsed.pluginId);
  const panel = plugin?.contributions["worktree.panels"]?.find((p) => p.id === parsed.panelId);
  return plugin && panel ? { pluginId: plugin.id, panel } : null;
}

/**
 * The panels of enabled bundled plugins that a worktree's worker can serve: the worker is online
 * and reports the panel's capability. The "+" menu lists these.
 */
export function useWorktreePanels(worktreeId: string): PanelContribution[] {
  const { repos } = useRepos();
  const plugins = useQuery({
    queryKey: ["plugins"],
    queryFn: () => trpc.plugins.list.query(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.workers.list.query()).hosts,
  });
  const hostId = repos
    .flatMap((repo) =>
      repo.worktrees.map((wt) => ({ id: toWorktreeId(repo.name, wt.name, wt.hostId), wt })),
    )
    .find((entry) => entry.id === worktreeId)?.wt.hostId;
  const host = hosts.data?.find((h) => h.id === (hostId ?? "local"));
  return useMemo(() => {
    if (!plugins.data || !host || host.status !== "online") return [];
    const enabled = new Set(plugins.data.filter((p) => p.status !== "disabled").map((p) => p.id));
    return BUNDLED_CLIENT_PLUGINS.filter((p) => enabled.has(p.id)).flatMap((plugin) =>
      (plugin.contributions["worktree.panels"] ?? [])
        .filter((panel) => host.capabilities.includes(panel.capability))
        .map((panel) => ({ pluginId: plugin.id, panel })),
    );
  }, [plugins.data, host]);
}
