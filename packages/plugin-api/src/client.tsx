import { type ComponentType, createContext, useContext } from "react";
import type { MergeMethod, WorktreeReview } from "./providers";

export interface WorktreeReviewQuery {
  data: WorktreeReview | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch(): void;
}

export interface WorktreeReviewQueryOptions {
  enabled: boolean;
  /** Poll interval in ms, or `false` to stop polling. May depend on the last result. */
  refetchInterval: number | false | ((data: WorktreeReview | undefined) => number | false);
}

/**
 * What the core offers plugin UI. Plugins never import the dashboard or its
 * tRPC client; they reach the core only through this object.
 */
export interface ClientPluginHost {
  useWorktreeReview(worktreeId: string, options: WorktreeReviewQueryOptions): WorktreeReviewQuery;
  mergeReview(worktreeId: string, method: MergeMethod): Promise<void>;
  /** Start a coding agent in the worktree with a first prompt, in this device's agent mode. */
  startAgent(worktreeId: string, prompt: string): Promise<void>;
  /** Open a URL in the system browser (the desktop app) or a new tab (the web app). */
  openUrl(url: string): void;
}

const ClientPluginHostContext = createContext<ClientPluginHost | null>(null);

export const ClientPluginHostProvider = ClientPluginHostContext.Provider;

export function useClientPluginHost(): ClientPluginHost {
  const host = useContext(ClientPluginHostContext);
  if (!host) throw new Error("useClientPluginHost must be used inside ClientPluginHostProvider");
  return host;
}

export interface WorktreeSideTabProps {
  worktreeId: string;
  /** False while the side panel is collapsed; stop polling then. */
  visible: boolean;
}

/** A tab in the worktree's right side panel, after Explorer and Changes. */
export interface WorktreeSideTab {
  /** Unique within the plugin. */
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  component: ComponentType<WorktreeSideTabProps>;
}

/** Keyed by slot id (`ClientSlotId`). */
export interface ClientContributions {
  "worktree.sideTabs"?: WorktreeSideTab[];
}

export interface ClientPlugin {
  /** Must equal the manifest id. */
  id: string;
  contributions: ClientContributions;
}

/** The default export of a plugin's client module. */
export function defineClientPlugin(plugin: ClientPlugin): ClientPlugin {
  return plugin;
}
