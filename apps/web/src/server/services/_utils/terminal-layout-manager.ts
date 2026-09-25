/**
 * Terminal layout persistence.
 *
 * Thin wrapper around DockviewLayoutManager for terminal tab layouts.
 * Each workspace gets one row in the `panel_states` table with
 * `panelType = "terminal_layout"`.
 */

import { DockviewLayoutManager } from "./dockview-layout-manager";

const manager = new DockviewLayoutManager("terminal_layout");

export const deleteTerminalLayout = (workspaceId: string) => manager.delete(workspaceId);

/**
 * Add a terminal panel to the saved dockview layout.
 */
export function addTerminalToLayout(
  workspaceId: string,
  terminalId: string,
  opts?: { title?: string; command?: string; cwd?: string; env?: Record<string, string> },
): void {
  manager.addPanel(workspaceId, {
    id: terminalId,
    contentComponent: "terminalTab",
    tabComponent: "terminalTab",
    title: opts?.title ?? "Terminal",
    params: {
      workspaceId,
      terminalId,
      ...(opts?.command ? { command: opts.command } : {}),
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.env ? { env: opts.env } : {}),
    },
  });
}

/**
 * Remove a terminal panel from the saved dockview layout.
 */
export function removeTerminalFromLayout(workspaceId: string, terminalId: string): void {
  manager.removePanel(workspaceId, terminalId);
}
