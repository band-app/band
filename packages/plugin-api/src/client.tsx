import { type ComponentType, createContext, useContext } from "react";

/**
 * What the core offers plugin UI. Plugins never import the dashboard or its
 * tRPC client; they reach the core only through this object.
 */
export interface ClientPluginHost {
  /**
   * Start a coding agent in the worktree with a first prompt, in this device's
   * agent mode. The agent's tab opens and becomes the active one in the center
   * dock. Resolves with the id of its chat or terminal.
   */
  startAgent(worktreeId: string, prompt: string): Promise<{ chatId?: string; terminalId?: string }>;
  /** Make the center dock tab with this chat or terminal id the active one. */
  openPane(worktreeId: string, paneId: string): void;
  /**
   * Delete the worktree the way its sidebar card does: at once when nothing is at risk,
   * else after the core's confirmation dialog. Does nothing for the default branch or a
   * superseded copy.
   */
  deleteWorktree(worktreeId: string): void;
  /** Open a URL in the system browser (the desktop app) or a new tab (the web app). */
  openUrl(url: string): void;
  /** Open a file of the worktree in the center dock, scrolled to `line` when given. */
  openFile(worktreeId: string, path: string, line?: number | null): void;
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
