/**
 * Window events between the plugin host and a worktree's center dock, for an
 * agent a plugin starts. The dock cannot be reached from plugin code directly.
 */

/** Sent before the launch call, with the ids the new chat and terminal will have. */
export const AGENT_LAUNCHING_EVENT = "band:agent-launching";
/** Sent to make a chat, terminal or plugin panel tab the active one. */
export const OPEN_PANE_EVENT = "band:open-pane";

export interface AgentLaunchingDetail {
  worktreeId: string;
  chatId: string;
  terminalId: string;
}

export interface OpenPaneDetail {
  worktreeId: string;
  paneId: string;
  /** Set when the pane may not exist yet, so the dock can add it. */
  kind?: "chat" | "term" | "plugin";
}

/**
 * Remembers which panes to activate. The server's creation event and the launch
 * answer can arrive in either order, so both paths call `activate` and the pane
 * is activated by whichever finds it first.
 */
export class PaneActivations {
  private readonly wanted = new Set<string>();

  expect(...ids: string[]): void {
    for (const id of ids) this.wanted.add(id);
  }

  has(id: string): boolean {
    return this.wanted.has(id);
  }

  /** Activate `id` if it was expected and the pane exists. Returns whether it did. */
  activate(id: string, getPanel: (id: string) => { api: { setActive(): void } } | undefined) {
    if (!this.wanted.has(id)) return false;
    const panel = getPanel(id);
    if (!panel) return false;
    panel.api.setActive();
    this.wanted.delete(id);
    return true;
  }
}
