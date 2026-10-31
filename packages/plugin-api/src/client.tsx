import { type ComponentType, createContext, type ReactNode, useContext } from "react";

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
  /**
   * The core's live remote screen: frames from the plugin's stream in, pointer and key events
   * out. It draws the header (title, state, Take control / Release, screenshot) and the screen.
   */
  RemoteScreen: ComponentType<RemoteScreenProps>;
  /**
   * Shows the simulator `udid` in Simulator.app on this Mac. Present only in the desktop app.
   * `canRevealSimulator` says whether the worktree's worker is this Mac's own worker.
   */
  revealSimulator?(worktreeId: string, udid: string): Promise<void>;
  canRevealSimulator?(worktreeId: string): Promise<boolean>;
}

/** What the plugin's stream tells the viewer, from its `{"type":"info"}` messages. */
export interface RemoteScreenInfo {
  /** The screen size in the plugin's own units (points for the simulator). */
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface RemoteScreenApi {
  /** Sends a JSON message to the plugin. Dropped by the hub while the viewer is view-only. */
  send(message: Record<string, unknown>): void;
  controlling: boolean;
  info: RemoteScreenInfo | null;
}

export interface RemoteScreenProps {
  pluginId: string;
  worktreeId: string;
  /** False while the tab is hidden; the stream stays connected. */
  visible: boolean;
  title: string;
  /** Buttons the plugin adds to the header, shown beside Take control. */
  actions?: (api: RemoteScreenApi) => ReactNode;
}

export interface WorktreePanelProps {
  worktreeId: string;
  /** False while the tab is hidden. */
  visible: boolean;
}

/**
 * A tab in the worktree's center dock. The "+" menu offers it when the worktree's worker reports
 * the `capability`; opening it adds the tab to the worktree's shared tab list.
 */
export interface WorktreePanel {
  /** Unique within the plugin. */
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** The worker capability that makes the panel available (a plugin's id). */
  capability: string;
  component: ComponentType<WorktreePanelProps>;
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
  "worktree.panels"?: WorktreePanel[];
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
