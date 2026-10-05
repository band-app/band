import type { WorktreeSideTab } from "@band-app/plugin-api/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
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
 * The `worktree.sideTabs` contributions of the bundled plugins the server
 * reports as enabled. Nothing renders until the server has answered, so a
 * disabled plugin's tab never flashes in.
 */
export function useWorktreeSideTabs(): SideTabContribution[] {
  const plugins = useQuery({
    queryKey: ["plugins"],
    queryFn: () => trpc.plugins.list.query(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return useMemo(() => {
    if (!plugins.data) return [];
    const enabled = new Set(plugins.data.filter((p) => p.status !== "disabled").map((p) => p.id));
    return BUNDLED_CLIENT_PLUGINS.filter((p) => enabled.has(p.id)).flatMap((plugin) =>
      (plugin.contributions["worktree.sideTabs"] ?? []).map((tab) => ({
        key: `${plugin.id}.${tab.id}`,
        slug: `${plugin.id}-${tab.id}`,
        pluginId: plugin.id,
        tab,
      })),
    );
  }, [plugins.data]);
}
