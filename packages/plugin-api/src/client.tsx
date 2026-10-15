import { type ComponentType, createContext, useContext } from "react";
import type { MergeMethod, RerunTarget, WorktreeReview } from "./providers";

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
  /**
   * Run CI jobs again, one request per target, and refetch the review. Stops
   * at the first target the forge refuses and rejects with its message.
   */
  rerunChecks(worktreeId: string, targets: RerunTarget[]): Promise<void>;
  /**
   * Start a coding agent in the worktree with a first prompt, in this device's
   * agent mode. The agent's tab opens and becomes the active one in the center
   * dock. Resolves with the id of its chat or terminal.
   */
  startAgent(worktreeId: string, prompt: string): Promise<{ chatId?: string; terminalId?: string }>;
  /** Make the center dock tab with this chat or terminal id the active one. */
  openPane(worktreeId: string, paneId: string): void;
  /** Open a URL in the system browser (the desktop app) or a new tab (the web app). */
  openUrl(url: string): void;
  /** Open a file of the worktree in the center dock, scrolled to `line` when given. */
  openFile(worktreeId: string, path: string, line?: number | null): void;
  /**
   * Renders Markdown from an untrusted author with the app's sanitising
   * renderer: no raw HTML, links open outside the dashboard.
   */
  Markdown: ComponentType<{ children: string; className?: string }>;
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
