/**
 * Terminal layout persistence.
 *
 * Thin wrapper around DockviewLayoutManager for terminal tab layouts.
 * Each worktree gets one row in the `panel_states` table with
 * `panelType = "terminal_layout"`.
 */

import { DockviewLayoutManager } from "./dockview-layout-manager";

const manager = new DockviewLayoutManager("terminal_layout");

export const deleteTerminalLayout = (worktreeId: string) => manager.delete(worktreeId);

/**
 * Add a terminal panel to the saved dockview layout.
 */
export function addTerminalToLayout(
  worktreeId: string,
  terminalId: string,
  opts?: { title?: string; command?: string; cwd?: string; env?: Record<string, string> },
): void {
  manager.addPanel(worktreeId, {
    id: terminalId,
    contentComponent: "terminalTab",
    tabComponent: "terminalTab",
    title: opts?.title ?? "Terminal",
    params: {
      worktreeId,
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
export function removeTerminalFromLayout(worktreeId: string, terminalId: string): void {
  manager.removePanel(worktreeId, terminalId);
}
